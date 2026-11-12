import { PokerEngine } from '../core/engine.ts'
import { isClientCommand } from '../shared/contracts.ts'
import { AFK_TURN_DURATION_MS, BLIND_LEVEL_MS, BLIND_LEVELS, TURN_DURATION_MS, TURN_WARNING_MS } from '../shared/tournament.ts'
import { MATCH_SIZE, publicProfile } from '../shared/profiles.ts'
import type { ClientCommand, ServerMessage, GameEvent, LastHandResult, MatchState, MatchFormat, PlayerPlacement, PublicProfile, PublicState, TournamentState, TurnTimer, WorldMode } from '../shared/contracts.ts'

export interface SessionTransport { send(id: string, message: ServerMessage): void }
export interface SessionOptions {
  format?:MatchFormat; autoStart?:boolean; reserveSeats?:boolean; matchId?:string; rated?:boolean
}
/** Final tournament facts for the hub's durable ledger; never includes private cards. */
export interface AuthorityOutcome {
  matchId:string; format:MatchFormat; participantIds:string[]
  winnerId:string|null; placements:PlayerPlacement[]
}
const RESULT_PAUSE = 2.6
const PREDEAL_PAUSE = 1.8

/** Per-room authority: chooses a mode before cards, runs hands automatically, settles the match. */
export class PokerSession {
  private engine: PokerEngine
  private random: ()=>number
  private members = new Map<string,string>()
  private participants = new Set<string>()
  private profiles = new Map<string,PublicProfile>()
  private surrendered = new Set<string>()
  private surrenderPlaces = new Map<string,number>()
  private seen = new Map<string,Set<string>>()
  private hostId: string|null = null
  private mode: 'solo'|'multiplayer'|null = null
  private soloPlayerId: string|null = null
  private botClock = 0
  private turnClock = 0
  private turnKey = ''
  private turnSerial = 0
  private turnId = ''
  private turnDurationMs = TURN_DURATION_MS
  private timeoutStreak = new Map<string,number>()
  private tournamentClockMs = 0
  private blindLevel = 0
  private broadcastClock = 0
  private phase: 'idle'|'result'|'predeal' = 'idle'
  private phaseClock = 0
  private settledHand: string|null = null
  private handStacks = new Map<string,number>()
  private handNames = new Map<string,string>()
  private previousHand: LastHandResult | undefined
  private match: MatchState = { status:'WAITING',placements:[],winnerId:null }

  constructor(private transport: SessionTransport, random?:()=>number, private options:SessionOptions={}) {
    this.random=random ?? Math.random
    this.engine=new PokerEngine({random:this.random,maxPlayers:options.format==='headsUp'?2:4})
    if(options.autoStart&&!options.format)throw new Error('Automatic admission requires an explicit format')
    if(options.format)this.match.format=options.format
  }

  /** Read-only tournament inspection; callers cannot mutate the session's roster or standings. */
  getMatchState():MatchState {
    return {...this.match,...(this.match.participantIds?{participantIds:[...this.match.participantIds]}:{}),
      placements:this.match.placements.map(placement=>({...placement}))}
  }

  /** A result exists only after the tournament ends and has a committed match identity. */
  getOutcome():AuthorityOutcome|null {
    const {status,matchId,format,winnerId}=this.match
    if(status!=='FINISHED'||!matchId||!format)return null
    return {matchId,format,participantIds:[...(this.match.participantIds??[])],winnerId,
      placements:this.match.placements.map(placement=>({...placement}))}
  }

  join(id:string,name:string,avatar:string|null=null):boolean {
    if(this.members.has(id)) {
      this.engine.joinPlayer(id,name.slice(0,32)||'Player')
      this.members.set(id,name)
      this.profiles.set(id,publicProfile(id,name,avatar));this.flush();return true
    }
    if(this.match.status!=='WAITING'&&!this.participants.has(id) ||
      this.members.size>=(this.options.format==='headsUp'?2:4) ||
      this.options.format==='solo'&&this.members.size>=1) {
      this.error(id,'ROOM_FULL','The table is full or the match has ended');return false
    }
    try {this.engine.joinPlayer(id,name.slice(0,32)||'Player')}
    catch {this.error(id,'ROOM_FULL','A seat will become available after this hand');return false}
    this.members.set(id,name)
    this.profiles.set(id,publicProfile(id,name,avatar))
    this.participants.add(id)
    if(!this.seen.has(id))this.seen.set(id,new Set())
    this.hostId ??= id
    this.transport.send(id,{type:'welcome',version:1,playerId:id})
    if(this.options.autoStart&&this.match.status==='WAITING'&&
      this.members.size===(this.options.format==='solo'?1:MATCH_SIZE[this.options.format!])) {
      this.startMatch(this.options.format==='solo'?'solo':'multiplayer',id)
    }
    this.flush();return true
  }

  leave(id:string):void {
    if(!this.members.has(id))return
    this.engine.leavePlayer(id)
    this.members.delete(id)
    if(this.match.status==='WAITING') {this.participants.delete(id);this.profiles.delete(id);this.seen.delete(id)}
    if(this.hostId===id)this.hostId=this.members.keys().next().value??null
    this.flush()
  }

  /** A transport interruption keeps the committed identity, chips and decision deadline. */
  disconnect(id:string):void {
    if(!this.members.has(id))return
    if(this.match.status==='WAITING') {this.leave(id);return}
    this.engine.disconnectPlayer(id)
    this.members.delete(id)
    if(this.hostId===id)this.hostId=this.members.keys().next().value??null
    this.flush()
  }

  /** Explicit departure differs from a dropped connection. All-in eligibility settles first. */
  surrender(id:string):boolean {
    if(!this.participants.has(id)||this.match.status!=='PLAYING'||this.surrendered.has(id))return false
    const before=this.engine.getPublicState()
    if(this.match.placements.some(r=>r.playerId===id))return false
    const remaining=before.players.filter(p=>!this.surrendered.has(p.id)&&!this.match.placements.some(r=>r.playerId===p.id)).length
    this.surrendered.add(id)
    // A surrender is a counted loss even if that player's all-in later wins the hand.
    // Keep unresolved all-in seats visible until the original pot has settled.
    this.surrenderPlaces.set(id,Math.max(2,remaining))
    this.engine.surrenderPlayer(id)
    const after=this.engine.getPublicState()
    if(!['PREFLOP','FLOP','TURN','RIVER','SHOWDOWN'].includes(after.stage)) {
      this.commitSurrenders()
      if(this.mode==='solo')this.finish()
    }
    this.flush()
    return true
  }

  private commitSurrenders():void {
    for(const [playerId,place] of this.surrenderPlaces)
      if(!this.match.placements.some(r=>r.playerId===playerId))this.match.placements.push({playerId,place,reason:'eliminated'})
    this.surrenderPlaces.clear()
  }

  receive(id:string,raw:unknown):void {
    if(!this.members.has(id))return this.error(id,'NOT_SEATED','You are not seated')
    if(!isClientCommand(raw))return this.error(id,'BAD_COMMAND','Invalid command')
    const command:ClientCommand=raw
    if(command.type==='hello') {
      this.transport.send(id,{type:'welcome',version:1,playerId:id});this.sendSnapshot(id);return
    }
    if(command.type==='ping') {this.transport.send(id,{type:'pong',nonce:command.nonce});return}
    if(command.type==='snapshot') {this.sendSnapshot(id);return}
    const seen=this.seen.get(id)!
    if(seen.has(command.actionId)) {this.sendSnapshot(id);return}
    const state=this.engine.getPublicState()
    try {
      if(command.type==='surrender') {
        // No-op departures must not grow replay storage while a room waits or has finished.
        if(this.surrender(id))seen.add(command.actionId)
        return
      } else if(command.type==='start') {
        if(id!==this.hostId)throw new Error('Only the table host can start the match')
        if(state.stage!=='LOBBY'||this.match.status!=='WAITING')throw new Error('The match has already started')
        this.startMatch(command.mode,id)
      } else {
        if(command.handId!==state.handId)throw new Error('This hand is out of date')
        if(command.type==='next')throw new Error('The next hand starts automatically')
        if(this.match.status!=='PLAYING')throw new Error('The match has ended')
        if(this.surrendered.has(id))throw new Error('This player has surrendered')
        if(state.actorId!==id)throw new Error('It is another player\'s turn')
        this.engine.act(id,command.action)
        this.timeoutStreak.delete(id)
        this.turnKey=''
      }
      seen.add(command.actionId)
      this.flush()
    } catch(error) {
      this.error(id,'REJECTED',error instanceof Error?error.message:'Action rejected',command.actionId)
      this.sendSnapshot(id)
    }
  }

  private startMatch(mode:'solo'|'multiplayer',id:string):void {
    const format=this.options.format??(mode==='solo'?'solo':this.members.size===2?'headsUp':'fourMax')
    if((format==='solo')!==(mode==='solo'))throw new Error('The room format cannot change')
    if(mode==='solo') {
      if(this.members.size!==1)throw new Error('Solo requires a separate room')
      for(let i=1;i<4;i++) {
        const botId=`bot:${i}`,name=['Vesper','Onyx','Scarlet'][i-1]
        this.engine.joinPlayer(botId,name,true);this.profiles.set(botId,publicProfile(botId,name,null))
      }
    } else if(this.options.format&&this.members.size!==MATCH_SIZE[format])throw new Error('Waiting for the complete roster')
    else if(this.members.size<2)throw new Error('Invite a second player')
    this.mode=mode;this.soloPlayerId=mode==='solo'?id:null
    this.match={status:'PLAYING',placements:[],winnerId:null,format,
      participantIds:[...this.participants],rated:this.options.rated===true,...(this.options.matchId?{matchId:this.options.matchId}:{})}
    this.tournamentClockMs=0;this.blindLevel=0;this.timeoutStreak.clear()
    this.prepareHand()
  }

  tick(dt:number):void {
    if(this.match.status!=='PLAYING')return
    const delta=Number.isFinite(dt)?Math.max(0,Math.min(dt,1)):0
    this.tournamentClockMs+=delta*1000
    this.broadcastClock+=delta
    if(this.phase!=='idle') {
      if(!this.canContinue()) {this.finish();this.flush();return}
      this.phaseClock-=delta
      if(this.phaseClock>1e-9) {this.broadcastTime();return}
      if(this.phase==='result')this.prepareHand()
      else this.dealPreparedHand()
      this.flush();return
    }
    const state=this.engine.getPublicState()
    this.syncTurn(state)
    const actor=state.players.find(p=>p.id===state.actorId)
    if(!actor)return
    const beforeRemaining=this.turnDurationMs-this.turnClock*1000
    this.botClock+=delta;this.turnClock+=delta
    if(actor.isBot&&this.botClock>=.65) {
      this.engine.act(actor.id,this.engine.getBotAction(actor.id))
      this.turnKey='';this.flush()
    } else if(!actor.isBot&&this.turnClock*1000>=this.turnDurationMs-1e-6) {
      this.engine.act(actor.id,{type:'fold'})
      this.timeoutStreak.set(actor.id,Math.min(2,(this.timeoutStreak.get(actor.id)??0)+1))
      this.turnKey='';this.flush()
    } else if(!actor.isBot&&beforeRemaining>TURN_WARNING_MS&&this.turnDurationMs-this.turnClock*1000<=TURN_WARNING_MS) this.flush()
    else this.broadcastTime()
  }

  private syncTurn(state:PublicState):void {
    const actor=state.players.find(p=>p.id===state.actorId)
    const key=this.match.status==='PLAYING'&&this.phase==='idle'&&actor?`${state.handId}:${state.stage}:${actor.id}`:''
    if(key===this.turnKey)return
    this.turnKey=key;this.botClock=0;this.turnClock=0
    if(key&&actor) {
      this.turnId=`${state.handId}:turn-${++this.turnSerial}`
      this.turnDurationMs=(this.timeoutStreak.get(actor.id)??0)>=2?AFK_TURN_DURATION_MS:TURN_DURATION_MS
    }
  }
  private decisionTimer(state:PublicState):TurnTimer|undefined {
    const actor=state.players.find(p=>p.id===state.actorId)
    if(!this.turnKey||!actor||actor.isBot||this.match.status!=='PLAYING')return
    return {turnId:this.turnId,playerId:actor.id,durationMs:this.turnDurationMs,
      remainingMs:Math.max(0,Math.round(this.turnDurationMs-this.turnClock*1000))}
  }
  private tournamentState():TournamentState|undefined {
    if(this.match.status==='WAITING')return
    const upcoming=Math.min(BLIND_LEVELS.length-1,Math.max(this.blindLevel+1,Math.floor(this.tournamentClockMs/BLIND_LEVEL_MS)))
    const next=this.blindLevel<BLIND_LEVELS.length-1?BLIND_LEVELS[upcoming]:null
    return {level:this.blindLevel+1,levelDurationMs:BLIND_LEVEL_MS,
      remainingMs:next?Math.max(0,Math.round((this.blindLevel+1)*BLIND_LEVEL_MS-this.tournamentClockMs)):0,
      nextSmallBlind:next?.[0]??null,nextBigBlind:next?.[1]??null}
  }
  private broadcastTime():void {
    if(this.broadcastClock>=1-1e-9)this.flush()
  }

  private prepareHand():void {
    // Independent 50/50 choice for every hand; consecutive identical modes are valid.
    const sample=this.random()
    if(!Number.isFinite(sample)||sample<0||sample>=1)throw new Error('Invalid mode random sample')
    const selected:WorldMode=sample<.5?'NORMAL':'MIRROR'
    this.engine.prepareNextHand(selected)
    this.phase='predeal';this.phaseClock=PREDEAL_PAUSE
  }
  private dealPreparedHand():void {
    this.blindLevel=Math.min(BLIND_LEVELS.length-1,Math.floor(this.tournamentClockMs/BLIND_LEVEL_MS))
    const blinds=BLIND_LEVELS[this.blindLevel]
    this.engine.setBlinds(blinds[0],blinds[1])
    const prepared=this.engine.getPublicState()
    this.handStacks=new Map(prepared.players.filter(p=>(p.connected||this.options.reserveSeats)&&p.stack>0).map(p=>[p.id,p.stack]))
    this.handNames=new Map(prepared.players.map(p=>[p.id,p.name]))
    this.engine.startHand(prepared.worldMode)
    this.phase='idle';this.phaseClock=0
    this.turnKey='';this.botClock=0;this.turnClock=0
    // IDs survive reconnection until handId changes; no arbitrary eviction during a hand.
    for(const [member,ids] of this.seen) {
      if(this.participants.has(member))ids.clear()
      else this.seen.delete(member)
    }
  }
  private settle(state:PublicState):void {
    if(state.stage!=='COMPLETE'||state.handId===this.settledHand)return
    this.settledHand=state.handId
    this.commitSurrenders()
    this.previousHand={handId:state.handId,worldMode:state.worldMode,winners:state.winners.map(winner=>({
      ...winner,playerName:this.handNames.get(winner.playerId)??state.players.find(p=>p.id===winner.playerId)?.name??'Player',
      ...(winner.cards?{cards:[...winner.cards]}:{}),
    }))}
    const contenders=[...this.handStacks.keys()].filter(id=>!this.match.placements.some(r=>r.playerId===id))
    const lastContender=contenders.length===1?contenders[0]:null
    const busted=contenders.map(id=>({id,stack:this.engine.getPlayerBalance(id)}))
      .filter(p=>p.stack===0&&!this.match.placements.some(r=>r.playerId===p.id))
      .filter(p=>p.id!==lastContender)
      .sort((a,b)=>this.handStacks.get(a.id)!-this.handStacks.get(b.id)!)
    // Simultaneous busts: bigger starting stack places higher; equal stacks share a place.
    let removed=0
    while(removed<busted.length) {
      let end=removed+1
      while(end<busted.length&&this.handStacks.get(busted[end].id)===this.handStacks.get(busted[removed].id))end++
      const place=contenders.length-end+1
      for(let i=removed;i<end;i++)this.match.placements.push({playerId:busted[i].id,place,reason:'eliminated'})
      removed=end
    }
    if(!this.canContinue() || this.mode==='solo'&&this.match.placements.some(r=>r.playerId===this.soloPlayerId))this.finish()
    else {this.phase='result';this.phaseClock=RESULT_PAUSE}
  }
  private canContinue():boolean {
    return this.engine.getPublicState().players.filter(p=>(p.connected||this.options.reserveSeats)&&p.stack>0).length>=2
  }
  private finish():void {
    this.phase='idle';this.phaseClock=0;this.match.status='FINISHED'
    const players=this.engine.getPublicState().players
    const live=players.filter(p=>(p.connected||this.options.reserveSeats)&&p.stack>0&&!this.surrendered.has(p.id))
    const funded=[...new Set([...this.handStacks.keys(),...players.map(p=>p.id)])]
      .filter(id=>(this.engine.getPlayerBalance(id)??0)>0)
    // An all-in champion may disconnect before payout; their paid balance still wins.
    const contenders=players.filter(p=>!this.surrendered.has(p.id)&&!this.match.placements.some(r=>r.playerId===p.id))
    const winner=contenders.length===1?contenders[0].id:funded.length===1?funded[0]:live.length===1?live[0].id:null
    if(winner) {
      this.match.winnerId=winner
      if(!this.match.placements.some(r=>r.playerId===winner))this.match.placements.push({playerId:winner,place:1,reason:'winner'})
    }
  }
  private sendSnapshot(id:string,events?:GameEvent[]):void {
    const state=this.engine.getPublicState()
    const turnTimer=this.decisionTimer(state),tournament=this.tournamentState()
    this.transport.send(id,{type:'snapshot',state:{...state,hostId:this.hostId,
      profiles:Object.fromEntries([...this.profiles].map(([key,profile])=>[key,{...profile}])),
      ...(turnTimer?{turnTimer}:{}),...(tournament?{tournament}:{}),
      ...(this.previousHand?{previousHand:{...this.previousHand,winners:this.previousHand.winners.map(w=>({...w,...(w.cards?{cards:[...w.cards]}:{})}))}}:{}),
      match:this.getMatchState()},privateState:this.engine.getPrivateState(id),...(events?.length?{events}:{})})
  }
  private flush():void {
    const state=this.engine.getPublicState()
    this.settle(state)
    if(this.match.status==='PLAYING'&&['COMPLETE','INTERMISSION'].includes(state.stage)&&!this.canContinue())this.finish()
    this.syncTurn(state)
    this.broadcastClock=0
    const events=this.engine.drainEvents()
    for(const id of this.members.keys())this.sendSnapshot(id,events)
  }
  private error(id:string,code:string,message:string,actionId?:string):void {
    this.transport.send(id,{type:'error',code,message,...(actionId?{actionId}:{})})
  }
}

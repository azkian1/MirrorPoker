import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
const root=resolve(import.meta.dirname,'..')
mkdirSync(resolve(root,'.test-output'),{recursive:true})
const result=spawnEsbuild(['tests/session-entry.ts','--bundle','--platform=node','--format=esm','--outfile=.test-output/session-bundle.mjs'],{cwd:root,encoding:'utf8'})
assert.equal(result.status,0,result.stderr)
const {PokerSession,StateReceiver}=await import('../.test-output/session-bundle.mjs')
const rng=seed=>()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296)
function fixture(count=2,random=rng(17)) {
  const messages=new Map()
  const session=new PokerSession({send(id,m){const log=messages.get(id)??[];log.push(structuredClone(m));messages.set(id,log)}},random)
  const last=id=>messages.get(id)?.findLast(m=>m.type==='snapshot')
  for(let i=0;i<count;i++)session.join(`p${i}`,`Player ${i}`)
  return {session,messages,last}
}
function tickFor(session,seconds) {
  for(let elapsed=0;elapsed<seconds-1e-9;elapsed+=.1)session.tick(Math.min(.1,seconds-elapsed))
}
function start(f,mode='multiplayer') {
  f.session.receive('p0',{type:'start',mode,actionId:'start'})
  assert.equal(f.last('p0').state.stage,'INTERMISSION')
  assert.deepEqual(f.last('p0').privateState.cards,[])
  tickFor(f.session,1.81)
  assert.equal(f.last('p0').state.stage,'PREFLOP')
}
function passive(f,observer='p0') {
  for(let guard=0;guard<100;guard++) {
    const state=f.last(observer).state
    if(state.stage==='COMPLETE')return
    const actor=state.actorId,legal=f.last(actor).privateState.legalActions
    const action=legal.find(a=>a.type==='check')??legal.find(a=>a.type==='call')
    assert.ok(action)
    f.session.receive(actor,{type:'act',handId:state.handId,actionId:`passive-${state.handId}-${guard}`,action:{type:action.type}})
  }
  assert.fail('Hand did not complete')
}
function allIn(f) {
  for(let guard=0;guard<12&&f.last('p0').state.stage!=='COMPLETE';guard++) {
    const state=f.last('p0').state
    f.session.receive(state.actorId,{type:'act',handId:state.handId,actionId:`allin-${state.handId}-${guard}`,action:{type:'allIn'}})
  }
  assert.equal(f.last('p0').state.stage,'COMPLETE')
}
function rigged(...hands) {
  let current=[...'cdhs'].flatMap(suit=>[...'23456789TJQKA'].map(rank=>rank+suit))
  const samples=Array(51).fill(.9999)
  for(const {draw,mode='NORMAL'} of hands) {
    samples.push(mode==='NORMAL'?.25:.75)
    const wanted=draw.split(' ')
    assert.equal(new Set(wanted).size,wanted.length)
    const desired=[...current.filter(card=>!wanted.includes(card)),...wanted.toReversed()]
    for(let i=51;i>0;i--) {
      const j=current.indexOf(desired[i])
      assert.ok(j<=i)
      samples.push((j+.25)/(i+1))
      ;[current[i],current[j]]=[current[j],current[i]]
    }
  }
  return ()=>samples.length?samples.shift():.9999
}
test('two-client authority: ping, private hands, fixed mode, identical payout and automatic next hand',()=>{
  const f=fixture(),{session,messages,last}=f
  session.receive('p1',{type:'ping',nonce:'smoke'})
  assert.ok(messages.get('p1').some(m=>m.type==='pong'&&m.nonce==='smoke'))
  start(f)
  const selected=last('p0').state.worldMode
  let actions=0
  while(last('p0').state.stage!=='COMPLETE'&&actions<100) {
    const a=last('p0'),b=last('p1')
    assert.equal(a.state.worldMode,selected)
    assert.deepEqual(a.state,b.state)
    assert.equal(a.state.players.every(p=>p.cards===undefined),true)
    assert.equal(a.privateState.playerId,'p0');assert.equal(b.privateState.playerId,'p1')
    assert.notDeepEqual(a.privateState.cards,b.privateState.cards)
    assert.equal(JSON.stringify(a).includes(JSON.stringify(b.privateState.cards)),false)
    const actor=a.state.actorId
    const own=last(actor)
    const legal=own.privateState.legalActions
    const action=legal.find(x=>x.type==='check') ?? legal.find(x=>x.type==='call')
    assert.ok(action)
    session.receive(actor,{type:'act',handId:a.state.handId,actionId:`action-${actions++}`,action:{type:action.type}})
  }
  const final=last('p0')
  assert.equal(final.state.stage,'COMPLETE')
  assert.equal(final.state.worldMode,selected)
  assert.equal(final.state.players.reduce((s,p)=>s+p.stack,0),2000)
  const events=messages.get('p0').flatMap(m=>m.events??[])
  assert.equal(events.filter(e=>e.type==='WORLD_CHANGED').length,selected==='MIRROR'?1:0)
  assert.equal(events.filter(e=>e.type==='PAYOUT').length,1)
  assert.deepEqual(final.state,last('p1').state)
  session.receive('p0',{type:'next',handId:final.state.handId,actionId:'next-1'})
  assert.equal(last('p0').state.handId,'hand-1')
  assert.equal(last('p0').state.stage,'COMPLETE')
  assert.match(messages.get('p0').at(-2).message,/automatically/)
  tickFor(session,2.5)
  assert.equal(last('p0').state.stage,'COMPLETE')
  tickFor(session,.11)
  assert.equal(last('p0').state.stage,'INTERMISSION')
  assert.equal(last('p0').state.handId,'hand-1')
  assert.deepEqual(last('p0').privateState.cards,[])
  assert.deepEqual(last('p0').state.board,[])
  tickFor(session,1.7)
  assert.equal(last('p0').state.stage,'INTERMISSION')
  tickFor(session,.11)
  assert.equal(last('p0').state.handId,'hand-2')
  assert.equal(last('p0').privateState.cards.length,2)
})
test('duplicate actionId, stale hand, out of turn, malformed and non-host starts do not mutate authority',()=>{
  const {session,last,messages}=fixture()
  session.receive('p1',{type:'start',mode:'multiplayer',actionId:'bad-start'})
  assert.equal(last('p0').state.stage,'LOBBY')
  session.receive('p0',{type:'start',mode:'multiplayer',actionId:'start'})
  const before=last('p0').state
  session.receive('p0',{type:'start',mode:'multiplayer',actionId:'start'})
  assert.deepEqual(last('p0').state,before)
  tickFor(session,1.81)
  const active=last('p0').state
  const actor=active.actorId,other=actor==='p0'?'p1':'p0'
  const legal=last(actor).privateState.legalActions
  const chosen=legal.find(a=>a.type==='call')??legal.find(a=>a.type==='check')
  const command={type:'act',handId:active.handId,actionId:'one-action',action:{type:chosen.type}}
  session.receive(actor,command)
  const after=last('p0').state
  session.receive(actor,command)
  assert.deepEqual(last('p0').state,after)
  session.receive(other,{...command,handId:'old-hand',actionId:'stale'})
  session.receive(other,{...command,actionId:'wrong',action:{type:'raise',amount:Infinity}})
  session.receive(other,[])
  assert.deepEqual(last('p0').state,after)
  assert.ok(messages.get(other).some(m=>m.type==='error'))
})
test('only accepted surrenders retain replay IDs through waiting, repeated departure, reconnect and finished rooms',()=>{
  const f=fixture(4)
  const spam=(id,prefix)=>{
    for(let i=0;i<10000;i++)f.session.receive(id,{type:'surrender',actionId:`${prefix}-${i}`})
  }
  const waiting=f.last('p0').state
  spam('p3','waiting')
  assert.equal(f.session.seen.get('p3').size,0,'Waiting no-ops cannot consume replay storage')
  assert.deepEqual(f.last('p0').state,waiting)

  start(f)
  assert.equal(f.last('p0').state.actorId,'p3')
  // A previously ignored ID is still available for a real surrender.
  const command={type:'surrender',actionId:'waiting-0'}
  f.session.receive('p3',command)
  const surrendered=f.last('p0').state
  assert.equal(surrendered.match.status,'PLAYING')
  assert.equal(surrendered.players.find(p=>p.id==='p3').folded,true)
  assert.deepEqual([...f.session.seen.get('p3')],['waiting-0'])
  spam('p3','already-surrendered')
  assert.deepEqual([...f.session.seen.get('p3')],['waiting-0'])
  assert.deepEqual(f.last('p0').state,surrendered)

  f.session.disconnect('p3')
  f.session.join('p3','Reconnected')
  const restored=f.last('p3').state
  f.session.receive('p3',command)
  assert.deepEqual(f.last('p3').state,restored)
  assert.deepEqual([...f.session.seen.get('p3')],['waiting-0'],'Accepted ID survives the same-hand reconnect')

  for(const id of ['p0','p1','p2'])f.session.surrender(id)
  const finished=f.last('p3').state
  assert.equal(finished.match.status,'FINISHED')
  spam('p3','finished')
  assert.deepEqual([...f.session.seen.get('p3')],['waiting-0'])
  assert.deepEqual(f.last('p3').state,finished)
})
test('Solo shares the same authority, bounded bot ticks complete a hand, exit cannot stall a turn',()=>{
  const {session,last}=fixture(1)
  session.receive('p0',{type:'start',mode:'solo',actionId:'solo'})
  assert.equal(last('p0').state.players.filter(p=>p.isBot).length,3)
  for(let i=0;i<1000 && last('p0').state.stage!=='COMPLETE';i++) {
    const snapshot=last('p0')
    if(snapshot.state.actorId==='p0') {
      const legal=snapshot.privateState.legalActions
      session.receive('p0',{type:'act',handId:snapshot.state.handId,actionId:`human-${i}`,action:{type:legal.some(a=>a.type==='check')?'check':'call'}})
    }
    session.tick(.1)
  }
  assert.equal(last('p0').state.stage,'COMPLETE')
  assert.equal(last('p0').state.players.reduce((n,p)=>n+p.stack,0),4000)
  const f=fixture(3)
  f.session.receive('p0',{type:'start',mode:'multiplayer',actionId:'start'})
  tickFor(f.session,1.81)
  const actor=f.last('p0').state.actorId
  f.session.leave(actor)
  const survivor=['p0','p1','p2'].find(id=>id!==actor)
  assert.notEqual(f.last(survivor).state.actorId,actor)
})
test('snapshot watermark rejects duplicates/stale updates and resync never replays effects',()=>{
  const f=fixture()
  const seen=[],effects=[]
  const receiver=new StateReceiver({snapshot(s){seen.push(s.seq)},event(e){effects.push(e.eventId)},error(){}})
  receiver.receive(f.last('p0'))
  f.session.receive('p0',{type:'start',mode:'multiplayer',actionId:'start'})
  tickFor(f.session,1.81)
  const active=f.last('p0')
  receiver.receive(active);receiver.receive(active)
  assert.equal(effects.length,new Set(effects).size)
  const count=effects.length
  receiver.receive({...active,events:undefined})
  receiver.receive({...active,state:{...active.state,seq:0}})
  assert.equal(effects.length,count)
  assert.notEqual(seen.at(-1),0)
  receiver.reset();receiver.receive(active)
  assert.equal(effects.length,count)
})

test('full table departure reserves its pot seat without crashing a rejected late join',()=>{
  const f=fixture(4)
  f.session.receive('p0',{type:'start',mode:'multiplayer',actionId:'start'})
  tickFor(f.session,1.81)
  const state=f.last('p0').state
  const departed=state.players.find(p=>p.id!==state.actorId&&p.id!=='p0').id
  f.session.leave(departed)
  const before=f.last('p0').state
  assert.equal(f.session.join('late','Late'),false)
  assert.ok(f.messages.get('late').some(m=>m.type==='error'&&m.code==='ROOM_FULL'))
  assert.deepEqual(f.last('p0').state,before)
  // Previous account can reclaim the retained seat in the same hand.
  assert.equal(f.session.join(departed,'Reconnected'),true)
  assert.equal(f.last(departed).privateState.cards.length,2)
  assert.equal(f.last('p0').state.handId,state.handId)
})

test('sender actionIds remain idempotent across leave/rejoin during the same hand',()=>{
  const f=fixture(3)
  const send=(id,actionId,action)=>f.session.receive(id,{type:'act',handId:f.last('p0').state.handId,actionId,action})
  f.session.receive('p0',{type:'start',mode:'multiplayer',actionId:'start'})
  tickFor(f.session,1.81)
  send('p0','raise',{type:'raise',amount:100})
  send('p1','call1',{type:'call'})
  const original={type:'act',handId:f.last('p0').state.handId,actionId:'call-retransmitted',action:{type:'call'}}
  f.session.receive('p2',original)
  assert.equal(f.last('p0').state.stage,'FLOP')
  assert.equal(f.last('p0').state.actorId,'p1')
  f.session.leave('p2')
  assert.equal(f.session.join('p2','Reconnected'),true)
  send('p1','flop-bet',{type:'bet',amount:100})
  assert.equal(f.last('p0').state.actorId,'p2')
  const before=f.last('p0').state
  f.session.receive('p2',original)
  assert.deepEqual(f.last('p2').state,before)
  assert.equal(f.last('p2').state.players.find(p=>p.id==='p2').stack,900)
})

test('a committed roster rejects a late player through the next hand without sending private state',()=>{
  const f=fixture(2)
  f.session.receive('p0',{type:'start',mode:'multiplayer',actionId:'start'})
  tickFor(f.session,1.81)
  assert.equal(f.session.join('late','Late'),false)
  assert.equal(f.last('late'),undefined)
  assert.equal(f.messages.get('late').at(-1).code,'ROOM_FULL')
  for(let guard=0;f.last('p0').state.stage!=='COMPLETE'&&guard<100;guard++) {
    const state=f.last('p0').state,actor=state.actorId
    assert.notEqual(actor,'late')
    const legal=f.last(actor).privateState.legalActions
    f.session.receive(actor,{type:'act',handId:state.handId,actionId:'passive-'+guard,action:{type:legal.some(a=>a.type==='check')?'check':'call'}})
  }
  const final=f.last('p0')
  f.session.receive('p0',{type:'next',handId:final.state.handId,actionId:'next'})
  assert.equal(f.last('late'),undefined)
  tickFor(f.session,2.61)
  assert.equal(f.last('p0').state.stage,'INTERMISSION')
  tickFor(f.session,1.81)
  assert.equal(f.session.join('late','Late'),false)
  assert.equal(f.last('late'),undefined)
  assert.equal(f.last('p0').privateState.cards.length,2)
  assert.ok(f.last('p0').state.players.every(p=>!p.cards))
})

test('independent random choices are visible before cards, can repeat, and never change during the hand',()=>{
  const modes=['MIRROR','MIRROR','NORMAL','NORMAL']
  const f=fixture(2,rigged(...modes.map(mode=>({mode,draw:'Ac Ad Kc Kd 2s 5h 8c 9d Jh'}))))
  f.session.receive('p0',{type:'start',mode:'multiplayer',actionId:'start'})
  let previous='NORMAL'
  for(let hand=0;hand<modes.length;hand++) {
    if(hand>0)tickFor(f.session,2.61)
    const prepared=f.last('p0'),mode=modes[hand]
    assert.equal(prepared.state.stage,'INTERMISSION')
    assert.equal(prepared.state.handId,`hand-${hand}`)
    assert.equal(prepared.state.worldMode,mode)
    assert.equal(prepared.state.actorId,null)
    assert.deepEqual(prepared.privateState.cards,[])
    assert.deepEqual(prepared.privateState.legalActions,[])
    assert.deepEqual(prepared.state.board,[])
    assert.deepEqual(prepared.events.map(e=>e.type),previous===mode?['HAND_PREPARED']:['HAND_PREPARED','WORLD_CHANGED'])
    assert.ok(prepared.events.every(e=>e.handId===`hand-${hand}`&&e.worldMode===mode))
    const before=f.messages.get('p0').length
    f.session.receive('p0',{type:'next',handId:prepared.state.handId,actionId:`skip-${hand}`})
    assert.equal(f.last('p0').state.stage,'INTERMISSION')
    assert.equal(f.last('p0').state.handId,prepared.state.handId)
    f.session.receive('p0',{type:'act',handId:prepared.state.handId,actionId:`early-${hand}`,action:{type:'allIn'}})
    assert.deepEqual(f.last('p0').privateState.cards,[])
    tickFor(f.session,1.7)
    assert.equal(f.last('p0').state.stage,'INTERMISSION')
    tickFor(f.session,.11)
    const dealt=f.last('p0')
    assert.equal(dealt.state.handId,`hand-${hand+1}`)
    assert.equal(dealt.state.worldMode,mode)
    assert.equal(dealt.privateState.cards.length,2)
    assert.deepEqual(dealt.events.map(e=>e.type),['HAND_STARTED','CARDS_DEALT'])
    assert.equal(dealt.events[0].worldMode,mode)
    assert.equal(dealt.events[1].cardCount,4)
    passive(f)
    const snapshots=f.messages.get('p0').slice(before).filter(m=>m.type==='snapshot')
    assert.ok(snapshots.every(m=>m.state.worldMode===mode))
    const events=snapshots.flatMap(m=>m.events??[])
    assert.equal(events.filter(e=>e.type==='WORLD_CHANGED').length,0)
    assert.deepEqual(events.filter(e=>e.type==='STREET_CHANGED').map(e=>e.board.length),[3,4,5])
    assert.equal(f.last('p0').state.match.status,'PLAYING')
    previous=mode
  }
})

test('a heads-up winner and loser receive final placements and a finished match never deals again',()=>{
  for(const mode of ['NORMAL','MIRROR']) {
    const f=fixture(2,rigged({mode,draw:'Ac Ad 2c 2d 6s 8h Tc Qd Kh'}))
    start(f)
    allIn(f)
    const state=f.last('p0').state,winner=mode==='NORMAL'?'p0':'p1',loser=winner==='p0'?'p1':'p0'
    assert.equal(state.match.status,'FINISHED')
    assert.equal(state.match.winnerId,winner)
    assert.deepEqual(state.match.placements.toSorted((a,b)=>a.place-b.place),[
      {playerId:winner,place:1,reason:'winner'},{playerId:loser,place:2,reason:'eliminated'},
    ])
    assert.equal(state.players.reduce((sum,p)=>sum+p.stack,0),2000)
    tickFor(f.session,20)
    assert.deepEqual(f.last('p0').state,state)
    f.session.receive('p0',{type:'next',handId:state.handId,actionId:'after-finish'})
    assert.deepEqual(f.last('p0').state,state)
    assert.equal(f.session.join('late','Late'),false)
  }
})

test('simultaneous equal-stack eliminations share a place and create exactly one tournament winner',()=>{
  const f=fixture(4,rigged({draw:'Ac Ad Kc Kd Qc Qd Jc Jd 2s 5h 8c 9d Th'}))
  start(f)
  allIn(f)
  const state=f.last('p0').state
  assert.equal(state.match.status,'FINISHED')
  assert.equal(state.match.winnerId,'p0')
  assert.deepEqual(state.match.placements.filter(p=>p.reason==='eliminated').map(p=>[p.playerId,p.place]),[['p1',2],['p2',2],['p3',2]])
  assert.deepEqual(state.match.placements.filter(p=>p.reason==='winner'),[{playerId:'p0',place:1,reason:'winner'}])
  f.session.receive('p0',{type:'snapshot'})
  assert.deepEqual(f.last('p0').state.match,state.match,'Resync never settles the same payout twice')
})

test('simultaneous unequal-stack busts place the larger starting stack higher',()=>{
  const f=fixture(3,rigged(
    {draw:'Ac Ad Kc Kd Qc Qd 2s 5h 8c 9d Jh'},
    {draw:'Kc Kd Ac Ad Qc Qd 2s 5h 8c 9d Jh'},
  ))
  start(f)
  const send=(id,actionId,action)=>f.session.receive(id,{type:'act',handId:f.last('p0').state.handId,actionId,action})
  send('p0','raise',{type:'raise',amount:500})
  send('p1','call',{type:'call'})
  send('p2','fold',{type:'fold'})
  send('p1','check',{type:'check'})
  send('p0','give-up',{type:'fold'})
  assert.deepEqual(f.last('p0').state.players.map(p=>p.stack),[500,1520,980])
  tickFor(f.session,2.61)
  tickFor(f.session,1.81)
  allIn(f)
  const state=f.last('p0').state
  assert.equal(state.match.status,'FINISHED')
  assert.equal(state.match.winnerId,'p1')
  assert.deepEqual(state.match.placements.toSorted((a,b)=>a.place-b.place),[
    {playerId:'p1',place:1,reason:'winner'},
    {playerId:'p2',place:2,reason:'eliminated'},
    {playerId:'p0',place:3,reason:'eliminated'},
  ])
  assert.equal(state.players.reduce((sum,p)=>sum+p.stack,0),3000)
})

test('Solo stops on the human loss while three bots still have chips',()=>{
  const f=fixture(1,rigged({draw:'6c 6d Ac Ad 2c 3d 4c 5d 7s 9h Tc Qd Kh'}))
  start(f,'solo')
  for(let guard=0;guard<200&&f.last('p0').state.match.status==='PLAYING';guard++) {
    const snapshot=f.last('p0')
    if(snapshot.state.actorId==='p0')f.session.receive('p0',{type:'act',handId:snapshot.state.handId,actionId:`human-${guard}`,action:{type:'allIn'}})
    else f.session.tick(.7)
  }
  const state=f.last('p0').state
  assert.equal(state.stage,'COMPLETE')
  assert.equal(state.players.find(p=>p.id==='p0').stack,0)
  assert.equal(state.players.filter(p=>p.stack>0).length,3)
  assert.equal(state.match.status,'FINISHED')
  assert.equal(state.match.winnerId,null)
  assert.deepEqual(state.match.placements,[{playerId:'p0',place:4,reason:'eliminated'}])
  tickFor(f.session,20)
  assert.deepEqual(f.last('p0').state,state)
})

test('Solo authority applies varied legal bot opens and reraises in both worlds',()=>{
  for(const {mode,draw} of [
    {mode:'NORMAL',draw:'7c 2d 8c 3d 9c 4d Ac Ad 6s Th Qd Kh Jh'},
    {mode:'MIRROR',draw:'Jc Ad Tc Kd 9c Qd 2c 2d 8s 6h 4d 3h 5h'},
  ]) {
    const f=fixture(1,rigged({mode,draw}))
    start(f,'solo')
    assert.equal(f.last('p0').state.actorId,'bot:3')
    tickFor(f.session,.71)
    const opened=f.last('p0')
    assert.equal(opened.state.actorId,'p0')
    const actions=()=>f.messages.get('p0').flatMap(message=>message.events??[])
      .filter(event=>event.type==='PLAYER_ACTED'&&event.playerId==='bot:3')
    const open=actions()[0]
    assert.equal(open.action.type,'raise')
    assert.ok(open.action.amount>=44&&open.action.amount<=70,'An unopened pot mixes legal 2.2–3.5 BB opens')
    assert.equal(opened.state.currentBet,open.action.amount)
    assert.equal(open.amount,open.action.amount,'The action event charges the actual contribution')
    f.session.receive('p0',{type:'act',handId:opened.state.handId,actionId:'challenge-open',action:{type:'raise',amount:150}})
    for(let guard=0;guard<4&&actions().length<2;guard++)tickFor(f.session,.71)
    const reraise=actions()[1]
    assert.equal(reraise?.action.type,'raise',mode)
    assert.ok(reraise.action.amount>=405&&reraise.action.amount<=570,'The premium hand mixes legal reraises around three times the faced total')
    const reraised=f.last('p0')
    assert.equal(reraised.state.currentBet,reraise.action.amount)
    assert.equal(reraise.amount,reraise.action.amount-open.action.amount,'A reraise charges only the increment after the earlier open')
    assert.equal(reraised.state.pot+reraised.state.players.reduce((sum,player)=>sum+player.stack,0),4000)
    assert.ok(reraised.state.players.every(player=>player.cards===undefined))
    assert.deepEqual(reraised.privateState.cards,draw.split(' ').slice(0,2))
    assert.ok(!f.messages.get('p0').some(message=>message.type==='error'))
  }
})

test('Solo bot varied value line charges legal contributions through the final payout',()=>{
  const f=fixture(1,rigged({draw:'Kc Kd 7c 2d 8c 3d Ac Ad Ah 5s 9d 6h Qc'}))
  start(f,'solo')
  tickFor(f.session,.71)
  const human=(action,label)=>f.session.receive('p0',{type:'act',handId:f.last('p0').state.handId,actionId:label,action})
  human({type:'call'},'call-open')
  for(let guard=0;guard<3&&f.last('p0').state.stage==='PREFLOP';guard++)tickFor(f.session,.71)
  for(const [stage,minFraction,maxFraction] of [['FLOP',.38,.8],['TURN',.5,1],['RIVER',.45,1.25]]) {
    const before=f.last('p0').state
    assert.equal(before.stage,stage)
    assert.equal(before.actorId,'bot:3')
    tickFor(f.session,.71)
    const after=f.last('p0').state
    const bot=before.players.find(player=>player.id==='bot:3')
    const acted=f.messages.get('p0').flatMap(message=>message.events??[])
      .findLast(event=>event.type==='PLAYER_ACTED'&&event.playerId==='bot:3')
    assert.ok(['bet','allIn'].includes(acted.action.type),`${stage}: the strong value hand applies pressure`)
    const amount=acted.action.type==='allIn'?bot.stack:acted.action.amount
    assert.ok(Number.isInteger(amount)&&amount>=Math.min(bot.stack,before.bigBlind)&&amount<=bot.stack,`${stage}: amount stays inside the legal stack and minimum`)
    if(acted.action.type==='bet') {
      assert.ok(amount>=Math.min(bot.stack,Math.max(before.bigBlind,Math.round(before.pot*minFraction))),`${stage}: value sizing respects its street's lower range`)
      assert.ok(amount<=Math.max(before.bigBlind,Math.round(before.pot*maxFraction)),`${stage}: value sizing respects its street's upper range`)
    }
    assert.equal(acted.amount,amount)
    assert.equal(after.actorId,'p0')
    assert.equal(after.currentBet,amount)
    assert.equal(after.pot+after.players.reduce((sum,player)=>sum+player.stack,0),4000)
    human({type:'call'},`call-${stage}`)
    if(f.last('p0').state.stage==='COMPLETE') break
  }
  const paid=f.last('p0').state
  assert.equal(paid.stage,'COMPLETE')
  assert.equal(paid.winners[0].playerId,'bot:3')
  assert.equal(paid.players.reduce((sum,player)=>sum+player.stack,0),4000)
  assert.ok(!f.messages.get('p0').some(message=>message.type==='error'))
})

test('Solo human victory receives first place after real bot decisions and payouts',()=>{
  const f=fixture(1,rigged({draw:'Ac Ad Kc Kd Qc Qd Jc Jd 2s 5h 8c 9d Th'}))
  start(f,'solo')
  for(let guard=0;guard<200&&f.last('p0').state.match.status==='PLAYING';guard++) {
    const snapshot=f.last('p0')
    if(snapshot.state.actorId==='p0')f.session.receive('p0',{type:'act',handId:snapshot.state.handId,actionId:`human-${guard}`,action:{type:'allIn'}})
    else f.session.tick(.7)
  }
  const state=f.last('p0').state
  assert.equal(state.match.status,'FINISHED')
  assert.equal(state.match.winnerId,'p0')
  assert.equal(state.players.find(p=>p.id==='p0').stack,4000)
  assert.deepEqual(state.match.placements.find(p=>p.playerId==='p0'),{playerId:'p0',place:1,reason:'winner'})
})

test('a COMPLETE leave/rejoin restores the exact paid balance without manufacturing a rebuy',()=>{
  const f=fixture(3)
  start(f)
  passive(f)
  const paid=f.last('p0').state
  assert.equal(paid.stage,'COMPLETE')
  const balance=paid.players.find(p=>p.id==='p1').stack
  assert.notEqual(balance,1000,'The regression must distinguish restored chips from a fresh buy-in')
  f.session.leave('p1')
  assert.equal(f.session.join('p1','Reconnected'),true)
  const rejoined=f.last('p1').state
  assert.equal(rejoined.handId,paid.handId)
  assert.equal(rejoined.players.find(p=>p.id==='p1').stack,balance)
  assert.equal(rejoined.players.reduce((sum,p)=>sum+p.stack,0),3000)
  tickFor(f.session,2.61)
  assert.equal(f.last('p1').state.stage,'INTERMISSION')
  assert.equal(f.last('p1').state.players.reduce((sum,p)=>sum+p.stack,0),3000)
})

test('the existing Solo player can reconnect during the current hand while new visitors remain rejected',()=>{
  const f=fixture(1)
  start(f,'solo')
  const initial=f.last('p0')
  assert.notEqual(initial.state.actorId,'p0')
  f.session.leave('p0')
  assert.equal(f.session.join('intruder','Visitor'),false)
  assert.ok(f.messages.get('intruder').some(message=>message.type==='error'&&message.code==='ROOM_FULL'))
  assert.equal(f.session.join('p0','Reconnected'),true)
  const restored=f.last('p0')
  assert.equal(restored.state.handId,initial.state.handId)
  assert.equal(restored.state.players.filter(p=>p.isBot).length,3)
  assert.equal(restored.state.players.find(p=>p.id==='p0').connected,true)
  assert.deepEqual(restored.privateState.cards,initial.privateState.cards)
  assert.equal(restored.state.players.reduce((sum,p)=>sum+p.stack,restored.state.pot),4000)
})

test('a disconnected all-in loser retains fourth place and a zero balance after reconnecting',()=>{
  const f=fixture(4,rng(1))
  start(f)
  const send=(id,actionId,action)=>f.session.receive(id,{type:'act',handId:f.last('p0').state.handId,actionId,action})
  assert.equal(f.last('p0').state.actorId,'p3')
  send('p3','departed-all-in',{type:'allIn'})
  f.session.leave('p3')
  send('p0','cover-all-in',{type:'allIn'})
  send('p1','fold-small',{type:'fold'})
  send('p2','fold-big',{type:'fold'})
  const paid=f.last('p0').state
  assert.equal(paid.stage,'COMPLETE')
  assert.equal(paid.match.status,'PLAYING')
  assert.ok(paid.players.every(p=>p.id!=='p3'))
  assert.deepEqual(paid.match.placements.find(p=>p.playerId==='p3'),{playerId:'p3',place:4,reason:'eliminated'})
  assert.equal(f.session.join('p3','Reconnected'),true)
  const restored=f.last('p3').state
  assert.equal(restored.players.find(p=>p.id==='p3').stack,0)
  assert.deepEqual(restored.match.placements.find(p=>p.playerId==='p3'),{playerId:'p3',place:4,reason:'eliminated'})
  assert.equal(restored.players.reduce((sum,p)=>sum+p.stack,0),4000)
  tickFor(f.session,2.61)
  tickFor(f.session,1.81)
  assert.equal(f.last('p3').state.handId,'hand-2')
  assert.equal(f.last('p3').state.players.find(p=>p.id==='p3').sittingOut,true)
  assert.deepEqual(f.last('p3').privateState.cards,[])
  assert.deepEqual(f.last('p3').privateState.legalActions,[])
})

test('known winner and loser reconnect to a FINISHED table with their result and balances intact',()=>{
  const f=fixture(2,rigged({draw:'Ac Ad 2c 2d 6s 8h Tc Qd Kh'}))
  start(f)
  allIn(f)
  const final=f.last('p0').state
  assert.equal(final.match.status,'FINISHED')
  assert.equal(final.match.winnerId,'p0')
  for(const id of ['p0','p1']) {
    const balance=final.players.find(p=>p.id===id).stack
    f.session.leave(id)
    assert.equal(f.session.join(id,'Reconnected'),true)
    const restored=f.last(id).state
    assert.equal(restored.handId,final.handId)
    assert.deepEqual(restored.match,final.match)
    assert.equal(restored.players.find(p=>p.id===id).stack,balance)
    assert.equal(restored.players.reduce((sum,p)=>sum+p.stack,0),2000)
  }
  assert.equal(f.session.join('visitor','Visitor'),false)
  tickFor(f.session,10)
  assert.equal(f.last('p0').state.handId,final.handId)
  assert.deepEqual(f.last('p0').state.match,final.match)
})

test('a disconnected heads-up all-in winner keeps first place and the paid stack when reconnecting',()=>{
  const f=fixture(2,rng(3))
  start(f)
  const handId=f.last('p0').state.handId
  assert.equal(f.last('p0').state.actorId,'p0')
  f.session.receive('p0',{type:'act',handId,actionId:'winner-all-in',action:{type:'allIn'}})
  f.session.leave('p0')
  f.session.receive('p1',{type:'act',handId,actionId:'loser-all-in',action:{type:'allIn'}})
  const paid=f.last('p1').state
  assert.equal(paid.stage,'COMPLETE')
  assert.ok(paid.players.every(p=>p.id!=='p0'))
  assert.equal(paid.winners.find(w=>w.playerId==='p0').amount,2000)
  assert.equal(paid.match.status,'FINISHED')
  assert.equal(paid.match.winnerId,'p0')
  assert.equal(paid.previousHand.winners.find(w=>w.playerId==='p0').playerName,'Player 0')
  assert.equal(paid.previousHand.winners.find(w=>w.playerId==='p0').cards.length,5)
  assert.deepEqual(paid.match.placements.find(p=>p.playerId==='p0'),{playerId:'p0',place:1,reason:'winner'})
  assert.deepEqual(paid.match.placements.find(p=>p.playerId==='p1'),{playerId:'p1',place:2,reason:'eliminated'})
  assert.equal(f.session.join('p0','Reconnected winner'),true)
  const restored=f.last('p0').state
  assert.equal(restored.players.find(p=>p.id==='p0').stack,2000)
  assert.equal(restored.players.reduce((sum,p)=>sum+p.stack,0),2000)
  assert.deepEqual(restored.match,paid.match)
  assert.deepEqual(restored.previousHand,paid.previousHand,'A disconnected winner keeps the name captured at the start of the hand')
  tickFor(f.session,10)
  assert.equal(f.last('p0').state.handId,handId)
  assert.deepEqual(f.last('p0').state.match,paid.match)
})

test('the last showdown exposes only the winning best five with the winner name and completed mode',()=>{
  for(const mode of ['NORMAL','MIRROR']) {
    const f=fixture(2,rigged({mode,draw:'Ac Ad Kc Kd 2s 5h 8c 9d Jh'}))
    start(f)
    assert.equal(f.last('p0').state.previousHand,undefined)
    assert.ok(f.last('p0').state.players.every(player=>!player.cards))
    passive(f)
    const result=f.last('p0').state.previousHand
    assert.equal(result.handId,'hand-1')
    assert.equal(result.worldMode,mode)
    assert.equal(result.winners.length,1)
    const winner=result.winners[0],winnerId=mode==='NORMAL'?'p0':'p1'
    assert.equal(winner.playerId,winnerId)
    assert.equal(winner.playerName,mode==='NORMAL'?'Player 0':'Player 1')
    assert.equal(winner.handName,'PAIR')
    assert.equal(winner.amount,40)
    assert.equal(winner.cards.length,5)
    assert.equal(new Set(winner.cards).size,5)
    assert.deepEqual(winner.cards.toSorted(),(mode==='NORMAL'?['Ac','Ad','Jh','9d','8c']:['Kc','Kd','2s','5h','8c']).toSorted())
    assert.deepEqual(result,f.last('p1').state.previousHand)
  }
})

test('the latest result persists through intermission, a different-mode deal, resync and reconnect, then is replaced',()=>{
  const f=fixture(3,rigged(
    {mode:'NORMAL',draw:'Ac Ad Kc Kd Qc Qd 2s 5h 8c 9d Jh'},
    {mode:'MIRROR',draw:'Ac Ad Kc Kd Qc Qd 2s 5h 8c 9d Jh'},
  ))
  start(f)
  passive(f)
  const first=structuredClone(f.last('p0').state.previousHand)
  assert.equal(first.handId,'hand-1')
  assert.equal(first.winners[0].playerId,'p0')
  tickFor(f.session,2.61)
  assert.equal(f.last('p0').state.stage,'INTERMISSION')
  assert.equal(f.last('p0').state.worldMode,'MIRROR')
  assert.deepEqual(f.last('p0').state.previousHand,first)
  assert.equal(f.last('p0').state.previousHand.worldMode,'NORMAL')
  tickFor(f.session,1.81)
  assert.equal(f.last('p0').state.handId,'hand-2')
  assert.ok(f.last('p0').state.players.every(player=>!player.cards))
  assert.deepEqual(f.last('p0').state.previousHand,first)
  f.session.receive('p0',{type:'snapshot'})
  assert.equal(f.last('p0').events,undefined)
  assert.deepEqual(f.last('p0').state.previousHand,first)
  assert.notEqual(f.last('p0').state.actorId,'p0')
  f.session.leave('p0')
  assert.equal(f.session.join('p0','Reconnected'),true)
  assert.deepEqual(f.last('p0').state.previousHand,first)
  passive(f)
  const latest=f.last('p0').state.previousHand
  assert.equal(latest.handId,'hand-2')
  assert.equal(latest.worldMode,'MIRROR')
  assert.equal(latest.winners[0].playerId,'p2')
  assert.equal(latest.winners[0].playerName,'Player 2')
  assert.notDeepEqual(latest,first)
  assert.deepEqual(Object.keys(latest).toSorted(),['handId','worldMode','winners'].toSorted())
  assert.equal(Array.isArray(latest),false,'Keep one latest result rather than a growing history')
  f.session.receive('p0',{type:'snapshot'})
  assert.deepEqual(f.last('p0').state.previousHand,latest)
})

test('an uncontested result never exposes hidden hole cards while surviving the next deal',()=>{
  const f=fixture(2,rigged(
    {mode:'NORMAL',draw:'Ac Ad Kc Kd 2s 5h 8c 9d Jh'},
    {mode:'MIRROR',draw:'Ac Ad Kc Kd 2s 5h 8c 9d Jh'},
  ))
  start(f)
  const active=f.last('p0').state
  f.session.receive(active.actorId,{type:'act',handId:active.handId,actionId:'uncontested-fold',action:{type:'fold'}})
  const paid=f.last('p0').state,result=structuredClone(paid.previousHand)
  assert.equal(paid.stage,'COMPLETE')
  assert.ok(paid.players.every(player=>!player.cards))
  assert.equal(result.winners.length,1)
  assert.equal(result.winners[0].handName,'UNCONTESTED')
  assert.equal(result.winners[0].cards,undefined)
  assert.equal('cards' in result.winners[0],false)
  assert.equal(result.winners[0].playerName,'Player 1')
  for(const id of ['p0','p1']) {
    f.session.receive(id,{type:'snapshot'})
    assert.deepEqual(f.last(id).state.previousHand,result)
    assert.equal(f.last(id).events,undefined)
  }
  tickFor(f.session,2.61)
  tickFor(f.session,1.81)
  assert.equal(f.last('p0').state.handId,'hand-2')
  assert.deepEqual(f.last('p0').state.previousHand,result)
  assert.ok(f.last('p0').state.players.every(player=>!player.cards))
})

test('uncontested preflop/flop/turn snapshots stop the board and preserve a private previousHand without showdown events',()=>{
  for(const mode of ['NORMAL','MIRROR'])for(const stage of ['PREFLOP','FLOP','TURN']){
    const f=fixture(3,()=>mode==='NORMAL'?.25:.75)
    start(f)
    for(let guard=0;f.last('p0').state.stage!==stage&&guard<30;guard++){
      const state=f.last('p0').state,legal=f.last(state.actorId).privateState.legalActions
      f.session.receive(state.actorId,{type:'act',handId:state.handId,actionId:`reach-${stage}-${guard}`,action:{type:legal.some(a=>a.type==='check')?'check':'call'}})
    }
    const before=f.last('p0').state,messageCount=f.messages.get('p0').length
    assert.equal(before.stage,stage)
    const send=(actionId,action)=>{
      const state=f.last('p0').state
      f.session.receive(state.actorId,{type:'act',handId:state.handId,actionId,action})
    }
    if(stage==='PREFLOP')send('unmatched-raise',{type:'raise',amount:200})
    else{send('opening-bet',{type:'bet',amount:40});send('unmatched-raise',{type:'raise',amount:200})}
    for(let guard=0;f.last('p0').state.stage!=='COMPLETE'&&guard<4;guard++)send(`fold-${guard}`,{type:'fold'})
    const paid=f.last('p0').state,result=structuredClone(paid.previousHand)
    assert.equal(paid.stage,'COMPLETE')
    assert.deepEqual(paid.board,before.board)
    assert.equal(paid.players.reduce((sum,player)=>sum+player.stack,0),3000)
    assert.ok(paid.players.every(player=>!player.cards))
    assert.equal(result.worldMode,mode)
    assert.equal(result.winners.length,1)
    assert.equal(result.winners[0].handName,'UNCONTESTED')
    assert.equal(result.winners[0].cards,undefined)
    const updates=f.messages.get('p0').slice(messageCount).filter(message=>message.type==='snapshot')
    assert.ok(updates.every(message=>JSON.stringify(message.state.board)===JSON.stringify(before.board)))
    const events=updates.flatMap(message=>message.events??[])
    assert.equal(events.filter(event=>event.type==='STREET_CHANGED'||event.type==='SHOWDOWN').length,0)
    assert.equal(events.at(-1).type,'PAYOUT')
    f.session.receive('p0',{type:'snapshot'})
    assert.deepEqual(f.last('p0').state.previousHand,result)
    assert.equal(f.last('p0').events,undefined)
  }
})

test('an all-in final snapshot still carries every missing street and a real showdown for two eligible hands',()=>{
  for(const mode of ['NORMAL','MIRROR'])for(const stage of ['PREFLOP','FLOP','TURN']){
    const f=fixture(3,()=>mode==='NORMAL'?.25:.75)
    start(f)
    for(let guard=0;f.last('p0').state.stage!==stage&&guard<30;guard++){
      const state=f.last('p0').state,legal=f.last(state.actorId).privateState.legalActions
      f.session.receive(state.actorId,{type:'act',handId:state.handId,actionId:`reach-${stage}-${guard}`,action:{type:legal.some(a=>a.type==='check')?'check':'call'}})
    }
    const before=f.last('p0').state
    const send=(actionId,action)=>{
      const state=f.last('p0').state
      f.session.receive(state.actorId,{type:'act',handId:state.handId,actionId,action})
    }
    send('first-allin',{type:'allIn'});send('one-fold',{type:'fold'});send('called-allin',{type:'allIn'})
    const final=f.last('p0'),events=final.events
    assert.equal(final.state.stage,'COMPLETE')
    assert.equal(final.state.board.length,5)
    assert.deepEqual(final.state.board.slice(0,before.board.length),before.board)
    assert.deepEqual(events.filter(event=>event.type==='STREET_CHANGED').map(event=>event.board.length),[3,4,5].filter(length=>length>before.board.length))
    assert.equal(events.filter(event=>event.type==='SHOWDOWN').length,1)
    assert.equal(events.at(-1).type,'PAYOUT')
    assert.equal(final.state.players.filter(player=>player.cards?.length===2).length,2)
    assert.ok(final.state.players.filter(player=>player.folded).every(player=>!player.cards))
    assert.ok(final.state.previousHand.winners.every(winner=>winner.cards?.length===5&&winner.handName!=='UNCONTESTED'))
    assert.equal(final.state.previousHand.worldMode,mode)
    assert.equal(final.state.players.reduce((sum,player)=>sum+player.stack,0),3000)
  }
})

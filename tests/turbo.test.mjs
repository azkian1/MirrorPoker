import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root=resolve(import.meta.dirname,'..')
mkdirSync(resolve(root,'.test-output'),{recursive:true})
const result=spawnEsbuild(['tests/session-entry.ts','--bundle','--platform=node','--format=esm','--outfile=.test-output/turbo-session-bundle.mjs'],{cwd:root,encoding:'utf8'})
assert.equal(result.status,0,result.stderr)
const {PokerSession,StateReceiver}=await import('../.test-output/turbo-session-bundle.mjs')

function fixture(count=2) {
  const messages=new Map()
  const session=new PokerSession({send(id,message){
    const log=messages.get(id)??[]
    log.push(structuredClone(message));messages.set(id,log)
  }},()=>.25)
  const last=(id='p0')=>messages.get(id)?.findLast(message=>message.type==='snapshot')
  for(let i=0;i<count;i++)session.join(`p${i}`,`Player ${i}`)
  return {session,messages,last,elapsedMs:0,serial:0}
}
function snapshot(f,id='p0') {
  f.session.receive(id,{type:'snapshot'})
  return f.last(id)
}
function tickMs(f,ms) {
  for(let remaining=ms;remaining>1e-6;) {
    const delta=Math.min(1000,remaining)
    f.session.tick(delta/1000);remaining-=delta;f.elapsedMs+=delta
  }
}
function start(f) {
  f.session.receive('p0',{type:'start',mode:'multiplayer',actionId:'start'})
  assert.equal(f.last().state.stage,'INTERMISSION')
  assert.ok(f.last().state.players.every(player=>player.stack===1000))
  tickMs(f,1800)
  assert.equal(f.last().state.stage,'PREFLOP')
  assert.equal(f.last().state.pot,30,'Only the 10/20 blinds are forced; there are no antes')
  assert.equal(f.last().state.turnTimer.remainingMs,30000,'The first decision starts with its entire allowance')
}
function act(f,action,actionId=`manual-${++f.serial}`) {
  const state=f.last().state
  const command={type:'act',handId:state.handId,actionId,action}
  f.session.receive(state.actorId,command)
  return command
}
function passiveAction(f) {
  const state=f.last().state
  const legal=f.last(state.actorId).privateState.legalActions
  const choice=legal.find(action=>action.type==='check')??legal.find(action=>action.type==='call')
  assert.ok(choice)
  return act(f,{type:choice.type})
}
function decisionFor(f,id) {
  for(let guard=0;guard<100;guard++) {
    const state=f.last().state
    if(state.stage==='COMPLETE') {tickMs(f,2600);tickMs(f,1800)}
    else if(state.stage==='INTERMISSION')tickMs(f,1800)
    else if(state.actorId===id)return snapshot(f).state
    else passiveAction(f)
  }
  assert.fail(`No decision reached for ${id}`)
}
const chips=state=>state.pot+state.players.reduce((sum,player)=>sum+player.stack,0)

test('human decisions expire at 30 seconds, warn at 5 remaining, and fold even with a free check',()=>{
  const f=fixture()
  start(f)
  const first=f.last().state.turnTimer
  act(f,{type:'call'})
  const before=f.last().state
  assert.equal(before.actorId,'p1')
  assert.ok(f.last('p1').privateState.legalActions.some(action=>action.type==='check'))
  assert.notEqual(before.turnTimer.turnId,first.turnId)
  assert.equal(before.turnTimer.remainingMs,30000)
  tickMs(f,24999)
  assert.equal(snapshot(f).state.turnTimer.remainingMs,5001)
  const priorMessages=f.messages.get('p0').length
  tickMs(f,1)
  const warning=f.last()
  assert.equal(f.messages.get('p0').length,priorMessages+1,'Crossing the warning threshold immediately broadcasts the timer')
  assert.equal(warning.state.turnTimer.remainingMs,5000)
  assert.equal(warning.state.seq,before.seq,'Timer-only updates do not create gameplay events')
  assert.equal(warning.events,undefined)
  tickMs(f,4999)
  const pending=snapshot(f).state
  assert.equal(pending.stage,'PREFLOP')
  assert.equal(pending.actorId,'p1')
  assert.equal(pending.turnTimer.remainingMs,1)
  tickMs(f,1)
  const paid=f.last()
  assert.equal(paid.state.stage,'COMPLETE')
  assert.equal(paid.state.turnTimer,undefined)
  assert.equal(paid.state.players.find(player=>player.id==='p1').folded,true)
  assert.equal(paid.state.winners[0].playerId,'p0')
  assert.deepEqual(paid.events.find(event=>event.type==='PLAYER_ACTED').action,{type:'fold'})
  assert.equal(chips(paid.state),2000)
})

test('two consecutive expiries shorten only that human to 10 seconds until an accepted action restores 30',()=>{
  const f=fixture(3)
  start(f)
  for(const [opportunity,duration] of [[1,30000],[2,30000],[3,10000],[4,10000]]) {
    const state=decisionFor(f,'p0')
    assert.equal(state.turnTimer.durationMs,duration,`Allowance for opportunity ${opportunity}`)
    assert.equal(state.turnTimer.remainingMs,duration)
    tickMs(f,duration-1)
    assert.equal(snapshot(f).state.actorId,'p0')
    assert.equal(f.last().state.turnTimer.remainingMs,1)
    tickMs(f,1)
    assert.equal(f.last().state.players.find(player=>player.id==='p0').folded,true)
    if(opportunity===2) {
      f.session.leave('p0')
      assert.equal(f.session.join('p0','Reconnected'),true,'Reconnect between decisions preserves inactivity history')
    }
    assert.equal(chips(f.last().state),3000)
  }
  const short=decisionFor(f,'p0')
  assert.equal(short.turnTimer.durationMs,10000)
  tickMs(f,7000)
  passiveAction(f)
  const restored=decisionFor(f,'p0')
  assert.equal(restored.turnTimer.durationMs,30000)
  assert.equal(restored.turnTimer.remainingMs,30000)
  assert.notEqual(restored.turnTimer.turnId,short.turnTimer.turnId)
  assert.equal(chips(restored),3000)
  assert.ok(f.messages.get('p1').filter(message=>message.state?.turnTimer?.playerId==='p1')
    .every(message=>message.state.turnTimer.durationMs===30000),'Other active players retain 30 seconds')
})

test('new decisions reset immediately even for the same actor on the next street, while rejected and replayed input cannot reset time',()=>{
  const f=fixture()
  start(f)
  act(f,{type:'call'})
  tickMs(f,18000)
  const prior=snapshot(f).state
  assert.equal(prior.actorId,'p1')
  assert.equal(prior.turnTimer.remainingMs,12000)
  const accepted=act(f,{type:'check'},'check-to-flop')
  const flop=f.last().state
  assert.equal(flop.stage,'FLOP')
  assert.equal(flop.actorId,prior.actorId)
  assert.equal(flop.turnTimer.remainingMs,30000)
  assert.notEqual(flop.turnTimer.turnId,prior.turnTimer.turnId)
  tickMs(f,7000)
  const elapsed=snapshot(f).state.turnTimer
  assert.equal(elapsed.remainingMs,23000)
  const unchanged=()=>assert.deepEqual(snapshot(f).state.turnTimer,elapsed)
  f.session.receive('p1',{...accepted,actionId:'below-minimum',action:{type:'bet',amount:0}})
  assert.equal(f.messages.get('p1').at(-2).type,'error')
  unchanged()
  f.session.receive('p1',{...accepted,actionId:'stale-hand',handId:'hand-0'})
  unchanged()
  f.session.receive('p0',{...accepted,actionId:'out-of-turn',handId:flop.handId})
  unchanged()
  f.session.receive('p1',accepted)
  unchanged()
  f.session.receive('p1',{type:'ping',nonce:'same-decision'})
  unchanged()
  f.session.receive('p1',{type:'hello',version:1})
  unchanged()
  assert.equal(f.session.join('p1','Same connected player'),true)
  unchanged()
  f.session.leave('p0')
  assert.equal(f.session.join('p0','Reconnected'),true)
  unchanged()
  tickMs(f,22999)
  assert.equal(snapshot(f).state.turnTimer.remainingMs,1)
  tickMs(f,1)
  assert.equal(f.last().state.stage,'COMPLETE')
  assert.equal(f.last().state.players.find(player=>player.id==='p1').folded,true)
})

test('equal-sequence clock snapshots update the receiver while repeated animation events stay deduplicated',()=>{
  const f=fixture()
  const rendered=[],events=[]
  const receiver=new StateReceiver({snapshot(state){rendered.push(structuredClone(state))},event(event){events.push(event.eventId)},error(message){assert.fail(message)}})
  receiver.receive(f.last())
  start(f)
  const initial=f.last()
  receiver.receive(initial)
  assert.ok(events.length>0)
  const eventCount=events.length
  tickMs(f,1000)
  const clock=f.last()
  assert.equal(clock.state.seq,initial.state.seq)
  assert.equal(clock.state.turnTimer.turnId,initial.state.turnTimer.turnId)
  assert.equal(clock.state.turnTimer.remainingMs,29000)
  assert.equal(clock.events,undefined)
  receiver.receive(clock)
  assert.equal(rendered.at(-1).turnTimer.remainingMs,29000)
  assert.equal(events.length,eventCount)
  receiver.receive({...clock,events:initial.events})
  assert.equal(events.length,eventCount)
  tickMs(f,1000)
  receiver.receive(f.last())
  assert.equal(rendered.at(-1).turnTimer.remainingMs,28000)
  assert.equal(events.length,eventCount)
  passiveAction(f)
  receiver.receive(f.last())
  assert.equal(events.length,eventCount+1,'A real accepted action still delivers its fresh animation')
  assert.equal(new Set(events).size,events.length)
})

test('three-minute blind boundaries leave the running hand intact and apply the new level only at the next deal',()=>{
  const f=fixture(3)
  start(f)
  let state=f.last().state
  assert.deepEqual([state.smallBlind,state.bigBlind,state.minRaise],[10,20,20])
  assert.deepEqual(state.tournament,{level:1,levelDurationMs:180000,remainingMs:178200,nextSmallBlind:15,nextBigBlind:30})
  // Six decisions reach the turn at 2:55.8; the boundary arrives well before timeout.
  for(let decision=0;decision<6;decision++) {
    tickMs(f,29000)
    passiveAction(f)
  }
  tickMs(f,180000-f.elapsedMs-1)
  state=snapshot(f).state
  assert.equal(state.stage,'TURN')
  assert.equal(state.tournament.remainingMs,1)
  assert.equal(state.turnTimer.remainingMs,25801)
  const actor=state.actorId,turnId=state.turnTimer.turnId
  tickMs(f,1)
  state=snapshot(f).state
  assert.equal(state.actorId,actor)
  assert.equal(state.turnTimer.turnId,turnId)
  assert.equal(state.turnTimer.remainingMs,25800,'A blind boundary cannot reset or expire the active human decision')
  assert.deepEqual([state.smallBlind,state.bigBlind,state.minRaise],[10,20,20])
  assert.equal(state.tournament.level,1)
  assert.equal(state.tournament.remainingMs,0)
  assert.equal(chips(state),3000)
  for(let guard=0;f.last().state.stage!=='COMPLETE'&&guard<10;guard++)passiveAction(f)
  assert.equal(f.last().state.stage,'COMPLETE')
  assert.equal(f.last().state.bigBlind,20)
  tickMs(f,2600)
  assert.equal(f.last().state.stage,'INTERMISSION')
  assert.equal(f.last().state.bigBlind,20)
  tickMs(f,1799)
  assert.equal(snapshot(f).state.stage,'INTERMISSION')
  tickMs(f,1)
  state=f.last().state
  assert.equal(state.handId,'hand-2')
  assert.equal(state.stage,'PREFLOP')
  assert.deepEqual([state.smallBlind,state.bigBlind,state.currentBet,state.minRaise],[15,30,30,30])
  assert.equal(state.tournament.level,2)
  assert.deepEqual([state.tournament.nextSmallBlind,state.tournament.nextBigBlind],[25,50])
  assert.deepEqual(state.players.map(player=>player.bet).filter(Boolean).sort((a,b)=>a-b),[15,30])
  assert.equal(state.pot,45)
  assert.equal(f.last(state.actorId).privateState.legalActions.find(action=>action.type==='raise').min,60)
  assert.equal(state.turnTimer.remainingMs,30000)
  assert.equal(chips(state),3000)
})

test('the next deal skips overdue three-minute levels and the final blind level remains capped',()=>{
  for(const [elapsedMs,level,blinds,next] of [
    [3*180000+12000,4,[50,100],[75,150]],
    [13*180000+12000,14,[2000,4000],[null,null]],
    [30*180000+12000,14,[2000,4000],[null,null]],
  ]) {
    const f=fixture(3)
    start(f)
    const handId=f.last().state.handId
    // Set the authority's match clock directly to isolate multi-boundary scheduling
    // from human timeouts and betting; tick(dt) deliberately caps each clock step.
    f.session.tournamentClockMs=elapsedMs
    const waiting=snapshot(f).state
    assert.equal(waiting.handId,handId)
    assert.deepEqual([waiting.smallBlind,waiting.bigBlind],[10,20])
    assert.equal(waiting.tournament.level,1)
    assert.equal(waiting.tournament.remainingMs,0)
    assert.deepEqual([waiting.tournament.nextSmallBlind,waiting.tournament.nextBigBlind],blinds)
    for(let guard=0;f.last().state.stage!=='COMPLETE'&&guard<20;guard++)passiveAction(f)
    assert.equal(f.last().state.stage,'COMPLETE')
    tickMs(f,2600)
    assert.equal(f.last().state.stage,'INTERMISSION')
    assert.equal(f.last().state.tournament.level,1)
    tickMs(f,1800)
    const dealt=f.last().state
    assert.equal(dealt.handId,'hand-2')
    assert.equal(dealt.tournament.level,level)
    assert.deepEqual([dealt.smallBlind,dealt.bigBlind],blinds)
    assert.deepEqual([dealt.tournament.nextSmallBlind,dealt.tournament.nextBigBlind],next)
    assert.equal(dealt.tournament.levelDurationMs,180000)
    assert.equal(dealt.tournament.remainingMs,level===14?0:180000-16400)
    assert.equal(chips(dealt),3000)
  }
})

test('a replay session starts fresh stacks and the first three-minute level without inheriting the prior match clock',()=>{
  const previous=fixture(3)
  start(previous)
  previous.session.tournamentClockMs=3*180000
  for(let guard=0;previous.last().state.stage!=='COMPLETE'&&guard<20;guard++)passiveAction(previous)
  tickMs(previous,2600)
  tickMs(previous,1800)
  const advanced=snapshot(previous).state
  assert.equal(advanced.tournament.level,4)
  assert.deepEqual([advanced.smallBlind,advanced.bigBlind],[50,100])

  // Replay creates a new authority session; an ended/live table cannot be restarted in place.
  const replay=fixture(3)
  replay.session.receive('p0',{type:'start',mode:'multiplayer',actionId:'replay-start'})
  const ready=replay.last().state
  assert.equal(ready.stage,'INTERMISSION')
  assert.ok(ready.players.every(player=>player.stack===1000))
  assert.deepEqual(ready.tournament,{level:1,levelDurationMs:180000,remainingMs:180000,nextSmallBlind:15,nextBigBlind:30})
  tickMs(replay,1800)
  const dealt=replay.last().state
  assert.equal(dealt.handId,'hand-1')
  assert.deepEqual([dealt.smallBlind,dealt.bigBlind],[10,20])
  assert.equal(dealt.tournament.remainingMs,178200)
  assert.equal(chips(dealt),3000)
  assert.equal(snapshot(previous).state.tournament.level,4,'A separate replay cannot mutate its previous table')
})

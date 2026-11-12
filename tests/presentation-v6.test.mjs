import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// Real pinned Three transforms + the production snapshot/event receiver; Canvas is a drawing stub.
const root=resolve(import.meta.dirname,'..')
mkdirSync(resolve(root,'.test-output'),{recursive:true})
const built=spawnEsbuild([
  'tests/presentation-v6-entry.ts','--bundle','--platform=node','--format=esm','--outfile=.test-output/presentation-v6-bundle.mjs',
],{cwd:root,encoding:'utf8'})
assert.equal(built.status,0,built.stderr)
const {THREE,createPieces,StateReceiver,ANCHORS,CARD_REST}=await import('../.test-output/presentation-v6-bundle.mjs')
globalThis.document={createElement(name){
  assert.equal(name,'canvas')
  const context=new Proxy({},{get(target,key){return key in target?target[key]:()=>{}}})
  return{width:0,height:0,getContext(){return context}}
}}
const holeCards=[['Ac','Ad'],['Kc','Kd'],['Qc','Qd'],['Jc','Jd']]
const board=['2s','5h','8c','9d','Th']
const players=()=>holeCards.map((_,seat)=>({id:`p${seat}`,name:`P${seat}`,seat,stack:1000,bet:0,totalBet:0,folded:false,allIn:false,connected:true,isBot:seat!==0,sittingOut:false}))
function state(overrides={}){
  return{handId:'hand-1',seq:10,stage:'PREFLOP',worldMode:'NORMAL',players:players(),board:[],pot:0,actorId:'p0',dealerSeat:0,smallBlind:10,bigBlind:20,currentBet:0,minRaise:20,winners:[],...overrides}
}
function finalState(overrides={}){
  return state({seq:30,stage:'COMPLETE',actorId:null,board:[...board],players:players().map((player,index)=>({...player,stack:index===1?4000:0,cards:[...holeCards[index]]})),winners:[{playerId:'p1',amount:4000,handName:'PAIR',cards:['Kc','Kd','Th','9d','8c']}],...overrides})
}
const personal=(handId='hand-1')=>({handId,playerId:'p0',cards:['Ac','Ad'],legalActions:[]})
const event=(seq,type,fields={})=>({handId:'hand-1',eventId:`event-${seq}`,seq,type,...fields})
function runoutEvents(){return[
  event(11,'CARDS_DEALT'),event(12,'STREET_CHANGED',{board:board.slice(0,3)}),event(13,'STREET_CHANGED',{board:board.slice(0,4)}),event(14,'STREET_CHANGED',{board:[...board]}),event(15,'SHOWDOWN',{board:[...board]}),event(16,'PAYOUT'),
]}
function fixture(){
  const scene=new THREE.Scene(),pieces=createPieces(scene)
  const receiver=new StateReceiver({snapshot(s,p){pieces.apply(s,p)},event(e){pieces.event(e)},error(message){assert.fail(message)}})
  const apply=(s,events,privateState=personal(s.handId))=>receiver.receive({type:'snapshot',state:s,privateState,...(events?{events}:{})})
  const get=name=>scene.getObjectByName(name)
  return{scene,pieces,receiver,apply,get,close(){pieces.dispose();assert.equal(scene.children.length,0)}}
}
function advance(f,steps){for(let i=0;i<steps;i++)f.pieces.update(.1)}
function finalPose(f){
  for(let seat=0;seat<4;seat++)for(let card=0;card<2;card++){
    const group=f.get(`HoleCard-${seat}-${card}`)
    assert.equal(group.visible,true)
    const at=ANCHORS.seats[seat]
    assert.ok(group.position.distanceTo(new THREE.Vector3(at[0]+(card===0?-.17:.17),CARD_REST.centerY+card*CARD_REST.overlapStep,at[2]))<1e-7)
    assert.equal(group.rotation.z,0)
  }
  for(let i=0;i<5;i++){
    const group=f.get(`BoardCard-${i}`)
    assert.equal(group.visible,true)
    const at=ANCHORS.board[i]
    assert.ok(group.position.distanceTo(new THREE.Vector3(at[0],CARD_REST.centerY,at[2]))<1e-7)
    assert.equal(group.rotation.z,0)
  }
}

test('instant all-in snapshot plus all streets/showdown stays unsettled through every dealt card and flip',()=>{
  const f=fixture()
  try{
    f.apply(state())
    f.apply(finalState(),runoutEvents())
    assert.equal(f.pieces.cardsSettled(),false)
    f.pieces.update(0)
    const lastHole=f.get('HoleCard-3-1'),lastBoard=f.get('BoardCard-4')
    const deck=new THREE.Vector3(...ANCHORS.deck).add(new THREE.Vector3(0,.12,0))
    assert.ok(lastHole.position.distanceTo(deck)<1e-7,'SHOWDOWN preserves the original hole-card flight from the deck')
    assert.ok(lastBoard.position.distanceTo(deck)<1e-7)
    advance(f,8)
    assert.equal(lastBoard.rotation.z,0,'All five board-card flights have finished first')
    assert.equal(f.pieces.cardsSettled(),false,'The final delayed hole card is still completing its flight')
    advance(f,2)
    assert.equal(f.pieces.cardsSettled(),true)
    finalPose(f)
  }finally{f.close()}
})

test('same-hand resync and duplicate snapshots preserve live positions, flips and remaining duration',()=>{
  const f=fixture()
  try{
    f.apply(state());const final=finalState();const events=runoutEvents();f.apply(final,events)
    advance(f,3)
    const names=['HoleCard-0-0','HoleCard-3-1','BoardCard-3','BoardCard-4']
    const poses=names.map(name=>({position:f.get(name).position.clone(),quaternion:f.get(name).quaternion.clone()}))
    f.apply({...final,seq:31})
    f.apply({...final,seq:31},events)
    assert.equal(f.pieces.cardsSettled(),false)
    names.forEach((name,index)=>{
      assert.ok(f.get(name).position.distanceTo(poses[index].position)<1e-9,'A resync must not teleport an unfinished flight')
      assert.ok(1-Math.abs(f.get(name).quaternion.dot(poses[index].quaternion))<1e-9,'A resync must not snap an unfinished flip')
    })
    advance(f,6)
    assert.equal(f.pieces.cardsSettled(),false)
    advance(f,1)
    assert.equal(f.pieces.cardsSettled(),true,'Duplicate snapshots do not restart the existing flights')
    finalPose(f)
  }finally{f.close()}
})

test('a showdown flip alone delays readiness until revealed opponents are face up',()=>{
  const f=fixture()
  try{
    f.apply(state({seq:10,stage:'RIVER',board:[...board]}))
    assert.equal(f.pieces.cardsSettled(),true)
    f.apply(finalState(),[event(11,'SHOWDOWN')])
    f.pieces.update(.1)
    assert.equal(f.pieces.cardsSettled(),false)
    assert.ok(f.get('HoleCard-0-0').rotation.z>0)
    advance(f,8)
    assert.equal(f.pieces.cardsSettled(),true)
    finalPose(f)
  }finally{f.close()}
})

test('snapshot-only COMPLETE/reconnect is immediately settled and still reveals newly eliminated public hands',()=>{
  const f=fixture()
  try{
    f.apply(finalState())
    assert.equal(f.pieces.cardsSettled(),true)
    finalPose(f)
    assert.equal(f.get('HoleCard-0-0').visible,true,'A zero-stack participant must retain their final public cards')
    assert.notEqual(f.get('HoleCard-0-0').children[1].material,f.get('HoleCard-0-0').children[2].material)
    f.receiver.reset();f.apply(finalState())
    assert.equal(f.pieces.cardsSettled(),true)
    finalPose(f)
  }finally{f.close()}
})

test('folded cards stay hidden and chip payout flights do not delay card readiness',()=>{
  const f=fixture()
  try{
    const folded=finalState()
    folded.players[0].folded=true
    f.apply(folded)
    assert.equal(f.get('HoleCard-0-0').visible,false)
    assert.equal(f.get('HoleCard-0-1').visible,false)
    assert.equal(f.pieces.cardsSettled(),true)
    f.pieces.event(event(31,'PAYOUT',{winners:folded.winners}))
    assert.equal(f.pieces.cardsSettled(),true,'This API gates cards only, not chips')
    f.pieces.event(event(32,'SHOWDOWN'))
    assert.equal(f.pieces.cardsSettled(),false)
    advance(f,10)
    assert.equal(f.pieces.cardsSettled(),true)
    assert.equal(f.get('HoleCard-0-0').visible,false)
  }finally{f.close()}
})

test('intermission and a new hand cancel stale readiness work and reject prior-hand effects',()=>{
  const f=fixture()
  try{
    f.apply(state());f.apply(finalState(),runoutEvents())
    assert.equal(f.pieces.cardsSettled(),false)
    f.apply(finalState({seq:31,stage:'INTERMISSION'}))
    assert.equal(f.pieces.cardsSettled(),true)
    for(let seat=0;seat<4;seat++)for(let card=0;card<2;card++)assert.equal(f.get(`HoleCard-${seat}-${card}`).visible,false)
    for(let card=0;card<5;card++)assert.equal(f.get(`BoardCard-${card}`).visible,false)
    f.apply(state({handId:'hand-2',seq:32}))
    f.pieces.event(event(33,'SHOWDOWN'))
    assert.equal(f.pieces.cardsSettled(),true)
    f.pieces.event(event(34,'CARDS_DEALT',{handId:'hand-2'}))
    assert.equal(f.pieces.cardsSettled(),false)
    advance(f,10)
    assert.equal(f.pieces.cardsSettled(),true)
  }finally{f.close()}
})

test('invalid or negative delta time cannot poison readiness or final card transforms',()=>{
  const f=fixture()
  try{
    f.apply(state());f.apply(finalState(),runoutEvents())
    for(const dt of [NaN,Infinity,-Infinity,-1,0]){
      f.pieces.update(dt)
      assert.equal(f.pieces.cardsSettled(),false)
      f.scene.traverse(object=>{
        assert.ok([...object.position.toArray(),...object.quaternion.toArray(),...object.scale.toArray()].every(Number.isFinite))
      })
    }
    f.pieces.update(Number.MAX_VALUE)
    assert.equal(f.pieces.cardsSettled(),false,'One oversized delta is bounded to an animation step')
    advance(f,9)
    assert.equal(f.pieces.cardsSettled(),true)
    finalPose(f)
  }finally{f.close()}
})

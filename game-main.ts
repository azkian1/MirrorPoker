import * as THREE from 'three'
import './ui/style.css'
import { ANCHORS, CAMERA, CHIP, CHIP_STACK } from './shared/assets.ts'
import type { ClientCommand, GameEvent, PublicState, PrivateState, ServerMessage, PokerAction, WorldMode } from './shared/contracts.ts'
import { createWorld } from './scene/world.ts'
import { createPieces } from './scene/pieces.ts'
import { createDealer } from './scene/dealer.ts'
import { createAudio } from './audio/index.ts'
import { createUI } from './ui/index.ts'
import { StateReceiver } from './client/state.ts'
import { createSessionClock } from './client/clock.ts'
import { createResultPresentation } from './client/result-presentation.ts'
import { createTurnWarning } from './client/turn-warning.ts'
import { createWorldTransition } from './client/world-transition.ts'
import { PokerSession } from './server/session.ts'

const boot=(window as unknown as { __mirrorBoot?: { stage(text:string):void; done():void; fail(error:unknown):void } }).__mirrorBoot
boot?.stage('Creating the game scene…')
const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(CAMERA.fov, 16/9, CAMERA.near, CAMERA.far)
camera.position.set(...CAMERA.position)
camera.lookAt(...CAMERA.target)
const renderer = new THREE.WebGLRenderer({ antialias:true, powerPreference:'high-performance' })
renderer.setPixelRatio(Math.min(devicePixelRatio,1.75))
renderer.shadowMap.enabled=true
renderer.shadowMap.type=THREE.PCFSoftShadowMap
renderer.toneMapping=THREE.ACESFilmicToneMapping
renderer.outputColorSpace=THREE.SRGBColorSpace
document.querySelector('#app')!.appendChild(renderer.domElement)
const world=createWorld(scene)
const pieces=createPieces(scene)
const dealer=createDealer(scene,{style:'sprite'})
const audio=createAudio()
const worldTransition=createWorldTransition(()=>audio.snap())
const turnWarning=createTurnWarning(()=>audio.turnWarning())
const resultPresentation=createResultPresentation()
let state:PublicState|null=null
let self:PrivateState|null=null
let local:PokerSession|null=null
let menuWorldMode:WorldMode='NORMAL'
let muted=false
let pending=false
let pendingStateKey=''
let smokeClock=0
let tornDown=false
const smoke=location.hash==='#smoke'
const id=()=>globalThis.crypto?.randomUUID?.() ?? `action-${Date.now()}-${Math.random().toString(36).slice(2)}`

const ui=createUI(document.querySelector('#hud')!,{
  solo:startLocal,
  previewWorld:next=>{if(!tornDown&&!state){menuWorldMode=next;ui.setWorldMode(next)}},
  replay:()=>{leave();ui.showBriefing()},
  act:(action:PokerAction)=>{if(state)send({type:'act',handId:state.handId,actionId:id(),action})},
  leave,
  mute:()=>{muted=!muted;audio.setMuted(muted);ui.setMuted(muted)},
})
const receiver=new StateReceiver({
  snapshot(next,privateState,events) {
    if(`${next.handId}:${next.seq}`!==pendingStateKey)pending=false
    state=next;self=privateState
    if(next.stage==='LOBBY')worldTransition.reset(menuWorldMode)
    else worldTransition.observe(next,events,document.visibilityState==='visible')
    ui.setWorldMode(worldTransition.mode())
    turnWarning.observe(next,privateState)
    world.setBlinds(next.smallBlind,next.bigBlind)
    pieces.apply(next,privateState)
    resultPresentation.observe(next,privateState)
    ui.update(next,privateState)
    if(resultPresentation.readyHand()) ui.setResultReady(resultPresentation.readyHand())
    projectSeats()
  },
  event(event:GameEvent) {pieces.event(event);dealer.event(event);audio.event(event);ui.event(event)},
  error(message) {pending=false;ui.setError(message);if(state)ui.update(state,self)},
})

function receive(message:ServerMessage) {
  if(tornDown)return
  receiver.receive(message)
}
function send(command:ClientCommand) {
  if(tornDown)return
  audio.unlock()
  if(pending && ['act','start','next'].includes(command.type)) return
  pending=['act','start','next'].includes(command.type)
  if(pending)pendingStateKey=state?`${state.handId}:${state.seq}`:''
  if(local) local.receive('local',command)
  else {pending=false;ui.setError('Join a table first')}
}

function startLocal() {
  if(tornDown)return
  audio.unlock()
  localClock.stop()
  receiver.reset()
  resetView()
  local=new PokerSession({send:(_id,message)=>receive(message)},undefined,{format:'solo'})
  local.join('local','You',null)
  ui.setConnection(smoke ? 'SOLO · automatic demo' : 'SOLO · YOU + THREE BOTS')
  send({type:'start',mode:'solo',actionId:id()})
  localClock.start()
}
function leave() {
  if(tornDown)return
  localClock.stop()
  local=null;pending=false
  receiver.reset();resetView()
  ui.setConnection('READY · PLAY AGAINST BOTS')
}
function resetView() {
  state=null;self=null;pending=false;pendingStateKey='';smokeClock=0
  turnWarning.reset()
  resultPresentation.reset()
  worldTransition.reset(menuWorldMode);ui.setWorldMode(menuWorldMode)
  world.setBlinds(10,20)
  ui.update(null,null);pieces.apply(emptyState(),null);dealer.reset();audio.reset()
}
function emptyState():PublicState {
  return {handId:'hand-0',seq:0,stage:'LOBBY',worldMode:'NORMAL',players:[],board:[],pot:0,actorId:null,dealerSeat:0,smallBlind:10,bigBlind:20,currentBet:0,minRaise:20,winners:[]}
}
function projectSeats() {
  if(tornDown)return
  const hud=document.querySelector<HTMLElement>('#hud')!
  const style=getComputedStyle(document.documentElement)
  const inset=Object.fromEntries(['top','right','bottom','left'].map(side=>[side,parseFloat(style.getPropertyValue(`--safe-${side}`))||0]))
  for(const side of ['top','right','bottom','left'] as const) hud.style[side]=`${inset[side]}px`
  const rect=hud.getBoundingClientRect()
  const project=(x:number,y:number,z:number)=>{
    const point=new THREE.Vector3(x,y,z).project(camera)
    return {x:((point.x+1)*innerWidth/2-rect.left)/Math.max(1,rect.width),y:((1-point.y)*innerHeight/2-rect.top)/Math.max(1,rect.height)}
  }
  const corners=[[-4.4,2.65],[-4.35,-2.85],[4.35,-2.85],[4.4,2.65]]
  const seats=corners.map(([x,z],seat)=>{
    const point=project(x,1,z),near=seat===0||seat===3,side=x<0?-1:1
    return {seat,x:point.x+side*(near?100:10)/Math.max(1,rect.width),y:point.y+(near?30:-52)/Math.max(1,rect.height)}
  })
  const bets=ANCHORS.bets.map(([x,y,z],seat)=>{
    const amount=state?.players.find(player=>player.seat===seat)?.bet??0
    const count=amount>0?Math.min(CHIP_STACK.betLimit,Math.max(1,Math.ceil(amount/CHIP_STACK.valuePerChip))):0
    const columns=Math.ceil(count/CHIP_STACK.perColumn)
    const inward=seat<2?1:-1
    const centerX=x+inward*Math.max(0,columns-1)*CHIP_STACK.columnSpacing/2
    const topY=y+Math.min(count,CHIP_STACK.perColumn)*CHIP.height
    const point=project(centerX,topY+.10,z)
    const outward=seat<2?-1:1
    const near=seat===0||seat===3
    // Keep long totals clear of the board corners and far-seat card fans.
    point.x+=(near?outward*16:-outward*20)/Math.max(1,rect.width)
    return {seat,...point}
  })
  ui.setTablePositions({seats,pot:project(0,1.02,-1.65),bets})
}
function resize() {
  if(tornDown)return
  const width=Math.max(1,innerWidth),height=Math.max(1,innerHeight)
  renderer.setSize(width,height)
  camera.aspect=width/height
  // Keep the designed table size through 3:2 windows before fitting its width.
  // Preserving a 16:9 horizontal field here made tall Desktop previews show
  // excessive ceiling above a smaller table.
  const framingAspect=3/2
  const compactLandscape=width>height&&height<=520&&width<=1100
  const fieldOfView=compactLandscape?29.7:CAMERA.fov
  camera.fov=THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(fieldOfView/2))*Math.max(1,framingAspect/camera.aspect)))
  const excessHeight=Math.max(0,height-width/framingAspect)
  if(compactLandscape)camera.setViewOffset(width,height,0,height*.02,width,height)
  else if(excessHeight>0)camera.setViewOffset(width,height,0,excessHeight*.2,width,height)
  else camera.clearViewOffset()
  camera.updateProjectionMatrix()
  projectSeats()
}
addEventListener('resize',resize)
resize()
ui.setConnection('READY · PLAY AGAINST BOTS')
const localClock=createSessionClock(dt=>{
  local?.tick(dt)
  if(smoke && local && state?.actorId==='local') {
    smokeClock+=dt
    if(smokeClock>.7) {
      smokeClock=0
      const legal=self?.legalActions ?? []
      const action=legal.find(a=>a.type==='check') ?? legal.find(a=>a.type==='call') ?? legal.find(a=>a.type==='fold')
      if(action) send({type:'act',handId:state.handId,actionId:id(),action:{type:action.type}})
    }
  }
})
if(smoke)startLocal()
let last=performance.now()
let firstFrame=true
renderer.setAnimationLoop(()=>{
  if(tornDown)return
  const now=performance.now(),dt=Math.min((now-last)/1000,.1);last=now
  turnWarning.frame()
  const transition=worldTransition.frame(document.visibilityState==='visible')
  const activeMode=state&&state.stage!=='LOBBY'?transition.mode:menuWorldMode
  ui.setWorldMode(activeMode);dealer.setSnap(state?transition.age:null)
  world.update(dt,activeMode);pieces.update(dt);dealer.update(dt,activeMode)
  renderer.render(scene,camera)
  ui.setResultReady(resultPresentation.frame(performance.now(),pieces.cardsSettled(),document.visibilityState==='visible'))
  if(firstFrame) {firstFrame=false;boot?.done()}
})
const suspendResultPresentation=()=>{resultPresentation.suspend();worldTransition.suspend()}
document.addEventListener('visibilitychange',suspendResultPresentation)
addEventListener('pagehide',event=>{
  if(tornDown)return
  // A cached page resumes its existing scene and UI when the browser restores it.
  if(event.persisted){suspendResultPresentation();return}
  tornDown=true
  localClock.stop()
  renderer.setAnimationLoop(null)
  local=null;state=null;self=null;pending=false
  removeEventListener('resize',resize);document.removeEventListener('visibilitychange',suspendResultPresentation);resultPresentation.reset();turnWarning.reset();ui.dispose();pieces.dispose();dealer.dispose();world.dispose();audio.dispose();renderer.dispose()
})

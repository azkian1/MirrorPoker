import type { GameEvent, PublicState, WorldMode } from '../shared/contracts.ts'
import { DEALER_SNAP } from '../shared/assets.ts'

/** Cosmetic timing only. Authority and input always use the latest unmodified snapshot. */
export function createWorldTransition(snap:()=>void,now:()=>number=()=>performance.now()) {
  let mode:WorldMode='NORMAL',target:WorldMode='NORMAL'
  let started:number|null=null
  let released=false
  function settle() {mode=target;started=null;released=false}
  function reset(initial:WorldMode='NORMAL') {mode=target=initial;started=null;released=false}
  return {
    observe(state:PublicState|null,events:readonly GameEvent[]=[],visible=true) {
      if(!state) {reset();return}
      const next=state.worldMode
      if(!visible||state.stage!=='INTERMISSION'||state.match?.status==='FINISHED') {
        target=next;settle();return
      }
      // Clock-only snapshots preserve the cue; attaching/resyncing never invents one.
      if(started!==null&&next===target) return
      const freshChange=events.some(event=>event.type==='WORLD_CHANGED'&&event.worldMode===next)
      target=next
      if(freshChange&&mode!==next) {started=now();released=false}
      else settle()
    },
    frame(visible=true) {
      if(started===null) return {mode,age:null}
      const age=Math.max(0,(now()-started)/1000)
      // A hidden tab or a long render gap must never replay an old snap sound.
      if(!visible||age>=DEALER_SNAP.duration) {settle();return {mode,age:null}}
      if(!released&&age>=DEALER_SNAP.release) {released=true;mode=target;snap()}
      return {mode,age}
    },
    mode:()=>mode,
    suspend:settle,
    reset,
  }
}

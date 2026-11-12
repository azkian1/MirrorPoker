import type { PrivateState, PublicState } from '../shared/contracts.ts'
import { TURN_WARNING_MS } from '../shared/tournament.ts'

/** A clock snapshot anchors presentation only; the session decides when to fold. */
export function createTurnWarning(warn:()=>void,now:()=>number=()=>performance.now()) {
  let turnId=''
  let deadline=0
  let warned=false
  function reset() {turnId='';deadline=0;warned=false}
  function frame() {
    const remaining=deadline-now()
    if(turnId&&!warned&&remaining>0&&remaining<=TURN_WARNING_MS) {warned=true;warn()}
  }
  return {
    observe(state:PublicState|null,self:PrivateState|null) {
      const timer=state?.turnTimer
      if(!timer||timer.playerId!==self?.playerId||state?.actorId!==self.playerId||state.match?.status!=='PLAYING') {reset();return}
      const remaining=timer.remainingMs
      if(!Number.isFinite(remaining)||remaining<0||!Number.isFinite(timer.durationMs)||timer.durationMs<=0) {reset();return}
      const nextDeadline=now()+Math.min(remaining,timer.durationMs)
      if(turnId!==timer.turnId) {turnId=timer.turnId;deadline=nextDeadline;warned=false}
      else deadline=Math.min(deadline,nextDeadline)
      frame()
    },
    frame,
    reset,
  }
}

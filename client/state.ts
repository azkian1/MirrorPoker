import type { GameEvent, PublicState, PrivateState, ServerMessage } from '../shared/contracts.ts'

export interface ClientView {
  snapshot(state:PublicState,self:PrivateState,events:readonly GameEvent[]):void
  event(event:GameEvent):void
  error(message:string):void
}
/** Snapshot and its optional events form one ordered transaction. Never replay on resync. */
export class StateReceiver {
  private seq = -1
  private ids = new Set<string>()
  constructor(private view:ClientView) {}
  receive(message:ServerMessage):void {
    if(message.type === 'error') {this.view.error(message.message);return}
    if(message.type !== 'snapshot' || message.state.seq < this.seq) return
    const before = this.seq
    const pendingIds = new Set<string>()
    const events = before < 0 ? [] : [...(message.events ?? [])].sort((a,b)=>a.seq-b.seq).filter(event=>{
      if(event.handId !== message.state.handId || event.seq <= before || event.seq > message.state.seq || this.ids.has(event.eventId) || pendingIds.has(event.eventId)) return false
      pendingIds.add(event.eventId)
      return true
    })
    // Expose this transaction's fresh events before presentation applies its snapshot.
    this.view.snapshot(message.state,message.privateState,events)
    this.seq=message.state.seq
    for(const event of events) {
      this.ids.add(event.eventId)
      this.view.event(event)
    }
    if(this.ids.size>512) this.ids = new Set([...this.ids].slice(-256))
  }
  reset():void {this.seq=-1;this.ids.clear()}
}

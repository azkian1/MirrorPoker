import type { PrivateState, PublicState } from '../shared/contracts.ts'

/** Let the final face-up hand remain readable before the tournament result covers it. */
export const FINAL_HAND_VIEW_MS = 2500

export function createResultPresentation() {
  let target: string | null = null
  let handId: string | null = null
  let lastFrame: number | null = null
  let visibleMs = 0
  let delayMs = FINAL_HAND_VIEW_MS
  let ready = false

  function reset() {
    target = handId = null; lastFrame = null; visibleMs = 0; ready = false
  }

  return {
    observe(state: PublicState | null, self: PrivateState | null) {
      const placement = state && self?.handId === state.handId && state.match?.placements.find(p => p.playerId === self.playerId)
      if (!placement || !state || !self) { reset(); return }
      const key = `${self.playerId}:${placement.place}:${placement.reason}`
      if (key !== target || handId !== state.handId && !ready) { reset(); target = key }
      // Once shown, a player's final result stays open while the remaining
      // multiplayer participants start other hands. Session reset still clears it.
      handId = state.handId
      // A multiplayer elimination can leave the table running. Do not hold its
      // result beyond the server's normal next-hand pause; still finish its cards.
      delayMs = state.match?.status === 'FINISHED' ? FINAL_HAND_VIEW_MS : 0
    },
    /** Call after rendering. Hidden tabs and unfinished cards never count as viewing time. */
    frame(nowMs: number, cardsSettled: boolean, visible: boolean): string | null {
      if (!handId) return null
      if (ready) return handId
      if (!visible || !cardsSettled || !Number.isFinite(nowMs)) {
        lastFrame = null
        // The reading pause starts again if a late reveal adds another card motion.
        if (!cardsSettled) visibleMs = 0
        return null
      }
      if (lastFrame !== null) visibleMs += Math.max(0, nowMs - lastFrame)
      lastFrame = Math.max(lastFrame ?? nowMs, nowMs)
      if (visibleMs < delayMs) return null
      ready = true
      return handId
    },
    /** Ignore time spent in a background tab, including when rAF stops completely. */
    suspend() { lastFrame = null },
    readyHand() { return ready ? handId : null },
    reset,
  }
}

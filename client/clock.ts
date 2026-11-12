export interface SessionClockHost {
  now(): number
  schedule(callback: () => void, milliseconds: number): unknown
  cancel(handle: unknown): void
}

/** Solo authority follows elapsed time even when rendering runs slowly or pauses. */
export function createSessionClock(tick: (dt: number) => void, host: SessionClockHost = {
  now: () => performance.now(),
  schedule: (callback, milliseconds) => setInterval(callback, milliseconds),
  cancel: handle => clearInterval(handle as number),
}) {
  let timer: unknown = null
  let previous = 0
  return {
    start() {
      if (timer !== null) return
      previous = host.now()
      timer = host.schedule(() => {
        const now = host.now()
        let remaining = Math.min(60, Math.max(0, (now - previous) / 1000))
        previous = now
        // PokerSession accepts at most one second per tick. Catch up bounded
        // delays in small steps without letting an old tab monopolise the thread.
        while (Number.isFinite(remaining) && remaining > 0) {
          const step = Math.min(1, remaining)
          tick(step)
          remaining -= step
        }
      }, 100)
    },
    stop() {
      if (timer === null) return
      host.cancel(timer)
      timer = null
    },
  }
}

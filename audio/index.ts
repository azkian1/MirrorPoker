import type { GameEvent } from '../shared/contracts.ts'

export interface AudioView {
  unlock(): void
  setMuted(muted: boolean): void
  event(event: GameEvent): void
  snap(): void
  turnWarning(): void
  reset(): void
  dispose(): void
}

/** Recorded Kenney Casino Audio and Joseph Sardin finger snap, CC0.
 * Local recordings keep playback independent of external services; offsets remove silence;
 * the natural snap is trimmed to its attack and tail (see finger-snap-license.txt). */
const SAMPLES = {
  snap: { url: 'assets/audio/finger-snap.wav', offset: 0, duration: .2 },
  slide1: { url: 'assets/audio/card-slide-1.wav', offset: .088, duration: .155 },
  slide2: { url: 'assets/audio/card-slide-2.wav', offset: 0, duration: .165 },
  slide3: { url: 'assets/audio/card-slide-3.wav', offset: 0, duration: .215 },
  slide4: { url: 'assets/audio/card-slide-4.wav', offset: 0, duration: .225 },
  place1: { url: 'assets/audio/card-place-1.wav', offset: .065, duration: .205 },
  place2: { url: 'assets/audio/card-place-2.wav', offset: .035, duration: .255 },
  fold: { url: 'assets/audio/card-shove-1.wav', offset: 0, duration: .36 },
  shuffle: { url: 'assets/audio/card-shuffle.wav', offset: 0, duration: .32 },
  tap1: { url: 'assets/audio/chip-lay-1.wav', offset: .04, duration: .13 },
  tap2: { url: 'assets/audio/chip-lay-2.wav', offset: .075, duration: .082 },
  collide: { url: 'assets/audio/chips-collide-1.wav', offset: .075, duration: .108 },
  stack: { url: 'assets/audio/chips-stack-1.wav', offset: .075, duration: .115 },
  handle: { url: 'assets/audio/chips-handle-1.wav', offset: .032, duration: .21 },
} as const
type SampleName = keyof typeof SAMPLES
const SLIDES: SampleName[] = ['slide1', 'slide2', 'slide3', 'slide4']
const MASTER_LEVEL = .58
const MAX_VOICES = 12
type Voice = { source: AudioScheduledSourceNode; gain: GainNode }

/** Gesture-unlocked card/chip foley. Locked, loading or muted events are consumed, never queued. */
export function createAudio(): AudioView {
  let context: AudioContext | null = null
  let master: GainNode | null = null
  let loading: Promise<void> | null = null
  let muted = false, disposed = false, lastSeq = -1, boardCount = 0
  const seen = new Set<string>()
  const buffers = new Map<SampleName, AudioBuffer>()
  const active = new Set<Voice>()

  function stopVoice(voice: Voice) {
    voice.source.onended = null
    try { voice.source.stop() } catch {}
    voice.source.disconnect()
    voice.gain.disconnect()
    active.delete(voice)
  }

  function stopVoices() {
    for (const voice of active) stopVoice(voice)
  }

  function loadSamples() {
    if (loading || !context) return
    const decoder = context
    loading = Promise.all((Object.keys(SAMPLES) as SampleName[]).map(async name => {
      try {
        const response = await fetch(SAMPLES[name].url)
        if (!response.ok || disposed) return
        const bytes = await response.arrayBuffer()
        if (disposed) return
        const buffer = await decoder.decodeAudioData(bytes)
        if (!disposed) buffers.set(name, buffer)
      } catch {
        // A missing/unsupported sound must not interrupt a hand or cause repeated requests.
      }
    })).then(() => {})
  }

  function sample(name: SampleName, delay = 0, level = .4, rate = 1, limit?: number) {
    const buffer = buffers.get(name)
    if (!context || !master || !buffer || muted || disposed || context.state !== 'running') return
    if (active.size >= MAX_VOICES) stopVoice(active.values().next().value!)
    const clip = SAMPLES[name]
    const offset = Math.min(clip.offset, Math.max(0, buffer.duration - .002))
    const duration = Math.min(limit ?? clip.duration, buffer.duration - offset)
    if (duration <= 0) return
    const source = context.createBufferSource(), gain = context.createGain()
    const start = context.currentTime + delay, end = start + duration / rate
    source.buffer = buffer
    source.playbackRate.value = rate
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(level, start + .002)
    gain.gain.setValueAtTime(level, Math.max(start + .002, end - .012))
    gain.gain.linearRampToValueAtTime(0, end)
    source.connect(gain)
    gain.connect(master)
    const voice = { source, gain }
    active.add(voice)
    source.onended = () => {
      active.delete(voice)
      source.disconnect()
      gain.disconnect()
    }
    source.start(start, offset, duration)
    source.stop(end + .002)
  }

  return {
    unlock() {
      if (disposed) return
      try {
        if (!context) {
          const AudioCtor = globalThis.AudioContext
          if (!AudioCtor) return
          context = new AudioCtor()
          context.onstatechange = () => {
            // The audio clock freezes during suspension. Cancel its existing
            // graph so a later gesture cannot resume an old deal/snap/warning.
            if (context?.state !== 'running') stopVoices()
          }
          master = context.createGain()
          master.gain.value = muted ? 0 : MASTER_LEVEL
          master.connect(context.destination)
          loadSamples()
        }
        if (context.state === 'suspended') {
          // A gesture may arrive before the queued statechange notification.
          stopVoices()
          void context.resume().catch(() => {})
        }
      } catch {
        // Audio support/permission never blocks gameplay.
      }
    },
    setMuted(value) {
      muted = value
      if (context && master) master.gain.setValueAtTime(muted ? 0 : MASTER_LEVEL, context.currentTime)
      if (muted) stopVoices() // Also cancels sources scheduled for later cards in a deal.
    },
    event(event) {
      if (disposed || seen.has(event.eventId) || event.seq <= lastSeq) return
      seen.add(event.eventId)
      lastSeq = event.seq
      if (seen.size > 256) seen.delete(seen.values().next().value as string)
      let streetCards = 0
      if (event.type === 'HAND_PREPARED' || event.type === 'HAND_STARTED') boardCount = 0
      if (event.type === 'STREET_CHANGED') {
        const nextCount = Math.max(boardCount, Math.min(5, event.board?.length ?? boardCount + 1))
        // A stream can attach after a silent mid-hand snapshot. Play this street only,
        // never catch up earlier flop/turn sounds that this audio instance did not see.
        streetCards = nextCount > boardCount ? nextCount === 3 ? 3 : 1 : 0
        boardCount = nextCount
      }
      if (!context || muted || context.state !== 'running') return
      if (event.type === 'CARDS_DEALT') {
        const count = Number.isSafeInteger(event.cardCount) ? Math.max(0, Math.min(8, event.cardCount!)) : 8
        for (let i = 0; i < count; i++) sample(SLIDES[(i + event.seq) % SLIDES.length], i * .065, .32)
      } else if (event.type === 'STREET_CHANGED') {
        for (let i = 0; i < streetCards; i++) sample(i % 2 ? 'place2' : 'place1', i * .085, .34)
      } else if (event.type === 'PLAYER_ACTED' && event.action) {
        switch (event.action.type) {
          case 'fold': sample('fold', 0, .27); break
          case 'check':
            // Two dry physical taps, deliberately quieter than moving betting chips.
            sample('tap2', 0, .19, .88, .065)
            sample('tap2', .095, .14, .88, .065)
            break
          case 'call': sample('tap1', 0, .38); break
          case 'bet': sample('stack', 0, .42); break
          case 'raise':
            sample('stack', 0, .42)
            sample('collide', .055, .29)
            break
          case 'allIn':
            sample('handle', 0, .43)
            sample('stack', .11, .4)
            sample('collide', .18, .28)
            break
        }
      } else if (event.type === 'PAYOUT') {
        sample('handle', 0, .4)
        sample('stack', .12, .31)
        sample('collide', .2, .23)
      }
    },
    snap() {
      // The presentation calls once at the .72 s finger release. A locked,
      // loading or unavailable recording is consumed without a delayed replay.
      sample('snap', 0, .68)
    },
    turnWarning() {
      if (!context || !master || muted || disposed || context.state !== 'running') return
      if (active.size >= MAX_VOICES) stopVoice(active.values().next().value!)
      const source = context.createOscillator(), gain = context.createGain()
      const start = context.currentTime, end = start + .31
      // Two brief rising tones remain distinct from physical card/chip recordings.
      // Synthesis is immediately available after unlock, even while samples load.
      source.type = 'triangle'
      source.frequency.setValueAtTime(880, start)
      source.frequency.setValueAtTime(1175, start + .16)
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(.22, start + .006)
      gain.gain.setValueAtTime(.22, start + .085)
      gain.gain.linearRampToValueAtTime(0, start + .105)
      gain.gain.setValueAtTime(0, start + .16)
      gain.gain.linearRampToValueAtTime(.22, start + .166)
      gain.gain.setValueAtTime(.22, start + .275)
      gain.gain.linearRampToValueAtTime(0, end)
      source.connect(gain)
      gain.connect(master)
      const voice = { source, gain }
      active.add(voice)
      source.onended = () => {
        active.delete(voice)
        source.disconnect()
        gain.disconnect()
      }
      source.start(start)
      source.stop(end + .002)
    },
    reset() {
      stopVoices()
      seen.clear()
      lastSeq = -1
      boardCount = 0
    },
    dispose() {
      if (disposed) return
      disposed = true
      stopVoices()
      seen.clear()
      buffers.clear()
      master?.disconnect()
      if (context) context.onstatechange = null
      if (context && context.state !== 'closed') void context.close().catch(() => {})
      context = null
      master = null
    },
  }
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
mkdirSync(resolve(root, '.test-output'), { recursive: true })
const build = spawnEsbuild(['tests/audio-v2-entry.ts', '--bundle', '--platform=node', '--format=esm', '--outfile=.test-output/audio-v2-bundle.mjs'], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, build.stderr)
const { createAudio } = await import('../.test-output/audio-v2-bundle.mjs')
const tick = () => new Promise(resolve => setImmediate(resolve))
const event = (seq, type, fields = {}) => ({ handId: 'hand-1', eventId: `event-${seq}`, seq, type, ...fields })

function fixture({ deferred = false, fail = false } = {}) {
  const originalContext = globalThis.AudioContext, originalFetch = globalThis.fetch
  const sources = [], oscillators = [], gains = [], requests = [], decoded = [], contexts = [], pending = []
  class Parameter {
    value = 0
    values = []
    setValueAtTime(value, time) { this.value = value; this.values.push(['set', value, time]) }
    linearRampToValueAtTime(value, time) { this.value = value; this.values.push(['ramp', value, time]) }
  }
  class Node {
    connected = true
    connect() {}
    disconnect() { this.connected = false }
  }
  class MockContext {
    currentTime = 10
    state = 'running'
    onstatechange = null
    resumeCalls = 0
    destination = {}
    constructor() { contexts.push(this) }
    createGain() { const gain = Object.assign(new Node(), { gain: new Parameter() }); gains.push(gain); return gain }
    createBufferSource() {
      const source = Object.assign(new Node(), {
        playbackRate: new Parameter(), onended: null, stops: [], cancelled: false,
        start(...args) { this.started = args },
        stop(time) { this.stops.push(time); if (time === undefined) this.cancelled = true },
        finish() { this.ended = true; this.onended?.() },
      })
      sources.push(source)
      return source
    }
    createOscillator() {
      const source = Object.assign(new Node(), {
        frequency: new Parameter(), onended: null, stops: [], cancelled: false,
        start(...args) { this.started = args },
        stop(time) { this.stops.push(time); if (time === undefined) this.cancelled = true },
        finish() { this.ended = true; this.onended?.() },
      })
      oscillators.push(source)
      return source
    }
    async decodeAudioData(bytes) {
      decoded.push(bytes.url)
      if (deferred) await new Promise(resolve => pending.push(resolve))
      return { duration: 4, url: bytes.url }
    }
    async resume() { this.resumeCalls++; this.state = 'running'; this.onstatechange?.() }
    async close() { this.state = 'closed'; this.onstatechange?.() }
  }
  globalThis.AudioContext = MockContext
  globalThis.fetch = async url => {
    requests.push(url)
    if (fail) throw new Error('offline')
    return { ok: true, arrayBuffer: async () => ({ url }) }
  }
  const audio = createAudio()
  const ready = async () => { audio.unlock(); await tick(); pending.splice(0).forEach(resolve => resolve()); await tick() }
  const clear = () => [...sources, ...oscillators].forEach(source => { if (!source.ended && !source.cancelled) source.finish() })
  const restore = () => { audio.dispose(); globalThis.AudioContext = originalContext; globalThis.fetch = originalFetch }
  return { audio, ready, sources, oscillators, gains, requests, decoded, contexts, clear, restore }
}

test('turn warning uses a brief rising two-tone envelope and does not wait for sample decoding', async () => {
  const f = fixture({ deferred: true })
  try {
    f.audio.turnWarning()
    assert.equal(f.contexts.length, 0, 'A warning cannot unlock or queue audio')
    f.audio.unlock(); await tick()
    f.audio.turnWarning()
    assert.equal(f.oscillators.length, 1)
    assert.equal(f.sources.length, 0)
    const tone = f.oscillators[0], gain = f.gains.at(-1)
    assert.equal(tone.type, 'triangle')
    assert.deepEqual(tone.frequency.values, [['set', 880, 10], ['set', 1175, 10.16]])
    assert.deepEqual(tone.started, [10])
    assert.ok(Math.abs(tone.stops[0] - 10.312) < 1e-9)
    assert.equal(gain.gain.values.at(-1)[1], 0)
    assert.ok(gain.gain.values.every(([, value]) => value >= 0 && value <= .22))
    assert.ok(gain.gain.values.some(([, value, time]) => value === 0 && Math.abs(time - 10.105) < 1e-9))
    tone.finish()
    assert.equal(tone.connected, false)
    assert.equal(gain.connected, false)
    await f.ready()
    assert.equal(f.oscillators.length, 1, 'Loading completion cannot replay a warning')
  } finally { f.restore() }
})

test('warning follows mute, suspended context, reset, shared voice cap and dispose', async () => {
  const f = fixture()
  try {
    await f.ready()
    f.audio.turnWarning()
    f.audio.setMuted(true)
    assert.ok(f.oscillators[0].cancelled && !f.oscillators[0].connected)
    f.audio.turnWarning()
    assert.equal(f.oscillators.length, 1)
    f.audio.setMuted(false)
    assert.equal(f.oscillators.length, 1, 'Unmute cannot replay a missed warning')
    f.contexts[0].state = 'suspended'
    f.audio.turnWarning()
    assert.equal(f.oscillators.length, 1)
    f.contexts[0].state = 'running'
    f.audio.turnWarning()
    f.audio.reset()
    assert.ok(f.oscillators[1].cancelled && !f.oscillators[1].connected)
    for (let seq = 1; seq <= 2; seq++) f.audio.event(event(seq, 'CARDS_DEALT', { cardCount: 8 }))
    f.audio.turnWarning()
    assert.equal([...f.sources, ...f.oscillators].filter(source => !source.cancelled).length, 12)
    f.audio.dispose()
    assert.ok([...f.sources, ...f.oscillators].every(source => source.cancelled))
    const count = f.oscillators.length
    f.audio.turnWarning(); f.audio.unlock()
    assert.equal(f.oscillators.length, count)
    assert.equal(f.contexts.length, 1)
    assert.equal(f.contexts[0].state, 'closed')
  } finally { f.restore() }
})

test('all fourteen runtime recordings use supported WAV files and retain the source CC0 licenses', () => {
  const source = readFileSync(resolve(root, 'audio/index.ts'), 'utf8')
  const clips = [...source.matchAll(/url: '(assets\/audio\/[^']+)', offset: ([.\d]+), duration: ([.\d]+)/g)]
    .map(([, path, offset, duration]) => ({ path, offset: Number(offset), duration: Number(duration) }))
  assert.equal(clips.length, 14)
  assert.equal(new Set(clips.map(clip => clip.path)).size, 14)
  let bytes = 0
  for (const { path, offset, duration } of clips) {
    assert.ok(path.endsWith('.wav'), `${path} must use the supported audio format`)
    const file = readFileSync(resolve(root, path))
    assert.equal(file.subarray(0, 4).toString(), 'RIFF')
    assert.equal(file.subarray(8, 12).toString(), 'WAVE')
    const chunks = new Map()
    for (let position = 12; position + 8 <= file.length;) {
      const size = file.readUInt32LE(position + 4)
      assert.ok(position + 8 + size <= file.length, `${path} contains a complete WAV chunk`)
      chunks.set(file.subarray(position, position + 4).toString(), file.subarray(position + 8, position + 8 + size))
      position += 8 + size + (size % 2)
    }
    const format = chunks.get('fmt '), data = chunks.get('data')
    assert.ok(format && data, `${path} contains format and recording data`)
    assert.equal(format.readUInt16LE(0), 1, 'uncompressed PCM')
    assert.equal(format.readUInt16LE(2), path.endsWith('finger-snap.wav') ? 1 : 2)
    assert.equal(format.readUInt32LE(4), path.endsWith('finger-snap.wav') ? 48000 : 44100)
    assert.equal(format.readUInt16LE(14), 16)
    const seconds = data.length / format.readUInt32LE(8)
    // Playback already clamps to the source tail; chip-lay-1 is slightly shorter
    // than its nominal .13-second clip after the .04-second leading offset.
    assert.ok(Math.min(duration, seconds - offset) > .05, `${path} retains an audible window after its scheduling offset`)
    bytes += file.length
  }
  assert.ok(bytes < 1_700_000)
  assert.equal(readdirSync(resolve(root, 'assets/audio')).filter(name => name.endsWith('.wav')).length, 14)
  assert.match(readFileSync(resolve(root, 'assets/audio/License.txt'), 'utf8'), /Creative Commons Zero, CC0/)
})

test('a gesture creates one context and each recording fetches/decodes once across unlock and reset', async () => {
  const f = fixture()
  try {
    assert.equal(f.contexts.length, 0)
    await f.ready()
    f.audio.unlock(); f.audio.unlock(); f.audio.reset(); f.audio.unlock()
    await tick()
    assert.equal(f.contexts.length, 1)
    assert.equal(f.requests.length, 14)
    assert.equal(f.decoded.length, 14)
    assert.equal(new Set(f.requests).size, 14)
    assert.equal(f.sources.length, 0)
  } finally { f.restore() }
})

test('dealing uses player card count and exact 65 ms spacing; flop/turn/river play only new board cards', async () => {
  const f = fixture()
  try {
    await f.ready()
    f.audio.event(event(1, 'HAND_PREPARED'))
    f.audio.event(event(2, 'HAND_STARTED'))
    f.audio.event(event(3, 'CARDS_DEALT', { cardCount: 4 }))
    assert.equal(f.sources.length, 4)
    f.sources.forEach((source, i) => {
      assert.match(source.buffer.url, /card-slide-/)
      assert.ok(Math.abs(source.started[0] - (10 + i * .065)) < 1e-9)
      assert.ok(source.started[2] <= .225)
    })
    f.clear()
    f.audio.event(event(4, 'STREET_CHANGED', { board: ['Ac', 'Kd', 'Qh'] }))
    assert.equal(f.sources.length, 7)
    f.audio.event(event(5, 'STREET_CHANGED', { board: ['Ac', 'Kd', 'Qh', 'Js'] }))
    assert.equal(f.sources.length, 8)
    f.audio.event(event(6, 'STREET_CHANGED', { board: ['Ac', 'Kd', 'Qh', 'Js', '2c'] }))
    assert.equal(f.sources.length, 9)
    f.audio.event(event(7, 'STREET_CHANGED', { board: ['Ac', 'Kd', 'Qh', 'Js', '2c'] }))
    assert.equal(f.sources.length, 9)
    f.audio.event(event(8, 'CARDS_DEALT'))
    assert.equal(f.sources.length, 17, 'Legacy events fall back to eight hole cards')
  } finally { f.restore() }
})

test('fold/check/call/bet/raise/all-in/payout use distinct samples; world audio waits for the visual snap', async () => {
  const f = fixture()
  try {
    await f.ready()
    const names = []
    let seq = 1
    for (const type of ['fold', 'check', 'call', 'bet', 'raise', 'allIn']) {
      const before = f.sources.length
      f.audio.event(event(seq++, 'PLAYER_ACTED', { action: { type } }))
      names.push(f.sources.slice(before).map(source => source.buffer.url.split('/').at(-1)))
      f.clear()
    }
    assert.deepEqual(names, [
      ['card-shove-1.wav'], ['chip-lay-2.wav', 'chip-lay-2.wav'], ['chip-lay-1.wav'],
      ['chips-stack-1.wav'], ['chips-stack-1.wav', 'chips-collide-1.wav'],
      ['chips-handle-1.wav', 'chips-stack-1.wav', 'chips-collide-1.wav'],
    ])
    assert.ok(Math.abs(f.sources[2].started[0] - f.sources[1].started[0] - .095) < 1e-9)
    const beforeWorld = f.sources.length
    f.audio.event(event(seq++, 'WORLD_CHANGED', { worldMode: 'MIRROR' }))
    assert.equal(f.sources.length, beforeWorld, 'presentation owns the snap sound at finger release')
    f.audio.event(event(seq++, 'PAYOUT'))
    assert.deepEqual(f.sources.slice(-3).map(source => source.buffer.url.split('/').at(-1)), ['chips-handle-1.wav', 'chips-stack-1.wav', 'chips-collide-1.wav'])
  } finally { f.restore() }
})

test('a stream attaching on the turn or river plays only that new card without catching up skipped streets', async () => {
  const f = fixture()
  try {
    await f.ready()
    // Resync snapshots have no events, so the first sound event can be a four-card turn.
    f.audio.event(event(20, 'STREET_CHANGED', { board: ['Ac', 'Kd', 'Qh', 'Js'] }))
    assert.equal(f.sources.length, 1)
    f.audio.event(event(21, 'STREET_CHANGED', { board: ['Ac', 'Kd', 'Qh', 'Js', '2c'] }))
    assert.equal(f.sources.length, 2)
    f.audio.event(event(22, 'STREET_CHANGED', { board: ['Ac', 'Kd', 'Qh', 'Js', '2c'] }))
    assert.equal(f.sources.length, 2)
    f.audio.reset()
    f.audio.event(event(30, 'STREET_CHANGED', { board: ['Ac', 'Kd', 'Qh', 'Js', '2c'] }))
    assert.equal(f.sources.length, 3, 'A first river event is one card, not an entire board')
  } finally { f.restore() }
})

test('mute cancels every current/future card and consumes events without replay on unmute', async () => {
  const f = fixture()
  try {
    await f.ready()
    f.audio.event(event(1, 'CARDS_DEALT', { cardCount: 8 }))
    assert.equal(f.sources.length, 8)
    f.audio.setMuted(true)
    assert.ok(f.sources.every(source => source.cancelled && !source.connected))
    assert.equal(f.gains[0].gain.value, 0)
    f.audio.event(event(2, 'STREET_CHANGED', { board: ['Ac', 'Kd', 'Qh'] }))
    f.audio.event(event(3, 'PLAYER_ACTED', { action: { type: 'raise' } }))
    f.audio.setMuted(false)
    assert.equal(f.sources.length, 8)
    f.audio.event(event(3, 'PLAYER_ACTED', { action: { type: 'raise' } }))
    assert.equal(f.sources.length, 8)
    f.audio.event(event(4, 'STREET_CHANGED', { board: ['Ac', 'Kd', 'Qh', 'Js'] }))
    assert.equal(f.sources.length, 9, 'Muted flop still updates board count; unmuted turn is one card')
  } finally { f.restore() }
})

test('locked/loading/duplicate/out-of-order events never play later; reset starts a fresh event stream', async () => {
  const f = fixture({ deferred: true })
  try {
    const first = event(1, 'CARDS_DEALT', { cardCount: 4 })
    f.audio.event(first)
    f.audio.unlock(); await tick()
    const loading = event(2, 'PLAYER_ACTED', { action: { type: 'fold' } })
    f.audio.event(loading)
    await f.ready()
    assert.equal(f.sources.length, 0)
    f.audio.event(first); f.audio.event(loading)
    f.audio.event(event(3, 'PLAYER_ACTED', { action: { type: 'call' } }))
    assert.equal(f.sources.length, 1)
    f.audio.event({ ...event(4, 'CARDS_DEALT'), eventId: 'event-3' })
    f.audio.event({ ...event(3, 'CARDS_DEALT'), eventId: 'different-id' })
    assert.equal(f.sources.length, 1)
    f.audio.reset()
    f.audio.event(first)
    assert.equal(f.sources.length, 5)
    assert.equal(f.requests.length, 14)
  } finally { f.restore() }
})

test('voice cap bounds bursts and dispose stops playback without restarting a context', async () => {
  const f = fixture()
  try {
    await f.ready()
    for (let seq = 1; seq <= 10; seq++) f.audio.event(event(seq, 'CARDS_DEALT', { cardCount: 8 }))
    assert.equal(f.sources.filter(source => !source.cancelled).length, 12)
    f.audio.dispose()
    assert.ok(f.sources.every(source => source.cancelled))
    assert.equal(f.contexts[0].state, 'closed')
    const count = f.sources.length
    f.audio.unlock(); f.audio.event(event(11, 'CARDS_DEALT'))
    assert.equal(f.sources.length, count)
    assert.equal(f.contexts.length, 1)
  } finally { f.restore() }
})

test('context suspension cancels existing deal, snap and warning voices without replay after resume', async () => {
  for (const state of ['suspended', 'interrupted']) {
    for (const cue of ['deal', 'snap', 'warning']) {
      const f = fixture()
      try {
        await f.ready()
        const play = seq => {
          if (cue === 'deal') f.audio.event(event(seq, 'CARDS_DEALT', { cardCount: 8 }))
          else if (cue === 'snap') f.audio.snap()
          else f.audio.turnWarning()
        }
        play(1)
        const voices = [...f.sources, ...f.oscillators]
        assert.equal(voices.length, cue === 'deal' ? 8 : 1)
        const context = f.contexts[0]
        context.state = state
        context.onstatechange()
        assert.ok(voices.every(voice => voice.cancelled && !voice.connected), `${cue}: ${state} must cancel the existing graph`)
        play(2)
        assert.equal(f.sources.length + f.oscillators.length, voices.length, 'Suspended events must be consumed')
        context.state = 'running'
        context.onstatechange()
        f.audio.unlock()
        assert.equal(f.sources.length + f.oscillators.length, voices.length, 'Resuming cannot replay old cues')
        play(3)
        assert.equal(f.sources.length + f.oscillators.length, voices.length * 2, 'A fresh cue after resume still plays')
        assert.equal(f.requests.length, 14, 'Resume keeps the decoded sample cache')
        f.audio.dispose()
        assert.equal(context.onstatechange, null, 'Dispose detaches the context lifecycle handler')
      } finally { f.restore() }
    }
  }
})

test('unlock cancels frozen voices before resume even before statechange dispatches', async () => {
  const f = fixture()
  try {
    await f.ready()
    f.audio.event(event(1, 'CARDS_DEALT', { cardCount: 8 }))
    f.audio.snap()
    f.audio.turnWarning()
    const voices = [...f.sources, ...f.oscillators], context = f.contexts[0]
    context.state = 'suspended' // Its notification is still queued when the gesture arrives.
    assert.ok(voices.every(voice => !voice.cancelled))
    f.audio.unlock()
    assert.equal(context.resumeCalls, 1)
    assert.equal(context.state, 'running')
    assert.ok(voices.every(voice => voice.cancelled && !voice.connected))
    assert.equal(f.sources.length + f.oscillators.length, voices.length)
    f.audio.snap()
    assert.equal(f.sources.length + f.oscillators.length, voices.length + 1)
  } finally { f.restore() }
})

test('failed sample loading is silent and is not retried per event or unlock', async () => {
  const f = fixture({ fail: true })
  try {
    await f.ready()
    f.audio.event(event(1, 'CARDS_DEALT'))
    f.audio.unlock(); await tick()
    assert.equal(f.requests.length, 14)
    assert.equal(f.decoded.length, 0)
    assert.equal(f.sources.length, 0)
  } finally { f.restore() }
})

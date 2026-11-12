import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
mkdirSync(resolve(root, '.test-output'), { recursive: true })
const build = spawnEsbuild(['tests/audio-v2-entry.ts', '--bundle', '--platform=node', '--format=esm', '--outfile=.test-output/audio-snap-v15-bundle.mjs'], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, build.stderr)
const { createAudio } = await import('../.test-output/audio-snap-v15-bundle.mjs')
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture({ deferred = false, fail = false } = {}) {
  const originalContext = globalThis.AudioContext, originalFetch = globalThis.fetch
  const sources = [], contexts = [], requests = [], decoded = [], pending = []
  class Node {
    connected = true
    connect() {}
    disconnect() { this.connected = false }
  }
  const parameter = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} })
  class Context {
    state = 'running'
    currentTime = 10
    destination = {}
    constructor() { contexts.push(this) }
    createGain() { return Object.assign(new Node(), { gain: parameter() }) }
    // No createBuffer or oscillator: a finger snap must use its decoded recording.
    createBufferSource() {
      const source = Object.assign(new Node(), { onended: null, playbackRate: parameter(),
        start(...args) { this.started = args }, stop(time) { if (time === undefined) this.cancelled = true },
        finish() { this.onended?.() },
      })
      sources.push(source)
      return source
    }
    async decodeAudioData(bytes) {
      decoded.push(bytes.url)
      if (deferred) await new Promise(resolve => pending.push(resolve))
      return { duration: .2, url: bytes.url }
    }
    async resume() { this.state = 'running' }
    async close() { this.state = 'closed' }
  }
  globalThis.AudioContext = Context
  globalThis.fetch = async url => {
    requests.push(url)
    if (fail) throw new Error('recording unavailable')
    return { ok: true, arrayBuffer: async () => ({ url }) }
  }
  const audio = createAudio()
  const ready = async () => { audio.unlock(); await tick(); pending.splice(0).forEach(resolve => resolve()); await tick() }
  return { audio, sources, contexts, requests, decoded, ready,
    close() { audio.dispose(); globalThis.AudioContext = originalContext; globalThis.fetch = originalFetch } }
}

test('snap uses one cached decoded natural recording at release without synthesizing a substitute', async () => {
  const f = fixture()
  try {
    f.audio.snap(); assert.equal(f.contexts.length, 0)
    await f.ready()
    f.audio.snap()
    assert.equal(f.sources.length, 1)
    assert.deepEqual(f.sources[0].started, [10, 0, .2])
    assert.equal(f.sources[0].buffer.url, 'assets/audio/finger-snap.wav')
    f.audio.snap(); f.audio.unlock(); f.audio.reset(); f.audio.unlock()
    await tick()
    assert.equal(f.sources[1].buffer, f.sources[0].buffer)
    assert.equal(f.requests.filter(url => url.endsWith('finger-snap.wav')).length, 1)
    assert.equal(f.decoded.filter(url => url.endsWith('finger-snap.wav')).length, 1)
    f.sources[0].finish()
    assert.equal(f.sources[0].connected, false)
  } finally { f.close() }
})

test('locked or loading snaps are consumed and never replay when decoding completes', async () => {
  const f = fixture({ deferred: true })
  try {
    f.audio.snap()
    f.audio.unlock(); await tick(); f.audio.snap()
    assert.equal(f.sources.length, 0)
    await f.ready()
    assert.equal(f.sources.length, 0, 'Loading completion must not play a late snap')
    f.audio.snap()
    assert.equal(f.sources.length, 1, 'Only a new presentation release may play')
  } finally { f.close() }
})

test('snap obeys mute/unlock/suspension and shared reset, voice cap and disposal', async () => {
  const f = fixture()
  try {
    await f.ready()
    f.audio.snap(); f.audio.setMuted(true)
    assert.ok(f.sources[0].cancelled && !f.sources[0].connected)
    f.audio.snap(); assert.equal(f.sources.length, 1)
    f.audio.setMuted(false); assert.equal(f.sources.length, 1)
    f.contexts[0].state = 'suspended'; f.audio.snap(); assert.equal(f.sources.length, 1)
    f.contexts[0].state = 'running'
    for (let i = 0; i < 15; i++) f.audio.snap()
    assert.equal(f.sources.filter(source => !source.cancelled).length, 12)
    f.audio.reset(); assert.ok(f.sources.every(source => source.cancelled))
    f.audio.dispose(); f.audio.snap(); f.audio.unlock()
    assert.equal(f.contexts.length, 1)
    assert.equal(f.contexts[0].state, 'closed')
  } finally { f.close() }
})

test('failed recordings are silent without synthetic fallback, retries or deferred playback', async () => {
  const f = fixture({ fail: true })
  try {
    await f.ready()
    f.audio.snap(); f.audio.unlock(); await tick(); f.audio.snap()
    assert.equal(f.sources.length, 0)
    assert.equal(f.decoded.length, 0)
    assert.equal(f.requests.filter(url => url.endsWith('finger-snap.wav')).length, 1)
  } finally { f.close() }
})

test('authoritative world events wait for the presentation release before playing the recording', async () => {
  const f = fixture()
  try {
    await f.ready()
    f.audio.event({ handId: 'hand-1', eventId: 'world-1', seq: 1, type: 'WORLD_CHANGED', worldMode: 'MIRROR' })
    assert.equal(f.sources.length, 0)
    f.audio.snap()
    assert.equal(f.sources.length, 1)
  } finally { f.close() }
})

test('the short PCM recording retains its creator, source, adaptation and CC0 provenance', () => {
  const bytes = readFileSync(resolve(root, 'assets/audio/finger-snap.wav'))
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF')
  assert.equal(bytes.subarray(8, 12).toString(), 'WAVE')
  assert.ok(bytes.length < 20_000)
  const license = readFileSync(resolve(root, 'assets/audio/finger-snap-license.txt'), 'utf8')
  assert.match(license, /Joseph SARDIN/)
  assert.match(license, /Creative Commons Zero, CC0 1.0 Universal/)
  assert.match(license, /https:\/\/bigsoundbank.com\/finger-clashes-s0483.html/)
  assert.ok(license.includes(createHash('sha256').update(bytes).digest('hex')))
})

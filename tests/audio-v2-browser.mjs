// Real Chromium WAV decode/offline signal check. No hosted runtime or listening claim.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { spawnEsbuild } from '../scripts/test-tools.mjs'

const root = path.resolve(import.meta.dirname, '..')
const { chromium } = await import('@playwright/test')
let executablePath = process.env.MIRROR_CHROMIUM

const source = await fs.readFile(path.join(root, 'audio/index.ts'), 'utf8')
const built = spawnEsbuild(['tests/audio-v2-entry.ts', '--bundle', '--platform=browser', '--format=esm'], { cwd: root, encoding: 'utf8' })
assert.equal(built.status, 0, built.stderr)
const productionAudioModule = built.stdout
const clips = [...source.matchAll(/(\w+): \{ url: '([^']+)', offset: ([.\d]+), duration: ([.\d]+) \}/g)]
  .map(([, name, url, offset, duration]) => ({ name, url, offset: Number(offset), duration: Number(duration) }))
assert.equal(clips.length, 14)
assert.ok(clips.every(clip => clip.url.endsWith('.wav')), 'Every production recording must use a supported upload format')
const origin = 'http://mirror-audio.local'
const browser = await chromium.launch({channel:"chromium", headless: true, ...(executablePath ? { executablePath } : {}) })
let report
try {
  const page = await browser.newPage()
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) return route.abort()
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Local audio decode check</title>' })
    if (url.pathname === '/audio.mjs') return route.fulfill({ contentType: 'text/javascript', body: productionAudioModule })
    if (!clips.some(clip => '/' + clip.url === url.pathname)) return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ contentType: 'audio/wav', body: await fs.readFile(path.join(root, '.' + url.pathname)) })
  })
  await page.goto(origin)
  report = await page.evaluate(async clips => {
    const decoder = new OfflineAudioContext(2, 44100, 44100)
    const decoded = new Map()
    const descriptions = []
    for (const clip of clips) {
      const response = await fetch(clip.url)
      const buffer = await decoder.decodeAudioData(await response.arrayBuffer())
      decoded.set(clip.name, buffer)
      descriptions.push({ name: clip.name, seconds: buffer.duration, channels: buffer.numberOfChannels, sampleRate: buffer.sampleRate })
    }
    const mixes = []
    for (const kind of ['deal-eight', 'actions-and-chips']) {
      const context = new OfflineAudioContext(2, 44100, 44100)
      const names = kind === 'deal-eight' ? ['slide1', 'slide2', 'slide3', 'slide4', 'slide1', 'slide2', 'slide3', 'slide4'] : ['fold', 'tap2', 'tap2', 'stack', 'collide', 'handle']
      names.forEach((name, index) => {
        const clip = clips.find(clip => clip.name === name)
        const node = context.createBufferSource(), gain = context.createGain()
        node.buffer = decoded.get(name)
        const start = index * (kind === 'deal-eight' ? .065 : .095), end = start + clip.duration
        gain.gain.setValueAtTime(0, start)
        gain.gain.linearRampToValueAtTime(.32 * .58, start + .002)
        gain.gain.setValueAtTime(.32 * .58, end - .012)
        gain.gain.linearRampToValueAtTime(0, end)
        node.connect(gain); gain.connect(context.destination)
        node.start(start, clip.offset, clip.duration)
      })
      const rendered = await context.startRendering()
      let peak = 0, energy = 0, nonzero = 0
      for (const value of rendered.getChannelData(0)) {
        peak = Math.max(peak, Math.abs(value)); energy += value * value; if (Math.abs(value) > .00001) nonzero++
      }
      mixes.push({ kind, peak, rms: Math.sqrt(energy / rendered.length), nonzeroFrames: nonzero })
    }
    const { createAudio } = await import('/audio.mjs')
    const originalContext = globalThis.AudioContext
    const contexts = [], snapCases = []
    // createAudio requires a running gesture-unlocked context. This adapter uses
    // native Chromium audio nodes/buffers while rendering their production graph
    // offline, with explicit lifecycle state instead of opening an audio device.
    class SnapOfflineContext {
      state = 'running'
      offline = new OfflineAudioContext(1, 12000, 48000)
      sources = []
      decoding = []
      constructor() { contexts.push(this) }
      get currentTime() { return this.offline.currentTime }
      get sampleRate() { return this.offline.sampleRate }
      get destination() { return this.offline.destination }
      createGain() { return this.offline.createGain() }
      createBufferSource() { const node = this.offline.createBufferSource(); this.sources.push(node); return node }
      decodeAudioData(...args) { const pending = this.offline.decodeAudioData(...args); this.decoding.push(pending); return pending }
      async resume() { this.state = 'running' }
      async close() { this.state = 'closed' }
    }
    const signal = buffer => {
      let peak = 0, energy = 0, nonzero = 0, finite = true, firstAttack = null, frame = 0
      for (const value of buffer.getChannelData(0)) {
        finite &&= Number.isFinite(value)
        peak = Math.max(peak, Math.abs(value)); energy += value * value; if (Math.abs(value) > .00001) nonzero++
        if (firstAttack === null && Math.abs(value) > .01) firstAttack = frame / buffer.sampleRate
        frame++
      }
      return { peak, rms: Math.sqrt(energy / buffer.length), nonzeroFrames: nonzero, finite, seconds: buffer.duration, firstAttack }
    }
    let lockedContextCount = -1, snapSource = null
    try {
      globalThis.AudioContext = SnapOfflineContext
      const locked = createAudio()
      locked.snap(); lockedContextCount = contexts.length; locked.dispose()
      for (const kind of ['snap', 'muted-before', 'muted-after', 'reset', 'disposed', 'suspended']) {
        const audio = createAudio()
        audio.unlock()
        const context = contexts.at(-1)
        const deadline = Date.now() + 10000
        while (context.decoding.length < clips.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
        if (context.decoding.length !== clips.length) throw new Error('Recording requests did not reach native decoding')
        await Promise.all(context.decoding)
        if (kind === 'muted-before') audio.setMuted(true)
        if (kind === 'suspended') context.state = 'suspended'
        audio.snap()
        if (kind === 'snap') snapSource = signal(context.sources[0].buffer)
        if (kind === 'muted-before') audio.setMuted(false) // No queued replay.
        if (kind === 'muted-after') audio.setMuted(true)
        if (kind === 'reset') audio.reset()
        if (kind === 'disposed') { audio.dispose(); audio.snap(); audio.unlock() }
        const rendered = await context.offline.startRendering()
        snapCases.push({ kind, sources: context.sources.length, ...signal(rendered) })
        audio.dispose()
      }
    } finally {
      globalThis.AudioContext = originalContext
    }
    const suspensionCases = [], nativeContexts = []
    // A sinkless native context advances its real audio clock without requiring
    // an output device. Unlike the offline lifecycle adapter, suspend/resume and
    // statechange dispatch here are Chromium's own implementations.
    class SuspensionContext extends originalContext {
      voices = []
      decoded = 0
      constructor() {
        super({ sinkId: { type: 'none' } })
        this.monitor = this.createAnalyser()
        this.monitor.fftSize = 2048
        this.monitor.connect(super.destination)
        nativeContexts.push(this)
      }
      get destination() { return this.monitor ?? super.destination }
      decodeAudioData(...args) { return super.decodeAudioData(...args).then(buffer => { this.decoded++; return buffer }) }
      track(node, kind) {
        const voice = { kind, cancelled: false, disconnected: false }
        const stop = node.stop.bind(node), disconnect = node.disconnect.bind(node)
        node.stop = (...args) => { if (args.length === 0) voice.cancelled = true; return stop(...args) }
        node.disconnect = (...args) => { voice.disconnected = true; return disconnect(...args) }
        this.voices.push(voice)
        return node
      }
      createBufferSource() { return this.track(super.createBufferSource(), 'sample') }
      createOscillator() { return this.track(super.createOscillator(), 'warning') }
      peak() {
        const values = new Float32Array(this.monitor.fftSize)
        this.monitor.getFloatTimeDomainData(values)
        let peak = 0
        for (const value of values) peak = Math.max(peak, Math.abs(value))
        return peak
      }
    }
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
    const until = async predicate => {
      const deadline = Date.now() + 10000
      while (!predicate() && Date.now() < deadline) await pause(5)
      if (!predicate()) throw new Error('Native audio lifecycle did not settle')
    }
    try {
      globalThis.AudioContext = SuspensionContext
      for (const kind of ['deal', 'snap', 'warning']) {
        const audio = createAudio()
        audio.unlock()
        const context = nativeContexts.at(-1)
        await until(() => context.decoded === clips.length && context.state === 'running')
        const play = seq => {
          if (kind === 'deal') audio.event({ handId: 'native-suspend', seq, eventId: `native-${seq}`, type: 'CARDS_DEALT', cardCount: 8 })
          else if (kind === 'snap') audio.snap()
          else audio.turnWarning()
        }
        play(1)
        const originalVoices = context.voices.slice()
        await context.suspend()
        await pause(20) // Allow the native statechange notification to dispatch.
        const cancelledAtSuspend = originalVoices.every(voice => voice.cancelled && voice.disconnected)
        const frozenTime = context.currentTime
        play(2) // Consumed during suspension, never queued.
        await pause(700) // Longer than the complete eight-card sound sequence.
        const frozen = context.currentTime === frozenTime
        audio.unlock()
        await until(() => context.state === 'running')
        await pause(60)
        const resumedPeak = context.peak(), voicesAfterResume = context.voices.length
        play(3)
        await pause(25)
        const freshPeak = context.peak(), voicesAfterFreshCue = context.voices.length
        audio.dispose()
        suspensionCases.push({ kind, originalVoices: originalVoices.length, cancelledAtSuspend, frozen,
          voicesAfterResume, resumedPeak, voicesAfterFreshCue, freshPeak, listenerDetached: context.onstatechange === null })
      }
    } finally {
      globalThis.AudioContext = originalContext
      await Promise.all(nativeContexts.filter(context => context.state !== 'closed').map(context => context.close()))
    }
    return { kind: 'LOCAL CHROMIUM AUDIO: OFFLINE SIGNAL + NATIVE LIFECYCLE — NOT HOSTED RUNTIME OR HUMAN LISTENING', decoded: descriptions, mixes,
      snap: { lockedContextCount, source: snapSource, cases: snapCases }, suspension: suspensionCases }
  }, clips)
  assert.equal(report.decoded.length, 14)
  assert.ok(report.decoded.every(clip => clip.channels === (clip.name === 'snap' ? 1 : 2) && clip.seconds > .1))
  assert.ok(report.mixes.every(mix => mix.peak > .005 && mix.peak < 1 && mix.rms > .0001 && mix.nonzeroFrames > 1000))
  assert.equal(report.snap.lockedContextCount, 0)
  assert.ok(report.snap.source.finite && report.snap.source.peak > .8 && report.snap.source.peak < 1)
  assert.equal(report.snap.source.seconds, .2)
  assert.ok(report.snap.source.firstAttack >= 0 && report.snap.source.firstAttack < .005, 'Natural transient stays aligned with the presentation cue')
  const renderedSnap = report.snap.cases.find(item => item.kind === 'snap')
  assert.ok(renderedSnap.finite && renderedSnap.peak > .02 && renderedSnap.peak < 1 && renderedSnap.rms > .001 && renderedSnap.nonzeroFrames > 1000)
  for (const result of report.snap.cases.filter(item => item.kind !== 'snap')) {
    assert.ok(result.finite && result.peak === 0 && result.rms === 0 && result.nonzeroFrames === 0, `${result.kind} must render silence`)
  }
  for (const result of report.suspension) {
    assert.equal(result.originalVoices, result.kind === 'deal' ? 8 : 1)
    assert.ok(result.cancelledAtSuspend && result.frozen && result.listenerDetached, `${result.kind}: suspension cancels the frozen graph and disposal detaches its handler`)
    assert.equal(result.voicesAfterResume, result.originalVoices, `${result.kind}: resume must not replay a consumed cue`)
    assert.equal(result.resumedPeak, 0, `${result.kind}: resumed graph must stay silent`)
    assert.equal(result.voicesAfterFreshCue, result.originalVoices * 2)
    assert.ok(result.freshPeak > .0001 && result.freshPeak < 1, `${result.kind}: a fresh cue must still produce unclipped audio`)
  }
  await fs.mkdir(path.join(root, '.test-output'), { recursive: true })
  await fs.writeFile(path.join(root, '.test-output/audio-v2-browser.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
}

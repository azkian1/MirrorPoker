import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
mkdirSync(resolve(root, '.test-output'), { recursive: true })
const built = spawnEsbuild(['client/result-presentation.ts', '--bundle', '--platform=node', '--format=esm', '--outfile=.test-output/result-v6-bundle.mjs'], { cwd: root, encoding: 'utf8' })
assert.equal(built.status, 0, built.stderr)
const { createResultPresentation, FINAL_HAND_VIEW_MS } = await import('../.test-output/result-v6-bundle.mjs')

const state = (overrides = {}) => ({ handId: 'last', stage: 'COMPLETE', match: { status: 'FINISHED', placements: [{ playerId: 'hero', place: 1, reason: 'winner' }], winnerId: 'hero' }, ...overrides })
const self = (handId = 'last') => ({ handId, playerId: 'hero' })

test('the final result waits for the last visible card motion and then 2.5 seconds of rendered viewing', () => {
  const gate = createResultPresentation()
  gate.observe(state(), self())
  assert.equal(gate.frame(0, false, true), null)
  assert.equal(gate.frame(30000, false, true), null, 'time spent laying cards is not reading time')
  assert.equal(gate.frame(30010, true, true), null)
  assert.equal(gate.frame(30010 + FINAL_HAND_VIEW_MS - 1, true, true), null)
  assert.equal(gate.frame(30010 + FINAL_HAND_VIEW_MS, true, true), 'last')
  assert.equal(gate.frame(90000, true, true), 'last')
})

test('duplicate snapshots of the paid hand preserve progress and reconnect without events still gets a viewing pause', () => {
  const gate = createResultPresentation()
  gate.observe(state(), self())
  assert.equal(gate.frame(0, true, true), null)
  assert.equal(gate.frame(1200, true, true), null)
  gate.observe(state({ seq: 99 }), self())
  assert.equal(gate.frame(2500, true, true), 'last')
  const reconnect = createResultPresentation()
  reconnect.observe(state({ seq: 999 }), self())
  assert.equal(reconnect.frame(70000, true, true), null)
  assert.equal(reconnect.frame(72500, true, true), 'last')
})

test('a late card animation restarts the reading pause rather than covering the new reveal', () => {
  const gate = createResultPresentation()
  gate.observe(state(), self())
  gate.frame(0, true, true)
  gate.frame(2000, true, true)
  assert.equal(gate.frame(2100, false, true), null)
  assert.equal(gate.frame(3000, true, true), null)
  assert.equal(gate.frame(5499, true, true), null)
  assert.equal(gate.frame(5500, true, true), 'last')
})

test('background time never counts, even if the browser completely suspends animation frames', () => {
  const gate = createResultPresentation()
  gate.observe(state(), self())
  gate.frame(0, true, true)
  gate.frame(1000, true, true)
  gate.suspend()
  assert.equal(gate.frame(60000, true, true), null)
  assert.equal(gate.frame(61499, true, true), null)
  assert.equal(gate.frame(61500, true, true), 'last')
  const hidden = createResultPresentation()
  hidden.observe(state(), self())
  assert.equal(hidden.frame(0, true, false), null)
  assert.equal(hidden.frame(50000, true, false), null)
  assert.equal(hidden.frame(60000, true, true), null)
  assert.equal(hidden.frame(62500, true, true), 'last')
})

test('a shown placement stays visible as other multiplayer hands start; session reset and absent placements clear it', () => {
  const gate = createResultPresentation()
  gate.observe(state(), self())
  gate.frame(0, true, true)
  assert.equal(gate.frame(2500, true, true), 'last')
  gate.observe(state({ handId: 'next' }), self('next'))
  assert.equal(gate.readyHand(), 'next')
  assert.equal(gate.frame(9000, false, true), 'next', 'the eliminated observer does not wait for unrelated new cards')
  gate.reset()
  assert.equal(gate.frame(90000, true, true), null)
  gate.observe(state(), self('old'))
  assert.equal(gate.frame(100000, true, true), null)
  gate.observe(state({ match: { status: 'PLAYING', placements: [], winnerId: null } }), self())
  assert.equal(gate.frame(110000, true, true), null)
  gate.observe(null, null)
  assert.equal(gate.frame(120000, true, true), null)
})

test('a hand change before readiness starts fresh and cannot inherit an unfinished reading pause', () => {
  const gate = createResultPresentation()
  gate.observe(state(), self())
  gate.frame(0, true, true)
  gate.frame(2000, true, true)
  gate.observe(state({ handId: 'next' }), self('next'))
  assert.equal(gate.readyHand(), null)
  assert.equal(gate.frame(2100, true, true), null)
  assert.equal(gate.frame(4599, true, true), null)
  assert.equal(gate.frame(4600, true, true), 'next')
})

test('a multiplayer elimination waits for its cards without delaying the continuing table or enabling actions', () => {
  const gate = createResultPresentation()
  gate.observe(state({ match: { status: 'PLAYING', placements: [{ playerId: 'hero', place: 4, reason: 'eliminated' }], winnerId: null } }), self())
  assert.equal(gate.frame(0, false, true), null)
  assert.equal(gate.frame(1000, true, true), 'last')
})

test('invalid and backwards timestamps never advance a final result ahead of monotonic rendered time', () => {
  const gate = createResultPresentation()
  gate.observe(state(), self())
  gate.frame(1000, true, true)
  assert.equal(gate.frame(0, true, true), null)
  assert.equal(gate.frame(2000, true, true), null)
  assert.equal(gate.frame(NaN, true, true), null)
  assert.equal(gate.frame(5000, true, true), null)
  assert.equal(gate.frame(6499, true, true), null)
  assert.equal(gate.frame(6500, true, true), 'last')
})

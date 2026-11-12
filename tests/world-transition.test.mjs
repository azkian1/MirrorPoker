import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
mkdirSync(resolve(root, '.test-output'), { recursive: true })
const built = spawnEsbuild(['tests/world-transition-entry.ts', '--bundle', '--platform=node', '--format=esm', '--outfile=.test-output/world-transition-bundle.mjs'], { cwd: root, encoding: 'utf8' })
assert.equal(built.status, 0, built.stderr)
const { createWorldTransition, StateReceiver, DEALER_SNAP } = await import('../.test-output/world-transition-bundle.mjs')

const state = (overrides = {}) => ({
  handId: 'hand-1', seq: 1, stage: 'COMPLETE', worldMode: 'NORMAL', players: [], board: [],
  pot: 0, actorId: null, dealerSeat: 0, smallBlind: 10, bigBlind: 20, currentBet: 0,
  minRaise: 20, winners: [], match: { status: 'PLAYING', placements: [], winnerId: null }, ...overrides,
})
const event = (seq, type = 'WORLD_CHANGED', overrides = {}) => ({
  handId: 'hand-1', eventId: `event-${seq}`, seq, type, worldMode: 'MIRROR', ...overrides,
})
const snapshot = (next, events) => ({
  type: 'snapshot', state: next,
  privateState: { handId: next.handId, playerId: 'hero', cards: [], legalActions: [] },
  ...(events ? { events } : {}),
})

function fixture(initial = state()) {
  let time = 0, visible = true, snaps = 0, current = null
  const trace = []
  const transition = createWorldTransition(() => { snaps++; trace.push('snap') }, () => time)
  const receiver = new StateReceiver({
    snapshot(next, self, events) {
      current = next
      transition.observe(next, events, visible)
      trace.push({ snapshot: next.seq, mode: transition.mode(), events: events.map(value => value.eventId), self: self.handId })
    },
    event(next) { trace.push({ event: next.eventId }) },
    error(message) { trace.push({ error: message }) },
  })
  receiver.receive(snapshot(initial))
  return {
    transition, receiver, trace,
    at(value) { time = value },
    visible(value) { visible = value },
    frame() { return transition.frame(visible) },
    receive(next, events) { receiver.receive(snapshot(next, events)) },
    prepare(mode = 'MIRROR', seq = 3, handId = 'hand-1') {
      const next = state({ handId, seq, stage: 'INTERMISSION', worldMode: mode })
      const events = [event(seq - 1, 'HAND_PREPARED', { handId, worldMode: mode }), event(seq, 'WORLD_CHANGED', { handId, worldMode: mode })]
      receiver.receive(snapshot(next, events))
      return { next, events }
    },
    get snaps() { return snaps },
    get current() { return current },
  }
}

test('both world changes lift before the .72-second snap, hold, and finish lowering at 1.4 seconds', () => {
  assert.equal(DEALER_SNAP.release, .72)
  assert.equal(DEALER_SNAP.release + DEALER_SNAP.hold, .88)
  assert.equal(DEALER_SNAP.duration, 1.4)
  const f = fixture()
  for (const [worldMode, priorMode, start, seq, handId] of [
    ['MIRROR', 'NORMAL', 0, 3, 'hand-1'],
    ['NORMAL', 'MIRROR', 2000, 7, 'hand-2'],
  ]) {
    if (start) f.receive(state({ handId, seq: seq - 2, stage: 'COMPLETE', worldMode: priorMode }))
    f.at(start); f.prepare(worldMode, seq, handId)
    assert.equal(f.current.worldMode, worldMode, 'authority changes immediately')
    assert.equal(f.transition.mode(), priorMode, 'presentation keeps the old world while lifting')
    f.at(start + 719)
    assert.deepEqual(f.frame(), { mode: priorMode, age: .719 })
    const before = f.snaps
    f.at(start + 720)
    assert.deepEqual(f.frame(), { mode: worldMode, age: .72 })
    assert.equal(f.snaps, before + 1)
    f.frame(); assert.equal(f.snaps, before + 1, 'rendering the release frame twice cannot replay sound')
    f.at(start + 880); assert.deepEqual(f.frame(), { mode: worldMode, age: .88 })
    f.at(start + 1399); assert.deepEqual(f.frame(), { mode: worldMode, age: 1.399 })
    f.at(start + 1400); assert.deepEqual(f.frame(), { mode: worldMode, age: null })
    f.at(start + 1800); assert.deepEqual(f.frame(), { mode: worldMode, age: null })
    assert.equal(f.snaps, before + 1)
  }
  assert.equal(f.snaps, 2)
})

test('menu preview seeds presentation silently and the first hand still selects its own world', () => {
  for (const next of ['NORMAL', 'MIRROR']) {
    let time = 0, snaps = 0
    const transition = createWorldTransition(() => snaps++, () => time)
    transition.reset('MIRROR')
    assert.deepEqual(transition.frame(), { mode: 'MIRROR', age: null })
    assert.equal(snaps, 0)
    const authority = state({ stage: 'INTERMISSION', worldMode: next })
    transition.observe(authority, [event(1, 'WORLD_CHANGED', { worldMode: next })])
    assert.equal(authority.worldMode, next)
    assert.equal(transition.mode(), 'MIRROR')
    time = 720
    assert.equal(transition.frame().mode, next)
    assert.equal(snaps, next === 'NORMAL' ? 1 : 0)
    transition.reset()
    assert.deepEqual(transition.frame(), { mode: 'NORMAL', age: null })
  }
})

test('duplicate, clock-only, and other fresh preparation snapshots preserve the cue deadline', () => {
  const f = fixture()
  f.at(1000)
  const prepared = f.prepare()
  f.at(1300); f.receive(prepared.next, prepared.events)
  f.at(1500); f.receive(prepared.next)
  f.at(1600)
  f.receive({ ...prepared.next, seq: 4 }, [event(4, 'PLAYER_JOINED')])
  f.at(1719); assert.deepEqual(f.frame(), { mode: 'NORMAL', age: .719 })
  assert.equal(f.snaps, 0)
  f.at(1720); assert.deepEqual(f.frame(), { mode: 'MIRROR', age: .72 })
  assert.equal(f.snaps, 1)
  assert.equal(f.trace.filter(value => value.event === 'event-3').length, 1)
  assert.equal(f.trace.filter(value => value.event === 'event-4').length, 1)
})

test('initial and receiver-reset snapshots restore their world without replaying attached history', () => {
  const f = fixture(state({ stage: 'INTERMISSION', worldMode: 'MIRROR', seq: 8 }))
  assert.deepEqual(f.frame(), { mode: 'MIRROR', age: null })
  f.receiver.reset()
  f.receive(state({ stage: 'INTERMISSION', seq: 3, worldMode: 'NORMAL' }), [event(3, 'WORLD_CHANGED', { worldMode: 'NORMAL' })])
  assert.deepEqual(f.frame(), { mode: 'NORMAL', age: null })
  f.at(1000); assert.deepEqual(f.frame(), { mode: 'NORMAL', age: null })
  assert.equal(f.snaps, 0)
  assert.equal(f.trace.filter(value => value.event).length, 0)
  assert.ok(f.trace.filter(value => value.snapshot).every(value => value.events.length === 0))
})

test('a missing preparation event and a repeated world select the authoritative mode without a gesture', () => {
  const f = fixture()
  f.receive(state({ seq: 2, stage: 'INTERMISSION' }), [event(2, 'HAND_PREPARED', { worldMode: 'NORMAL' })])
  assert.deepEqual(f.frame(), { mode: 'NORMAL', age: null })
  f.receive(state({ seq: 3, stage: 'INTERMISSION', worldMode: 'MIRROR' }))
  assert.deepEqual(f.frame(), { mode: 'MIRROR', age: null })
  f.receive(state({ seq: 4, stage: 'INTERMISSION', worldMode: 'MIRROR' }), [event(4)])
  assert.deepEqual(f.frame(), { mode: 'MIRROR', age: null })
  f.at(1000); f.frame(); assert.equal(f.snaps, 0)
})

test('dealing or finishing the match during the lift commits the world and cancels the pending snap', () => {
  for (const next of [
    state({ handId: 'hand-2', seq: 5, stage: 'PREFLOP', worldMode: 'MIRROR' }),
    state({ seq: 5, stage: 'INTERMISSION', worldMode: 'MIRROR', match: { status: 'FINISHED', placements: [], winnerId: null } }),
  ]) {
    const f = fixture()
    f.prepare(); f.at(500); f.receive(next)
    assert.deepEqual(f.frame(), { mode: 'MIRROR', age: null })
    f.at(900); f.frame(); assert.equal(f.snaps, 0)
  }
})

test('hidden snapshots, hidden frames, suspension, and missed whole gestures finish silently', () => {
  for (const finish of ['snapshot', 'frame', 'suspend', 'long-gap']) {
    const f = fixture()
    const prepared = f.prepare()
    if (finish === 'snapshot') { f.visible(false); f.at(500); f.receive(prepared.next) }
    if (finish === 'frame') { f.visible(false); f.at(800); f.frame() }
    if (finish === 'suspend') { f.at(500); f.transition.suspend() }
    if (finish === 'long-gap') { f.at(10000); f.frame() }
    f.visible(true); f.at(11000)
    assert.deepEqual(f.frame(), { mode: 'MIRROR', age: null }, finish)
    assert.equal(f.snaps, 0, finish)
  }
  const hidden = fixture()
  hidden.visible(false); hidden.prepare(); hidden.visible(true); hidden.at(720)
  assert.deepEqual(hidden.frame(), { mode: 'MIRROR', age: null })
  assert.equal(hidden.snaps, 0)
})

test('reset and leaving clear the cue, restore the menu world, and permit a fresh later gesture', () => {
  for (const reset of [transition => transition.reset(), transition => transition.observe(null)]) {
    const f = fixture()
    f.prepare(); f.at(500); reset(f.transition)
    assert.deepEqual(f.frame(), { mode: 'NORMAL', age: null })
    f.at(1000); f.frame(); assert.equal(f.snaps, 0)
    f.receiver.reset(); f.receive(state())
    f.prepare(); f.at(1720); assert.deepEqual(f.frame(), { mode: 'MIRROR', age: .72 })
    assert.equal(f.snaps, 1)
  }
})

test('StateReceiver supplies only sorted, scoped, unique fresh events before their effects', () => {
  const trace = []
  const receiver = new StateReceiver({
    snapshot(next, self, events) { trace.push({ snapshot: next.seq, events: events.map(value => value.eventId), self: self.handId }) },
    event(next) { trace.push({ event: next.eventId }) },
    error(message) { trace.push({ error: message }) },
  })
  receiver.receive(snapshot(state({ seq: 10 }), [event(10)]))
  assert.deepEqual(trace, [{ snapshot: 10, events: [], self: 'hand-1' }], 'initial snapshot ignores history')
  trace.length = 0
  receiver.receive(snapshot(state({ seq: 14 }), [
    event(14), event(12), event(11), event(13, 'HAND_PREPARED', { eventId: 'event-12' }),
    event(15), event(10), event(13, 'WORLD_CHANGED', { handId: 'old-hand' }),
  ]))
  assert.deepEqual(trace, [
    { snapshot: 14, events: ['event-11', 'event-12', 'event-14'], self: 'hand-1' },
    { event: 'event-11' }, { event: 'event-12' }, { event: 'event-14' },
  ])
  trace.length = 0
  receiver.receive(snapshot(state({ seq: 14 }), [event(14)]))
  receiver.receive(snapshot(state({ seq: 14 })))
  receiver.receive(snapshot(state({ seq: 13 }), [event(13)]))
  receiver.receive(snapshot(state({ seq: 15 }), [event(15, 'WORLD_CHANGED', { eventId: 'event-12' })]))
  assert.deepEqual(trace, [
    { snapshot: 14, events: [], self: 'hand-1' },
    { snapshot: 14, events: [], self: 'hand-1' },
    { snapshot: 15, events: [], self: 'hand-1' },
  ], 'equal sequence refreshes state, stale state is ignored, and seen IDs cannot replay at a newer sequence')
  trace.length = 0
  receiver.reset()
  receiver.receive(snapshot(state({ seq: 2 }), [event(2)]))
  receiver.receive(snapshot(state({ seq: 3 }), [event(3)]))
  assert.deepEqual(trace, [
    { snapshot: 2, events: [], self: 'hand-1' },
    { snapshot: 3, events: ['event-3'], self: 'hand-1' },
    { event: 'event-3' },
  ])
})

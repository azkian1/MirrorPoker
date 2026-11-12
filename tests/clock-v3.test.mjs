import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
mkdirSync(resolve(root, '.test-output'), { recursive: true })
const build = spawnEsbuild(['tests/clock-v3-entry.ts', '--bundle', '--platform=node', '--format=esm', '--outfile=.test-output/clock-v3-bundle.mjs'], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, build.stderr)
const { createSessionClock, PokerSession } = await import('../.test-output/clock-v3-bundle.mjs')

/** Runs scheduled intervals against a monotonic fake wall clock. No renderer/RAF exists here. */
class FakeTimerHost {
  time = 0
  nextId = 1
  scheduled = 0
  cancelled = 0
  timers = new Map()
  now = () => this.time
  schedule = (callback, milliseconds) => {
    assert.ok(milliseconds > 0)
    const handle = this.nextId++
    this.timers.set(handle, { callback, interval: milliseconds, next: this.time + milliseconds })
    this.scheduled++
    return handle
  }
  cancel = handle => { if (this.timers.delete(handle)) this.cancelled++ }
  advance(milliseconds) {
    const until = this.time + milliseconds
    let guard = 0
    while (this.timers.size) {
      const due = Math.min(...[...this.timers.values()].map(timer => timer.next))
      if (due > until) break
      assert.ok(++guard < 20000, 'fake timer must terminate')
      this.time = due
      const ready = [...this.timers.entries()].filter(([, timer]) => timer.next <= due)
      for (const [handle, timer] of ready) {
        if (!this.timers.has(handle)) continue
        timer.next += timer.interval
        timer.callback()
      }
    }
    this.time = until
  }
  /** Browser was suspended: fire just one delayed interval, instead of replaying interval callbacks. */
  delayed(milliseconds) {
    this.time += milliseconds
    for (const [handle, timer] of [...this.timers]) {
      if (!this.timers.has(handle)) continue
      timer.next = this.time + timer.interval
      timer.callback()
    }
  }
}

const rng = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
function fixture({ mode = 'multiplayer', count = 2, seed = 17 } = {}) {
  const host = new FakeTimerHost(), messages = new Map(), events = []
  const session = new PokerSession({ send(id, message) {
    const log = messages.get(id) || []
    log.push(structuredClone(message)); messages.set(id, log)
    if (id === 'p0') events.push(...(message.events || []).map(event => ({ ...event, at: host.time })))
  } }, rng(seed))
  const last = (id = 'p0') => messages.get(id)?.findLast(message => message.type === 'snapshot')
  const clock = createSessionClock(dt => session.tick(dt), host)
  for (let i = 0; i < count; i++) session.join(`p${i}`, `Player ${i}`)
  session.receive('p0', { type: 'start', mode, actionId: 'start' })
  clock.start()
  let action = 0
  return {
    host, clock, session, messages, events, last,
    act(id, value) { session.receive(id, { type: 'act', handId: last().state.handId, actionId: `act-${action++}`, action: value }) },
    close() { clock.stop(); assert.equal(host.timers.size, 0) },
  }
}

test('real PokerSession selects mode and deals on wall time without any renderer frame', () => {
  const f = fixture()
  try {
    const prepared = f.last()
    assert.equal(prepared.state.stage, 'INTERMISSION')
    assert.equal(prepared.state.actorId, null)
    assert.deepEqual(prepared.privateState.cards, [])
    assert.equal(f.events.some(event => event.type === 'CARDS_DEALT'), false)
    f.host.advance(1000)
    assert.equal(f.last().state.stage, 'INTERMISSION')
    f.host.advance(1000)
    assert.equal(f.last().state.stage, 'PREFLOP')
    assert.equal(f.last().state.handId, 'hand-1')
    assert.equal(f.last().privateState.cards.length, 2)
    assert.equal(f.last().state.worldMode, prepared.state.worldMode)
    assert.equal(f.events.filter(event => event.type === 'CARDS_DEALT').length, 1)
  } finally { f.close() }
})

test('Solo bots act from the timer while the renderer remains absent', () => {
  const f = fixture({ mode: 'solo', count: 1 })
  try {
    f.host.advance(2000)
    const before = f.last().state
    const actor = before.players.find(player => player.id === before.actorId)
    assert.equal(actor.isBot, true)
    assert.equal(f.events.filter(event => event.type === 'PLAYER_ACTED').length, 0)
    f.host.advance(1000)
    const acted = f.events.filter(event => event.type === 'PLAYER_ACTED')
    assert.ok(acted.some(event => event.playerId === actor.id))
    assert.ok(f.last().state.seq > before.seq)
    assert.ok(acted.every(event => event.playerId.startsWith('bot:')), 'human input is never synthesized by a normal clock')
  } finally { f.close() }
})

test('an idle human who owes a call folds after 30 seconds of wall time', () => {
  const f = fixture()
  try {
    f.host.advance(2000)
    const actor = f.last().state.actorId
    assert.equal(f.last(actor).privateState.legalActions.some(action => action.type === 'check'), false)
    f.host.advance(29000)
    assert.equal(f.events.some(event => event.type === 'PLAYER_ACTED'), false)
    f.host.advance(1200)
    const timedOut = f.events.find(event => event.type === 'PLAYER_ACTED' && event.playerId === actor)
    assert.equal(timedOut.action.type, 'fold')
    assert.equal(f.last().state.stage, 'COMPLETE')
    assert.equal(f.events.filter(event => event.type === 'PAYOUT').length, 1)
  } finally { f.close() }
})

test('an idle human folds on expiry even when a free check is legal', () => {
  const f = fixture()
  try {
    f.host.advance(2000)
    const smallBlind = f.last().state.actorId
    f.act(smallBlind, { type: 'call' })
    const actor = f.last().state.actorId
    assert.equal(f.last(actor).privateState.legalActions.some(action => action.type === 'check'), true)
    const count = f.events.filter(event => event.type === 'PLAYER_ACTED').length
    f.host.advance(29000)
    assert.equal(f.events.filter(event => event.type === 'PLAYER_ACTED').length, count)
    f.host.advance(1200)
    const timedOut = f.events.filter(event => event.type === 'PLAYER_ACTED').slice(count)
    assert.equal(timedOut.length, 1)
    assert.equal(timedOut[0].playerId, actor)
    assert.equal(timedOut[0].action.type, 'fold')
    assert.equal(f.last().state.stage, 'COMPLETE')
  } finally { f.close() }
})

test('COMPLETE advances through the payout pause and predeal into the next hand in 4.6 seconds', () => {
  const f = fixture()
  try {
    f.host.advance(2000)
    f.act(f.last().state.actorId, { type: 'fold' })
    const completed = f.last()
    assert.equal(completed.state.stage, 'COMPLETE')
    f.host.advance(2500)
    assert.equal(f.last().state.stage, 'COMPLETE')
    f.host.advance(2100)
    assert.equal(f.last().state.stage, 'PREFLOP')
    assert.equal(f.last().state.handId, 'hand-2')
    assert.equal(f.last().privateState.cards.length, 2)
    const between = f.messages.get('p0').filter(message => message.type === 'snapshot' && message.state.stage === 'INTERMISSION' && message.state.handId === 'hand-1')
    assert.ok(between.length > 0)
    assert.ok(between.every(message => message.privateState.cards.length === 0 && message.state.board.length === 0))
    assert.equal(f.events.filter(event => event.type === 'CARDS_DEALT').length, 2)
  } finally { f.close() }
})

test('stopping and restarting cancels the timer without fast-forwarding the stopped pause', () => {
  const f = fixture()
  try {
    f.clock.start()
    assert.equal(f.host.scheduled, 1, 'start is idempotent')
    f.host.advance(1000)
    const paused = structuredClone(f.last())
    f.clock.stop(); f.clock.stop()
    assert.equal(f.host.cancelled, 1)
    f.host.advance(60000)
    assert.deepEqual(f.last(), paused)
    f.clock.start()
    assert.equal(f.host.scheduled, 2)
    f.host.advance(500)
    assert.equal(f.last().state.stage, 'INTERMISSION', 'the stopped minute was discarded')
    f.host.advance(700)
    assert.equal(f.last().state.stage, 'PREFLOP')
    assert.equal(f.events.filter(event => event.type === 'CARDS_DEALT').length, 1)
  } finally { f.close() }
})

test('late callbacks split elapsed time into finite steps of at most one second', () => {
  const host = new FakeTimerHost(), steps = []
  const clock = createSessionClock(dt => steps.push(dt), host)
  try {
    clock.start()
    host.delayed(2350)
    assert.equal(steps.length, 3)
    assert.ok(steps.every(step => Number.isFinite(step) && step > 0 && step <= 1))
    assert.ok(Math.abs(steps.reduce((sum, step) => sum + step, 0) - 2.35) < 1e-9)
    const before = steps.length
    host.delayed(86400000)
    const catchup = steps.slice(before)
    assert.equal(catchup.length, 60, 'a suspended tab must not run an unbounded catch-up loop')
    assert.equal(catchup.reduce((sum, step) => sum + step, 0), 60)
    host.advance(100)
    assert.ok(Math.abs(steps.at(-1) - .1) < 1e-9, 'discarded old time is not replayed on the next interval')
  } finally { clock.stop() }
})

test('a real session also advances safely through one heavily delayed callback', () => {
  const f = fixture({ mode: 'solo', count: 1 })
  try {
    f.host.delayed(86400000)
    assert.ok(f.last().state.handId !== 'hand-0')
    assert.ok(f.events.some(event => event.type === 'CARDS_DEALT'))
    assert.ok(f.events.some(event => event.type === 'PLAYER_ACTED'))
    assert.equal(f.host.timers.size, 1)
    assert.ok(f.last().state.players.every(player => Number.isFinite(player.stack) && player.stack >= 0))
    const state = f.last().state
    assert.equal(state.players.reduce((sum, player) => sum + player.stack, 0) + state.pot, 4000)
  } finally { f.close() }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
mkdirSync(resolve(root, '.test-output'), { recursive: true })
const build = spawnEsbuild(['tests/fold-v4-entry.ts', '--bundle', '--platform=node', '--format=esm', '--outfile=.test-output/fold-v4-bundle.mjs'], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, build.stderr)
const { THREE, createPieces, StateReceiver, ANCHORS } = await import('../.test-output/fold-v4-bundle.mjs')
globalThis.document = { createElement(name) {
  assert.equal(name, 'canvas')
  return { width: 0, height: 0, getContext() { return new Proxy({}, { get() { return () => {} } }) } }
} }

function state({ folded = [], ...overrides } = {}) {
  return {
    handId: 'hand-1', seq: 10, stage: 'PREFLOP', worldMode: 'NORMAL',
    players: Array.from({ length: 4 }, (_, seat) => ({ id: `p${seat}`, name: `Player ${seat}`, seat, stack: 1000, bet: 0, totalBet: 0, folded: folded.includes(seat), allIn: false, connected: true, isBot: seat !== 0, sittingOut: false })),
    board: [], pot: 0, actorId: 'p0', dealerSeat: 0, smallBlind: 10, bigBlind: 20, currentBet: 0, minRaise: 20, winners: [],
    ...overrides,
  }
}
const personal = handId => ({ handId: handId || 'hand-1', playerId: 'p0', cards: ['As', 'Kd'], legalActions: [] })
const fold = (seat, seq = 11, handId = 'hand-1', eventId = 'fold-1') => ({ type: 'PLAYER_ACTED', action: { type: 'fold' }, playerId: `p${seat}`, seq, handId, eventId })
function fixture() {
  const scene = new THREE.Scene(), pieces = createPieces(scene)
  const receiver = new StateReceiver({ snapshot(next, self) { pieces.apply(next, self) }, event(event) { pieces.event(event) }, error(message) { assert.fail(message) } })
  const card = (seat, index) => scene.getObjectByName(`HoleCard-${seat}-${index}`)
  const cards = seat => [card(seat, 0), card(seat, 1)]
  const snapshot = (next, events) => receiver.receive({ type: 'snapshot', state: next, privateState: personal(next.handId), ...(events ? { events } : {}) })
  const advance = seconds => { for (let left = seconds; left > 1e-9; left -= .05) pieces.update(Math.min(.05, left)) }
  return { scene, pieces, receiver, card, cards, snapshot, advance, close() { pieces.dispose(); assert.equal(scene.children.length, 0) } }
}
const allHidden = cards => cards.every(card => !card.visible)
const allVisible = cards => cards.every(card => card.visible)
function assertBacks(cards, backMaterial) {
  for (const card of cards) {
    assert.equal(card.children[1].material, backMaterial, 'the former face is replaced by the card back')
    assert.equal(card.children[2].material, backMaterial)
    assert.equal(card.rotation.z, Math.PI, 'no face-up flip during muck')
  }
}

test('own fold hides on authoritative apply, then moves both cards face down and removes them within .35s', () => {
  const f = fixture()
  try {
    f.snapshot(state())
    const back = f.card(1, 0).children[1].material
    assert.notEqual(f.card(0, 0).children[1].material, back)
    const origins = f.cards(0).map(card => card.position.clone())
    f.pieces.apply(state({ folded: [0], seq: 11 }), personal())
    assert.ok(allHidden(f.cards(0)), 'the snapshot is complete even without an event')
    f.pieces.event(fold(0))
    assert.ok(allVisible(f.cards(0)))
    assertBacks(f.cards(0), back)
    f.advance(.15)
    const muck = new THREE.Vector3(ANCHORS.deck[0], ANCHORS.deck[1] + .035, ANCHORS.deck[2] + .55)
    f.cards(0).forEach((card, i) => {
      assert.ok(card.position.distanceTo(origins[i]) > .1)
      assert.ok(card.position.distanceTo(muck) < origins[i].distanceTo(muck))
    })
    assert.ok(allVisible(f.cards(0)))
    assertBacks(f.cards(0), back)
    f.advance(.2)
    assert.ok(allHidden(f.cards(0)))
    f.snapshot(state({ folded: [0], seq: 12 }))
    assert.ok(allHidden(f.cards(0)))
  } finally { f.close() }
})

test('opponent folds use the same bounded muck at every other seat without moving stacks, D or other hands', () => {
  for (const seat of [1, 2, 3]) {
    const f = fixture()
    try {
      f.snapshot(state())
      const chips = f.scene.getObjectByName('TableChips')
      const chipData = [...chips.instanceMatrix.array], chipCount = chips.count
      const button = f.scene.getObjectByName('DealerButton').position.clone()
      const other = f.cards(0).map(card => ({ position: card.position.clone(), material: card.children[1].material }))
      const back = f.card(seat, 0).children[1].material
      f.snapshot(state({ folded: [seat], seq: 11 }), [fold(seat)])
      assert.ok(allVisible(f.cards(seat)))
      assertBacks(f.cards(seat), back)
      f.advance(.35)
      assert.ok(allHidden(f.cards(seat)))
      f.cards(0).forEach((card, i) => { assert.equal(card.visible, true); assert.ok(card.position.equals(other[i].position)); assert.equal(card.children[1].material, other[i].material) })
      assert.equal(chips.count, chipCount)
      assert.deepEqual([...chips.instanceMatrix.array], chipData)
      assert.ok(f.scene.getObjectByName('DealerButton').position.equals(button))
    } finally { f.close() }
  }
})

test('repeated IDs, a second fold ID and fresh snapshots do not restart or snap back an active muck', () => {
  const f = fixture()
  try {
    f.snapshot(state())
    const folded = state({ folded: [0], seq: 11 })
    f.snapshot(folded, [fold(0)])
    f.advance(.1)
    const midway = f.cards(0).map(card => card.position.clone())
    f.pieces.event(fold(0))
    f.snapshot(state({ folded: [0], seq: 12 }), [fold(0, 12, 'hand-1', 'fold-again')])
    f.cards(0).forEach((card, i) => assert.ok(card.position.equals(midway[i]), 'snapshot preserves the in-flight pose'))
    f.advance(.15)
    assert.ok(allVisible(f.cards(0)))
    f.advance(.1)
    assert.ok(allHidden(f.cards(0)), 'duplicates did not extend the original .32s lifetime')
    f.snapshot(state({ folded: [0], seq: 13 }), [fold(0, 13, 'hand-1', 'late-fold')])
    assert.ok(allHidden(f.cards(0)))
  } finally { f.close() }
})

test('a reconnect already containing folded players hides them immediately and never replays the supplied history', () => {
  const f = fixture()
  try {
    const next = state({ folded: [0, 2], seq: 25 })
    next.players[0].cards = ['Ac', 'Ad'] // Defensive: even stale/public faces must not show.
    f.snapshot(next, [fold(0, 20), fold(2, 22, 'hand-1', 'fold-2')])
    assert.ok(allHidden(f.cards(0)))
    assert.ok(allHidden(f.cards(2)))
    f.pieces.event(fold(0, 25, 'hand-1', 'direct-replay'))
    f.advance(.1)
    assert.ok(allHidden(f.cards(0)))
    assert.ok(allHidden(f.cards(2)))
    assert.ok(allVisible(f.cards(1)))
  } finally { f.close() }
})

test('snapshot-only resync removes a newly folded hand without waiting for an event or replaying it later', () => {
  const f = fixture()
  try {
    f.snapshot(state())
    f.snapshot(state({ folded: [0], seq: 11 }))
    assert.ok(allHidden(f.cards(0)))
    f.advance(.01)
    f.pieces.event(fold(0))
    assert.ok(allHidden(f.cards(0)))
    f.snapshot(state({ folded: [0], seq: 12 }), [fold(0, 12, 'hand-1', 'late-history')])
    assert.ok(allHidden(f.cards(0)))
  } finally { f.close() }
})

test('SHOWDOWN never reveals or revives a folded hand, including during its active muck', () => {
  const f = fixture()
  try {
    f.snapshot(state())
    const back = f.card(1, 0).children[1].material
    f.snapshot(state({ folded: [0], seq: 11 }), [fold(0)])
    f.advance(.1)
    const during = f.cards(0).map(card => card.position.clone())
    const complete = state({ folded: [0], seq: 13, stage: 'COMPLETE', board: ['2c', '3d', '4h', '5s', '6c'] })
    complete.players[0].cards = ['Ac', 'Ad']
    complete.players[1].cards = ['Qc', 'Qd']
    f.snapshot(complete, [{ type: 'SHOWDOWN', seq: 13, handId: 'hand-1', eventId: 'showdown' }])
    f.cards(0).forEach((card, i) => assert.ok(card.position.equals(during[i])))
    assertBacks(f.cards(0), back)
    f.advance(.25)
    assert.ok(allHidden(f.cards(0)))
    f.pieces.event({ type: 'SHOWDOWN', seq: 14, handId: 'hand-1', eventId: 'showdown-again' })
    f.advance(.5)
    assert.ok(allHidden(f.cards(0)))
    assert.ok(allVisible(f.cards(1)))
    assert.notEqual(f.card(1, 0).children[1].material, back, 'eligible opponent still reveals normally')
  } finally { f.close() }
})

test('INTERMISSION cancels muck immediately; a new hand restores cards and rejects stale fold events', () => {
  const f = fixture()
  try {
    f.snapshot(state())
    f.snapshot(state({ folded: [0], seq: 11 }), [fold(0)])
    f.advance(.1)
    f.snapshot(state({ folded: [0], seq: 12, stage: 'INTERMISSION' }))
    for (let seat = 0; seat < 4; seat++) assert.ok(allHidden(f.cards(seat)))
    f.advance(.5)
    f.pieces.event(fold(0, 12, 'hand-1', 'late-intermission-fold'))
    assert.ok(allHidden(f.cards(0)))
    f.snapshot(state({ handId: 'hand-2', seq: 15 }))
    assert.ok(allVisible(f.cards(0)))
    f.pieces.event(fold(0, 100, 'hand-1', 'stale-hand-fold'))
    assert.ok(allVisible(f.cards(0)))
    f.snapshot(state({ handId: 'hand-2', seq: 16, folded: [0] }), [fold(0, 16, 'hand-2', 'new-hand-fold')])
    assert.ok(allVisible(f.cards(0)), 'a fresh fold animates normally in the new hand')
    f.advance(.35)
    assert.ok(allHidden(f.cards(0)))
  } finally { f.close() }
})

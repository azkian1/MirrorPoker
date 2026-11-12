import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// Real pinned Three geometry/projection math. Canvas is a drawing stub; no WebGL claim.
const root = resolve(import.meta.dirname, '..')
mkdirSync(resolve(root, '.test-output'), { recursive: true })
const build = spawnEsbuild(['tests/pieces-v3-entry.ts', '--bundle', '--platform=node', '--format=esm', '--outfile=.test-output/pieces-v3-bundle.mjs'], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, build.stderr)
const { THREE, createPieces, createWorld, ANCHORS, CAMERA, CARD, CARD_REST, CHIP, TABLE } = await import('../.test-output/pieces-v3-bundle.mjs')
const texts = []
globalThis.document = { createElement(name) {
  assert.equal(name, 'canvas')
  const gradient = () => ({ addColorStop() {} })
  const context = new Proxy({ fillText(text) { texts.push(text) }, measureText(text) { return { width: String(text).length * 9 } }, createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4) } }, createLinearGradient: gradient, createRadialGradient: gradient }, { get(target, key) { return key in target ? target[key] : () => {} } })
  return { width: 0, height: 0, getContext() { return context } }
} }

function state(overrides = {}) {
  return {
    handId: 'hand-1', seq: 10, stage: 'PREFLOP', worldMode: 'NORMAL',
    players: Array.from({ length: 4 }, (_, seat) => ({ id: `p${seat}`, name: `Player ${seat}`, seat, stack: 1000, bet: 0, totalBet: 0, folded: false, allIn: false, connected: true, isBot: seat !== 0, sittingOut: false })),
    board: [], pot: 0, actorId: 'p0', dealerSeat: 0, smallBlind: 10, bigBlind: 20, currentBet: 0, minRaise: 20, winners: [],
    ...overrides,
  }
}
const personal = (handId = 'hand-1') => ({ handId, playerId: 'p0', cards: ['As', 'Kd'], legalActions: [] })
function fixture() {
  const scene = new THREE.Scene()
  const pieces = createPieces(scene)
  const group = scene.getObjectByName('PokerPieces')
  return { scene, pieces, group, get: name => scene.getObjectByName(name), close() { pieces.dispose(); assert.equal(scene.children.length, 0) } }
}
function camera(width = 1280, height = 720) {
  const fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(CAMERA.fov / 2)) * Math.max(1, (16 / 9) / (width / height))))
  const result = new THREE.PerspectiveCamera(fov, width / height, CAMERA.near, CAMERA.far)
  result.position.set(...CAMERA.position); result.lookAt(...CAMERA.target); result.updateMatrixWorld(true)
  return result
}
function bounds(points, view, width, height) {
  const projected = points.map(point => point.clone().project(view))
  return {
    left: Math.min(...projected.map(point => (point.x + 1) * width / 2)),
    right: Math.max(...projected.map(point => (point.x + 1) * width / 2)),
    top: Math.min(...projected.map(point => (1 - point.y) * height / 2)),
    bottom: Math.max(...projected.map(point => (1 - point.y) * height / 2)),
  }
}
function geometryPoints(geometry, matrix) {
  const position = geometry.getAttribute('position'), result = []
  for (let i = 0; i < position.count; i++) result.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix))
  return result
}
function objectPoints(object) {
  const result = []
  object.traverse(child => { if (child.isMesh && !child.isInstancedMesh) result.push(...geometryPoints(child.geometry, child.matrixWorld)) })
  return result
}
function instancePoints(mesh, index) {
  const matrix = new THREE.Matrix4()
  mesh.getMatrixAt(index, matrix); matrix.premultiply(mesh.matrixWorld)
  return geometryPoints(mesh.geometry, matrix)
}
const overlaps = (a, b, gap = 0) => a.left < b.right + gap && a.right + gap > b.left && a.top < b.bottom + gap && a.bottom + gap > b.top
const samePosition = (actual, expected) => assert.ok(actual.distanceTo(new THREE.Vector3(...expected)) < 1e-7, `${actual.toArray()} != ${expected}`)

test('deck is by the dealer hands and clear of the 1280px pot panel', () => {
  const f = fixture()
  try {
    const deck = f.get('DealerDeck'), base = f.get('DealerDeckBase')
    samePosition(base.position, ANCHORS.deck)
    samePosition(deck.position, [ANCHORS.deck[0], ANCHORS.deck[1] + .045 + CARD.thickness / 2 + CARD_REST.skinOffset + CARD_REST.gap, ANCHORS.deck[2]])
    assert.ok(Math.abs(ANCHORS.deck[0]) < 1.5)
    assert.ok(Math.abs(ANCHORS.deck[2] - ANCHORS.dealer[2]) < 1.5)
    f.scene.updateMatrixWorld(true)
    const deckBounds = bounds([...objectPoints(deck), ...objectPoints(base)], camera(), 1280, 720)
    assert.equal(overlaps(deckBounds, { left: 592, right: 688, top: 251, bottom: 313 }), false, JSON.stringify(deckBounds))
  } finally { f.close() }
})

test('menu and LOBBY hide both deck objects from first construction, while preparing and running hands retain them', () => {
  const f = fixture()
  try {
    const deck = f.get('DealerDeck'), base = f.get('DealerDeckBase')
    assert.equal(deck.visible, false, 'no first-frame flash before any snapshot')
    assert.equal(base.visible, false)
    for (const next of [state({ stage: 'LOBBY' }), state({ handId: '', stage: 'PREFLOP', players: [] })]) {
      f.pieces.apply(next, null); f.pieces.update(.1)
      assert.equal(deck.visible, false); assert.equal(base.visible, false)
    }
    for (const stage of ['INTERMISSION', 'PREFLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN', 'COMPLETE']) {
      const next = state({ stage })
      f.pieces.apply(next, personal()); f.pieces.update(.1)
      assert.equal(deck.visible, true, `${stage} still owns its dealer deck`)
      assert.equal(base.visible, true)
    }
    f.pieces.apply(state({ stage: 'LOBBY', players: [] }), null)
    assert.equal(deck.visible, false); assert.equal(base.visible, false)
    assert.ok(f.get('HoleCard-0-0'), 'hiding the menu deck must not remove shared card assets')
  } finally { f.close() }
})

test('one physical D button follows all four dealer positions independently of hole cards', () => {
  const f = fixture()
  try {
    assert.ok(texts.includes('D'), 'dealer button has a real D face texture')
    const button = f.get('DealerButton')
    assert.ok(button.children.some(child => child.geometry.type === 'CylinderGeometry'))
    assert.equal(button.visible, false)
    for (let seat = 0; seat < 4; seat++) {
      f.pieces.apply(state({ dealerSeat: seat }), personal())
      assert.equal(button.visible, true)
      samePosition(button.position, [ANCHORS.dealerButtons[seat][0], ANCHORS.dealerButtons[seat][1] + .0225, ANCHORS.dealerButtons[seat][2]])
      samePosition(f.get('HoleCard-0-0').position, [ANCHORS.seats[0][0] - .17, CARD_REST.centerY, ANCHORS.seats[0][2]])
    }
    f.pieces.apply(state({ stage: 'LOBBY' }), personal())
    assert.equal(button.visible, false)
  } finally { f.close() }
})

test('INTERMISSION hides every hole/board card even with stale snapshot cards or active deal motion', () => {
  const f = fixture()
  try {
    f.pieces.apply(state({ board: ['2h', '3h', '4h'] }), personal())
    f.pieces.event({ type: 'CARDS_DEALT', handId: 'hand-1', seq: 11, eventId: 'deal' })
    f.pieces.update(.1)
    f.pieces.apply(state({ stage: 'INTERMISSION', seq: 12, board: ['2h', '3h', '4h'] }), personal())
    f.pieces.update(.1)
    for (let seat = 0; seat < 4; seat++) for (let card = 0; card < 2; card++) assert.equal(f.get(`HoleCard-${seat}-${card}`).visible, false)
    for (let card = 0; card < 5; card++) assert.equal(f.get(`BoardCard-${card}`).visible, false)
    assert.equal(f.get('DealerButton').visible, true)
    assert.equal(f.get('DealerDeck').visible, true)
    assert.equal(f.get('DealerDeckBase').visible, true)
  } finally { f.close() }
})

test('cards depart from the relocated deck when dealt', () => {
  const f = fixture()
  try {
    f.pieces.apply(state(), personal())
    f.pieces.event({ type: 'CARDS_DEALT', handId: 'hand-1', seq: 11, eventId: 'deal' })
    f.pieces.update(0)
    for (let seat = 0; seat < 4; seat++) for (let card = 0; card < 2; card++) samePosition(f.get(`HoleCard-${seat}-${card}`).position, [ANCHORS.deck[0], ANCHORS.deck[1] + .12, ANCHORS.deck[2]])
    for (let i = 0; i < 20; i++) f.pieces.update(.1)
    samePosition(f.get('HoleCard-0-0').position, [ANCHORS.seats[0][0] - .17, CARD_REST.centerY, ANCHORS.seats[0][2]])
  } finally { f.close() }
})

test('settled cards follow the real felt plane in both worlds, with a 1mm lower gap and non-intersecting two-card fans', t => {
  const f = fixture(), world = createWorld(f.scene)
  try {
    f.scene.updateMatrixWorld(true)
    const felt = f.scene.getObjectByName('mirror-monolith-world').children.find(mesh => {
      if (!mesh.isMesh) return false
      const points = objectPoints(mesh)
      return Math.abs(Math.max(...points.map(p=>p.y))-CARD_REST.feltY)<1e-6 &&
        Math.abs(Math.max(...points.map(p=>p.x))-Math.min(...points.map(p=>p.x))-(TABLE.width-.88))<1e-5
    })
    assert.ok(felt, 'measure the actual world felt geometry, not a duplicated surface constant')
    const feltY = Math.max(...objectPoints(felt).map(point=>point.y)), clearances=[]
    for (const mode of ['NORMAL','MIRROR']) {
      const next = state({ stage:'RIVER', worldMode:mode, board:['2h','3c','4s','5d','Ah'] })
      f.pieces.apply(next,personal()); f.scene.updateMatrixWorld(true)
      const cards=[...Array.from({length:4},(_,seat)=>[0,1].map(i=>({card:f.get(`HoleCard-${seat}-${i}`),step:i}))).flat(), ...Array.from({length:5},(_,i)=>({card:f.get(`BoardCard-${i}`),step:0}))]
      for (const {card,step} of cards) {
        const points=objectPoints(card),bottom=Math.min(...points.map(p=>p.y)),top=Math.max(...points.map(p=>p.y))
        const surface=card.children[Math.abs(card.rotation.z-Math.PI)<1e-7?2:1]
        const normal=new THREE.Vector3(0,0,1).transformDirection(surface.matrixWorld)
        assert.ok(normal.distanceTo(new THREE.Vector3(0,1,0))<1e-7,`${card.name} is parallel to the table, never camera-facing`)
        assert.ok(Math.abs(card.position.y-CARD_REST.centerY-step*CARD_REST.overlapStep)<1e-7)
        assert.ok(Math.abs(bottom-feltY-CARD_REST.gap-step*CARD_REST.overlapStep)<1e-6)
        assert.ok(Math.abs(top-bottom-(CARD.thickness+CARD_REST.skinOffset*2))<1e-6)
        clearances.push(bottom-feltY)
      }
      for(let seat=0;seat<4;seat++) {
        const lower=objectPoints(f.get(`HoleCard-${seat}-0`)),upper=objectPoints(f.get(`HoleCard-${seat}-1`))
        assert.ok(Math.min(...upper.map(p=>p.y))-Math.max(...lower.map(p=>p.y))>=.00049,'overlapping cards have a real half-millimetre separation')
      }
    }
    t.diagnostic(JSON.stringify({feltY,centerY:CARD_REST.centerY,minClearance:Math.min(...clearances),maxClearance:Math.max(...clearances),thickness:CARD.thickness,overlapStep:CARD_REST.overlapStep}))
  } finally { world.dispose(); f.close() }
})

test('bounded contact patches stay on the felt, follow card yaw, and disappear during deal/flip/menu/fold', () => {
  const f=fixture()
  try {
    const contacts=f.get('CardContactShadows')
    assert.equal(contacts.count,0)
    assert.equal(contacts.instanceMatrix.count,13)
    assert.equal(contacts.material.depthWrite,false)
    assert.equal(contacts.material.polygonOffset,false,'slope bias must never pull contact ink over the paper')
    assert.equal(contacts.castShadow,false)
    assert.equal(contacts.material.opacity,.14)
    assert.equal(contacts.material.map.image.width,64);assert.equal(contacts.material.map.image.height,90)
    const alpha=contacts.material.map.image.data.filter((_,i)=>i%4===3)
    assert.equal(alpha[0],0);assert.equal(Math.max(...alpha),255)
    assert.ok(alpha.some(value=>value>0&&value<255),'the contact rectangle has a soft transparent edge')
    const next=state({stage:'RIVER',board:['2h','3c','4s','5d','Ah']})
    f.pieces.apply(next,personal());assert.equal(contacts.count,13)
    const matrix=new THREE.Matrix4()
    for(let i=0;i<contacts.count;i++) {
      contacts.getMatrixAt(i,matrix)
      assert.ok(Math.abs(new THREE.Vector3().setFromMatrixPosition(matrix).y-(CARD_REST.feltY+.0007))<1e-6)
      assert.ok(new THREE.Vector3(0,0,1).transformDirection(matrix).distanceTo(new THREE.Vector3(0,1,0))<1e-6)
    }
    const lower=f.get('HoleCard-0-0'),contactX=new THREE.Vector3(1,0,0).transformDirection((contacts.getMatrixAt(0,matrix),matrix))
    const cardX=new THREE.Vector3(1,0,0).applyEuler(lower.rotation)
    assert.ok(contactX.distanceTo(cardX)<1e-6,'contact yaw matches the actual card footprint')
    f.pieces.event({type:'CARDS_DEALT',handId:'hand-1',seq:11,eventId:'allin-deal'})
    f.pieces.event({type:'STREET_CHANGED',handId:'hand-1',seq:12,eventId:'allin-board',board:next.board})
    assert.equal(contacts.count,0,'no flat contact patch under cards flying from the deck')
    f.pieces.update(.1)
    const moving=f.get('HoleCard-0-0').position.clone()
    f.pieces.apply({...next,seq:13},personal())
    assert.ok(f.get('HoleCard-0-0').position.equals(moving),'same-hand resync preserves the real flight')
    assert.equal(contacts.count,0)
    for(let i=0;i<25;i++)f.pieces.update(.1)
    assert.equal(f.pieces.cardsSettled(),true);assert.equal(contacts.count,13)
    f.pieces.event({type:'SHOWDOWN',handId:'hand-1',seq:14,eventId:'showdown'})
    assert.equal(contacts.count,5,'hole-card flips hide their own contact patches')
    for(let i=0;i<12;i++)f.pieces.update(.1)
    assert.equal(contacts.count,13)
    const folded={...next,seq:15,players:next.players.map(p=>p.seat===0?{...p,folded:true}:p)}
    f.pieces.apply(folded,personal());assert.equal(contacts.count,11)
    f.pieces.event({type:'PLAYER_ACTED',action:{type:'fold'},playerId:'p0',handId:'hand-1',seq:15,eventId:'fold'})
    assert.equal(contacts.count,11,'discarded moving cards cannot leave a contact patch behind')
    f.pieces.apply(state({stage:'INTERMISSION',seq:16}),personal());assert.equal(contacts.count,0)
    f.pieces.apply(state({stage:'LOBBY',players:[],seq:17}),null);assert.equal(contacts.count,0)
  } finally { f.close() }
})

test('bankroll columns stay beside cards for four seats, stack sizes, folded cards and viewport perspectives', () => {
  const f = fixture()
  try {
    const chips = f.get('TableChips'), rings = f.get('TableChipRings')
    for (const [width, height] of [[1280, 720], [960, 600], [1920, 1080]]) {
      const view = camera(width, height)
      for (let seat = 0; seat < 4; seat++) for (const folded of [false, true]) for (const amount of [0, 1, 75, 76, 750, 751, 1500, 1875, 1000000]) {
        const next = state()
        next.players.forEach(player => { player.stack = player.seat === seat ? amount : 0; player.folded = folded })
        f.pieces.apply(next, personal()); f.scene.updateMatrixWorld(true)
        assert.ok(chips.count <= 25, 'bankroll geometry is bounded to three columns')
        const cardBounds = Array.from({ length: 4 }, (_, cardSeat) => bounds([0, 1].flatMap(card => objectPoints(f.get(`HoleCard-${cardSeat}-${card}`))), view, width, height))
        const columns = new Set()
        for (let i = 0; i < chips.count; i++) {
          const matrix = new THREE.Matrix4(); chips.getMatrixAt(i, matrix)
          const position = new THREE.Vector3().setFromMatrixPosition(matrix)
          columns.add(position.x.toFixed(4))
          assert.ok(Math.abs(position.x - ANCHORS.chips[seat][0]) <= .25001)
          assert.ok(Math.abs(position.z - ANCHORS.chips[seat][2]) < 1e-5)
          assert.ok(position.y + CHIP.height / 2 <= ANCHORS.chips[seat][1] + .40001)
          const projected = bounds([...instancePoints(chips, i), ...instancePoints(rings, i)], view, width, height)
          for (const hand of cardBounds) assert.equal(overlaps(projected, hand, .5), false, JSON.stringify({ width, height, seat, folded, amount, i, projected, hand }))
        }
        assert.ok(columns.size <= 3)
      }
    }
  } finally { f.close() }
})

test('full bankrolls, bets, pot and dealer button leave every river card unobscured', () => {
  const f = fixture()
  try {
    const next = state({ stage: 'RIVER', board: ['2h', '3c', '4s', '5d', 'Ah'], pot: 100000 })
    next.players.forEach(player => { player.stack = 100000; player.bet = 10000 })
    const chips = f.get('TableChips'), rings = f.get('TableChipRings')
    for (const [width, height] of [[1280, 720], [960, 600]]) for (let seat = 0; seat < 4; seat++) {
      next.dealerSeat = seat; f.pieces.apply(next, personal()); f.scene.updateMatrixWorld(true)
      const view = camera(width, height)
      const cardBounds = [...Array.from({ length: 4 }, (_, s) => [0, 1].map(card => f.get(`HoleCard-${s}-${card}`))).flat(), ...Array.from({ length: 5 }, (_, card) => f.get(`BoardCard-${card}`))].map(card => bounds(objectPoints(card), view, width, height))
      for (let i = 0; i < chips.count; i++) {
        const projected = bounds([...instancePoints(chips, i), ...instancePoints(rings, i)], view, width, height)
        for (const card of cardBounds) assert.equal(overlaps(projected, card), false, JSON.stringify({ width, height, seat, i, projected, card }))
      }
      const button = bounds(objectPoints(f.get('DealerButton')), view, width, height)
      for (const card of cardBounds) assert.equal(overlaps(button, card), false, JSON.stringify({ width, height, seat, button, card }))
    }
  } finally { f.close() }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
mkdirSync(resolve(root, '.test-output'), { recursive: true })
const build = spawnEsbuild(['tests/deck-v6-entry.ts', '--bundle', '--platform=node', '--format=esm', '--outfile=.test-output/deck-v6-bundle.mjs'], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, build.stderr)
const { THREE, createPieces, createWorld, ANCHORS, CAMERA, TABLE } = await import('../.test-output/deck-v6-bundle.mjs')

// Instantiate the actual world and pieces. Only Canvas drawing is stubbed; hulls
// below come from rendered world.ts vertices, not a duplicated table rectangle.
globalThis.document = { createElement(name) {
  assert.equal(name, 'canvas')
  const gradient = () => ({ addColorStop() {} })
  const context = new Proxy({ createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) } }, createRadialGradient: gradient, createLinearGradient: gradient }, { get(target, key) { return key in target ? target[key] : () => {} } })
  return { width: 0, height: 0, getContext() { return context } }
} }
function fixture() {
  const scene = new THREE.Scene(), world = createWorld(scene), pieces = createPieces(scene)
  scene.updateMatrixWorld(true)
  return { scene, pieces, get: name => scene.getObjectByName(name), close() { pieces.dispose(); world.dispose(); assert.equal(scene.children.length, 0) } }
}
function points(object) {
  const result = []
  object.traverse(child => {
    if (!child.isMesh || child.isInstancedMesh) return
    const positions = child.geometry.getAttribute('position')
    for (let i = 0; i < positions.count; i++) result.push(new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(child.matrixWorld))
  })
  return result
}
function hullXZ(vertices) {
  const unique = [...new Map(vertices.map(point => [`${point.x.toFixed(6)}:${point.z.toFixed(6)}`, { x: point.x, z: point.z }])).values()].sort((a, b) => a.x - b.x || a.z - b.z)
  const cross = (a, b, p) => (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x)
  const half = values => {
    const result = []
    for (const value of values) { while (result.length > 1 && cross(result.at(-2), result.at(-1), value) <= 1e-10) result.pop(); result.push(value) }
    return result
  }
  return [...half(unique).slice(0, -1), ...half(unique.toReversed()).slice(0, -1)]
}
function topSurface(mesh) {
  const vertices = points(mesh), y = Math.max(...vertices.map(point => point.y))
  return { y, hull: hullXZ(vertices.filter(point => Math.abs(point.y - y) < 1e-6)) }
}
function surfaces(scene) {
  const world = scene.getObjectByName('mirror-monolith-world')
  const meshes = world.children.filter(child => child.isMesh)
  const felt = meshes.find(mesh => mesh.material.bumpMap)
  assert.ok(felt, 'use the real felt material mesh from world.ts')
  const rail = meshes.find(mesh => {
    const vertices = points(mesh)
    const maxY = Math.max(...vertices.map(point => point.y))
    const width = Math.max(...vertices.map(point => point.x)) - Math.min(...vertices.map(point => point.x))
    return Math.abs(maxY - TABLE.topY) < 1e-6 && width > TABLE.width - .15
  })
  assert.ok(rail, 'use the real beveled table top contour')
  return { felt: topSurface(felt), rail: topSurface(rail) }
}
function minimumMargin(vertices, hull) {
  return Math.min(...vertices.flatMap(point => hull.map((a, i) => {
    const b = hull[(i + 1) % hull.length], dx = b.x - a.x, dz = b.z - a.z
    return (dx * (point.z - a.z) - dz * (point.x - a.x)) / Math.hypot(dx, dz)
  })))
}
function assertSupported(deckPoints, basePoints, surface) {
  const margin = minimumMargin([...deckPoints, ...basePoints], surface.hull)
  assert.ok(margin >= .12, `Deck outside playable surface / insufficient margin: ${margin}`)
  const baseBottom = Math.min(...basePoints.map(point => point.y)), baseTop = Math.max(...basePoints.map(point => point.y))
  const cardBottom = Math.min(...deckPoints.map(point => point.y)), cardTop = Math.max(...deckPoints.map(point => point.y))
  assert.ok(baseBottom >= surface.y - 1e-6, 'base must not sink into the felt')
  assert.ok(baseBottom - surface.y <= .002, 'base must be supported by the felt rather than float')
  assert.ok(cardBottom >= baseTop - 1e-6, 'upper card must not penetrate the deck base')
  assert.ok(cardBottom - baseTop <= .007, 'preserve only the existing millimetre-scale upper-card gap')
  assert.ok(cardTop > baseTop, 'the upper card is still above the deck stack')
  return { playableMargin: margin, supportY: surface.y, baseBottom, baseTop, cardBottom, cardTop, supportGap: baseBottom - surface.y, upperCardGap: cardBottom - baseTop }
}
function camera(width, height) {
  const fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(CAMERA.fov / 2)) * Math.max(1, (16 / 9) / (width / height))))
  const view = new THREE.PerspectiveCamera(fov, width / height, CAMERA.near, CAMERA.far)
  view.position.set(...CAMERA.position); view.lookAt(...CAMERA.target); view.updateMatrixWorld(true)
  return view
}
function projectedBounds(vertices, view, width, height) {
  const projected = vertices.map(point => point.clone().project(view))
  return { left: Math.min(...projected.map(point => (point.x + 1) * width / 2)), right: Math.max(...projected.map(point => (point.x + 1) * width / 2)), top: Math.min(...projected.map(point => (1 - point.y) * height / 2)), bottom: Math.max(...projected.map(point => (1 - point.y) * height / 2)) }
}
const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top

test('every upper-card/base vertex is inside the actual felt octagon with support and margin; the former rail anchor fails', t => {
  const f = fixture()
  try {
    const { felt, rail } = surfaces(f.scene)
    assert.equal(felt.hull.length, 8)
    assert.equal(rail.hull.length, 8)
    const deckPoints = points(f.get('DealerDeck')), basePoints = points(f.get('DealerDeckBase'))
    const metrics = assertSupported(deckPoints, basePoints, felt)
    assert.ok(minimumMargin([...deckPoints, ...basePoints], rail.hull) > metrics.playableMargin)
    const former = new THREE.Vector3(-1.17, 1, -2.46).sub(new THREE.Vector3(...ANCHORS.deck))
    const oldDeck = deckPoints.map(point => point.clone().add(former)), oldBase = basePoints.map(point => point.clone().add(former))
    assert.throws(() => assertSupported(oldDeck, oldBase, felt), /outside playable surface/)
    const oldMargin = minimumMargin([...oldDeck, ...oldBase], felt.hull)
    assert.ok(oldMargin < -.34, 'the former deck really extended beyond the felt by about .35m')
    t.diagnostic(JSON.stringify({ anchor: ANCHORS.deck, ...metrics, formerAnchor: [-1.17, 1, -2.46], formerPlayableMargin: oldMargin }))
  } finally { f.close() }
})

test('deck upper/lower geometry clears pot HUD, board, all hole cards and every D position at three viewport sizes', t => {
  const f = fixture()
  try {
    const next = { handId: 'hand-1', seq: 1, stage: 'RIVER', worldMode: 'NORMAL', players: Array.from({ length: 4 }, (_, seat) => ({ id: `p${seat}`, name: `P${seat}`, seat, stack: 1000, bet: 0, totalBet: 0, folded: false, allIn: false, connected: true, isBot: false, sittingOut: false })), board: ['2c', '3d', '4h', '5s', 'Ac'], pot: 4000, actorId: null, dealerSeat: 0, smallBlind: 10, bigBlind: 20, currentBet: 0, minRaise: 20, winners: [] }
    const self = { handId: 'hand-1', playerId: 'p0', cards: ['As', 'Kd'], legalActions: [] }, metrics = []
    f.pieces.apply(next, self); f.scene.updateMatrixWorld(true)
    const deck = [...points(f.get('DealerDeck')), ...points(f.get('DealerDeckBase'))]
    const cards = [...Array.from({ length: 4 }, (_, seat) => [0, 1].map(card => f.get(`HoleCard-${seat}-${card}`))).flat(), ...Array.from({ length: 5 }, (_, card) => f.get(`BoardCard-${card}`))]
    for (const [width, height] of [[1280, 720], [960, 600], [1920, 1080]]) {
      const view = camera(width, height), deckBox = projectedBounds(deck, view, width, height)
      const center = new THREE.Vector3(0, 1.02, -1.65).project(view)
      // Conservative 96×62px pot envelope: larger than the unboxed current label.
      const pot = { left: (center.x + 1) * width / 2 - 48, right: (center.x + 1) * width / 2 + 48, top: (1 - center.y) * height / 2 - 31, bottom: (1 - center.y) * height / 2 + 31 }
      assert.equal(intersects(deckBox, pot), false, JSON.stringify({ width, height, deckBox, pot }))
      const potGap = pot.left - deckBox.right
      assert.ok(potGap >= 8, `Keep visible air from the pot in ${width}×${height}: ${potGap}px`)
      for (const card of cards) assert.equal(intersects(deckBox, projectedBounds(points(card), view, width, height)), false, `${width}×${height}: ${card.name}`)
      for (let dealerSeat = 0; dealerSeat < 4; dealerSeat++) {
        f.pieces.apply({ ...next, dealerSeat }, self); f.scene.updateMatrixWorld(true)
        assert.equal(intersects(deckBox, projectedBounds(points(f.get('DealerButton')), view, width, height)), false, `${width}×${height}: D seat ${dealerSeat}`)
      }
      metrics.push({ width, height, potGap, deckBox })
    }
    t.diagnostic(JSON.stringify({ minimumScreenPotGap: Math.min(...metrics.map(item => item.potGap)), viewports: metrics }))
  } finally { f.close() }
})

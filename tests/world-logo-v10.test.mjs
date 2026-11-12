import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
mkdirSync(resolve(root, '.test-output'), { recursive: true })
const build = spawnEsbuild(['tests/world-logo-v10-entry.ts', '--bundle', '--platform=node', '--format=esm', '--outfile=.test-output/world-logo-v10-bundle.mjs'], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, build.stderr)
const { THREE, createWorld, POKER_MARK: mark, CARD_REST } = await import('../.test-output/world-logo-v10-bundle.mjs')
const originalDocument = globalThis.document, canvases = []
globalThis.document = { createElement(name) {
  assert.equal(name, 'canvas')
  const drawing = [], gradient = () => ({ addColorStop() {} })
  const context = new Proxy({
    createImageData(width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4) } },
    createRadialGradient: gradient, createLinearGradient: gradient,
  }, { get(target, key) { return key in target ? target[key] : (...args) => drawing.push([key, ...args]) } })
  const canvas = { width: 0, height: 0, drawing, getContext() { return context } }
  canvases.push(canvas); return canvas
} }
after(() => { globalThis.document = originalDocument })
function fixture() {
  const scene = new THREE.Scene(), world = createWorld(scene)
  const engraving = scene.getObjectByName('TablePokerEngraving')
  assert.ok(engraving)
  return { scene, world, engraving, close() { world.dispose(); world.dispose(); assert.equal(scene.children.length, 0) } }
}
function vertices(mesh) {
  mesh.updateWorldMatrix(true, false)
  const attribute = mesh.geometry.getAttribute('position')
  return Array.from({ length: attribute.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(attribute, i).applyMatrix4(mesh.matrixWorld))
}

test('the avatar SVG and felt share the standalone spade mark', () => {
  const svg = readFileSync(resolve(root, mark.assetURL), 'utf8')
  const paths = [...svg.matchAll(/<path\b([^>]+)>?/g)].map(match => match[1])
  assert.equal(paths.length, 2, 'one white face fill and one canonical compound black path')
  assert.ok(paths.some(path => path.includes(`d="${mark.facePath}"`) && path.includes('fill="#fff"')))
  assert.ok(paths.some(path => path.includes(`d="${mark.path}"`) && path.includes('fill-rule="evenodd"') && path.includes('fill="#000"')))
  assert.ok(svg.includes(`viewBox="${mark.viewBox}"`))
  assert.ok(!/<rect\b|<image\b|<text\b|b6ff00|pokerstars/i.test(svg), 'there is no background square, bitmap, lettering or third-party wordmark')
  assert.equal(mark.width / mark.height, 900 / 804)
  const f = fixture()
  try {
    const mask = f.engraving.material.map.image
    const expected = mark.commands.map(([kind,...args]) => [({M:'moveTo',L:'lineTo',Q:'quadraticCurveTo',Z:'closePath'})[kind], ...args])
    const actual = mask.drawing.filter(([kind]) => ['moveTo','lineTo','quadraticCurveTo','closePath'].includes(kind))
    assert.deepEqual(actual, expected, 'the table rasterizes canonical vector commands without a second hand-drawn silhouette')
    assert.ok(mask.drawing.some(call => call[0] === 'fill' && call[1] === 'evenodd'))
    assert.equal(f.engraving.userData.canonicalPath, mark.path)
  } finally { f.close() }
})

test('the neutral engraving is physically above the felt and below cards with no z-fighting or overlay order', () => {
  const f = fixture()
  try {
    const points = vertices(f.engraving), mat = f.engraving.material
    const felt = f.scene.getObjectByName('mirror-monolith-world').children.find(mesh => mesh.isMesh && mesh.material.bumpMap?.isDataTexture)
    const feltTop = Math.max(...vertices(felt).map(point => point.y))
    for (const point of points) {
      assert.ok(Math.abs(point.y - (CARD_REST.feltY + .0005)) < 1e-7)
      assert.ok(point.y - feltTop >= .00049 && point.y - feltTop <= .00051)
      assert.ok(Math.abs(point.x) < 4 && Math.abs(point.z) < 2.4, 'the whole plane stays inside the felt')
      assert.ok(point.y < feltTop + CARD_REST.gap, 'engraving stays below the actual lower card skin, not the old anchor height')
    }
    assert.deepEqual(f.engraving.position.toArray(), [0, CARD_REST.feltY + .0005, -.15])
    assert.ok(Math.abs(f.engraving.geometry.parameters.width / f.engraving.geometry.parameters.height - mark.width / mark.height) < 1e-12)
    assert.equal(f.engraving.renderOrder, 0)
    assert.equal(f.engraving.castShadow, false)
    assert.equal(mat.depthWrite, false); assert.equal(mat.depthTest, true)
    assert.equal(mat.transparent, true); assert.equal(mat.polygonOffset, false)
    assert.equal(mat.emissive.getHex(), 0); assert.equal(mat.metalness, 0)
    assert.equal(mat.roughness, .98)
    assert.ok(mat.bumpScale < 0 && mat.bumpScale >= -.005)
    assert.equal(mat.map, mat.bumpMap)
  } finally { f.close() }
})

test('NORMAL and MIRROR turn the low-contrast spade mark smoothly; frames reuse meshes, geometry and textures', t => {
  const f = fixture()
  try {
    const mat = f.engraving.material, geometry = f.engraving.geometry.uuid, texture = mat.map.uuid, originalCanvases = canvases.length
    const normalColor = mat.color.getHexString(), normalOpacity = mat.opacity
    assert.equal(f.engraving.rotation.z, 0)
    f.world.update(.05, 'MIRROR')
    assert.ok(f.engraving.rotation.z > 0 && f.engraving.rotation.z < Math.PI, 'the logo turns gradually in the felt plane')
    for (let i=0;i<60;i++) { f.world.update(.05, 'MIRROR'); assert.ok(mat.opacity >= .13 && mat.opacity <= .16) }
    const mirrorColor = mat.color.getHexString(), mirrorOpacity = mat.opacity
    assert.notEqual(mirrorColor, normalColor)
    assert.ok(Math.abs(mirrorOpacity - .13) < 1e-8)
    assert.equal(f.engraving.rotation.z, Math.PI, 'MIRROR ends upside down without changing the logo anchor')
    assert.equal(mat.emissive.getHex(), 0)
    for (let i=0;i<60;i++) f.world.update(.05, 'NORMAL')
    assert.equal(mat.color.getHexString(), normalColor); assert.equal(mat.opacity, normalOpacity)
    assert.equal(f.engraving.rotation.z, 0)
    for (const dt of [NaN, Infinity, -1]) f.world.update(dt, 'MIRROR')
    assert.ok(Number.isFinite(mat.opacity)); assert.equal(f.engraving.geometry.uuid, geometry); assert.equal(mat.map.uuid, texture)
    assert.equal(canvases.length, originalCanvases, 'no per-frame texture generation')
    let meshes=0, triangles=0
    f.scene.traverse(node => { if (node.isMesh) { meshes++; triangles += (node.geometry.index?.count || node.geometry.getAttribute('position').count) / 3 } })
    // Architectural detail may grow; keep the agreed budget instead of freezing
    // the historical mesh count. The integrated harness also counts all pieces.
    assert.ok(meshes<=150&&triangles<=150000,'World remains inside the agreed whole-scene budget')
    assert.equal(f.engraving.geometry.index.count,6,'only two triangles; no extra shadow caster/pass')
    t.diagnostic(JSON.stringify({normalColor,mirrorColor,normalOpacity,mirrorOpacity,meshes,triangles,incrementalDrawCalls:1}))
  } finally { f.close() }
})

test('upright felt lettering identifies the current world and shows only valid changed blind pairs', () => {
  const f = fixture()
  try {
    const holdem = f.scene.getObjectByName('TableHoldemEngraving'), mirror = f.scene.getObjectByName('TableMirrorEngraving'), blinds = f.scene.getObjectByName('TableBlindsEngraving')
    assert.ok(holdem && mirror && blinds)
    assert.equal(holdem.userData.text, 'HOLDEM'); assert.equal(mirror.userData.text, 'MIRROR')
    assert.equal(holdem.visible, true); assert.equal(mirror.visible, false)
    assert.deepEqual(holdem.position.toArray(), [0, CARD_REST.feltY + .0005, 1.4])
    assert.deepEqual(blinds.position.toArray(), [-2.6, CARD_REST.feltY + .0005, .12])
    for (const label of [holdem, mirror, blinds]) {
      assert.equal(label.rotation.z, 0); assert.equal(label.castShadow, false)
      assert.equal(label.material.depthWrite, false); assert.equal(label.material.polygonOffset, false)
      assert.equal(label.material.map, label.material.bumpMap)
      for (const point of vertices(label)) assert.ok(Math.abs(point.y - (CARD_REST.feltY + .0005)) < 1e-7)
    }
    const texture = blinds.material.map, originalCanvases = canvases.length
    const calls = () => texture.image.drawing.filter(([kind]) => kind === 'fillText')
    assert.equal(calls().at(-1)[1], '10 / 20')
    const initialDraws = calls().length
    f.world.setBlinds(10, 20)
    for (const pair of [[0, 20], [20, 10], [1.5, 30], [NaN, 30], [10, Infinity]]) f.world.setBlinds(...pair)
    assert.equal(calls().length, initialDraws, 'equal and invalid inputs never redraw the blind mask')
    f.world.setBlinds(25, 50)
    assert.equal(blinds.userData.text, '25 / 50'); assert.equal(calls().at(-1)[1], '25 / 50')
    assert.equal(calls().length, initialDraws + 1)
    f.world.update(.1, 'MIRROR')
    assert.ok(holdem.material.opacity > 0 && mirror.material.opacity > 0, 'world lettering softly cross-fades')
    for (let i = 0; i < 60; i++) f.world.update(.05, 'MIRROR')
    assert.equal(holdem.visible, false); assert.equal(mirror.visible, true)
    assert.equal(mirror.rotation.z, 0); assert.equal(blinds.rotation.z, 0)
    assert.equal(blinds.material.map, texture); assert.equal(canvases.length, originalCanvases)
    const released = [0, 0, 0]
    for (const [i, label] of [holdem, mirror, blinds].entries()) label.material.map.addEventListener('dispose', () => released[i]++)
    f.close()
    f.world.setBlinds(100, 200)
    assert.equal(calls().length, initialDraws + 1); assert.deepEqual(released, [1, 1, 1])
  } finally { f.close() }
})

test('dispose releases engraving geometry/material/texture once and restores the prior scene', () => {
  const scene = new THREE.Scene(), oldBackground = new THREE.Color('#abcabc'), oldFog = new THREE.Fog('#abcabc',1,5), oldEnvironment = new THREE.CubeTexture()
  scene.background=oldBackground;scene.fog=oldFog;scene.environment=oldEnvironment
  const world=createWorld(scene), mesh=scene.getObjectByName('TablePokerEngraving'), counts={geometry:0,material:0,texture:0}
  mesh.geometry.addEventListener('dispose',()=>counts.geometry++)
  mesh.material.addEventListener('dispose',()=>counts.material++)
  mesh.material.map.addEventListener('dispose',()=>counts.texture++)
  world.dispose();world.dispose();world.update(1,'MIRROR')
  assert.deepEqual(counts,{geometry:1,material:1,texture:1})
  assert.equal(scene.background,oldBackground);assert.equal(scene.fog,oldFog);assert.equal(scene.environment,oldEnvironment)
  assert.equal(scene.children.length,0)
})

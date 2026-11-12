import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
mkdirSync(resolve(root, '.test-output'), { recursive: true })
const build = spawnEsbuild(['tests/dealer-v5-entry.ts', '--bundle', '--platform=node', '--format=esm', '--outfile=.test-output/dealer-v5-bundle.mjs'], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, build.stderr)
const { THREE, createDealer, ANCHORS, CAMERA, OPTIONAL_ASSETS, TABLE } = await import('../.test-output/dealer-v5-bundle.mjs')
const originalDocument = globalThis.document, originalLoad = THREE.TextureLoader.prototype.load
const loads = []
globalThis.document = { createElement(name) {
  assert.equal(name, 'canvas')
  const context = new Proxy({ createRadialGradient() { return { addColorStop() {} } } }, { get(target, key) { return key in target ? target[key] : () => {} } })
  return { width: 0, height: 0, getContext() { return context } }
} }
THREE.TextureLoader.prototype.load = function(url, onLoad, _progress, onError) {
  const png = readFileSync(resolve(root, url))
  const texture = new THREE.Texture({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) })
  loads.push({ url, texture, onLoad, onError })
  return texture
}
after(() => { globalThis.document = originalDocument; THREE.TextureLoader.prototype.load = originalLoad })

function fixture(style = 'sprite', loading = 'ready') {
  const start = loads.length, scene = new THREE.Scene()
  const dealer = createDealer(scene, { style })
  const requests = loads.slice(start)
  const complete = () => requests.forEach(request => request.onLoad?.(request.texture))
  if (loading === 'ready') complete()
  return { scene, dealer, requests, complete, figure: () => scene.getObjectByName('DealerCutout'), close() { dealer.dispose(); dealer.dispose(); assert.equal(scene.children.length, 0) } }
}
function camera(width = 1280, height = 720) {
  const fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(CAMERA.fov / 2)) * Math.max(1, (16 / 9) / (width / height))))
  const view = new THREE.PerspectiveCamera(fov, width / height, CAMERA.near, CAMERA.far)
  view.position.set(...CAMERA.position); view.lookAt(...CAMERA.target); view.updateMatrixWorld(true)
  return view
}
function dimensions() {
  return [OPTIONAL_ASSETS.dealerNormal, OPTIONAL_ASSETS.dealerMirror].map(path => {
    const png = readFileSync(resolve(root, path))
    assert.equal(png.subarray(1, 4).toString(), 'PNG')
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
  })
}
const worldEvent = (seq = 1, mode = 'MIRROR') => ({ type: 'WORLD_CHANGED', seq, handId: 'hand-1', eventId: `world-${seq}`, worldMode: mode })
function assertNoToken(scene) {
  assert.equal(scene.getObjectByName('DealerWorldTurnToken'), undefined)
  scene.traverse(object => {
    assert.ok(!/WorldTurnToken|TokenTrail|TokenEcho/.test(object.name))
    assert.notEqual(object.geometry?.type, 'TorusGeometry', 'no hidden spinning-token rings remain')
  })
}
function poses(scene) {
  const values = []
  scene.traverse(object => values.push({ name: object.name, position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray() }))
  return values
}
function shaderFor(figure) {
  const shader = { uniforms: {}, vertexShader: '#include <begin_vertex>', fragmentShader: '#include <map_fragment>' }
  figure.material.onBeforeCompile(shader)
  return shader
}
function projectFigure(figure, view, width, height) {
  figure.updateWorldMatrix(true, false)
  const position = figure.geometry.getAttribute('position'), uv = figure.geometry.getAttribute('uv'), points = [], corners = {}
  for (let i = 0; i < position.count; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(figure.matrixWorld).project(view)
    points.push(new THREE.Vector2((p.x + 1) * width / 2, (1 - p.y) * height / 2))
    if ([0, 1].includes(uv.getX(i)) && [0, 1].includes(uv.getY(i))) corners[`${uv.getX(i)},${uv.getY(i)}`] = points.at(-1)
  }
  const left = Math.min(...points.map(point => point.x)), right = Math.max(...points.map(point => point.x))
  const top = Math.min(...points.map(point => point.y)), bottom = Math.max(...points.map(point => point.y))
  return { edgeAspect: corners['0,1'].distanceTo(corners['1,1']) / corners['0,1'].distanceTo(corners['0,0']), boxAspect: (right - left) / (bottom - top), left, right, top, bottom }
}

test('the approved v3 PNG aspect is preserved in screen projection at three viewport sizes', () => {
  const sizes = dimensions()
  assert.deepEqual(sizes, [{ width: 1215, height: 1295 }, { width: 1215, height: 1295 }])
  const expected = sizes[0].width / sizes[0].height
  const f = fixture()
  try {
    const figure = f.figure()
    assert.ok(figure.geometry.index.count > 6, 'connected hand-depth surface, with original image bounds')
    assert.equal(figure.userData.sourceAspect, expected)
    for (const [width, height] of [[1280, 720], [960, 600], [1920, 1080]]) {
      const view = camera(width, height)
      const projected = projectFigure(figure, view, width, height)
      assert.ok(Math.abs(projected.edgeAspect - expected) < 1e-6, JSON.stringify({ width, height, expected, projected }))
      assert.ok(Math.abs(projected.boxAspect - expected) < .004)
      f.dealer.event(worldEvent())
      for (let i = 0; i < 40; i++) f.dealer.update(.05, 'MIRROR')
      const breathing = projectFigure(figure, view, width, height)
      assert.ok(Math.abs(breathing.edgeAspect - expected) < 1e-6, 'uniform breathing does not flatten the portrait')
      assert.ok(Math.abs(breathing.boxAspect - expected) < .004, 'the tiny in-plane idle roll stays visually proportional')
      assert.ok(Math.abs(figure.scale.x - figure.scale.y) < 1e-12)
      f.dealer.reset(); f.dealer.update(0, 'NORMAL')
    }
  } finally { f.close() }
})

test('WORLD_CHANGED changes costumes/palette without introducing a token or a special world pose in either style', () => {
  for (const style of ['sprite', 'mesh']) {
    const normal = fixture(style), mirror = fixture(style)
    try {
      const before = poses(mirror.scene).length
      mirror.dealer.event(worldEvent())
      for (let i = 0; i < 30; i++) {
        normal.dealer.update(.05, 'NORMAL'); mirror.dealer.update(.05, 'MIRROR')
        assertNoToken(normal.scene); assertNoToken(mirror.scene)
        assert.equal(poses(mirror.scene).length, before)
        assert.deepEqual(poses(mirror.scene), poses(normal.scene), 'the world event adds no hand lift, spin, lean or scale gesture')
      }
      if (style === 'sprite') {
        assert.equal(shaderFor(normal.figure()).uniforms.worldMix.value, 0)
        assert.ok(shaderFor(mirror.figure()).uniforms.worldMix.value > .99)
      } else {
        const materialColors = scene => { const colors = []; scene.traverse(object => { if (object.isMesh && object.material.color) colors.push(object.material.color.toArray()) }); return colors }
        assert.notDeepEqual(materialColors(mirror.scene), materialColors(normal.scene), 'the mesh costume palette still changes')
      }
    } finally { normal.close(); mirror.close() }
  }
})

test('portrait pivot, depth protection and real table occlusion survive the aspect correction', () => {
  const f = fixture()
  try {
    const portrait = f.scene.getObjectByName('DealerSpriteCandidate'), figure = f.figure()
    assert.deepEqual(portrait.position.toArray(), [...ANCHORS.dealer])
    assert.equal(figure.material.depthTest, true)
    assert.equal(figure.material.depthWrite, true)
    assert.ok(figure.material.alphaTest > 0)
    assert.equal(figure.renderOrder, 1)
    const flat = figure.geometry.userData.flatPositions
    assert.ok(Math.abs(Math.min(...Array.from(flat).filter((_, i) => i % 3 === 1)) + .42) < 1e-6)
    const tableGeometry = new THREE.BoxGeometry(TABLE.width, .3, TABLE.depth), tableMaterial = new THREE.MeshBasicMaterial()
    const table = new THREE.Mesh(tableGeometry, tableMaterial)
    table.position.y = TABLE.topY - .15; f.scene.add(table); f.scene.updateMatrixWorld(true)
    const view = camera()
    const firstHit = localPoint => {
      const target = figure.localToWorld(localPoint)
      return new THREE.Raycaster(view.position, target.sub(view.position).normalize()).intersectObjects([table, figure], false)[0]?.object
    }
    assert.equal(firstHit(new THREE.Vector3(0, -.3, .035)), table, 'lower image remains occluded by the actual table depth')
    assert.equal(firstHit(new THREE.Vector3(0, 1.5, .035)), figure, 'the face stays visible above the rail')
    f.scene.remove(table); tableGeometry.dispose(); tableMaterial.dispose()
  } finally { f.close() }
})

test('the shader preserves costume mixing and leaves hand depth in the real CPU geometry', () => {
  const f = fixture()
  try {
    const shader = shaderFor(f.figure())
    assert.equal(shader.vertexShader, '#include <begin_vertex>')
    assert.equal(shader.uniforms.gestureLift, undefined)
    assert.match(shader.fragmentShader, /mix\(normalCutout, mirrorCutout, worldMix\)/)
    assert.equal(shader.uniforms.mirrorMap.value, f.requests[1].texture)
    assert.equal(shader.uniforms.dealerHeadMap.value, f.requests[2].texture)
    assert.match(shader.fragmentShader, /diffuseColor \*= dealerHead\(mix\(normalCutout, mirrorCutout, worldMix\), vMapUv\)/)
  } finally { f.close() }
})

test('late approved images and texture failure keep the loading/reset/dispose contract without a token', () => {
  const late = fixture('sprite', 'pending')
  try {
    assert.equal(late.scene.getObjectByName('DealerCroupier'), undefined, 'normal loading never flashes the prototype face')
    late.dealer.update(.1, 'MIRROR')
    late.requests.slice(0, 2).forEach(request => request.onLoad(request.texture))
    assert.equal(late.scene.getObjectByName('DealerSpriteCandidate').visible, false, 'both body variants wait for the new head')
    late.requests[2].onLoad(late.requests[2].texture)
    assert.equal(late.scene.getObjectByName('DealerSpriteCandidate').visible, true)
    assert.equal(shaderFor(late.figure()).uniforms.worldMix.value, 1, 'a late MIRROR load never flashes NORMAL')
    const texture = late.figure().material.map
    late.dealer.event(worldEvent()); late.dealer.update(.1, 'NORMAL'); late.dealer.reset()
    assert.equal(late.figure().material.map, texture)
    assertNoToken(late.scene)
  } finally { late.close() }
  const failed = fixture('sprite', 'pending')
  failed.requests[0].onError(new Error('missing test texture'))
  try {
    assert.ok(failed.scene.getObjectByName('DealerCroupier'))
    failed.dealer.event(worldEvent()); failed.dealer.update(.1, 'MIRROR'); failed.dealer.reset()
    assertNoToken(failed.scene)
  } finally { failed.close() }
  failed.complete() // A completed image callback after teardown must not recreate scene objects.
  assert.equal(failed.scene.children.length, 0)
})

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
mkdirSync(resolve(root, '.test-output'), { recursive: true })
const build = spawnEsbuild([
  'tests/dealer-v10-entry.ts', '--bundle', '--platform=node', '--format=esm',
  '--outfile=.test-output/dealer-v10-bundle.mjs',
], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, build.stderr)
const { THREE, createDealer, createWorld, ANCHORS, CAMERA, OPTIONAL_ASSETS, TABLE } = await import('../.test-output/dealer-v10-bundle.mjs')
const originalDocument = globalThis.document, originalLoad = THREE.TextureLoader.prototype.load
let dimensionsOverride = null
const requests = []
globalThis.document = { createElement() {
  const gradient = () => ({ addColorStop() {} })
  const context = new Proxy({
    createRadialGradient: gradient, createLinearGradient: gradient,
    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) } },
  }, { get(target, key) { return key in target ? target[key] : () => {} } })
  return { width: 0, height: 0, getContext() { return context } }
} }
THREE.TextureLoader.prototype.load = function(url, onLoad, _progress, onError) {
  const png = readFileSync(resolve(root, url))
  const size = dimensionsOverride?.[url] || [png.readUInt32BE(16), png.readUInt32BE(20)]
  const texture = new THREE.Texture({ width: size[0], height: size[1] })
  requests.push({ url, texture, onLoad, onError })
  return texture
}
after(() => { globalThis.document = originalDocument; THREE.TextureLoader.prototype.load = originalLoad })
function fixture(ready = true) {
  const scene = new THREE.Scene(), start = requests.length
  const dealer = createDealer(scene, { style: 'sprite' })
  const loads = requests.slice(start)
  if (ready) loads.forEach(load => load.onLoad(load.texture))
  return { scene, dealer, loads, figure: scene.getObjectByName('DealerCutout'), close() { dealer.dispose(); dealer.dispose(); assert.equal(scene.children.length, 0) } }
}
function camera(width = 1280, height = 720) {
  const fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(CAMERA.fov / 2)) * Math.max(1, (16 / 9) / (width / height))))
  const view = new THREE.PerspectiveCamera(fov, width / height, CAMERA.near, CAMERA.far)
  view.position.set(...CAMERA.position); view.lookAt(...CAMERA.target); view.updateMatrixWorld(true)
  return view
}
function sample(figure, u, top) {
  const uv = figure.geometry.getAttribute('uv')
  let best = -1, distance = Infinity
  for (let i = 0; i < uv.count; i++) {
    const d = (uv.getX(i) - u) ** 2 + (1 - uv.getY(i) - top) ** 2
    if (d < distance) { best = i; distance = d }
  }
  return best
}
function worldVertex(figure, index, flat = false) {
  figure.updateWorldMatrix(true, false)
  const point = flat ? new THREE.Vector3().fromArray(figure.geometry.userData.flatPositions, index * 3)
    : new THREE.Vector3().fromBufferAttribute(figure.geometry.getAttribute('position'), index)
  return point.applyMatrix4(figure.matrixWorld)
}
const event = (type, seq) => ({ type, seq, handId: 'hand-1', eventId: `event-${seq}` })

test('all hand/finger regions stay above the real tabletop throughout idle, deal and payout in both worlds', () => {
  const f = fixture()
  try {
    const { figure } = f, uv = figure.geometry.getAttribute('uv'), position = figure.geometry.getAttribute('position')
    const head = sample(figure, .49, .19), torso = sample(figure, .5, .96)
    const views = [[1280, 720], [960, 600], [1920, 1080]].map(size => camera(...size))
    for (let frame = 0; frame < 90; frame++) {
      if (frame === 12) f.dealer.event(event('CARDS_DEALT', 1))
      if (frame === 35) f.dealer.event(event('PAYOUT', 2))
      f.dealer.update(frame % 13 === 0 ? NaN : .1, frame < 45 ? 'NORMAL' : 'MIRROR')
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i), v = 1 - uv.getY(i)
        if (!figure.userData.handRegions.some(([left, top, right, bottom]) => u >= left && u <= right && v >= top && v <= bottom)) continue
        const actual = worldVertex(figure, i), baseline = worldVertex(figure, i, true)
        assert.ok(actual.y >= TABLE.topY + .025 - 1e-6, `frame ${frame} hand UV ${u},${v} Y ${actual.y}`)
        for (const view of views) {
          const a = actual.clone().project(view), b = baseline.clone().project(view)
          assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 2e-7, 'the hand does not move sideways on screen')
        }
      }
      for (const index of [head, torso]) {
        const baseline = new THREE.Vector3().fromArray(figure.geometry.userData.flatPositions, index * 3)
        assert.ok(new THREE.Vector3().fromBufferAttribute(position, index).distanceTo(baseline) < 1e-7, 'head and vest remain completely undeformed')
      }
      assert.ok(worldVertex(figure, torso).y < TABLE.topY, 'the waist stays behind the rail')
    }
  } finally { f.close() }
})

test('real world table hides the torso while both fingertips and the head win the depth test', () => {
  const f = fixture(), world = createWorld(f.scene)
  try {
    f.dealer.update(.1, 'NORMAL'); f.scene.updateMatrixWorld(true)
    const solids = []
    f.scene.getObjectByName('mirror-monolith-world').traverse(object => {
      if (object.isMesh && !object.material.transparent) solids.push(object)
    })
    const view = camera()
    for (const [u, v, expected] of [[.31, .96, 'hand'], [.72, .96, 'hand'], [.5, .96, 'table'], [.49, .19, 'head']]) {
      const target = worldVertex(f.figure, sample(f.figure, u, v))
      const ray = new THREE.Raycaster(view.position, target.clone().sub(view.position).normalize())
      const first = ray.intersectObjects([...solids, f.figure], false)[0]?.object
      if (expected === 'table') assert.notEqual(first, f.figure, 'actual rear rail occludes waist')
      else assert.equal(first, f.figure, `${expected} remains visible without disabling depth`)
    }
    assert.equal(f.figure.material.depthTest, true)
    assert.equal(f.figure.material.depthWrite, true)
    assert.equal(f.figure.material.toneMapped, false)
  } finally { world.dispose(); f.close() }
})

test('body aspect comes from loaded image dimensions and the third head texture gates visibility', () => {
  dimensionsOverride = { [OPTIONAL_ASSETS.dealerNormal]: [900, 1200], [OPTIONAL_ASSETS.dealerMirror]: [900, 1200] }
  const f = fixture(false)
  dimensionsOverride = null
  try {
    const group = f.scene.getObjectByName('DealerSpriteCandidate')
    assert.equal(group.userData.assetVersion, 'v14')
    f.loads.slice(0, 2).forEach(load => load.onLoad(load.texture))
    assert.equal(group.visible, false)
    assert.equal(f.scene.getObjectByName('DealerCroupier'), undefined)
    f.dealer.update(.1, 'MIRROR')
    f.loads[2].onLoad(f.loads[2].texture)
    assert.equal(group.visible, true)
    assert.equal(group.userData.loadingState, 'ready')
    assert.equal(f.figure.userData.sourceAspect, .75)
    assert.equal(f.figure.userData.imageWidth, 900)
    assert.equal(f.figure.userData.imageHeight, 1200)
    assert.deepEqual(group.position.toArray(), [...ANCHORS.dealer])
    const shader = { uniforms: {}, fragmentShader: '#include <map_fragment>', vertexShader: '#include <begin_vertex>' }
    f.figure.material.onBeforeCompile(shader)
    assert.equal(shader.uniforms.worldMix.value, 1)
    assert.equal(shader.uniforms.dealerHeadMap.value, f.loads[2].texture)
    assert.equal(f.loads[2].texture.colorSpace, THREE.SRGBColorSpace)
    assert.match(shader.fragmentShader, /return vec4\(mix\(body.rgb, reference, coverage\), body.a\)/, 'head keeps the approved body alpha silhouette')
    assert.match(shader.fragmentShader, /platformWardrobe\(texture2D\(map/)
    assert.match(shader.fragmentShader, /diffuseColor \*= dealerHead\(mix\(/, 'new head is applied after clothing recolor')
  } finally { f.close() }
})

test('missing new head or incompatible costume aspect uses the existing fallback and teardown disposes all maps', () => {
  const missing = fixture(false)
  try {
    missing.loads.slice(0, 2).forEach(load => load.onLoad(load.texture))
    missing.loads[2].onError(new Error('missing head'))
    assert.equal(missing.scene.getObjectByName('DealerSpriteCandidate').visible, false)
    assert.ok(missing.scene.getObjectByName('DealerCroupier'))
  } finally { missing.close() }
  dimensionsOverride = { [OPTIONAL_ASSETS.dealerMirror]: [900, 1200] }
  const mismatched = fixture()
  dimensionsOverride = null
  try {
    assert.equal(mismatched.scene.getObjectByName('DealerSpriteCandidate').visible, false)
    assert.ok(mismatched.scene.getObjectByName('DealerCroupier'), 'never stretch one costume to a different silhouette')
    let disposed = 0
    mismatched.loads.forEach(load => load.texture.addEventListener('dispose', () => disposed++))
    mismatched.dealer.dispose()
    assert.equal(disposed, 3)
    mismatched.loads.forEach(load => load.onLoad(load.texture))
  } finally { mismatched.close() }
})

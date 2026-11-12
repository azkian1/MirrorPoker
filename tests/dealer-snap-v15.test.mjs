import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
mkdirSync(resolve(root, '.test-output'), { recursive: true })
const build = spawnEsbuild([
  'tests/dealer-snap-v15-entry.ts', '--bundle', '--platform=node', '--format=esm',
  '--outfile=.test-output/dealer-snap-v15-bundle.mjs',
], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, build.stderr)
const { THREE, createDealer, DEALER_SNAP } = await import('../.test-output/dealer-snap-v15-bundle.mjs')
const originalDocument = globalThis.document, originalLoad = THREE.TextureLoader.prototype.load
const requests = []
globalThis.document = { createElement() {
  const context = new Proxy({ createRadialGradient: () => ({ addColorStop() {} }) }, { get: (target, key) => target[key] || (() => {}) })
  return { width: 0, height: 0, getContext: () => context }
} }
THREE.TextureLoader.prototype.load = function(url, onLoad, _progress, onError) {
  const texture = new THREE.Texture({ width: 1215, height: 1295 })
  requests.push({ url, texture, onLoad, onError })
  return texture
}
after(() => { globalThis.document = originalDocument; THREE.TextureLoader.prototype.load = originalLoad })

function fixture() {
  const start = requests.length, scene = new THREE.Scene()
  const dealer = createDealer(scene, { style: 'sprite' }), base = requests.slice(start)
  base.forEach(load => load.onLoad(load.texture))
  const poses = requests.slice(start + 3)
  return { scene, dealer, poses, base, group: scene.getObjectByName('DealerSpriteCandidate'), figure: scene.getObjectByName('DealerCutout'),
    close() { dealer.dispose(); dealer.dispose(); assert.equal(scene.children.length, 0) } }
}

test('registered native arms rise, hold, snap and return while the original body geometry stays fixed', () => {
  const f = fixture()
  try {
    f.poses.forEach(load => load.onLoad(load.texture))
    const arm = f.scene.getObjectByName('DealerSnapArm')
    assert.equal(f.poses.length, 8, 'four real pose textures for each costume')
    f.dealer.update(0, 'NORMAL')
    const fixed = Array.from(f.figure.geometry.getAttribute('position').array)
    const fixedTransform = [f.figure.position.toArray(), f.figure.scale.toArray(), f.figure.rotation.toArray()]
    for (const [age, expected] of [[0, [0, 1]], [DEALER_SNAP.ready / 3, [1, 2]], [DEALER_SNAP.ready * 2 / 3, [2, 3]],
      [DEALER_SNAP.ready, [3, 3]], [.64, [3, 3]], [.71999, [3, 3]], [.72, [4, 4]], [.879, [4, 4]], [1.39, [1, 0]]]) {
      f.dealer.setSnap(age); f.dealer.update(.016, 'NORMAL')
      assert.deepEqual(f.figure.userData.snapFrames.slice(0, 2), expected)
      assert.deepEqual(Array.from(f.figure.geometry.getAttribute('position').array), fixed, 'every body/head vertex remains pixel registered')
      assert.deepEqual([f.figure.position.toArray(), f.figure.scale.toArray(), f.figure.rotation.toArray()], fixedTransform)
      assert.equal(f.figure.geometry.userData.snapPositions, undefined, 'the body never uses the arm skin')
    }
    const bodyShader = { uniforms: {}, fragmentShader: '#include <map_fragment>', vertexShader: '' }
    const armShader = { uniforms: {}, fragmentShader: '#include <map_fragment>', vertexShader: '' }
    f.figure.material.onBeforeCompile(bodyShader); arm.material.onBeforeCompile(armShader)
    f.dealer.setSnap(.48)
    assert.equal(f.figure.userData.selectedPose, 3)
    assert.ok(f.figure.userData.snapWrist[1] > .52 && f.figure.userData.snapWrist[1] < .665)
    assert.ok(arm.geometry.userData.snapPositions.some((value, index) => Math.abs(value - arm.geometry.userData.flatPositions[index]) > .001), 'only the isolated arm is articulated')
    assert.equal(armShader.uniforms.armNormalMap.value, f.poses[2].texture)
    assert.equal(armShader.uniforms.armMirrorMap.value, f.poses[6].texture, 'white sleeve is real native art')
    assert.equal(bodyShader.uniforms.waistNormalMap.value, f.poses[2].texture)
    assert.equal(bodyShader.uniforms.waistMirrorMap.value, f.poses[6].texture)
    assert.equal(bodyShader.uniforms.worldMix.value, 0, 'raising the arm never changes the world palette')
    assert.ok(!/snapFromMap|armNormalMap|armMirrorMap/.test(bodyShader.fragmentShader), 'the fixed body cannot sample the moving arm drawing')
    assert.match(bodyShader.fragmentShader, /smoothstep\(\.80, \.83, p.y\)/, 'the visible upper chest/lapel stays original above the lower waist feather')
    assert.match(bodyShader.fragmentShader, /float amount = snapActive \* dealerWaistRegion/, 'fixed plate RGB covers both sides of the old glove boundary')
    assert.match(bodyShader.fragmentShader, /mix\(body.rgb \* body.a, waist.rgb \* waist.a, amount\)/, 'native cutout alpha blends in premultiplied form')
    assert.match(bodyShader.fragmentShader, /normalWaist.rgb \*= \.33/)
    assert.match(bodyShader.fragmentShader, /mirrorWaist.rgb \*= \.80/, 'waist exposure is measured separately from the arm shoulder')
    assert.ok(!/mirrorPoseWardrobe|pow\(/.test(armShader.fragmentShader), 'white cloth is never reconstructed from quantized black pixels')
    assert.match(bodyShader.fragmentShader, /dealerHead\(mix\(normalCutout, mirrorCutout, worldMix\)/)
    // None of the segmented sleeve/glove polygons can reach the central face,
    // chest, opposite arm, or the visible upper/mid right lapel.
    const inside = ([x, y], polygon) => polygon.reduce((hit, a, i) => {
      const b = polygon[(i + 1) % polygon.length]
      return (a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0] ? !hit : hit
    }, false)
    for (const age of [0, .19, .38, .56, .72]) {
      f.dealer.setSnap(age)
      assert.equal(bodyShader.uniforms.waistNormalMap.value, f.poses[2].texture, 'lower jacket plate never changes with the moving arm')
      assert.equal(bodyShader.uniforms.waistMirrorMap.value, f.poses[6].texture)
      const polygons = Object.values(arm.userData.sourcePolygon)
      for (const point of [[.49, .19], [.30, .90], [.50, .65], [.74, .50], [.76, .65]]) {
        assert.ok(polygons.every(polygon => !inside(point, polygon)), `body pixel ${point} cannot enter arm drawing`)
      }
    }
    f.dealer.setSnap(.72)
    assert.equal(armShader.uniforms.armNormalMap.value, f.poses[3].texture)
    assert.equal(armShader.uniforms.armMirrorMap.value, f.poses[7].texture)
    assert.equal(bodyShader.uniforms.snapActive.value, 1)
    f.dealer.setSnap(DEALER_SNAP.duration)
    assert.equal(bodyShader.uniforms.snapActive.value, 0)
    assert.equal(arm.visible, false)
    assert.deepEqual(f.figure.userData.snapFrames, [0, 0, 0])
    for (let frame = 0; frame < 20; frame++) {
      f.dealer.update(.1, 'NORMAL')
      assert.deepEqual(Array.from(f.figure.geometry.getAttribute('position').array), fixed, 'idle keeps the same registered height')
      assert.deepEqual([f.figure.position.toArray(), f.figure.scale.toArray(), f.figure.rotation.toArray()], fixedTransform)
    }
    for (const invalid of [null, -1, NaN, Infinity]) { f.dealer.setSnap(invalid); assert.equal(f.group.userData.snapAge, null) }
  } finally { f.close() }
})

test('every moving glove stays above the felt through the full gesture without changing its camera projection', () => {
  const f = fixture()
  try {
    f.poses.forEach(load => load.onLoad(load.texture))
    const arm = f.scene.getObjectByName('DealerSnapArm')
    const camera = new THREE.PerspectiveCamera(33, 16 / 9, .1, 80)
    camera.position.set(0, 12.8, 11); camera.lookAt(0, 1, -.15); camera.updateMatrixWorld()
    const inside = ([x, y], polygon) => polygon.reduce((hit, a, i) => {
      const b = polygon[(i + 1) % polygon.length]
      return (a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0] ? !hit : hit
    }, false)
    let protectedReturningVertices = 0
    for (const mode of ['NORMAL', 'MIRROR']) {
      f.dealer.reset(); f.dealer.update(0, mode)
      const fixedBody = Array.from(f.figure.geometry.getAttribute('position').array)
      for (let frame = 0; frame * .02 < DEALER_SNAP.duration; frame++) {
        const age = frame * .02
        f.dealer.setSnap(age); f.dealer.update(.02, mode)
        arm.updateWorldMatrix(true, false)
        const uv = arm.geometry.getAttribute('uv'), positions = arm.geometry.getAttribute('position')
        const source = arm.geometry.userData.snapPositions, glove = arm.userData.sourcePolygon.glove
        const floor = arm.userData.handSurfaceY
        let checked = 0
        for (let i = 0; i < uv.count; i++) {
          if (!inside([uv.getX(i), 1 - uv.getY(i)], glove)) continue
          const baseline = new THREE.Vector3().fromArray(source, i * 3).applyMatrix4(arm.matrixWorld)
          const seated = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(arm.matrixWorld)
          assert.ok(seated.y >= floor - 1e-6, `${mode} ${age.toFixed(2)}s: the complete selected glove stays above the felt`)
          if (age > DEALER_SNAP.release && baseline.y < floor - .001) protectedReturningVertices++
          baseline.project(camera); seated.project(camera)
          assert.ok(Math.abs(baseline.x - seated.x) < 1e-6 && Math.abs(baseline.y - seated.y) < 1e-6,
            `${mode} ${age.toFixed(2)}s: depth seating preserves the skinned drawing's camera ray`)
          checked++
        }
        assert.ok(checked > 100, 'check the full selected glove polygon, including its fingertips')
        assert.deepEqual(Array.from(f.figure.geometry.getAttribute('position').array), fixedBody, 'the body remains registered throughout the gesture')
      }
    }
    assert.ok(protectedReturningVertices > 0, 'the regression exercises fingertips that would otherwise fall below the hand surface on return')
  } finally { f.close() }
})

test('missing or incompatible native pose art keeps the original portrait intact in either world', () => {
  const f = fixture()
  try {
    assert.equal(f.group.visible, true)
    f.poses.forEach((load, index) => { if (index !== 6) load.onLoad(load.texture) })
    f.poses[6].texture.image = { width: 900, height: 900 }; f.poses[6].onLoad(f.poses[6].texture)
    f.dealer.setSnap(.72)
    assert.deepEqual(f.figure.userData.snapFrames.slice(0, 2), [0, 0])
    assert.deepEqual(f.group.userData.snapMirrorPoseState, ['ready', 'ready', 'incompatible', 'ready'])
    assert.equal(f.scene.getObjectByName('DealerSnapArm').visible, false)
    assert.equal(f.group.visible, true)
    assert.equal(f.group.userData.loadingState, 'ready')
    assert.equal(f.scene.getObjectByName('DealerCroupier'), undefined)
    const shader = { uniforms: {}, fragmentShader: '#include <map_fragment>', vertexShader: '' }
    f.figure.material.onBeforeCompile(shader)
    assert.equal(shader.uniforms.snapActive.value, 0, 'original resting arm remains visible')
    f.dealer.update(.1, 'MIRROR')
    f.poses[3].onError(new Error('missing release'))
    f.dealer.reset()
    assert.deepEqual(f.figure.userData.snapFrames, [0, 0, 0])
    let disposed = 0
    for (const load of [...f.base, ...f.poses]) load.texture.addEventListener('dispose', () => disposed++)
    f.dealer.dispose(); assert.equal(disposed, 11)
    f.poses.forEach(load => load.onLoad(load.texture))
    assert.equal(f.scene.children.length, 0)
  } finally { f.close() }
})

test('mesh fallback raises its arm and changes finger pose on the same release boundary', () => {
  const scene = new THREE.Scene(), dealer = createDealer(scene, { style: 'mesh' })
  try {
    const hand = scene.getObjectByName('DealerSnapHand'), finger = scene.getObjectByName('DealerSnapMiddleFinger')
    dealer.setSnap(DEALER_SNAP.ready / 2); dealer.update(0, 'NORMAL')
    assert.ok(Math.abs(finger.rotation.x) < 1e-9, 'hand remains relaxed during the early lift')
    dealer.setSnap(DEALER_SNAP.ready); dealer.update(0, 'NORMAL')
    const top = hand.rotation.x
    dealer.setSnap(DEALER_SNAP.release - .0001); dealer.update(0, 'NORMAL')
    const ready = finger.rotation.x
    assert.equal(hand.rotation.x, top, 'hand holds its top height before release')
    assert.ok(Math.abs(hand.rotation.x) > .5)
    dealer.setSnap(DEALER_SNAP.release); dealer.update(0, 'NORMAL')
    assert.ok(finger.rotation.x > ready * 2)
    dealer.reset(); dealer.update(0, 'NORMAL')
    assert.ok(Math.abs(hand.rotation.x) < 1e-9)
    assert.ok(Math.abs(finger.rotation.x) < 1e-9)
  } finally { dealer.dispose() }
})

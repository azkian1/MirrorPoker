import * as THREE from 'three'
import { ANCHORS, CAMERA, DEALER_SNAP, OPTIONAL_ASSETS, PLATFORM_PALETTE, TABLE } from '../shared/assets.ts'
import type { GameEvent, WorldMode } from '../shared/contracts.ts'
import { createCardFactory } from './pieces.ts'
import { DEALER_HEAD_GLSL } from './dealer-head.ts'

export interface DealerView {
  update(dt: number, worldMode: WorldMode): void
  event(event: GameEvent): void
  /** Presentation time supplied by the client; null restores the resting pose. */
  setSnap(ageSeconds: number | null): void
  reset(): void
  dispose(): void
}

type PaletteMaterial = { material: THREE.MeshStandardMaterial; normal: THREE.Color; mirror: THREE.Color }
type Reaction = 'idle' | 'deal' | 'win'
const ease = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t) }

/** Original stylized mesh croupier. This is an articulated art prototype, not a scanned/rigged asset. */
export function createDealer3D(scene: THREE.Scene): DealerView {
  const root = new THREE.Group()
  root.name = 'DealerCroupier'
  root.position.set(...ANCHORS.dealer)
  scene.add(root)
  const body = new THREE.Group()
  root.add(body)
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const palette: PaletteMaterial[] = []
  const mat = (normal: string, mirror: string, options: THREE.MeshStandardMaterialParameters = {}) => {
    const material = new THREE.MeshStandardMaterial({ color: normal, roughness: .62, flatShading: true, ...options })
    materials.add(material)
    palette.push({ material, normal: new THREE.Color(normal), mirror: new THREE.Color(mirror) })
    return material
  }
  const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D = body) => {
    geometries.add(geometry)
    materials.add(material)
    const result = new THREE.Mesh(geometry, material)
    result.castShadow = result.receiveShadow = true
    parent.add(result)
    return result
  }
  const polygon = (points: [number, number][], z: number, material: THREE.Material, parent: THREE.Object3D = body) => {
    const shape = new THREE.Shape()
    points.forEach(([x, y], i) => i ? shape.lineTo(x, y) : shape.moveTo(x, y))
    shape.closePath()
    const result = mesh(new THREE.ShapeGeometry(shape), material, parent)
    result.position.z = z
    return result
  }
  const sphere = (radius: number, material: THREE.Material, parent: THREE.Object3D, x: number, y: number, z: number) => {
    const result = mesh(new THREE.SphereGeometry(radius, 8, 6), material, parent)
    result.position.set(x, y, z)
    return result
  }
  const segment = (from: THREE.Vector3, to: THREE.Vector3, top: number, bottom: number, material: THREE.Material, parent: THREE.Object3D) => {
    const direction = to.clone().sub(from)
    const result = mesh(new THREE.CylinderGeometry(top, bottom, direction.length(), 7), material, parent)
    result.position.copy(from).add(to).multiplyScalar(.5)
    result.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize())
    return result
  }

  const suit = mat('#14171e', '#e4dfd5', { roughness: .66 })
  const lapel = mat('#242832', '#eee8dc', { roughness: .4, metalness: .08 })
  const vest = mat(PLATFORM_PALETTE.forest, PLATFORM_PALETTE.forest, { roughness: .7 })
  const piping = mat(PLATFORM_PALETTE.lime, PLATFORM_PALETTE.forest, { roughness: .44 })
  const shirt = mat('#c8bdab', '#f1eadc', { roughness: .81 })
  const skin = mat('#d8d0bf', '#e8ddcb', { roughness: .83 })
  const noseMat = mat('#c5b8a5', '#d7c8b4', { roughness: .8 })
  const shadow = mat('#242126', '#2b2328', { roughness: .9 })
  const hair = mat('#101218', '#171a21', { roughness: .33 })
  const glove = mat('#17191f', '#e2d8c9', { roughness: .67 })
  const metal = mat('#aaa394', '#b7aa91', { roughness: .25, metalness: .8 })
  const lips = mat('#946b5e', '#a87d6c', { roughness: .8 })

  const torsoShape = new THREE.Shape()
  ;[[-.37, 0], [.37, 0], [.48, .55], [.64, 1.17], [.53, 1.34], [.25, 1.47],
    [-.25, 1.47], [-.53, 1.34], [-.64, 1.17], [-.48, .55]].forEach(([x, y], i) => i ? torsoShape.lineTo(x, y) : torsoShape.moveTo(x, y))
  torsoShape.closePath()
  const torsoGeometry = new THREE.ExtrudeGeometry(torsoShape, { depth: .42, bevelEnabled: false, steps: 1 })
  torsoGeometry.translate(0, 0, -.21)
  mesh(torsoGeometry, suit)

  polygon([[-.17, 1.48], [.17, 1.48], [.24, 1.18], [0, .77], [-.24, 1.18]], .215, shirt)
  polygon([[-.34, .05], [.34, .05], [.37, .91], [.16, 1.29], [0, 1.06], [-.16, 1.29], [-.37, .91]], .224, vest)
  polygon([[-.045, 1.32], [.045, 1.32], [.062, 1.19], [0, 1.10], [-.062, 1.19]], .233, shadow)
  polygon([[-.023, 1.15], [.023, 1.15], [.047, .85], [0, .79], [-.047, .85]], .234, shadow)
  polygon([[-.22, 1.46], [-.52, 1.27], [-.36, 1.02], [-.44, .94], [-.035, .42], [-.105, 1.12]], .242, lapel)
  polygon([[.22, 1.46], [.52, 1.27], [.36, 1.02], [.44, .94], [.035, .42], [.105, 1.12]], .242, lapel)
  // Thin green lapel piping preserves the costume's existing silhouette detail.
  polygon([[-.22, 1.46], [-.205, 1.449], [-.09, 1.12], [-.022, .42], [-.043, .45], [-.12, 1.12]], .246, piping)
  polygon([[.22, 1.46], [.205, 1.449], [.09, 1.12], [.022, .42], [.043, .45], [.12, 1.12]], .246, piping)
  for (const y of [.31, .52, .73]) {
    const button = sphere(.023, metal, body, .035, y, .252)
    button.scale.z = .35
  }
  polygon([[.29, .98], [.43, 1.01], [.42, .95], [.3, .93]], .251, vest)
  const pinMaterial = mat(PLATFORM_PALETTE.lime, PLATFORM_PALETTE.lime, { roughness: .3, metalness: .55, emissive: PLATFORM_PALETTE.lime, emissiveIntensity: .12 })
  const pin = mesh(new THREE.OctahedronGeometry(.043, 0), pinMaterial)
  pin.position.set(-.37, 1.22, .28)

  const neck = mesh(new THREE.CylinderGeometry(.115, .135, .23, 8), skin)
  neck.position.set(0, 1.48, -.005)
  const collarLeft = polygon([[-.16, 1.48], [-.015, 1.36], [-.12, 1.22], [-.23, 1.39]], .258, shirt)
  const collarRight = polygon([[.16, 1.48], [.015, 1.36], [.12, 1.22], [.23, 1.39]], .258, shirt)
  collarLeft.castShadow = collarRight.castShadow = false

  const head = new THREE.Group()
  head.position.set(0, 1.91, .015)
  body.add(head)
  const skull = mesh(new THREE.SphereGeometry(1, 12, 8), skin, head)
  skull.scale.set(.315, .425, .275)
  const jaw = mesh(new THREE.SphereGeometry(1, 8, 5), skin, head)
  jaw.scale.set(.23, .22, .22)
  jaw.position.set(0, -.22, .012)
  // Separate low-contrast cheek facets keep the face legible from the fixed high camera.
  polygon([[-.27, -.02], [-.10, -.08], [-.19, -.22], [-.28, -.13]], .205, noseMat, head)
  polygon([[.27, -.02], [.10, -.08], [.19, -.22], [.28, -.13]], .205, noseMat, head)
  for (const side of [-1, 1]) {
    const eye = polygon([[side * .055, .075], [side * .225, .105], [side * .195, -.018], [side * .085, -.025]], .253, shadow, head)
    eye.castShadow = false
    const brow = mesh(new THREE.BoxGeometry(.177, .033, .025), hair, head)
    brow.position.set(side * .14, .116, .26)
    brow.rotation.z = -side * .23
    const glint = sphere(.012, shirt, head, side * .124, .028, .267)
    glint.scale.y = .55
    const ear = sphere(.07, skin, head, side * .313, -.012, -.025)
    ear.scale.set(.55, 1.2, .75)
  }
  const nose = mesh(new THREE.ConeGeometry(.055, .16, 4), noseMat, head)
  nose.rotation.x = Math.PI / 2
  nose.position.set(0, -.04, .289)
  polygon([[-.195, -.135], [-.10, -.175], [.035, -.18], [.2, -.105], [.145, -.2], [-.005, -.23], [-.14, -.195]], .245, lips, head)
  polygon([[-.115, -.174], [.025, -.187], [.14, -.15], [.075, -.19], [-.018, -.205]], .249, shirt, head)
  const scalp = mesh(new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI * .55), hair, head)
  scalp.scale.set(.337, .44, .293)
  scalp.position.set(0, .035, -.03)
  for (let i = 0; i < 5; i++) {
    const tuft = mesh(new THREE.ConeGeometry(.115, .38, 3), hair, head)
    tuft.position.set(-.23 + i * .103, .38 + Math.sin(i * .62) * .035, -.025 - i * .018)
    tuft.rotation.z = -.52 - i * .08
    tuft.rotation.x = -.35
  }
  const fringe = mesh(new THREE.ConeGeometry(.11, .32, 3), hair, head)
  fringe.position.set(-.2, .19, .18)
  fringe.rotation.z = 2.72
  fringe.rotation.x = -.2

  function arm(side: number) {
    const shoulder = new THREE.Group()
    shoulder.position.set(side * .575, 1.24, -.015)
    body.add(shoulder)
    const elbowPosition = new THREE.Vector3(side * .16, -.58, .12)
    segment(new THREE.Vector3(), elbowPosition, .16, .145, suit, shoulder)
    const elbow = new THREE.Group()
    elbow.position.copy(elbowPosition)
    shoulder.add(elbow)
    const wristPosition = new THREE.Vector3(-side * .075, -.44, .57)
    segment(new THREE.Vector3(), wristPosition, .117, .14, suit, elbow)
    segment(wristPosition.clone().multiplyScalar(.86), wristPosition, .118, .118, shirt, elbow)
    const hand = new THREE.Group()
    hand.position.copy(wristPosition)
    elbow.add(hand)
    const palm = mesh(new THREE.BoxGeometry(.19, .10, .235), glove, hand)
    palm.position.set(0, -.006, .1)
    palm.rotation.x = -.12
    const fingers: THREE.Group[] = []
    for (let i = 0; i < 4; i++) {
      const x = -.067 + i * .044
      const finger = new THREE.Group()
      finger.position.set(x, -.018, .16)
      hand.add(finger)
      segment(new THREE.Vector3(), new THREE.Vector3(0, -.007, .14 - Math.abs(i - 1.5) * .018), .022, .025, glove, finger)
      fingers.push(finger)
    }
    const thumb = new THREE.Group()
    thumb.position.set(-side * .08, 0, .08)
    hand.add(thumb)
    segment(new THREE.Vector3(), new THREE.Vector3(-side * .06, -.01, .09), .032, .038, glove, thumb)
    const cuffLink = sphere(.019, metal, hand, side * .11, .025, -.025)
    cuffLink.scale.z = .5
    return { shoulder, elbow, hand, fingers, thumb }
  }
  const left = arm(-1), right = arm(1)
  right.hand.name = 'DealerSnapHand'
  right.fingers[1].name = 'DealerSnapMiddleFinger'
  // Dealer prop uses the same card dimensions, geometry and canvas faces as all game cards.
  const cardFactory = createCardFactory()
  const heldCard = cardFactory.create(null)
  heldCard.group.position.set(-.015, .21, .105)
  heldCard.group.rotation.set(1.04, -.12, -.13)
  left.hand.add(heldCard.group)

  // Batch static parts inside each articulated node. Preserve head/arm pivots and card factory meshes.
  function batchStatic(parent: THREE.Object3D) {
    const buckets = new Map<string, THREE.Mesh[]>()
    for (const child of [...parent.children]) {
      if (child instanceof THREE.Mesh && geometries.has(child.geometry) && !Array.isArray(child.material)) {
        const key = `${child.material.uuid}:${child.castShadow}:${child.receiveShadow}`
        const bucket = buckets.get(key) || []
        bucket.push(child)
        buckets.set(key, bucket)
      }
    }
    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue
      const positions: number[] = [], normals: number[] = [], uvs: number[] = []
      for (const part of bucket) {
        part.updateMatrix()
        const source = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone()
        source.applyMatrix4(part.matrix)
        const position = source.getAttribute('position'), normal = source.getAttribute('normal'), uv = source.getAttribute('uv')
        for (let i = 0; i < position.count; i++) {
          positions.push(position.getX(i), position.getY(i), position.getZ(i))
          normals.push(normal.getX(i), normal.getY(i), normal.getZ(i))
          uvs.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0)
        }
        source.dispose()
        parent.remove(part)
        part.geometry.dispose()
        geometries.delete(part.geometry)
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
      const combined = mesh(geometry, bucket[0].material as THREE.Material, parent)
      combined.castShadow = bucket[0].castShadow
      combined.receiveShadow = bucket[0].receiveShadow
    }
  }
  for (const node of [body, head, left.shoulder, left.elbow, left.hand, right.shoulder, right.elbow, right.hand]) batchStatic(node)

  let elapsed = 0, mix = 0, age = 10, reaction: Reaction = 'idle', disposed = false
  let snapAge: number | null = null
  const seen = new Set<string>()
  let lastSeq = -1
  return {
    update(dt, worldMode) {
      if (disposed) return
      const delta = Number.isFinite(dt) ? Math.max(0, Math.min(dt, .1)) : 0
      elapsed += delta
      age += delta
      mix += ((worldMode === 'MIRROR' ? 1 : 0) - mix) * (1 - Math.exp(-delta * 4.4))
      for (const entry of palette) entry.material.color.copy(entry.normal).lerp(entry.mirror, mix)
      const duration = reaction === 'win' ? 1.05 : .8
      const phase = Math.min(1, age / duration)
      const envelope = Math.sin(phase * Math.PI)
      if (phase >= 1) reaction = 'idle'
      const deal = reaction === 'deal' ? envelope : 0
      const win = reaction === 'win' ? envelope : 0
      body.position.y = Math.sin(elapsed * 1.25) * .009
      body.rotation.y = Math.sin(elapsed * .37) * .018
      head.rotation.set(-.15 + win * .12, Math.sin(elapsed * .48) * .065 + deal * .045, Math.sin(elapsed * .61) * .018)
      head.position.y = 1.91 + Math.sin(elapsed * 1.25 + .3) * .006
      left.shoulder.rotation.set(-.025 - deal * .24, deal * .09, -.025)
      right.shoulder.rotation.set(-.02 - win * .11, -win * .08, .025)
      left.elbow.rotation.set(-deal * .16, -deal * .18, 0)
      right.elbow.rotation.set(0, win * .09, 0)
      const raised = snapAge === null ? 0 : snapAge < DEALER_SNAP.release
        ? ease(snapAge / DEALER_SNAP.ready)
        : 1 - ease((snapAge - DEALER_SNAP.release - DEALER_SNAP.hold) / (DEALER_SNAP.duration - DEALER_SNAP.release - DEALER_SNAP.hold))
      const released = snapAge !== null && snapAge >= DEALER_SNAP.release
      const prepared = snapAge === null ? 0 : ease((snapAge - DEALER_SNAP.ready * .70) / (DEALER_SNAP.ready * .30))
      right.shoulder.rotation.x -= raised * .88
      right.shoulder.rotation.z -= raised * .30
      right.elbow.rotation.x -= raised * 1.15
      right.hand.rotation.set(raised * -.54, raised * .15, raised * -.27)
      right.fingers.forEach((finger, index) => {
        finger.rotation.x = raised * (index === 1 ? released ? 1.12 : .34 * prepared : index > 1 ? .92 * prepared : .20 * prepared)
        finger.rotation.y = raised * prepared * (index === 1 ? -.20 : .05)
      })
      right.thumb.rotation.set(raised * prepared * -.45, raised * prepared * (released ? -.3 : -.9), raised * prepared * -.25)
      heldCard.group.rotation.y = -.12 + deal * .28 + Math.sin(elapsed * .7) * .015
    },
    setSnap(value) {
      if (disposed) return
      snapAge = value !== null && Number.isFinite(value) && value >= 0 && value < DEALER_SNAP.duration ? value : null
      root.userData.snapAge = snapAge
    },
    event(event) {
      if (disposed || seen.has(event.eventId) || event.seq <= lastSeq) return
      seen.add(event.eventId)
      lastSeq = event.seq
      if (seen.size > 256) seen.delete(seen.values().next().value as string)
      if (event.type === 'PAYOUT') reaction = 'win'
      else if (event.type === 'CARDS_DEALT' || event.type === 'STREET_CHANGED') reaction = 'deal'
      else return
      age = 0
    },
    reset() {
      seen.clear()
      lastSeq = -1
      reaction = 'idle'
      age = 10
      snapAge = null
      root.userData.snapAge = null
    },
    dispose() {
      if (disposed) return
      disposed = true
      scene.remove(root)
      cardFactory.dispose()
      geometries.forEach(geometry => geometry.dispose())
      materials.forEach(material => material.dispose())
      seen.clear()
    },
  }
}

export type DealerStyle = 'mesh' | 'sprite'

/** Top-left image coordinates, including the cuff and every fingertip. */
export type DealerHandRegion = readonly [left: number, top: number, right: number, bottom: number]

// Both costume images must share this pose/layout. Root can replace these bounds
// with the approved asset metadata without changing the rendering/lifecycle API.
const HAND_REGIONS: readonly DealerHandRegion[] = [[.15, .80, .43, 1], [.60, .80, .90, 1]]
const PORTRAIT_HEIGHT = 2.7
const PORTRAIT_BOTTOM = -.42
const HAND_SURFACE_Y = TABLE.topY + .025

type ArmPoint = readonly [number, number]
type ArmPose = { shoulder: ArmPoint; elbow: ArmPoint; wrist: ArmPoint; palm: ArmPoint }
// Registered top-left image landmarks. Fingers belong to the palm bone; the
// ready/release pair deliberately shares its wrist and palm placement.
const ARM_POSES: readonly ArmPose[] = [
  { shoulder: [.835, .45], elbow: [.944, .777], wrist: [.846, .868], palm: [.747, .919] },
  { shoulder: [.835, .45], elbow: [.942, .851], wrist: [.817, .866], palm: [.727, .811] },
  { shoulder: [.835, .45], elbow: [.918, .843], wrist: [.910, .665], palm: [.893, .562] },
  { shoulder: [.835, .45], elbow: [.916, .801], wrist: [.925, .520], palm: [.920, .424] },
  { shoulder: [.835, .45], elbow: [.916, .801], wrist: [.925, .520], palm: [.920, .424] },
]

// Source-image sleeve seams, separate from the lapel/chest. The glove polygons
// include genuine hand pixels that overlap the lower jacket in the resting pose.
// They are evaluated before skinning, so no generated torso is ever sampled.
const ARM_SLEEVE: readonly ArmPoint[] = [
  [.828, .410], [.817, .49], [.806, .56], [.790, .65], [.773, .72],
  [.754, .80], [.778, .835], [.82, .94], [1.01, .95], [1.01, .410],
]
const ARM_GLOVES: readonly (readonly ArmPoint[])[] = [
  [[.827, .829], [.772, .831], [.715, .838], [.673, .873], [.622, .915], [.621, .995], [.705, 1.01], [.853, .976], [.90, .923], [.891, .855]],
  [[.806, .844], [.793, .779], [.777, .748], [.758, .750], [.75, .779], [.722, .757], [.680, .728], [.657, .726], [.630, .740], [.622, .766], [.625, .801], [.642, .837], [.692, .872], [.76, .908], [.825, .908], [.85, .88]],
  [[.850, .690], [.823, .622], [.807, .560], [.798, .513], [.808, .483], [.830, .483], [.848, .535], [.856, .496], [.846, .47], [.86, .435], [.88, .425], [.925, .459], [.97, .51], [.985, .58], [.97, .65], [.949, .70]],
  [[.81, .25], [1.01, .25], [1.01, .58], [.86, .58], [.82, .44]],
  [[.81, .25], [1.01, .25], [1.01, .58], [.86, .58], [.82, .44]],
]
// A returning raised drawing can put fingertips below the felt even though
// their source UVs are above the resting hand bounds. Protect each full glove
// along the same camera rays, while retaining the original cuff coverage.
const ARM_HAND_REGIONS: readonly (readonly DealerHandRegion[])[] = ARM_GLOVES.map(points => [
  ...HAND_REGIONS,
  [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1])),
    Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))],
])

function polygonGLSL(name: string, points: readonly ArmPoint[]) {
  const vector = (point: ArmPoint) => `vec2(${point[0].toFixed(5)}, ${point[1].toFixed(5)})`
  return `float ${name}(vec2 p) { float inside = 0.0;\n${points.map((a, index) => {
    const b = points[(index + 1) % points.length]
    if (a[1] === b[1]) return ''
    return `if (((${vector(a)}.y > p.y) != (${vector(b)}.y > p.y)) && p.x < (${vector(b)}.x - ${vector(a)}.x) * (p.y - ${vector(a)}.y) / (${vector(b)}.y - ${vector(a)}.y) + ${vector(a)}.x) inside = 1.0 - inside;`
  }).join('\n')}\nreturn inside; }`
}

const ARM_MASK_GLSL = [polygonGLSL('dealerSleeveMask', ARM_SLEEVE),
  ...ARM_GLOVES.map((points, index) => polygonGLSL(`dealerGloveMask${index}`, points)),
  `float dealerArmMask(vec2 uv, float pose) {
    vec2 p = vec2(uv.x, 1.0 - uv.y);
    float glove = dealerGloveMask0(p);
    if (pose > .5 && pose < 1.5) glove = dealerGloveMask1(p);
    else if (pose < 2.5 && pose > 1.5) glove = dealerGloveMask2(p);
    else if (pose < 3.5 && pose > 2.5) glove = dealerGloveMask3(p);
    else if (pose > 3.5) glove = dealerGloveMask4(p);
    return max(dealerSleeveMask(p), glove);
  }`,
].join('\n')

const WARDROBE_GLSL = `
  uniform vec3 wardrobeGreen;
  vec4 platformWardrobe(vec4 cutout, vec2 uv) {
    float neckline = .585 + .115 * smoothstep(.065, .13, abs(uv.x - .49));
    float clothing = 1.0 - smoothstep(neckline - .008, neckline + .008, uv.y);
    float redDominance = (cutout.r - max(cutout.g, cutout.b)) / max(cutout.r, .0001);
    float sourceLuma = dot(cutout.rgb, vec3(.2126, .7152, .0722));
    float fabric = clothing * smoothstep(.48, .64, redDominance)
      * smoothstep(.0005, .002, sourceLuma);
    float greenLuma = dot(wardrobeGreen, vec3(.2126, .7152, .0722));
    vec3 greenFabric = wardrobeGreen * sourceLuma / max(greenLuma, .0001);
    return vec4(mix(cutout.rgb, greenFabric, fabric), cutout.a);
  }
`

function tweenArm(first: ArmPose, second: ArmPose, amount: number, aspect: number): ArmPose {
  const point = (a: ArmPoint, b: ArmPoint): ArmPoint => [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount]
  const wrist = point(first.wrist, second.wrist)
  const direction = (pose: ArmPose) => [Math.atan2(pose.palm[1] - pose.wrist[1], (pose.palm[0] - pose.wrist[0]) * aspect),
    Math.hypot((pose.palm[0] - pose.wrist[0]) * aspect, pose.palm[1] - pose.wrist[1])]
  const [angleA, lengthA] = direction(first), [angleB, lengthB] = direction(second)
  const turn = Math.atan2(Math.sin(angleB - angleA), Math.cos(angleB - angleA))
  const angle = angleA + turn * amount, length = lengthA + (lengthB - lengthA) * amount
  return { shoulder: point(first.shoulder, second.shoulder), elbow: point(first.elbow, second.elbow), wrist,
    palm: [wrist[0] + Math.cos(angle) * length / aspect, wrist[1] + Math.sin(angle) * length] }
}

/** Move one opaque arm artwork along a continuous articulated path. */
function poseArm(figure: THREE.Mesh, sourceIndex: number, target: ArmPose | null) {
  const geometry = figure.geometry, flat = geometry.userData.flatPositions as Float32Array
  if (!target) { geometry.userData.snapPositions = null; return }
  const aspect = figure.userData.sourceAspect as number || 1
  const source = ARM_POSES[sourceIndex], uv = geometry.getAttribute('uv')
  const output = geometry.userData.snapPositions as Float32Array | null || new Float32Array(flat.length)
  output.set(flat)
  const metric = (point: ArmPoint): ArmPoint => [point[0] * aspect, point[1]]
  const s = [source.shoulder, source.elbow, source.wrist, source.palm].map(metric)
  const t = [target.shoulder, target.elbow, target.wrist, target.palm].map(metric)
  const project = (point: ArmPoint, a: ArmPoint, b: ArmPoint) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy
    const along = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / Math.max(.00001, length2)
    const clamped = Math.max(0, Math.min(1, along))
    return { along, distance: Math.hypot(point[0] - a[0] - dx * clamped, point[1] - a[1] - dy * clamped) }
  }
  const transform = (point: ArmPoint, a: ArmPoint, b: ArmPoint, nextA: ArmPoint, nextB: ArmPoint): ArmPoint => {
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy)
    const nextX = nextB[0] - nextA[0], nextY = nextB[1] - nextA[1], nextLength = Math.hypot(nextX, nextY)
    const along = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / Math.max(.00001, length * length)
    const across = ((point[1] - a[1]) * dx - (point[0] - a[0]) * dy) / Math.max(.00001, length)
    return [nextA[0] + nextX * along - nextY / nextLength * across,
      nextA[1] + nextY * along + nextX / nextLength * across]
  }
  const tip: ArmPoint = [s[2][0] + (s[3][0] - s[2][0]) * 2.4, s[2][1] + (s[3][1] - s[2][1]) * 2.4]
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = 1 - uv.getY(i), point: ArmPoint = [u * aspect, v]
    const inner = .70 + (.60 - .70) * ease((v - .40) / .10) - .025 * ease((v - .72) / .10)
    const mask = ease((u - inner) / .035)
    if (mask <= 0) continue
    const upper = project(point, s[0], s[1]), lower = project(point, s[1], s[2])
    const distal = project(point, s[2], tip)
    const upperWeight = (1 - ease((upper.distance - .045) / .09)) * (1 - ease((upper.along - .72) / .40))
    const lowerWeight = (1 - ease((Math.min(lower.distance, distal.distance) - .055) / .09)) * ease((lower.along + .12) / .35)
    const total = upperWeight + lowerWeight
    if (total <= 0) continue
    const upperPoint = transform(point, s[0], s[1], t[0], t[1])
    const lowerPoint = transform(point, s[1], s[2], t[1], t[2])
    const handPoint = transform(point, s[2], s[3], t[2], t[3])
    const hand = ease((lower.along - .78) / .40)
    const x = (upperPoint[0] * upperWeight + (lowerPoint[0] + (handPoint[0] - lowerPoint[0]) * hand) * lowerWeight) / total
    const y = (upperPoint[1] * upperWeight + (lowerPoint[1] + (handPoint[1] - lowerPoint[1]) * hand) * lowerWeight) / total
    const weight = mask * Math.min(1, total)
    output[i * 3] += (x / aspect - u) * PORTRAIT_HEIGHT * aspect * weight
    output[i * 3 + 1] -= (y - v) * PORTRAIT_HEIGHT * weight
  }
  geometry.userData.snapPositions = output
}

/** A connected UV grid keeps the sleeves seamless while only the hands change depth. */
function portraitGeometry(aspect: number, arm = false) {
  const geometry = new THREE.PlaneGeometry(PORTRAIT_HEIGHT * aspect, PORTRAIT_HEIGHT, arm ? 96 : 48, arm ? 128 : 64)
  geometry.translate(0, PORTRAIT_HEIGHT / 2 + PORTRAIT_BOTTOM, .035)
  const position = geometry.getAttribute('position')
  geometry.userData.flatPositions = new Float32Array(position.array)
  return geometry
}

/**
 * Put hand pixels above the felt along their original camera rays. Their screen
 * positions and the untouched head/torso stay fixed; real scene depth still works.
 * Reapply from flat positions after every idle/deal transform, never cumulatively.
 */
function seatHandsOnTable(figure: THREE.Mesh, regions: readonly DealerHandRegion[]) {
  figure.updateWorldMatrix(true, false)
  const inverse = figure.matrixWorld.clone().invert()
  const position = figure.geometry.getAttribute('position')
  const uv = figure.geometry.getAttribute('uv')
  const flat = (figure.geometry.userData.snapPositions || figure.geometry.userData.flatPositions) as Float32Array
  const camera = new THREE.Vector3(...CAMERA.position)
  const point = new THREE.Vector3()
  const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t) }
  for (let i = 0; i < position.count; i++) {
    const u = uv.getX(i), v = 1 - uv.getY(i)
    // Feather outside the full hand bounds. No vertex on the hand itself is left
    // below the rail; the connected sleeve/transparent margin absorbs the blend.
    let weight = 0
    for (const [left, top, right, bottom] of regions) {
      const horizontal = Math.min(smooth((u - left + .035) / .035), smooth((right + .035 - u) / .035))
      const vertical = Math.min(smooth((v - top + .035) / .035), smooth((bottom + .035 - v) / .035))
      weight = Math.max(weight, horizontal * vertical)
    }
    point.fromArray(flat, i * 3)
    if (weight > 0) {
      point.applyMatrix4(figure.matrixWorld)
      if (point.y < HAND_SURFACE_Y) {
        const targetY = point.y + (HAND_SURFACE_Y - point.y) * weight
        const t = (camera.y - targetY) / (camera.y - point.y)
        point.sub(camera).multiplyScalar(t).add(camera)
      }
      point.applyMatrix4(inverse)
    }
    position.setXYZ(i, point.x, point.y, point.z)
  }
  position.needsUpdate = true
  figure.geometry.computeBoundingSphere()
}

/** Root can compare both real candidates without changing their shared event/lifecycle API. */
export function createDealer(scene: THREE.Scene, options: { style?: DealerStyle } = {}): DealerView {
  return options.style === 'sprite' ? createDealerSprite(scene) : createDealer3D(scene)
}

/** Approved body/head with a separately segmented, articulated native-costume arm. */
export function createDealerSprite(scene: THREE.Scene): DealerView {
  const root = new THREE.Group()
  root.name = 'DealerSpriteCandidate'
  root.position.set(...ANCHORS.dealer)
  root.visible = false
  scene.add(root)
  let fallback: DealerView | null = null
  let disposed = false, loaded = 0, age = 10, mix = 0, lastSeq = -1
  let currentMode: WorldMode = 'NORMAL'
  let snapAge: number | null = null
  let reaction: Reaction = 'idle'
  const seen = new Set<string>()
  root.userData.assetVersion = 'v14'
  root.userData.loadingState = 'loading'
  root.userData.snapPoseState = ['unrequested', 'unrequested', 'unrequested', 'unrequested']
  root.userData.snapMirrorPoseState = ['unrequested', 'unrequested', 'unrequested', 'unrequested']
  const worldMix = { value: 0 }, snapActive = { value: 0 }, armPose = { value: 0 }
  const armNormal = { value: null as THREE.Texture | null }, armMirror = { value: null as THREE.Texture | null }
  const waistNormal = { value: null as THREE.Texture | null }, waistMirror = { value: null as THREE.Texture | null }
  const normalExposure = { value: 1 }
  const poseMaps: THREE.Texture[][] = [[], []]
  const poseReady = [Array(4).fill(false), Array(4).fill(false)] as boolean[][]
  const exposure = [1, .72, .78, .63, .64]
  let posesRequested = false
  const loader = new THREE.TextureLoader()

  function loadPoses() {
    if (posesRequested || disposed) return
    posesRequested = true
    const paths = [
      [OPTIONAL_ASSETS.dealerSnapRaise1, OPTIONAL_ASSETS.dealerSnapRaise2, OPTIONAL_ASSETS.dealerSnapReady, OPTIONAL_ASSETS.dealerSnapRelease],
      [OPTIONAL_ASSETS.dealerSnapMirrorRaise1, OPTIONAL_ASSETS.dealerSnapMirrorRaise2, OPTIONAL_ASSETS.dealerSnapMirrorReady, OPTIONAL_ASSETS.dealerSnapMirrorRelease],
    ]
    paths.forEach((family, costume) => family.forEach((path, index) => {
      const states = costume ? root.userData.snapMirrorPoseState : root.userData.snapPoseState
      states[index] = 'loading'
      const texture = loader.load(path, () => {
        if (disposed) return
        const image = texture.image as { naturalWidth?: number; naturalHeight?: number; width: number; height: number }
        const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height
        const aspect = figure.userData.sourceAspect as number
        poseReady[costume][index] = width > 0 && height > 0 && Math.abs(width / height - aspect) <= .002
        states[index] = poseReady[costume][index] ? 'ready' : 'incompatible'
        applySnap()
      }, undefined, () => {
        if (disposed) return
        states[index] = 'missing'
        poseReady[costume][index] = false
        applySnap()
      })
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = 8
      poseMaps[costume].push(texture)
    }))
  }

  function applySnap() {
    // Both native costume families must be available before replacing the resting
    // arm. A missing optional drawing leaves the approved portrait untouched.
    const available = poseReady.every(family => family.every(Boolean))
    let from = 0, to = 0, blend = 0
    if (snapAge !== null && available) {
      if (snapAge < DEALER_SNAP.ready) {
        const position = snapAge / DEALER_SNAP.ready * 3
        from = Math.floor(position); to = from + 1; blend = ease(position - from)
      } else if (snapAge < DEALER_SNAP.release) {
        from = to = 3
      } else if (snapAge < DEALER_SNAP.release + DEALER_SNAP.hold) {
        from = to = 4
      } else {
        const position = (snapAge - DEALER_SNAP.release - DEALER_SNAP.hold)
          / (DEALER_SNAP.duration - DEALER_SNAP.release - DEALER_SNAP.hold) * 3
        const frames = [4, 2, 1, 0], segment = Math.min(2, Math.floor(position))
        from = frames[segment]; to = frames[segment + 1]; blend = ease(position - segment)
      }
    }
    const active = snapAge !== null && available
    const selected = blend < .5 ? from : to
    // A single fixed body plate reveals cloth that the resting glove originally
    // covered. This binding never follows the selected arm drawing.
    waistNormal.value = available ? poseMaps[0][2] : normalMap
    waistMirror.value = available ? poseMaps[1][2] : mirrorMap
    armNormal.value = selected ? poseMaps[0][selected - 1] : normalMap
    armMirror.value = selected ? poseMaps[1][selected - 1] : mirrorMap
    armPose.value = selected
    normalExposure.value = exposure[selected]
    snapActive.value = active ? 1 : 0
    arm.visible = active
    const aspect = figure.userData.sourceAspect as number || 1
    const target = active ? tweenArm(ARM_POSES[from], ARM_POSES[to], blend, aspect) : null
    poseArm(arm, selected, target)
    seatHandsOnTable(arm, ARM_HAND_REGIONS[selected])
    root.userData.snapAge = snapAge
    figure.userData.snapFrames = [from, to, blend]
    figure.userData.snapSource = selected
    figure.userData.selectedPose = selected
    figure.userData.snapWrist = target ? [...target.wrist] : null
    arm.userData.selectedPose = selected
    arm.userData.sourcePolygon = { sleeve: ARM_SLEEVE, glove: ARM_GLOVES[selected] }
  }

  const ready = () => {
    if (disposed) return
    loaded++
    if (loaded !== 3) return
    const image = normalMap.image as { naturalWidth?: number; naturalHeight?: number; width: number; height: number }
    const other = mirrorMap.image as typeof image
    const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height
    const mirrorWidth = other.naturalWidth || other.width, mirrorHeight = other.naturalHeight || other.height
    if (!(width > 0 && height > 0 && mirrorWidth > 0 && mirrorHeight > 0)
      || Math.abs(width / height - mirrorWidth / mirrorHeight) > .002) { failed(); return }
    geometry.dispose(); armGeometry.dispose()
    geometry = portraitGeometry(width / height)
    armGeometry = portraitGeometry(width / height, true)
    figure.geometry = geometry; arm.geometry = armGeometry
    for (const surface of [figure, arm]) {
      surface.userData.sourceAspect = width / height
      surface.userData.imageWidth = width
      surface.userData.imageHeight = height
      seatHandsOnTable(surface, HAND_REGIONS)
    }
    mix = currentMode === 'MIRROR' ? 1 : 0
    worldMix.value = mix
    root.visible = true
    root.userData.loadingState = 'ready'
    fallback?.dispose(); fallback = null
    loadPoses()
    applySnap()
  }
  const failed = () => {
    if (disposed || root.visible || fallback) return
    fallback = createDealer3D(scene)
    fallback.setSnap(snapAge)
    root.userData.loadingState = 'fallback'
  }
  const normalMap = loader.load(OPTIONAL_ASSETS.dealerNormal, ready, undefined, failed)
  const mirrorMap = loader.load(OPTIONAL_ASSETS.dealerMirror, ready, undefined, failed)
  const headMap = loader.load(OPTIONAL_ASSETS.dealerHead, ready, undefined, failed)
  armNormal.value = normalMap; armMirror.value = mirrorMap
  waistNormal.value = normalMap; waistMirror.value = mirrorMap
  for (const texture of [normalMap, mirrorMap, headMap]) { texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8 }
  let geometry = portraitGeometry(1), armGeometry = portraitGeometry(1, true)
  const parameters: THREE.MeshBasicMaterialParameters = { map: normalMap, transparent: true, alphaTest: .12, depthWrite: true,
    depthTest: true, toneMapped: false, side: THREE.FrontSide }
  const material = new THREE.MeshBasicMaterial(parameters)
  // Both hand layers sit on the same felt plane after seatHandsOnTable. Their
  // different UV grids need a depth bias so the moving glove covers the body
  // plate without coplanar triangle fragments, especially in the lowered pose.
  const armMaterial = new THREE.MeshBasicMaterial({ ...parameters, polygonOffset: true,
    polygonOffsetFactor: -1, polygonOffsetUnits: -1 })
  material.onBeforeCompile = shader => {
    shader.uniforms.mirrorMap = { value: mirrorMap }
    shader.uniforms.dealerHeadMap = { value: headMap }
    shader.uniforms.worldMix = worldMix
    shader.uniforms.snapActive = snapActive
    shader.uniforms.waistNormalMap = waistNormal
    shader.uniforms.waistMirrorMap = waistMirror
    shader.uniforms.wardrobeGreen = { value: new THREE.Color(PLATFORM_PALETTE.forest) }
    shader.fragmentShader = DEALER_HEAD_GLSL + WARDROBE_GLSL + ARM_MASK_GLSL + `
      uniform sampler2D mirrorMap;
      uniform float worldMix;
      uniform float snapActive;
      uniform sampler2D waistNormalMap;
      uniform sampler2D waistMirrorMap;
      // Previously occluded lower waist only; the visible chest/lapel above .80
      // always remains the original costume image. Native alpha defines its rim.
      float dealerWaistRegion(vec2 uv) {
        vec2 p = vec2(uv.x, 1.0 - uv.y);
        return smoothstep(.80, .83, p.y) * (1.0 - smoothstep(.91, .94, p.y))
          * smoothstep(.58, .62, p.x) * (1.0 - smoothstep(.80, .84, p.x));
      }
      vec4 revealDealerWaist(vec4 body, vec4 waist, vec2 uv, float restingArm) {
        // The complete fixed plate covers both sides of the old glove boundary.
        // Tying its RGB to the binary arm mask would leave a triangular seam.
        body.a *= 1.0 - restingArm;
        float amount = snapActive * dealerWaistRegion(uv);
        float alpha = mix(body.a, waist.a, amount);
        vec3 premultiplied = mix(body.rgb * body.a, waist.rgb * waist.a, amount);
        return vec4(premultiplied / max(alpha, .00001), alpha);
      }
    ` + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec4 normalCutout = platformWardrobe(texture2D(map, vMapUv), vMapUv);
        vec4 mirrorCutout = platformWardrobe(texture2D(mirrorMap, vMapUv), vMapUv);
        // Only the newly exposed lower waist uses the constant clean body plate.
        // The original head/chest/lapel never sample the selected arm drawing.
        float restingArm = snapActive * dealerArmMask(vMapUv, 0.0);
        vec4 normalWaist = texture2D(waistNormalMap, vMapUv);
        normalWaist.rgb *= .33;
        normalWaist = platformWardrobe(normalWaist, vMapUv);
        vec4 mirrorWaist = texture2D(waistMirrorMap, vMapUv);
        mirrorWaist.rgb *= .80;
        mirrorWaist = platformWardrobe(mirrorWaist, vMapUv);
        normalCutout = revealDealerWaist(normalCutout, normalWaist, vMapUv, restingArm);
        mirrorCutout = revealDealerWaist(mirrorCutout, mirrorWaist, vMapUv, restingArm);
        diffuseColor *= dealerHead(mix(normalCutout, mirrorCutout, worldMix), vMapUv);
      #endif
    `)
  }
  armMaterial.onBeforeCompile = shader => {
    shader.uniforms.armNormalMap = armNormal
    shader.uniforms.armMirrorMap = armMirror
    shader.uniforms.worldMix = worldMix
    shader.uniforms.armPose = armPose
    shader.uniforms.normalExposure = normalExposure
    shader.uniforms.wardrobeGreen = { value: new THREE.Color(PLATFORM_PALETTE.forest) }
    shader.fragmentShader = WARDROBE_GLSL + ARM_MASK_GLSL + `
      uniform sampler2D armNormalMap;
      uniform sampler2D armMirrorMap;
      uniform float worldMix;
      uniform float armPose;
      uniform float normalExposure;
    ` + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec4 normalArm = texture2D(armNormalMap, vMapUv);
        normalArm.rgb *= normalExposure;
        normalArm = platformWardrobe(normalArm, vMapUv);
        vec4 mirrorArm = platformWardrobe(texture2D(armMirrorMap, vMapUv), vMapUv);
        vec4 cutout = mix(normalArm, mirrorArm, worldMix);
        cutout.a *= dealerArmMask(vMapUv, armPose);
        diffuseColor *= cutout;
      #endif
    `)
  }
  material.customProgramCacheKey = () => 'mirror-poker-dealer-v16-fixed-body-v14-head'
  armMaterial.customProgramCacheKey = () => 'mirror-poker-dealer-v16-native-arm'
  const figure = new THREE.Mesh(geometry, material), arm = new THREE.Mesh(armGeometry, armMaterial)
  figure.name = 'DealerCutout'; arm.name = 'DealerSnapArm'
  arm.visible = false
  for (const surface of [figure, arm]) {
    surface.userData.handRegions = HAND_REGIONS
    surface.userData.handSurfaceY = HAND_SURFACE_Y
    surface.userData.portraitHeight = PORTRAIT_HEIGHT
    surface.userData.portraitBottom = PORTRAIT_BOTTOM
    surface.renderOrder = surface === arm ? 2 : 1
    surface.rotation.x = -Math.atan2(CAMERA.position[1] - CAMERA.target[1], CAMERA.position[2] - CAMERA.target[2])
    surface.castShadow = surface.receiveShadow = false
    root.add(surface)
  }
  // Tiny camera-directed offset prevents the sleeve seam sharing body depth.
  arm.position.z = .0001

  const shadowCanvas = document.createElement('canvas')
  shadowCanvas.width = shadowCanvas.height = 128
  const context = shadowCanvas.getContext('2d')
  if (context) {
    const gradient = context.createRadialGradient(64, 64, 5, 64, 64, 63)
    gradient.addColorStop(0, 'rgba(0,0,0,.8)'); gradient.addColorStop(1, 'rgba(0,0,0,0)')
    context.fillStyle = gradient; context.fillRect(0, 0, 128, 128)
  }
  const shadowMap = new THREE.CanvasTexture(shadowCanvas)
  const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowMap, transparent: true, opacity: .27, depthWrite: false, toneMapped: false })
  const shadowGeometry = new THREE.PlaneGeometry(1.65, .34), contactShadow = new THREE.Mesh(shadowGeometry, shadowMaterial)
  contactShadow.name = 'DealerRailContact'
  contactShadow.rotation.x = -Math.PI / 2
  contactShadow.position.set(0, .009, .35)
  root.add(contactShadow)

  return {
    update(dt, worldMode) {
      if (disposed) return
      currentMode = worldMode
      fallback?.update(dt, worldMode)
      const delta = Number.isFinite(dt) ? Math.max(0, Math.min(dt, .1)) : 0
      age += delta
      mix += ((worldMode === 'MIRROR' ? 1 : 0) - mix) * (1 - Math.exp(-delta * 4.4))
      worldMix.value = mix
      const duration = reaction === 'win' ? 1.05 : .8
      const phase = Math.min(1, age / duration), envelope = Math.sin(phase * Math.PI)
      if (phase >= 1) reaction = 'idle'
      const deal = reaction === 'deal' ? envelope : 0, win = reaction === 'win' ? envelope : 0
      // Stable portrait registration: idle and the complete gesture never change
      // head height, body scale or roll. Poker reactions retain their small motion.
      const reacting = snapAge === null
      figure.position.set(reacting ? deal * .009 : 0, reacting ? deal * .014 + win * .017 : 0, 0)
      figure.rotation.z = reacting ? win * .003 : 0
      figure.scale.setScalar(1)
      seatHandsOnTable(figure, HAND_REGIONS)
      arm.position.copy(figure.position); arm.position.z += .0001
      arm.rotation.z = figure.rotation.z; arm.scale.copy(figure.scale)
      seatHandsOnTable(arm, ARM_HAND_REGIONS[armPose.value])
      shadowMaterial.opacity = .27 - mix * .08
    },
    setSnap(value) {
      if (disposed) return
      snapAge = value !== null && Number.isFinite(value) && value >= 0 && value < DEALER_SNAP.duration ? value : null
      fallback?.setSnap(snapAge)
      applySnap()
    },
    event(event) {
      fallback?.event(event)
      if (disposed || seen.has(event.eventId) || event.seq <= lastSeq) return
      seen.add(event.eventId); lastSeq = event.seq
      if (seen.size > 256) seen.delete(seen.values().next().value as string)
      if (event.type === 'PAYOUT') reaction = 'win'
      else if (event.type === 'CARDS_DEALT' || event.type === 'STREET_CHANGED') reaction = 'deal'
      else return
      age = 0
    },
    reset() {
      fallback?.reset()
      seen.clear(); lastSeq = -1; reaction = 'idle'; age = 10; snapAge = null
      applySnap()
    },
    dispose() {
      if (disposed) return
      disposed = true
      scene.remove(root)
      fallback?.dispose(); fallback = null
      geometry.dispose(); armGeometry.dispose(); material.dispose(); armMaterial.dispose()
      normalMap.dispose(); mirrorMap.dispose(); headMap.dispose()
      poseMaps.flat().forEach(texture => texture.dispose())
      shadowGeometry.dispose(); shadowMaterial.dispose(); shadowMap.dispose(); seen.clear()
    },
  }
}

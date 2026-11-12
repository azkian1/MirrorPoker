import * as THREE from 'three'
import { CARD_REST, PLATFORM_PALETTE, TABLE } from '../shared/assets.ts'
import { POKER_MARK } from '../shared/poker-mark.ts'
import type { WorldMode } from '../shared/contracts.ts'

export interface WorldView {
  setBlinds(small: number, big: number): void
  update(dt: number, worldMode: WorldMode): void
  dispose(): void
}

type Profile = { y: number; width: number; depth: number; corner: number }
type ColorPair = { material: THREE.MeshStandardMaterial; normal: THREE.Color; mirror: THREE.Color }
const BACK_WALL = { panelBaseZ: -6.93, panelDepth: .1, bevel: .026, glowZ: -6.788, glowBottom: .34, glowTop: 5.65, glowWidth: 6.6 }

/** Broad slab with a small physical bevel; the wall stays behind the fixed dealer ring. */
function wallPanel(width: number, height: number): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape()
  shape.moveTo(-width / 2, -height / 2)
  shape.lineTo(width / 2, -height / 2)
  shape.lineTo(width / 2, height / 2)
  shape.lineTo(-width / 2, height / 2)
  shape.closePath()
  return new THREE.ExtrudeGeometry(shape, {
    depth: BACK_WALL.panelDepth, steps: 1, bevelEnabled: true, bevelSegments: 1,
    bevelSize: BACK_WALL.bevel, bevelThickness: BACK_WALL.bevel, curveSegments: 1,
  })
}

/** The same octagonal contour is used by every solid, bevel and inlay. */
function contour(width: number, depth: number, corner: number): [number, number][] {
  const x = width / 2, z = depth / 2
  return [[-x + corner, -z], [x - corner, -z], [x, -z + corner], [x, z - corner],
    [x - corner, z], [-x + corner, z], [-x, z - corner], [-x, -z + corner]]
}

/** Flat faces preserve the monolithic silhouette; top surfaces stay exactly at contract height. */
function solid(profiles: Profile[]): THREE.BufferGeometry {
  const positions: number[] = [], uvs: number[] = []
  const point = (x: number, y: number, z: number) => {
    positions.push(x, y, z)
    uvs.push(x / TABLE.width + .5, z / TABLE.depth + .5)
  }
  for (let level = 0; level < profiles.length - 1; level++) {
    const low = profiles[level], high = profiles[level + 1]
    const a = contour(low.width, low.depth, low.corner), b = contour(high.width, high.depth, high.corner)
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8
      point(a[i][0], low.y, a[i][1]); point(b[i][0], high.y, b[i][1]); point(b[j][0], high.y, b[j][1])
      point(a[i][0], low.y, a[i][1]); point(b[j][0], high.y, b[j][1]); point(a[j][0], low.y, a[j][1])
    }
  }
  for (const [profile, top] of [[profiles[0], false], [profiles[profiles.length - 1], true]] as const) {
    const edge = contour(profile.width, profile.depth, profile.corner)
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8
      point(0, profile.y, 0)
      point(edge[top ? j : i][0], profile.y, edge[top ? j : i][1])
      point(edge[top ? i : j][0], profile.y, edge[top ? i : j][1])
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.computeVertexNormals()
  return geometry
}

function ring(width: number, depth: number, corner: number, inset: number, y: number): THREE.BufferGeometry {
  const outer = contour(width, depth, corner)
  const inner = contour(width - inset * 2, depth - inset * 2, Math.max(.01, corner - inset * .59))
  const positions: number[] = []
  const point = (p: [number, number]) => positions.push(p[0], y, p[1])
  for (let i = 0; i < 8; i++) {
    const j = (i + 1) % 8
    point(outer[i]); point(inner[i]); point(inner[j])
    point(outer[i]); point(inner[j]); point(outer[j])
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const result = document.createElement('canvas')
  result.width = result.height = size
  const context = result.getContext('2d')
  if (!context) throw new Error('Mirror Poker world needs a canvas 2D context')
  return [result, context]
}

/** Small deterministic material maps: no network, downloaded textures or frame-time generation. */
function stoneTexture(): THREE.CanvasTexture {
  const [image, context] = canvas(256)
  const pixels = context.createImageData(256, 256)
  let seed = 0x4d495252
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const vein = Math.sin(x * .038 + y * .053 + Math.sin(y * .027) * 3.2)
    const fineVein = Math.pow(Math.max(0, vein), 28)
    const value = Math.round(246 - fineVein * 18 - (seed >>> 28) * .38)
    const i = (y * 256 + x) * 4
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = value
    pixels.data[i + 3] = 255
  }
  context.putImageData(pixels, 0, 0)
  const texture = new THREE.CanvasTexture(image)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(3, 3)
  texture.anisotropy = 4
  return texture
}

function feltTexture(): THREE.DataTexture {
  const size = 128, data = new Uint8Array(size * size * 4)
  let seed = 271828
  for (let i = 0; i < size * size; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const value = 96 + (seed >>> 25)
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = value
    data[i * 4 + 3] = 255
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.repeat.set(16, 12)
  texture.needsUpdate = true
  return texture
}

/** One monochrome engraving mask, using the avatar's exact canonical path. */
function feltMarkTexture(): THREE.CanvasTexture {
  const [image, context] = canvas(512)
  context.scale(image.width / POKER_MARK.width, image.height / POKER_MARK.height)
  context.beginPath()
  for (const command of POKER_MARK.commands) {
    if (command[0] === 'M') context.moveTo(command[1], command[2])
    else if (command[0] === 'L') context.lineTo(command[1], command[2])
    else if (command[0] === 'Q') context.quadraticCurveTo(command[1], command[2], command[3], command[4])
    else context.closePath()
  }
  context.fillStyle = '#fff'
  context.fill(POKER_MARK.fillRule)
  const texture = new THREE.CanvasTexture(image)
  texture.name = 'PokerEngravingMask'
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

/** Felt lettering shares the logo's monochrome ink and needs no external font or asset. */
function feltTextTexture(text: string): { texture: THREE.CanvasTexture; draw(text: string): void } {
  const [image, context] = canvas(1024)
  image.height = 160
  const texture = new THREE.CanvasTexture(image)
  texture.name = 'FeltLetteringMask'
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  const draw = (value: string) => {
    context.clearRect(0, 0, image.width, image.height)
    context.fillStyle = '#fff'
    context.font = '600 144px Arial, sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    // Fill the intended print area instead of shrinking short labels into a
    // mostly empty mask. The mesh already fixes the lettering's visual size.
    const measuredWidth = context.measureText(value)?.width
    const textScale = Number.isFinite(measuredWidth) && measuredWidth > 0 ? (image.width - 96) / measuredWidth : 1
    context.save()
    context.translate(image.width / 2, image.height / 2 + 3)
    context.scale(textScale, 1)
    context.fillText(value, 0, 0)
    context.restore()
    texture.needsUpdate = true
  }
  draw(text)
  return { texture, draw }
}

/** Neutral architectural reflection: polished slabs without an expensive planar reflection pass. */
function hallReflection(): THREE.CubeTexture {
  const faces: HTMLCanvasElement[] = []
  for (let face = 0; face < 6; face++) {
    const [image, context] = canvas(128)
    const gradient = context.createLinearGradient(0, 0, 128, 128)
    gradient.addColorStop(0, '#17191e')
    gradient.addColorStop(.33, '#42454c')
    gradient.addColorStop(.47, face === 2 ? '#e8dfcf' : '#b3b2ac')
    gradient.addColorStop(.51, '#22232a')
    gradient.addColorStop(.77, '#111319')
    gradient.addColorStop(1, '#55545a')
    context.fillStyle = gradient
    context.fillRect(0, 0, 128, 128)
    context.fillStyle = '#ece6d9'
    context.globalAlpha = face === 3 ? .08 : .72
    context.fillRect(face % 2 ? 23 : 96, 0, 3, 128)
    context.globalAlpha = .13
    context.fillRect(0, 100, 128, 5)
    faces.push(image)
  }
  const texture = new THREE.CubeTexture(faces)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  return texture
}

function contactTexture(): THREE.CanvasTexture {
  const [image, context] = canvas(128)
  const gradient = context.createRadialGradient(64, 64, 12, 64, 64, 63)
  gradient.addColorStop(0, 'rgba(0,0,0,.85)')
  gradient.addColorStop(.48, 'rgba(0,0,0,.55)')
  gradient.addColorStop(1, 'rgba(0,0,0,0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(image)
}

/** Soft ring-shaped wall illumination, cropped above the stone plinth; no bloom pass. */
function arcGlowTexture(): THREE.CanvasTexture {
  const [image, context] = canvas(256)
  const height = BACK_WALL.glowTop - BACK_WALL.glowBottom
  context.scale(image.width / BACK_WALL.glowWidth, image.height / height)
  const x = BACK_WALL.glowWidth / 2, y = BACK_WALL.glowTop - 2.58
  const gradient = context.createRadialGradient(x, y, 0, x, y, 3.15)
  // Map coordinates are metres, so the illumination follows the real circular ring.
  // The empty centre and soft outer edge avoid a luminous filled disk on the wall.
  gradient.addColorStop(0, 'rgba(255,255,255,0)')
  gradient.addColorStop(.48, 'rgba(255,255,255,0)')
  gradient.addColorStop(.62, 'rgba(255,255,255,.03)')
  gradient.addColorStop(.74, 'rgba(255,255,255,.16)')
  gradient.addColorStop(.81, 'rgba(255,255,255,.24)')
  gradient.addColorStop(.91, 'rgba(255,255,255,.09)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, BACK_WALL.glowWidth, height)
  const texture = new THREE.CanvasTexture(image)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export function createWorld(scene: THREE.Scene): WorldView {
  const group = new THREE.Group()
  group.name = 'mirror-monolith-world'
  scene.add(group)
  const prior = { background: scene.background, fog: scene.fog, environment: scene.environment }
  const background = new THREE.Color('#141419')
  const fog = new THREE.Fog(background.clone(), 19, 52)
  const environment = hallReflection()
  scene.background = background
  scene.fog = fog
  scene.environment = environment

  const stone = stoneTexture(), wallStone = stoneTexture(), feltGrain = feltTexture(), contact = contactTexture(), arcGlowMap = arcGlowTexture(), feltMarkMap = feltMarkTexture()
  // Extruded slab UVs use metres. Keep wall veins broad without changing floor/table maps.
  wallStone.repeat.set(.13, .25)
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const colors: ColorPair[] = []
  const material = (normal: string, mirror: string, options: THREE.MeshStandardMaterialParameters = {}) => {
    const result = new THREE.MeshStandardMaterial({ color: normal, ...options })
    materials.add(result)
    colors.push({ material: result, normal: new THREE.Color(normal), mirror: new THREE.Color(mirror) })
    return result
  }
  const mesh = (geometry: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = group) => {
    geometries.add(geometry)
    materials.add(mat)
    const result = new THREE.Mesh(geometry, mat)
    result.castShadow = result.receiveShadow = true
    parent.add(result)
    return result
  }

  const floorMat = material('#24242a', '#c3c0b7', { map: stone, roughness: .34, metalness: .16, envMapIntensity: .28 })
  const floor = mesh(new THREE.PlaneGeometry(70, 70), floorMat)
  floor.rotation.x = -Math.PI / 2
  floor.castShadow = false

  const architecture = new THREE.Group()
  architecture.name = 'BackWallArchitecture'
  group.add(architecture)
  const wallBackingMaterial = material('#111518', '#aca99f', { map: wallStone, roughness: .88, metalness: 0 })
  const wallBacking = mesh(new THREE.BoxGeometry(34, 8, .26), wallBackingMaterial, architecture)
  wallBacking.name = 'BackWallBacking'
  wallBacking.position.set(0, 4, -7.07)
  wallBacking.castShadow = false
  const wallPanelMaterial = material('#4d5255', '#e5e2d9', {
    map: wallStone, bumpMap: wallStone, bumpScale: .008, roughness: .74,
    metalness: .04, envMapIntensity: .12,
  })
  const panelHeight = 7.2, centralWidth = 6.12, sideWidth = 3.25, seam = .072
  const addPanel = (name: string, x: number, width: number) => {
    const panel = mesh(wallPanel(width, panelHeight), wallPanelMaterial, architecture)
    panel.name = name
    panel.position.set(x, .33 + panelHeight / 2, BACK_WALL.panelBaseZ)
    panel.castShadow = false
  }
  addPanel('BackWallPanelCenter', 0, centralWidth)
  for (const side of [-1, 1]) for (let index = 0; index < 4; index++) {
    const x = side * (centralWidth / 2 + seam + sideWidth / 2 + index * (sideWidth + seam))
    addPanel(`BackWallPanel${side < 0 ? 'Left' : 'Right'}${index + 1}`, x, sideWidth)
  }
  const plinthMaterial = material('#24282a', '#cbc8bf', {
    map: wallStone, roughness: .57, metalness: .06, envMapIntensity: .15,
  })
  const plinth = mesh(new THREE.BoxGeometry(34, .255, .24), plinthMaterial, architecture)
  plinth.name = 'BackWallPlinth'
  plinth.position.set(0, .1275, -6.82)
  plinth.castShadow = false
  // The upward-facing cap catches more key light than the panels; keep it darker in NORMAL.
  const plinthCapMaterial = material('#24282a', '#e5e2d9', {
    map: wallStone, bumpMap: wallStone, bumpScale: .008, roughness: .74,
    metalness: .04, envMapIntensity: .12,
  })
  const plinthCap = mesh(new THREE.BoxGeometry(34, .045, .29), plinthCapMaterial, architecture)
  plinthCap.name = 'BackWallPlinthCap'
  plinthCap.position.set(0, .2775, -6.815)
  plinthCap.castShadow = false

  // Sparse floor joints establish perspective without competing with the cards.
  const joints: number[] = []
  for (let n = -8; n <= 8; n++) {
    joints.push(n * 3.2, .006, -25, n * 3.2, .006, 25)
    joints.push(-25, .006, n * 3.2, 25, .006, n * 3.2)
  }
  const jointsGeometry = new THREE.BufferGeometry()
  jointsGeometry.setAttribute('position', new THREE.Float32BufferAttribute(joints, 3))
  geometries.add(jointsGeometry)
  const jointMaterial = new THREE.LineBasicMaterial({ color: '#111117', transparent: true, opacity: .12, depthWrite: false })
  materials.add(jointMaterial)
  const floorJoints = new THREE.LineSegments(jointsGeometry, jointMaterial)
  floorJoints.name = 'FloorJoints'
  // Decorative transparent lines must be painted before transparent character cutouts.
  // The dealer also writes alpha-tested depth, so scene lines can never show through his face.
  floorJoints.renderOrder = -10
  group.add(floorJoints)

  const stoneMat = material('#111318', '#e0dcd2', { map: stone, roughness: .3, metalness: .17, envMapIntensity: .35 })
  const baseMat = material('#13151b', '#ccc8bd', { map: stone, roughness: .38, metalness: .12, envMapIntensity: .32 })
  mesh(solid([
    { y: .055, width: 5.6, depth: 3.25, corner: .6 },
    { y: .16, width: 5.75, depth: 3.4, corner: .62 },
    { y: .62, width: 6.12, depth: 3.92, corner: .77 },
    { y: .71, width: 6.12, depth: 3.92, corner: .77 },
  ]), baseMat)
  mesh(solid([
    { y: .61, width: 9.7, depth: 5.7, corner: TABLE.corner },
    { y: .68, width: TABLE.width, depth: TABLE.depth, corner: TABLE.corner },
    { y: TABLE.topY - .065, width: TABLE.width, depth: TABLE.depth, corner: TABLE.corner },
    { y: TABLE.topY, width: TABLE.width - .12, depth: TABLE.depth - .12, corner: TABLE.corner - .04 },
  ]), stoneMat)

  const feltMat = material('#202126', '#b8b2a6', {
    roughness: .94, metalness: 0, bumpMap: feltGrain, bumpScale: .012, envMapIntensity: .08,
  })
  const playingWidth = TABLE.width - .88, playingDepth = TABLE.depth - .88
  mesh(solid([
    { y: TABLE.topY - .024, width: playingWidth, depth: playingDepth, corner: .72 },
    { y: TABLE.topY + .004, width: playingWidth, depth: playingDepth, corner: .72 },
  ]), feltMat)

  // Printed into the felt: below every playing piece, without a bright decal or overlay.
  const feltMarkMaterial = material('#62635e', '#6d6b60', {
    map: feltMarkMap, bumpMap: feltMarkMap, bumpScale: -.0035,
    roughness: .98, metalness: 0, envMapIntensity: .03,
    transparent: true, opacity: .16, depthWrite: false, alphaTest: .01,
    // Physical separation is enough. A depth bias can pull the decal through
    // the thin cards when they touch the felt.
    polygonOffset: false,
  })
  const feltMark = mesh(new THREE.PlaneGeometry(2.65, 2.65 * POKER_MARK.height / POKER_MARK.width), feltMarkMaterial)
  feltMark.name = 'TablePokerEngraving'
  feltMark.userData.canonicalPath = POKER_MARK.path
  feltMark.rotation.x = -Math.PI / 2
  feltMark.position.set(0, CARD_REST.feltY + .0005, -.15)
  feltMark.castShadow = false
  feltMark.receiveShadow = true

  // Labels stay upright and in the clear lanes around the physical cards and bets.
  // Only the spade mark turns upside down with the mirrored world.
  const holdemPrint = feltTextTexture('HOLDEM'), mirrorPrint = feltTextTexture('MIRROR'), blindsPrint = feltTextTexture('10 / 20')
  const feltLettering = (name: string, print: THREE.CanvasTexture, width: number, height: number, x: number, z: number) => {
    const ink = material('#62635e', '#6d6b60', {
      map: print, bumpMap: print, bumpScale: -.0035,
      roughness: .98, metalness: 0, envMapIntensity: .03,
      transparent: true, opacity: .26, depthWrite: false, alphaTest: .01, polygonOffset: false,
    })
    const label = mesh(new THREE.PlaneGeometry(width, height), ink)
    label.name = name
    label.rotation.x = -Math.PI / 2
    label.position.set(x, CARD_REST.feltY + .0005, z)
    label.castShadow = false
    label.receiveShadow = true
    return label
  }
  const holdemLabel = feltLettering('TableHoldemEngraving', holdemPrint.texture, 1.9, .44, 0, 1.4)
  const mirrorLabel = feltLettering('TableMirrorEngraving', mirrorPrint.texture, 1.9, .44, 0, 1.4)
  holdemLabel.userData.text = 'HOLDEM'
  mirrorLabel.userData.text = 'MIRROR'
  mirrorLabel.material.opacity = 0
  mirrorLabel.visible = false
  const blindLabel = feltLettering('TableBlindsEngraving', blindsPrint.texture, 1.35, .50, -2.6, .12)
  blindLabel.userData.text = '10 / 20'
  let smallBlind = 10, bigBlind = 20

  // Unlit colour keeps the thin logo-lime print saturated under the warm table key.
  // Unlike the dealer ring, the table outline has no halo or light spill of its own.
  const inlayMaterial = new THREE.MeshBasicMaterial({ color: PLATFORM_PALETTE.lime, toneMapped: false })
  const inlay = mesh(ring(playingWidth + .09, playingDepth + .09, .75, .034, TABLE.topY + .006), inlayMaterial)
  inlay.name = 'TableLimeInlay'
  inlay.castShadow = false
  const inlayUnderlayMaterial = new THREE.MeshBasicMaterial({
    color: PLATFORM_PALETTE.ink, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
  })
  const inlayUnderlay = mesh(ring(playingWidth + .118, playingDepth + .118, .758, .062, TABLE.topY + .005), inlayUnderlayMaterial)
  inlayUnderlay.name = 'TableInlayGraphiteUnderlay'
  inlayUnderlay.castShadow = inlayUnderlay.receiveShadow = false
  inlayUnderlay.visible = false
  const edgingMat = material('#4a4d55', '#c1bdb2', { roughness: .27, metalness: .72, envMapIntensity: .65 })
  const edging = mesh(ring(TABLE.width - .19, TABLE.depth - .19, TABLE.corner - .07, .018, TABLE.topY + .002), edgingMat)
  edging.castShadow = false
  const seamMaterial = material(PLATFORM_PALETTE.forest, PLATFORM_PALETTE.forest, {
    roughness: .45, metalness: .2, envMapIntensity: .2,
  })
  const baseSeam = mesh(solid([
    { y: .125, width: 5.78, depth: 3.43, corner: .63 },
    { y: .144, width: 5.78, depth: 3.43, corner: .63 },
  ]), seamMaterial)
  baseSeam.name = 'TableForestBaseSeam'
  baseSeam.castShadow = false

  const shadowMaterial = new THREE.MeshBasicMaterial({ map: contact, transparent: true, opacity: .7, depthWrite: false })
  const contactShadow = mesh(new THREE.PlaneGeometry(8.8, 6.6), shadowMaterial)
  contactShadow.rotation.x = -Math.PI / 2
  contactShadow.position.y = .012
  contactShadow.castShadow = contactShadow.receiveShadow = false

  // Central lane stays clear for the dealer at ANCHORS.dealer [0,.95,-3.22].
  const mirrorMat = material('#80858e', '#e2dfd7', {
    metalness: .96, roughness: .1, envMapIntensity: .82, emissive: '#eee8dc', emissiveIntensity: 0,
  })
  const mirrorEdge = material('#20232b', '#d7d3ca', {
    metalness: .78, roughness: .22, envMapIntensity: .55, emissive: '#e2dbcd', emissiveIntensity: 0,
  })
  const facetMat = new THREE.MeshBasicMaterial({ color: '#e4e0d5', transparent: true, opacity: .14, depthWrite: false })
  for (const side of [-1, 1]) {
    const pillar = new THREE.Group()
    pillar.position.set(side * 5.05, .02, -5.55)
    pillar.rotation.y = -side * .16
    group.add(pillar)
    const foot = mesh(new THREE.BoxGeometry(1.78, .13, .94), stoneMat, pillar)
    foot.position.y = .065
    const frame = mesh(new THREE.BoxGeometry(1.34, 5.65, .19), mirrorEdge, pillar)
    frame.position.y = 2.96
    const face = mesh(new THREE.PlaneGeometry(1.23, 5.52), mirrorMat, pillar)
    face.position.set(0, 2.96, .101)
    face.castShadow = false
    const facetGeometry = new THREE.BufferGeometry()
    facetGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -.6, .23, .106, .6, 2.6, .106, .6, 5.7, .106,
      -.6, .23, .106, .6, 5.7, .106, -.31, 4.9, .106,
    ], 3))
    const facet = mesh(facetGeometry, facetMat, pillar)
    facet.castShadow = facet.receiveShadow = false
    const sill = mesh(new THREE.BoxGeometry(1.42, .018, .03), inlayMaterial, pillar)
    sill.name = side < 0 ? 'LeftMirrorLimeSill' : 'RightMirrorLimeSill'
    sill.position.set(0, .145, .44)
    sill.castShadow = false
  }

  const arcMaterial = new THREE.MeshBasicMaterial({ color: PLATFORM_PALETTE.lime, toneMapped: false })
  const arc = mesh(new THREE.TorusGeometry(2.42, .018, 6, 96), arcMaterial)
  arc.name = 'DealerLimeRing'
  arc.position.set(0, 2.58, -6.35)
  arc.castShadow = arc.receiveShadow = false
  const arcHaloMaterial = new THREE.MeshBasicMaterial({
    color: PLATFORM_PALETTE.lime, transparent: true, opacity: .045, depthWrite: false, toneMapped: false,
  })
  const arcHalo = mesh(new THREE.TorusGeometry(2.42, .052, 6, 96), arcHaloMaterial)
  arcHalo.name = 'DealerLimeHalo'
  arcHalo.position.copy(arc.position)
  arcHalo.castShadow = arcHalo.receiveShadow = false

  const wallGlowMaterial = new THREE.MeshBasicMaterial({
    color: PLATFORM_PALETTE.lime, map: arcGlowMap, transparent: true, opacity: .48, depthWrite: false,
    blending: THREE.NormalBlending, toneMapped: false,
  })
  const wallGlow = mesh(new THREE.PlaneGeometry(BACK_WALL.glowWidth, BACK_WALL.glowTop - BACK_WALL.glowBottom), wallGlowMaterial)
  wallGlow.name = 'DealerLimeWallGlow'
  wallGlow.position.set(0, (BACK_WALL.glowBottom + BACK_WALL.glowTop) / 2, BACK_WALL.glowZ)
  wallGlow.castShadow = wallGlow.receiveShadow = false
  wallGlow.renderOrder = -8

  const ambient = new THREE.HemisphereLight('#e2d7cb', '#171a23', .78)
  group.add(ambient)
  const key = new THREE.DirectionalLight('#ffead5', 2.85)
  key.name = 'OverheadTableKey'
  key.position.set(0, 10, .3)
  key.target.position.set(0, .7, -.3)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.camera.left = -9
  key.shadow.camera.right = 9
  key.shadow.camera.top = 9
  key.shadow.camera.bottom = -9
  key.shadow.camera.near = .5
  key.shadow.camera.far = 30
  key.shadow.bias = -.0003
  key.shadow.normalBias = .018
  key.shadow.radius = 3
  group.add(key, key.target)
  const rim = new THREE.DirectionalLight(PLATFORM_PALETTE.lime, .12)
  rim.name = 'DealerLimeRim'
  rim.position.set(0, 4.5, -7)
  group.add(rim)
  const arcSpill = new THREE.PointLight(PLATFORM_PALETTE.lime, 5, 12, 2)
  arcSpill.name = 'DealerLimeSpill'
  arcSpill.position.set(0, 2.8, -6.05)
  group.add(arcSpill)
  const tablePool = new THREE.SpotLight('#fff1dc', 25, 14, .59, .7, 2)
  tablePool.name = 'SoftOverheadTablePool'
  tablePool.position.set(0, 8, 0)
  tablePool.target.position.set(0, TABLE.topY, 0)
  // The directional key owns the only shadow map; this adds a soft centred pool cheaply.
  group.add(tablePool, tablePool.target)
  // A broad neutral wash aimed backwards makes vertical stone readable without a new shadow pass.
  const wallFill = new THREE.SpotLight('#e8e9e4', 30, 13, 1.12, .85, 2)
  wallFill.name = 'BackWallNeutralFill'
  wallFill.position.set(0, 4.8, -3.8)
  wallFill.target.position.set(0, 1.9, -6.85)
  group.add(wallFill, wallFill.target)

  const normalBackground = new THREE.Color('#141419'), mirrorBackground = new THREE.Color('#b5b1a7')
  const normalSky = new THREE.Color('#e2d7cb'), mirrorSky = new THREE.Color('#fff2df')
  const normalGround = new THREE.Color('#171a23'), mirrorGround = new THREE.Color('#9c978b')
  const normalKey = new THREE.Color('#ffead5'), mirrorKey = new THREE.Color('#fff5e7')
  let mix = 0, disposed = false

  return {
    setBlinds(small, big) {
      if (disposed || !Number.isSafeInteger(small) || !Number.isSafeInteger(big) || small <= 0 || big < small) return
      if (small === smallBlind && big === bigBlind) return
      smallBlind = small; bigBlind = big
      blindLabel.userData.text = `${small} / ${big}`
      blindsPrint.draw(blindLabel.userData.text)
    },
    update(dt, worldMode) {
      if (disposed) return
      const target = worldMode === 'MIRROR' ? 1 : 0
      const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, .1)) : 0
      mix += (target - mix) * (1 - Math.exp(-step * 4.4))
      if (Math.abs(target - mix) < .0005) mix = target
      for (const item of colors) item.material.color.copy(item.normal).lerp(item.mirror, mix)
      background.copy(normalBackground).lerp(mirrorBackground, mix)
      fog.color.copy(background)
      ambient.color.copy(normalSky).lerp(mirrorSky, mix)
      ambient.groundColor.copy(normalGround).lerp(mirrorGround, mix)
      ambient.intensity = .78 + mix * .38
      key.color.copy(normalKey).lerp(mirrorKey, mix)
      key.intensity = 2.85 - mix * .4
      tablePool.intensity = 25 - mix * 7
      wallFill.intensity = 30 - mix * 18
      rim.intensity = .12 - mix * .07
      arcSpill.intensity = 5 - mix * 3
      floorMat.envMapIntensity = .28 + mix * .15
      // The static reflection cube is dark; add a pale diffuse/emissive silver response in MIRROR.
      // This is an art-directed polished slab, not a physically accurate live mirror.
      mirrorMat.envMapIntensity = .82 - mix * .17
      mirrorMat.metalness = .96 - mix * .48
      mirrorMat.roughness = .1 + mix * .11
      mirrorMat.emissiveIntensity = mix * .2
      mirrorEdge.metalness = .78 - mix * .36
      mirrorEdge.roughness = .22 + mix * .09
      mirrorEdge.emissiveIntensity = mix * .1
      inlayUnderlayMaterial.opacity = mix * .92
      inlayUnderlay.visible = mix > 0
      shadowMaterial.opacity = .7 - mix * .14
      facetMat.opacity = .14 - mix * .035
      arcHaloMaterial.opacity = .045 - mix * .02
      wallGlowMaterial.opacity = .48 - mix * .16
      jointMaterial.opacity = .12 - mix * .035
      feltMarkMaterial.opacity = .16 - mix * .03
      feltMark.rotation.z = Math.PI * mix
      const letteringOpacity = .26 - mix * .04
      holdemLabel.material.opacity = letteringOpacity * (1 - mix)
      mirrorLabel.material.opacity = letteringOpacity * mix
      holdemLabel.visible = mix < 1
      mirrorLabel.visible = mix > 0
      blindLabel.material.opacity = letteringOpacity
    },
    dispose() {
      if (disposed) return
      disposed = true
      scene.remove(group)
      for (const geometry of geometries) geometry.dispose()
      for (const mat of materials) mat.dispose()
      stone.dispose(); wallStone.dispose(); feltGrain.dispose(); contact.dispose(); arcGlowMap.dispose(); feltMarkMap.dispose(); environment.dispose()
      holdemPrint.texture.dispose(); mirrorPrint.texture.dispose(); blindsPrint.texture.dispose()
      key.shadow.map?.dispose()
      if (scene.background === background) scene.background = prior.background
      if (scene.fog === fog) scene.fog = prior.fog
      if (scene.environment === environment) scene.environment = prior.environment
    },
  }
}

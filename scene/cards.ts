import * as THREE from 'three'
import { CARD, CARD_REST, PLATFORM_PALETTE } from '../shared/assets.ts'
import { CARD_ART, CARD_RANK_CENTERS, cardArtParts, suitPlacement } from '../shared/card-art.ts'
import type { Card } from '../shared/contracts.ts'

/** One card geometry / texture factory for every seat, board card and deck. */
export function createCardFactory() {
  const textures = new Map<string, THREE.CanvasTexture>()
  const materials = new Map<string, THREE.MeshBasicMaterial>()
  const radius = CARD.width * CARD_ART.cornerRadius / CARD_ART.width
  const left = -CARD.width / 2, right = CARD.width / 2, bottom = -CARD.height / 2, top = CARD.height / 2
  const shape = new THREE.Shape()
  shape.moveTo(left + radius, bottom)
  shape.lineTo(right - radius, bottom); shape.absarc(right - radius, bottom + radius, radius, -Math.PI / 2, 0, false)
  shape.lineTo(right, top - radius); shape.absarc(right - radius, top - radius, radius, 0, Math.PI / 2, false)
  shape.lineTo(left + radius, top); shape.absarc(left + radius, top - radius, radius, Math.PI / 2, Math.PI, false)
  shape.lineTo(left, bottom + radius); shape.absarc(left + radius, bottom + radius, radius, Math.PI, Math.PI * 1.5, false)
  shape.closePath()
  const faceGeometry = new THREE.ShapeGeometry(shape, 6)
  const positions = faceGeometry.getAttribute('position'), uv = faceGeometry.getAttribute('uv')
  for (let i = 0; i < positions.count; i++) uv.setXY(i, positions.getX(i) / CARD.width + .5, positions.getY(i) / CARD.height + .5)
  const edgeGeometry = new THREE.ExtrudeGeometry(shape, { depth: CARD.thickness, bevelEnabled: false, steps: 1, curveSegments: 6 })
  edgeGeometry.translate(0, 0, -CARD.thickness / 2)
  edgeGeometry.rotateX(-Math.PI / 2)
  const edgeMaterial = new THREE.MeshStandardMaterial({ color: 0xe7eade, roughness: .54 })
  const outlines = new Map<string, Path2D>()
  const outline = (source: string) => {
    // Geometry-only Node checks supply a Canvas stub, without the native Path2D
    // available in Chromium. The real rendering path always uses vectors.
    if (typeof Path2D === 'undefined') return null
    let path = outlines.get(source)
    if (!path) { path = new Path2D(source); outlines.set(source, path) }
    return path
  }

  function texture(card: Card | null): THREE.CanvasTexture {
    const key = card || 'back'
    const existing = textures.get(key)
    if (existing) return existing
    const canvas = document.createElement('canvas')
    canvas.width = CARD.textureWidth
    canvas.height = CARD.textureHeight
    const c = canvas.getContext('2d')!
    const w = canvas.width, h = canvas.height
    // Draw in a fixed design space so a higher texture resolution, if needed later,
    // preserves the same clear indices and the existing back design.
    c.scale(w / 256, h / 360)
    const designW = 256, designH = 360
    c.fillStyle = card ? CARD_ART.paper : '#c4cdbf'
    c.fillRect(0, 0, designW, designH)
    const roundRect = (x: number, y: number, width: number, height: number, r: number) => {
      c.beginPath(); c.roundRect(x, y, width, height, r)
    }
    if (card) {
      c.strokeStyle = CARD_ART.rim; c.lineWidth = 1.2
      roundRect(2, 2, designW - 4, designH - 4, 11); c.stroke()
      const { rank, suit, color, rankPath, suitPath } = cardArtParts(card)
      const rankOutline = outline(rankPath), suitOutline = outline(suitPath)
      const pip = (x: number, y: number, width: number, height: number) => {
        if (!suitOutline) return
        const p = suitPlacement(suit, x, y, width, height)
        c.save(); c.translate(x, y); c.scale(p.scale, p.scale); c.translate(-p.centerX, -p.centerY)
        c.fillStyle = color; c.fill(suitOutline); c.restore()
      }
      const index = () => {
        const a = CARD_ART.index, [cx, cy] = CARD_RANK_CENTERS[rank], p = CARD_ART.cornerPip
        if (rankOutline) {
          c.save(); c.translate(a.x, a.y); c.scale(a.scaleX, a.scaleY); c.translate(-cx, -cy)
          c.strokeStyle = color; c.lineWidth = CARD_ART.rankStroke; c.lineCap = 'round'; c.lineJoin = 'round'
          c.stroke(rankOutline); c.restore()
        }
        pip(p.x, p.y, p.width, p.height)
      }
      index()
      c.save()
      c.translate(designW, designH)
      c.rotate(Math.PI)
      index()
      c.restore()
      const p = CARD_ART.centralPip
      pip(p.x, p.y, p.width, p.height)
    } else {
      c.fillStyle = PLATFORM_PALETTE.ink
      roundRect(4, 4, designW - 8, designH - 8, 9); c.fill()
      c.strokeStyle = PLATFORM_PALETTE.lime
      c.lineWidth = 1
      c.save()
      // Keep a dark field when several backs overlap; the central mark stays
      // brighter than the fine lime lattice at the gameplay camera distance.
      c.globalAlpha = .20
      c.beginPath()
      c.roundRect(12, 12, designW - 24, designH - 24, 5)
      c.clip()
      for (let x = -designH; x < designW + designH; x += 27) {
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x + designH, designH); c.stroke()
        c.beginPath(); c.moveTo(x, designH); c.lineTo(x + designH, 0); c.stroke()
      }
      c.restore()
      c.fillStyle = PLATFORM_PALETTE.forest
      c.save(); c.translate(designW / 2, designH / 2); c.rotate(Math.PI / 4)
      c.fillRect(-45, -45, 90, 90)
      c.strokeStyle = PLATFORM_PALETTE.lime; c.lineWidth = 1.8; c.strokeRect(-40, -40, 80, 80)
      c.restore()
      c.fillStyle = PLATFORM_PALETTE.lime; c.textAlign = 'center'; c.textBaseline = 'middle'
      c.font = '46px Georgia, serif'; c.fillText('M', designW / 2, designH / 2 + 2)
      c.strokeStyle = PLATFORM_PALETTE.lime; c.lineWidth = 1.2
      c.save(); c.globalAlpha = .65
      roundRect(11, 11, designW - 22, designH - 22, 5); c.stroke(); c.restore()
    }
    const map = new THREE.CanvasTexture(canvas)
    map.colorSpace = THREE.SRGBColorSpace
    map.anisotropy = 4
    textures.set(key, map)
    return map
  }

  function material(card: Card | null) {
    const key = card || 'back'
    let mat = materials.get(key)
    if (!mat) {
      // Printed faces and the logo-lime back retain their ink colours under ACES.
      mat = new THREE.MeshBasicMaterial({ map: texture(card), color: 0xffffff, toneMapped: false })
      materials.set(key, mat)
    }
    return mat
  }

  function create(card: Card | null = null) {
    const group = new THREE.Group()
    const edge = new THREE.Mesh(edgeGeometry, edgeMaterial)
    edge.castShadow = true
    edge.receiveShadow = true
    group.add(edge)
    const front = new THREE.Mesh(faceGeometry, material(card))
    front.rotation.x = -Math.PI / 2
    front.position.y = CARD.thickness / 2 + CARD_REST.skinOffset
    const back = new THREE.Mesh(faceGeometry, material(null))
    back.rotation.x = Math.PI / 2
    back.position.y = -CARD.thickness / 2 - CARD_REST.skinOffset
    group.add(front, back)
    return { group, setCard(value: Card | null) { front.material = material(value) } }
  }

  return {
    create,
    dispose() {
      faceGeometry.dispose(); edgeGeometry.dispose(); edgeMaterial.dispose()
      materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose())
      outlines.clear()
    },
  }
}

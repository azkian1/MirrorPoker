import * as THREE from 'three'
import { ANCHORS, CARD, CARD_REST, CHIP, CHIP_STACK, PLATFORM_PALETTE, type Vec3 } from '../shared/assets'
import type { Card, GameEvent, PrivateState, PublicState } from '../shared/contracts'

export interface PiecesView {
  apply(state: PublicState, self: PrivateState | null): void
  event(event: GameEvent): void
  update(dt: number): void
  /** True once every visible hole/board card has finished its flight, flip or muck.
   * Does not wait for chips; a snapshot without existing card motions is settled immediately. */
  cardsSettled(): boolean
  dispose(): void
}

import { createCardFactory } from './cards.ts'
const clamp = (n: number) => Math.max(0, Math.min(1, n))
const ease = (n: number) => 1 - Math.pow(1 - clamp(n), 3)
const v = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2])

/** Shared soft rectangular contact mask; the card itself occludes its dark centre. */
function cardContactTexture() {
  const width = 64, height = 90, pad = .03, radius = .035
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const localX = ((x + .5) / width - .5) * (CARD.width + pad * 2)
    const localY = ((y + .5) / height - .5) * (CARD.height + pad * 2)
    const qx = Math.abs(localX) - CARD.width / 2 + radius
    const qy = Math.abs(localY) - CARD.height / 2 + radius
    const distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
    const t = clamp((distance + .004) / .034)
    data[(y * width + x) * 4 + 3] = Math.round((1 - t * t * (3 - 2 * t)) * 255)
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat)
  texture.name = 'CardContactMask'
  texture.magFilter = texture.minFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

export { createCardFactory } from './cards.ts'

type CardPiece = ReturnType<ReturnType<typeof createCardFactory>['create']> & {
  target: THREE.Vector3; yaw: number; up: boolean; motion?: CardMotion
}
interface CardMotion { elapsed: number; delay: number; duration: number; from?: THREE.Vector3; flip?: boolean; kind?: 'muck'; to?: THREE.Vector3; yawFrom?: number }
interface PendingMuck { afterSeq: number; poses: { from: THREE.Vector3; yaw: number }[] }
interface ChipFlight { from: THREE.Vector3; to: THREE.Vector3; elapsed: number; duration: number; delay: number; color: number }

export function createPieces(scene: THREE.Scene): PiecesView {
  const root = new THREE.Group()
  root.name = 'PokerPieces'
  scene.add(root)
  const factory = createCardFactory()
  const holes = Array.from({ length: 4 }, (_, seat) => Array.from({ length: 2 }, (_, card) => makeCard(`HoleCard-${seat}-${card}`)))
  const board = Array.from({ length: 5 }, (_, card) => makeCard(`BoardCard-${card}`))
  const allCards = [...holes.flat(), ...board]
  let current: PublicState | null = null
  let previousHand = ''
  let boardCount = 0
  let newBoard: number[] = []
  const seen = new Set<string>()
  const pendingMucks = new Map<string, PendingMuck>()
  const muckedPlayers = new Set<string>()
  let lastEventSeq = -1
  let time = 0
  const flights: ChipFlight[] = []
  const deck = factory.create(null)
  deck.group.name = 'DealerDeck'
  deck.group.visible = false
  deck.group.position.copy(v(ANCHORS.deck)).add(new THREE.Vector3(0, .045 + CARD.thickness / 2 + CARD_REST.skinOffset + CARD_REST.gap, 0))
  deck.group.rotation.z = Math.PI
  root.add(deck.group)
  const deckBase = new THREE.Mesh(new THREE.BoxGeometry(CARD.width, .09, CARD.height), new THREE.MeshStandardMaterial({ color: 0xe4ded2, roughness: .65 }))
  deckBase.name = 'DealerDeckBase'
  deckBase.visible = false
  deckBase.position.copy(v(ANCHORS.deck))
  root.add(deckBase)

  const contactMap = cardContactTexture()
  const contactGeometry = new THREE.PlaneGeometry(CARD.width + .06, CARD.height + .06)
  const contactMaterial = new THREE.MeshBasicMaterial({
    map: contactMap, color: 0x000000, transparent: true, opacity: .14,
    depthWrite: false, depthTest: true, alphaTest: .001, toneMapped: false,
    // A slope bias can pull a near-flush shadow through the printed card face.
    // Physical separation from the felt is sufficient; keep the depth exact.
    polygonOffset: false,
  })
  const cardContacts = new THREE.InstancedMesh(contactGeometry, contactMaterial, 13)
  cardContacts.name = 'CardContactShadows'
  cardContacts.count = 0
  cardContacts.frustumCulled = false
  cardContacts.castShadow = cardContacts.receiveShadow = false
  cardContacts.userData.surfaceY = CARD_REST.feltY + .0007
  root.add(cardContacts)
  const contactDummy = new THREE.Object3D()

  const chipGeometry = new THREE.CylinderGeometry(CHIP.radius, CHIP.radius, CHIP.height, 24)
  const ringGeometry = new THREE.CylinderGeometry(CHIP.radius * 1.015, CHIP.radius * 1.015, CHIP.height * .22, 24, 1, true)
  const chipMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .4, metalness: .14 })
  const ringMaterial = new THREE.MeshStandardMaterial({ color: 0xf6e5ca, roughness: .6 })
  const chips = new THREE.InstancedMesh(chipGeometry, chipMaterial, 480)
  const chipRings = new THREE.InstancedMesh(ringGeometry, ringMaterial, 480)
  chips.name = 'TableChips'
  chipRings.name = 'TableChipRings'
  chips.castShadow = true; chips.receiveShadow = true
  chips.frustumCulled = false; chipRings.frustumCulled = false
  root.add(chips, chipRings)
  const matrixDummy = new THREE.Object3D()
  const chipColor = new THREE.Color()
  const forestChip = new THREE.Color(PLATFORM_PALETTE.forest).getHex()
  const limeChip = new THREE.Color(PLATFORM_PALETTE.lime).getHex()
  const seatColors = [forestChip, 0xe4daca, 0x354855, forestChip]
  const activeRing = new THREE.Mesh(new THREE.RingGeometry(.62, .645, 64), new THREE.MeshBasicMaterial({ color: PLATFORM_PALETTE.lime, transparent: true, opacity: .65, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }))
  activeRing.rotation.x = -Math.PI / 2
  activeRing.visible = false
  root.add(activeRing)

  // Physical dealer button: a cream chip on the felt, independent of the HTML player panel.
  const dealerButton = new THREE.Group()
  dealerButton.name = 'DealerButton'
  dealerButton.visible = false
  const buttonGeometry = new THREE.CylinderGeometry(.155, .155, .045, 40)
  const buttonMaterial = new THREE.MeshStandardMaterial({ color: '#e4dac7', roughness: .43, metalness: .06 })
  const buttonBody = new THREE.Mesh(buttonGeometry, buttonMaterial)
  buttonBody.castShadow = buttonBody.receiveShadow = true
  dealerButton.add(buttonBody)
  const buttonCanvas = document.createElement('canvas')
  buttonCanvas.width = buttonCanvas.height = 256
  const buttonContext = buttonCanvas.getContext('2d')!
  buttonContext.fillStyle = '#eee5d4'
  buttonContext.fillRect(0, 0, 256, 256)
  buttonContext.strokeStyle = '#987750'; buttonContext.lineWidth = 7
  buttonContext.beginPath(); buttonContext.arc(128, 128, 115, 0, Math.PI * 2); buttonContext.stroke()
  buttonContext.fillStyle = '#28232a'; buttonContext.font = '700 166px Georgia, serif'
  buttonContext.textAlign = 'center'; buttonContext.textBaseline = 'middle'
  buttonContext.fillText('D', 128, 139)
  const buttonMap = new THREE.CanvasTexture(buttonCanvas)
  buttonMap.colorSpace = THREE.SRGBColorSpace
  buttonMap.anisotropy = 4
  const buttonFaceGeometry = new THREE.CircleGeometry(.151, 40)
  const buttonFaceMaterial = new THREE.MeshBasicMaterial({ map: buttonMap, toneMapped: false })
  const buttonFace = new THREE.Mesh(buttonFaceGeometry, buttonFaceMaterial)
  buttonFace.rotation.x = -Math.PI / 2
  buttonFace.position.y = .0231
  dealerButton.add(buttonFace)
  root.add(dealerButton)

  function makeCard(name: string): CardPiece {
    const piece = factory.create(null)
    piece.group.name = name
    piece.group.visible = false
    root.add(piece.group)
    return { ...piece, target: new THREE.Vector3(), yaw: 0, up: false }
  }
  function poseCard(piece: CardPiece) {
    piece.group.position.copy(piece.target)
    piece.group.rotation.set(0, piece.yaw, piece.up ? 0 : Math.PI)
    piece.group.scale.set(1, 1, 1)
  }
  function anchor(seat: number) { return ANCHORS.seats[seat] || ANCHORS.seats[0] }

  function apply(state: PublicState, self: PrivateState | null) {
    const before = current
    const changedHand = state.handId !== previousHand || !!current && state.seq < current.seq
    // A transition cache belongs only to the next synchronous event batch. A snapshot
    // alone already removes the folded cards; it never waits for an animation event.
    pendingMucks.clear()
    if (changedHand) {
      seen.clear(); lastEventSeq = -1; flights.length = 0; boardCount = 0
      muckedPlayers.clear()
      holes.flat().concat(board).forEach(p => { p.motion = undefined })
      previousHand = state.handId
    }
    current = state
    const deckVisible = state.stage !== 'LOBBY' && state.handId !== ''
    deck.group.visible = deckBase.visible = deckVisible
    newBoard = state.board.map((_, i) => i).filter(i => i >= boardCount)
    boardCount = state.board.length
    const playing = state.stage !== 'LOBBY' && state.stage !== 'INTERMISSION' && state.handId !== ''
    dealerButton.visible = state.stage !== 'LOBBY' && state.players.some(player => player.seat === state.dealerSeat)
    if (dealerButton.visible) dealerButton.position.copy(v(ANCHORS.dealerButtons[state.dealerSeat] || ANCHORS.dealerButtons[0])).add(new THREE.Vector3(0, .0225, 0))
    for (let seat = 0; seat < 4; seat++) {
      const player = state.players.find(p => p.seat === seat)
      const priorPlayer = before?.players.find(p => p.id === player?.id && p.seat === seat)
      if (playing && player?.folded && !changedHand && priorPlayer && !priorPlayer.folded && !priorPlayer.sittingOut &&
          holes[seat].every(piece => piece.group.visible) && !muckedPlayers.has(player.id)) {
        pendingMucks.set(player.id, { afterSeq: before!.seq, poses: holes[seat].map(piece => ({ from: piece.group.position.clone(), yaw: piece.group.rotation.y })) })
      } else if (player?.folded && !pendingMucks.has(player.id)) muckedPlayers.add(player.id)
      for (let i = 0; i < 2; i++) {
        const piece = holes[seat][i]
        const continuingMuck = playing && !!player?.folded && piece.motion?.kind === 'muck'
        piece.group.visible = playing && !!player && !player.sittingOut && (!player.folded || continuingMuck)
        if (!player) { piece.motion = undefined; continue }
        const privateCards = self?.playerId === player.id && self.handId === state.handId ? self.cards : []
        const card = player.folded ? null : privateCards[i] || player.cards?.[i] || null
        piece.setCard(card)
        piece.up = card !== null && !player.folded
        if (continuingMuck) continue // A fresh snapshot must not snap the moving cards back to the seat.
        if (player.folded || !playing || player.sittingOut) piece.motion = undefined
        const p = anchor(seat)
        piece.target.set(p[0] + (i === 0 ? -.17 : .17), CARD_REST.centerY + i * CARD_REST.overlapStep, p[2] + (player.folded ? -.14 : 0))
        piece.yaw = (i === 0 ? -.095 : .095) + (seat === 1 ? .12 : seat === 2 ? -.12 : 0)
        // A same-hand resync updates the target/face without teleporting a live flight.
        if (!piece.motion) poseCard(piece)
      }
    }
    board.forEach((piece, i) => {
      piece.group.visible = playing && !!state.board[i]
      piece.setCard(state.board[i] || null)
      piece.up = true; piece.yaw = 0
      piece.target.set(ANCHORS.board[i][0], CARD_REST.centerY, ANCHORS.board[i][2])
      if (!playing || !state.board[i]) piece.motion = undefined
      if (!piece.motion) poseCard(piece)
    })
    activeRing.visible = false
    const actor = state.players.find(p => p.id === state.actorId)
    if (actor) {
      const p = anchor(actor.seat)
      activeRing.position.set(p[0], CARD_REST.feltY + .002, p[2] + .05)
      activeRing.scale.set(1.15, .73, 1)
      activeRing.visible = true
    }
    drawChips()
    drawCardContacts()
  }

  function drawCardContacts() {
    let index = 0
    for (const piece of allCards) {
      // The real card edges cast flight shadows. The tight contact patch belongs
      // only to a settled card, never to a floating deal, flip or discarded hand.
      if (!piece.group.visible || piece.motion) continue
      contactDummy.position.set(piece.group.position.x, cardContacts.userData.surfaceY, piece.group.position.z)
      // RY(yaw)*RX(-PI/2) keeps the footprint exactly on XZ, with the card fan yaw.
      contactDummy.rotation.set(-Math.PI / 2, 0, piece.yaw)
      contactDummy.scale.set(1, 1, 1)
      contactDummy.updateMatrix()
      cardContacts.setMatrixAt(index++, contactDummy.matrix)
    }
    cardContacts.count = index
    cardContacts.instanceMatrix.needsUpdate = true
  }

  function animateCards(pieces: CardPiece[], flip: boolean, fromDeck: boolean) {
    pieces.filter(p => p.group.visible && p.motion?.kind !== 'muck').forEach((piece, i) => {
      if (!fromDeck && piece.motion) {
        // An instant all-in transaction can contain CARDS_DEALT then SHOWDOWN.
        // Reveal on the original flight instead of replacing it with a seat-only flip.
        piece.motion.flip ||= flip && piece.up
        return
      }
      piece.motion = { elapsed: 0, delay: i * .065, duration: fromDeck ? .48 : .42, from: fromDeck ? v(ANCHORS.deck).add(new THREE.Vector3(0, .12, 0)) : undefined, flip: flip && piece.up }
    })
  }
  function event(e: GameEvent) {
    if (!current || e.handId !== current.handId || seen.has(e.eventId) || e.seq < lastEventSeq) return
    seen.add(e.eventId); lastEventSeq = Math.max(lastEventSeq, e.seq)
    // Bounded retention for long-running rooms.
    if (seen.size > 300) seen.delete(seen.values().next().value as string)
    if (e.type === 'CARDS_DEALT') animateCards(holes.flat(), true, true)
    if (e.type === 'STREET_CHANGED') {
      const indexes = newBoard.length ? newBoard : e.board ? e.board.map((_, i) => i).filter(i => current!.board[i] && !board[i].motion) : []
      animateCards(indexes.map(i => board[i]), true, true)
      newBoard = []
    }
    if (e.type === 'SHOWDOWN') animateCards(holes.flat(), true, false)
    if (e.type === 'PLAYER_ACTED' && e.playerId && e.action?.type === 'fold') {
      const player = current.players.find(p => p.id === e.playerId)
      const pending = pendingMucks.get(e.playerId)
      if (player?.folded && !player.sittingOut && pending && !muckedPlayers.has(player.id) && e.seq > pending.afterSeq && e.seq <= current.seq && !['LOBBY', 'INTERMISSION'].includes(current.stage)) {
        muckedPlayers.add(player.id)
        pendingMucks.delete(player.id)
        holes[player.seat].forEach((piece, i) => {
          piece.setCard(null); piece.up = false; piece.group.visible = true
          piece.motion = { kind: 'muck', elapsed: 0, delay: i * .02, duration: .3,
            from: pending.poses[i].from, yawFrom: pending.poses[i].yaw,
            to: v(ANCHORS.deck).add(new THREE.Vector3(i === 0 ? -.09 : .09, .035 + i * .004, .55)),
          }
          piece.group.position.copy(pending.poses[i].from)
          piece.group.rotation.set(0, pending.poses[i].yaw, Math.PI)
          piece.group.scale.set(1, 1, 1)
        })
      }
    }
    if (e.type === 'PLAYER_ACTED' && e.playerId && e.action && !['fold', 'check'].includes(e.action.type)) {
      const player = current.players.find(p => p.id === e.playerId)
      if (player) fly(v(ANCHORS.chips[player.seat]).add(new THREE.Vector3(0, .1, 0)), v(ANCHORS.bets[player.seat]), seatColors[player.seat], 6)
    }
    if (e.type === 'PAYOUT') for (const winner of e.winners || current.winners) {
      const player = current.players.find(p => p.id === winner.playerId)
      if (player) fly(v(ANCHORS.pot), v(ANCHORS.chips[player.seat]).add(new THREE.Vector3(0, .1, 0)), limeChip, 8)
    }
    drawCardContacts()
  }

  function fly(from: THREE.Vector3, to: THREE.Vector3, color: number, count: number) {
    for (let i = 0; i < count; i++) flights.push({ from: from.clone(), to: to.clone(), elapsed: 0, duration: .55, delay: i * .035, color })
    if (flights.length > 72) flights.splice(0, flights.length - 72)
  }

  function drawChips() {
    let index = 0
    function chip(x: number, y: number, z: number, color: number, spin = 0) {
      if (index >= 480) return
      matrixDummy.position.set(x, y, z)
      matrixDummy.rotation.set(0, spin, 0)
      matrixDummy.scale.set(1, 1, 1)
      matrixDummy.updateMatrix()
      chips.setMatrixAt(index, matrixDummy.matrix)
      chipRings.setMatrixAt(index, matrixDummy.matrix)
      chips.setColorAt(index, chipColor.setHex(color))
      index++
    }
    function stack(amount: number, p: Vec3, color: number, max: number, layout: 'pot' | 'bankroll' | 'bet' = 'pot', side = 1) {
      const count = amount > 0 ? Math.min(max, Math.max(1, Math.ceil(amount / CHIP_STACK.valuePerChip))) : 0
      for (let i = 0; i < count; i++) {
        const column = Math.floor(i / CHIP_STACK.perColumn), row = i % CHIP_STACK.perColumn
        // Bankroll anchors are centres: fill centre, outside, inside, never grow toward cards.
        const offset = layout === 'bankroll' ? (column === 0 ? 0 : column === 1 ? side : -side) * CHIP_STACK.columnSpacing
          : layout === 'bet' ? column * -side * CHIP_STACK.columnSpacing
          : (column % 3) * CHIP_STACK.columnSpacing
        const depthOffset = layout === 'pot' ? Math.floor(column / 3) * CHIP_STACK.columnSpacing : 0
        chip(p[0] + offset, p[1] + CHIP.height / 2 + row * CHIP.height, p[2] + depthOffset, color, i * .7)
      }
    }
    if (current) {
      current.players.forEach(player => {
        const side = player.seat < 2 ? -1 : 1
        stack(player.stack, ANCHORS.chips[player.seat], seatColors[player.seat], CHIP_STACK.bankrollLimit, 'bankroll', side)
        // Extra bet columns expand inwards, away from the two outside card fans.
        stack(player.bet, ANCHORS.bets[player.seat], forestChip, CHIP_STACK.betLimit, 'bet', side)
      })
      stack(Math.max(0, current.pot - current.players.reduce((sum, p) => sum + p.bet, 0)), ANCHORS.pot, forestChip, CHIP_STACK.potLimit)
    }
    flights.forEach(f => {
      const t = clamp((f.elapsed - f.delay) / f.duration)
      if (f.elapsed < f.delay || t >= 1) return
      const p = f.from.clone().lerp(f.to, ease(t))
      p.y += .3 * Math.sin(t * Math.PI)
      chip(p.x, p.y + .04, p.z, f.color, t * 5)
    })
    chips.count = index; chipRings.count = index
    chips.instanceMatrix.needsUpdate = true; chipRings.instanceMatrix.needsUpdate = true
    if (chips.instanceColor) chips.instanceColor.needsUpdate = true
  }

  function update(dt: number) {
    // Snapshot-only resyncs cannot replay a missed fold on a later frame.
    pendingMucks.clear()
    const delta = Number.isFinite(dt) ? Math.min(.1, Math.max(0, dt)) : 0
    time += delta
    holes.flat().concat(board).forEach(piece => {
      const motion = piece.motion
      if (!motion || !piece.group.visible) return
      motion.elapsed += delta
      const t = clamp((motion.elapsed - motion.delay) / motion.duration)
      poseCard(piece)
      if (motion.kind === 'muck') {
        piece.group.position.lerpVectors(motion.from!, motion.to!, ease(t))
        piece.group.position.y += .045 * Math.sin(t * Math.PI)
        piece.group.rotation.set(0, (motion.yawFrom || 0) + t * .38, Math.PI)
        piece.group.scale.setScalar(1 - .3 * ease(t))
        if (t >= 1) { piece.motion = undefined; piece.group.visible = false; poseCard(piece) }
        return
      }
      if (motion.from) {
        piece.group.position.lerpVectors(motion.from, piece.target, ease(t))
        piece.group.position.y += .28 * Math.sin(t * Math.PI)
      }
      if (motion.flip) piece.group.rotation.z = Math.PI * (1 - ease(t))
      if (t >= 1) { piece.motion = undefined; poseCard(piece) }
    })
    const hadFlights = flights.length > 0
    for (let i = flights.length - 1; i >= 0; i--) {
      flights[i].elapsed += delta
      if (flights[i].elapsed >= flights[i].delay + flights[i].duration) flights.splice(i, 1)
    }
    if (activeRing.visible) {
      (activeRing.material as THREE.MeshBasicMaterial).opacity = .45 + .25 * Math.sin(time * 4)
    }
    if (hadFlights) drawChips()
    drawCardContacts()
  }

  function cardsSettled(): boolean {
    return holes.every(hand => hand.every(piece => !piece.group.visible || !piece.motion)) &&
      board.every(piece => !piece.group.visible || !piece.motion)
  }

  return { apply, event, update, cardsSettled, dispose() {
    scene.remove(root); factory.dispose()
    deckBase.geometry.dispose(); (deckBase.material as THREE.Material).dispose()
    contactGeometry.dispose(); contactMaterial.dispose(); contactMap.dispose(); cardContacts.dispose()
    chipGeometry.dispose(); ringGeometry.dispose(); chipMaterial.dispose(); ringMaterial.dispose()
    chips.dispose(); chipRings.dispose()
    activeRing.geometry.dispose(); (activeRing.material as THREE.Material).dispose()
    buttonGeometry.dispose(); buttonMaterial.dispose(); buttonFaceGeometry.dispose(); buttonFaceMaterial.dispose(); buttonMap.dispose()
    flights.length = 0
    pendingMucks.clear(); muckedPlayers.clear()
  } }
}

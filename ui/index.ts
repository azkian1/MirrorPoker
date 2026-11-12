import type { ActionType, Card, GameEvent, LegalAction, PokerAction, PrivateState, PublicState, Winner, WorldMode } from '../shared/contracts'
import { CARD_SUITS } from '../shared/assets.ts'
import { POKER_MARK_SVG } from '../shared/poker-mark.ts'
import { cardCompactSvg } from '../shared/card-art.ts'

export interface UICallbacks {
  solo(): void
  replay(): void
  act(action: PokerAction): void
  leave(): void
  mute(): void
  previewWorld?(mode: WorldMode): void
}
export interface UIProfile { playerId: string; displayName: string; avatarUrl: string | null }
export interface ScreenPoint { x: number; y: number }
export interface SeatPosition extends ScreenPoint { seat: number }
export interface GameUI {
  update(state: PublicState | null, self: PrivateState | null): void
  event(event: GameEvent): void
  setConnection(label: string): void
  setError(message: string): void
  showBriefing(): void
  setMuted(muted: boolean): void
  /** Presentation-only title/theme override; null restores the snapshot's world. */
  setWorldMode(mode: WorldMode | null): void
  /** Integrator opens the match result only after the final cards can be viewed. */
  setResultReady(handId: string | null): void
  /** Normalized projections of outside-table anchors, supplied by the scene integrator. */
  setSeatPositions(positions: SeatPosition[]): void
  /** Normalized projection just above each current-street chip stack. */
  setBetPositions(positions: SeatPosition[]): void
  setPotPosition(position: ScreenPoint): void
  setTablePositions(positions: { seats: SeatPosition[]; pot: ScreenPoint; bets?: SeatPosition[] }): void
  dispose(): void
}

const HANDS: Record<string, string> = { ROYAL_FLUSH: 'Royal flush', STRAIGHT_FLUSH: 'Straight flush', FOUR_OF_A_KIND: 'Four of a kind', FULL_HOUSE: 'Full house', FLUSH: 'Flush', STRAIGHT: 'Straight', THREE_OF_A_KIND: 'Three of a kind', TWO_PAIR: 'Two pair', PAIR: 'One pair', HIGH_CARD: 'High card', UNCONTESTED: 'Everyone else folded' }
const amountText = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)
const handText = (name: string) => HANDS[name] || name.replace(/_/g, ' ').toLowerCase()
const NORMAL_RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2']
// Vector navigation never depends on a phone's emoji/font substitution.
const uiSymbol = (path: string) => `<svg class="mp-symbol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`
const ARROW_OUT = uiSymbol('M6 18 18 6M6 6h12v12')
const ARROW_RIGHT = uiSymbol('M4 12h16m-6-6 6 6-6 6')
const CHEVRON_DOWN = uiSymbol('m6 9 6 6 6-6')
const REFRESH = uiSymbol('M20 7v5h-5M20 12a8 8 0 1 0-2 5M20 7v5')

/** DOM overlay. The server snapshot owns permissions, pot values and match placement. */
export function createUI(root: HTMLElement, callbacks: UICallbacks): GameUI {
  const shell = document.createElement('div')
  shell.className = 'mp-ui'
  shell.innerHTML = `
    <header class="mp-header">
      <button class="mp-icon mp-help" type="button" title="Open table guide" aria-label="Open table guide" aria-haspopup="dialog" aria-controls="mp-help-dialog" aria-expanded="false" hidden>H</button>
      <div class="mp-menu-brand"><img src="assets/brand/loading-chip.svg" alt="Mirror Poker" decoding="async" draggable="false"></div>
      <div class="mp-top-right">
        <div class="mp-utilities" id="mp-menu-utilities"><button class="mp-theme-toggle" type="button" role="switch" aria-checked="false" aria-label="Preview MIRROR world" title="Preview MIRROR world"><span class="mp-theme-swatch mp-theme-dark" aria-hidden="true"></span><span class="mp-theme-swatch mp-theme-light" aria-hidden="true"></span><span class="mp-theme-knob" aria-hidden="true"></span></button><button class="mp-icon mp-mute" title="Mute audio" aria-label="Mute audio">♪</button><button class="mp-icon mp-exit" title="Leave table" aria-label="Leave table" hidden>${ARROW_OUT}</button></div>
        <aside class="mp-last-hand" aria-label="Previous completed hand" hidden><span class="mp-last-title">LAST HAND</span><div class="mp-last-winners" aria-live="polite" aria-atomic="true"></div></aside>
      </div>
    </header>
    <section class="mp-menu" aria-label="Game menu">
      <div class="mp-eyebrow"><i></i> TEXAS HOLD’EM / REIMAGINED</div>
      <h1>ONE TABLE.<br>TWO<br><em>WORLDS.</em></h1>
      <p class="mp-intro">The rules stay.<br>The strongest cards don’t.</p>
      <div class="mp-menu-actions"><button class="mp-button mp-primary mp-solo"><span>PLAY VS BOTS<small>YOU + THREE BOTS</small></span><b>${ARROW_RIGHT}</b></button></div>
      <div class="mp-menu-note">52 CARDS. TWO WORLDS. ONE DEALER.</div>
    </section>
    <section class="mp-search mp-panel" role="dialog" aria-modal="true" aria-labelledby="mp-search-title" aria-describedby="mp-briefing-rules" aria-owns="mp-menu-utilities" tabindex="-1" hidden>
      <div class="mp-briefing-heading"><span class="mp-eyebrow mp-search-format"></span><span class="mp-briefing-edition">THE DEALER’S RULES / 01</span></div>
      <h2 id="mp-search-title"></h2>
      <div class="mp-world-cards" aria-label="Two worlds. One Dealer.">
        <article class="mp-world-card mp-world-card-normal" aria-label="Holdem: standard card strength"><span class="mp-card-corner">HOLDEM<span>♠</span></span><div class="mp-card-portrait"><img src="assets/dealer/normal-v3.png" alt="The Dealer in a dark suit" decoding="async" draggable="false"></div><div class="mp-card-caption"><span>THE ORIGINAL WORLD</span><strong>NL HOLDEM</strong><small>A <i>→</i> 2</small></div><span class="mp-card-corner mp-card-corner-bottom" aria-hidden="true">HOLDEM<span>♠</span></span></article>
        <span class="mp-world-cards-link" aria-hidden="true">⇄</span>
        <article class="mp-world-card mp-world-card-mirror" aria-label="Mirror: reversed card strength"><span class="mp-card-corner">MIRROR<span>♠</span></span><div class="mp-card-portrait"><img src="assets/dealer/mirror-v3.png" alt="The Dealer in an ivory suit" decoding="async" draggable="false"></div><div class="mp-card-caption"><span>EVERYTHING TURNS</span><strong>MIRROR NL HOLDEM</strong><small>2 <i>→</i> A</small></div><span class="mp-card-corner mp-card-corner-bottom" aria-hidden="true">MIRROR<span>♠</span></span></article>
      </div>
      <div class="mp-briefing-rules" id="mp-briefing-rules"><p>The Dealer mirrors the world between hands, <br>reversing card strength.</p><p>In <strong>MIRROR</strong>, <b>2</b> is the strongest. <b>A</b> is the weakest.</p></div>
      <div class="mp-search-state"><p class="mp-search-message" role="status" aria-live="polite"></p><p class="mp-search-count" hidden></p><div class="mp-search-players" aria-label="Matched players"></div></div>
      <div class="mp-search-actions"><button class="mp-button mp-primary mp-briefing-play" hidden>PLAY <span>${ARROW_RIGHT}</span></button><button class="mp-button mp-secondary mp-search-cancel">CANCEL SEARCH <span>${ARROW_OUT}</span></button></div>
    </section>
    <section class="mp-lobby mp-panel" aria-label="Preparing table" hidden><span class="mp-eyebrow">MIRROR POKER</span><h2>Take a seat.</h2><p>Your table is being prepared.</p></section>
    <section class="mp-pot" aria-label="Pot" hidden><span class="mp-small-label">TOTAL POT</span><strong>0</strong></section>
    <div class="mp-seats" aria-label="Players"></div>
    <div class="mp-bets" aria-label="Current street bets"></div>
    <section class="mp-match-result" role="dialog" aria-modal="true" aria-labelledby="mp-match-title" hidden>
      <div class="mp-result-card"><div class="mp-result-ornament" aria-hidden="true">♠</div><span class="mp-result-kicker">MIRROR POKER</span><span class="mp-result-rating"></span><div class="mp-result-player" hidden><div class="mp-profile-avatar" aria-hidden="true">${POKER_MARK_SVG}</div><span></span></div><div class="mp-result-medallion"><span></span><small>PLACE</small></div><h2 id="mp-match-title"></h2><p class="mp-result-description"></p><div class="mp-result-buttons"><button class="mp-button mp-primary mp-replay">Play Again <span>${REFRESH}</span></button><button class="mp-button mp-secondary mp-result-leave">Main menu <span>${ARROW_OUT}</span></button></div></div>
    </section>
    <dialog class="mp-leave-confirm" aria-labelledby="mp-leave-title"><h2 id="mp-leave-title">Are you sure you want to leave?</h2><div class="mp-confirm-buttons"><button type="button" class="mp-button mp-secondary mp-confirm-leave">Leave</button><button type="button" class="mp-button mp-primary mp-confirm-stay" autofocus>Stay</button></div></dialog>
    <dialog class="mp-help-dialog" id="mp-help-dialog" aria-labelledby="mp-help-title" aria-describedby="mp-help-intro">
      <div class="mp-help-heading"><div><span class="mp-eyebrow">THE DEALER’S GUIDE</span><h2 id="mp-help-title">One table. Two worlds.</h2></div><button class="mp-icon mp-help-close" type="button" aria-label="Close help" title="Close help" autofocus>${uiSymbol('m6 6 12 12M6 18 18 6')}</button></div>
      <div class="mp-help-body">
        <section class="mp-help-tempo"><div><span class="mp-small-label">YOUR TOURNAMENT</span><p>Blinds rise between hands.</p></div><div class="mp-tournament" aria-label="Turbo tournament blinds" hidden><strong></strong><span></span></div></section>
        <section class="mp-help-worlds"><div class="mp-help-section-title"><h3>Card strength</h3><span>STRONGEST → WEAKEST</span></div><p id="mp-help-intro">The Dealer chooses a world before each hand. Rank strength reverses in MIRROR; the world stays fixed until payout.</p><div class="mp-help-rank-tables">${(['NORMAL', 'MIRROR'] as const).map(mode => `<article class="mp-help-world mp-help-world-${mode.toLowerCase()}" data-world="${mode}"><h4>${mode === 'NORMAL' ? 'HOLDEM' : 'MIRROR'}</h4><ol class="mp-help-ranks" aria-label="${mode === 'NORMAL' ? 'Holdem' : 'Mirror'} ranks, strongest to weakest">${(mode === 'NORMAL' ? NORMAL_RANKS : [...NORMAL_RANKS].reverse()).map(rank => `<li>${rank}</li>`).join('')}</ol><small>${mode === 'NORMAL' ? 'ACE HIGH · TWO LOW' : 'TWO HIGH · ACE LOW'}</small></article>`).join('')}</div><p class="mp-help-category-note">Hand categories keep their usual order in both worlds.</p><ol class="mp-help-categories" aria-label="Hand categories, strongest to weakest">${Object.entries(HANDS).filter(([key]) => key !== 'UNCONTESTED').map(([, name]) => `<li>${name}</li>`).join('')}</ol></section>
        <section class="mp-help-standings" aria-labelledby="mp-help-standings-title" hidden><div class="mp-help-section-title"><h3 id="mp-help-standings-title">At the table</h3><span>CHIP LEAD FIRST</span></div><p class="mp-help-prize">1 winner · 1st place only</p><div class="mp-help-roster" role="list" aria-label="Tournament players by stack"></div></section>
        <section class="mp-help-history" hidden></section>
        <p class="mp-help-live-note">The game and your turn timer keep running while this guide is open.</p>
      </div>
    </dialog>
    <footer class="mp-bottom" hidden>
      <section class="mp-action-area" aria-label="Your actions"><div class="mp-action-heading"><span class="mp-turn-caption" role="status" aria-live="polite"></span><output class="mp-turn-clock" role="timer" aria-live="off" hidden><strong></strong><span></span></output><span class="mp-action-note">PLAY CHIPS · NO REAL MONEY</span></div><div class="mp-action-row"><div class="mp-action-buttons"></div><div class="mp-bet-control"><div class="mp-bet-heading"><label for="mp-raise-value">RAISE TO</label><span class="mp-bet-range"></span></div><div class="mp-bet-inputs"><input class="mp-slider" aria-label="Bet amount" type="range" step="1"><input class="mp-number" id="mp-raise-value" aria-label="Total bet on this street" type="number" step="1" inputmode="numeric"></div><div class="mp-bet-presets"><button type="button" data-preset="half">1/2 POT</button><button type="button" data-preset="threequarters">3/4</button><button type="button" data-preset="allin">ALLIN</button></div></div></div></section>
    </footer>
    <div class="mp-toast" role="alert" hidden></div>
    <div class="mp-connection"><i></i><span>CONNECTING</span></div>
  `
  root.appendChild(shell)
  const el = <T extends HTMLElement = HTMLElement>(selector: string) => shell.querySelector<T>(selector)!
  const menu = el('.mp-menu'), lobby = el('.mp-lobby'), pot = el('.mp-pot')
  const searchPanel = el('.mp-search')
  const bottom = el('.mp-bottom'), actions = el('.mp-action-buttons'), result = el('.mp-match-result')
  const leaveConfirm = el<HTMLDialogElement>('.mp-leave-confirm')
  const helpDialog = el<HTMLDialogElement>('.mp-help-dialog'), helpHistory = el('.mp-help-history')
  const slider = el<HTMLInputElement>('.mp-slider'), number = el<HTMLInputElement>('.mp-number')
  const turnCaption = el('.mp-turn-caption'), lastHand = el('.mp-last-hand'), lastWinners = el('.mp-last-winners')
  const turnClock = el('.mp-turn-clock'), tournament = el('.mp-tournament'), sideStack = el('.mp-top-right')
  let seatPositions: SeatPosition[] = [{ seat: 0, x: .09, y: .76 }, { seat: 1, x: .12, y: .36 }, { seat: 2, x: .88, y: .36 }, { seat: 3, x: .91, y: .76 }]
  let potPosition: ScreenPoint = { x: .5, y: .39 }
  let betPositions: SeatPosition[] = [{ seat: 0, x: .38, y: .57 }, { seat: 1, x: .355, y: .44 }, { seat: 2, x: .645, y: .44 }, { seat: 3, x: .62, y: .57 }]
  const seats = seatPositions.map((_position, i) => {
    const seat = document.createElement('article')
    seat.className = `mp-seat mp-seat-${i}`
    seat.hidden = true
    seat.innerHTML = `<div class="mp-seat-avatar" aria-hidden="true">${POKER_MARK_SVG}</div><div class="mp-seat-marker"></div><div class="mp-seat-details"><div class="mp-seat-name"></div><div class="mp-seat-stack"></div><div class="mp-seat-status"></div><output class="mp-seat-clock" role="timer" aria-live="off" hidden></output></div><div class="mp-seat-time-track" aria-hidden="true" hidden><i></i></div>`
    el('.mp-seats').appendChild(seat)
    return seat
  })
  const betAmounts = Array.from({ length: 4 }, (_, seat) => {
    const label = document.createElement('output')
    label.className = `mp-bet-amount mp-bet-amount-${seat}`
    label.dataset.seat = String(seat)
    label.hidden = true
    el('.mp-bets').appendChild(label)
    return label
  })
  let state: PublicState | null = null
  let presentedWorldMode: WorldMode | null = null
  let self: PrivateState | null = null
  let legal: LegalAction[] = []
  let wager: LegalAction | undefined
  let wagerMin = 0, wagerMax = 0, allInTotal = 0
  let actionSignature = '', sentKey = ''
  let toastTimeout: ReturnType<typeof setTimeout> | undefined
  let lastResultSignature = ''
  let resultReadyHandId: string | null = null
  let turnTiming: { turnId: string; playerId: string; durationMs: number; deadline: number } | null = null
  let levelTiming: { level: number; deadline: number } | null = null
  let clockFrame = 0, lastClockFrame = -Infinity, disposed = false
  let leavePending = false, leaveFocus: HTMLElement | null = null
  let helpFocus: HTMLElement | null = null
  const helpPlayers = new Map<string, { name: string; stack: number; seat: number }>()
  let practiceBriefing = false, practicePending = false, briefingVisible = false
  let briefingFocus: HTMLElement | null = null
  const avatarBindings = new Map<HTMLElement, { key: string; image: HTMLImageElement | null }>()
  const listeners: (() => void)[] = []

  function listen(target: EventTarget, event: string, handler: EventListener) {
    target.addEventListener(event, handler)
    listeners.push(() => target.removeEventListener(event, handler))
  }
  const onClick = (selector: string, callback: () => void) => listen(el(selector), 'click', callback)
  onClick('.mp-solo', showBriefing)
  onClick('.mp-search-cancel', cancelBriefing)
  onClick('.mp-briefing-play', () => {
    if (!practiceBriefing || practicePending || disposed || state) return
    practicePending = true
    el<HTMLButtonElement>('.mp-briefing-play').disabled = true
    el('.mp-search-message').textContent = 'Preparing your table…'
    searchPanel.setAttribute('aria-busy', 'true')
    callbacks.solo()
  })
  onClick('.mp-theme-toggle', () => {
    if (state) return
    const mode: WorldMode = shell.classList.contains('mp-mirror') ? 'NORMAL' : 'MIRROR'
    if (callbacks.previewWorld) callbacks.previewWorld(mode)
    else { presentedWorldMode = mode; renderWorldMode() }
  })
  onClick('.mp-replay', () => { setResultReady(null); callbacks.replay() })
  onClick('.mp-result-leave', requestLeave)
  onClick('.mp-exit', requestLeave)
  onClick('.mp-mute', callbacks.mute)
  onClick('.mp-help', openHelp)
  onClick('.mp-help-close', () => closeHelp())
  listen(helpDialog, 'cancel', event => { event.preventDefault(); closeHelp() })
  listen(helpDialog, 'click', ((event: MouseEvent) => {
    const bounds = helpDialog.getBoundingClientRect()
    if (event.target === helpDialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closeHelp()
  }) as EventListener)
  listen(helpDialog, 'close', () => { el('.mp-help').setAttribute('aria-expanded', String(helpDialog.open)); setActionDisabled(actionPending()) })
  onClick('.mp-confirm-stay', () => closeLeaveConfirm())
  onClick('.mp-confirm-leave', () => {
    if (!leaveConfirm.open || !state || leavePending) return
    leavePending = true
    closeLeaveConfirm(false)
    setResultReady(null)
    callbacks.leave()
  })
  listen(leaveConfirm, 'cancel', event => { event.preventDefault(); closeLeaveConfirm() })
  listen(leaveConfirm, 'keydown', ((event: KeyboardEvent) => {
    if (event.key !== 'Tab') return
    const first = el('.mp-confirm-leave'), last = el('.mp-confirm-stay')
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }) as EventListener)
  listen(leaveConfirm, 'click', ((event: MouseEvent) => {
    const bounds = leaveConfirm.getBoundingClientRect()
    if (event.target === leaveConfirm && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closeLeaveConfirm()
  }) as EventListener)

  function requestLeave() {
    if (!state || disposed || leavePending || leaveConfirm.open || helpDialog.open) return
    leaveFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    leaveConfirm.showModal()
    el('.mp-confirm-stay').focus()
  }
  function closeLeaveConfirm(restoreFocus = true) {
    const target = leaveFocus
    leaveFocus = null
    if (leaveConfirm.open) leaveConfirm.close()
    if (restoreFocus && target?.isConnected && !target.closest('[hidden]') && !target.matches(':disabled')) target.focus()
  }

  function helpAvailable() { return !!state && state.stage !== 'LOBBY' && !resultIsVisible() }
  function actionPending() { return !!state && sentKey === `${state.handId}:${state.seq}` }
  function openHelp() {
    if (!helpAvailable() || disposed || leavePending || leaveConfirm.open || helpDialog.open) return
    helpFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    renderHelpRoster()
    helpDialog.showModal()
    el('.mp-help').setAttribute('aria-expanded', 'true')
    setActionDisabled(actionPending())
    el('.mp-help-close').focus()
  }
  function closeHelp(restoreFocus = true) {
    const target = helpFocus
    helpFocus = null
    if (helpDialog.open) helpDialog.close()
    el('.mp-help').setAttribute('aria-expanded', 'false')
    setActionDisabled(actionPending())
    if (restoreFocus && target?.isConnected && !target.closest('[hidden]') && !target.matches(':disabled')) target.focus()
  }
  function syncHelpVisibility() {
    const available = helpAvailable()
    el('.mp-help').hidden = !available
    if (!available) closeHelp(false)
  }
  function renderHelpRoster() {
    const standings = el('.mp-help-standings'), roster = el('.mp-help-roster')
    const match = state?.match
    standings.hidden = !state || !(match?.format === 'fourMax' || match?.format === 'solo' || state.players.length > 2 || (match?.participantIds?.length ?? 0) > 2)
    if (!state) { helpPlayers.clear(); roster.replaceChildren(); return }
    state.players.forEach(player => helpPlayers.set(player.id, { name: profileFor(player.id, player.name).displayName, stack: player.stack, seat: player.seat }))
    if (standings.hidden) return
    const ids = new Set([...state.players.map(player => player.id), ...(match?.participantIds ?? []), ...(match?.placements.map(placement => placement.playerId) ?? [])])
    const entries = [...ids].map(id => {
      const player = state!.players.find(player => player.id === id), cached = helpPlayers.get(id)
      const placement = match?.placements.find(placement => placement.playerId === id)
      return { id, player, placement, stack: placement?.reason === 'eliminated' ? 0 : player?.stack ?? cached?.stack ?? 0, name: player?.name ?? cached?.name, seat: player?.seat ?? cached?.seat ?? 99 }
    }).sort((a, b) => Number(a.placement?.reason === 'eliminated') - Number(b.placement?.reason === 'eliminated') || b.stack - a.stack || (a.placement?.place ?? a.seat) - (b.placement?.place ?? b.seat) || a.id.localeCompare(b.id))
    roster.replaceChildren()
    entries.forEach((entry, index) => {
      const row = document.createElement('article'), place = document.createElement('span'), name = document.createElement('span'), stack = document.createElement('strong'), status = document.createElement('span')
      const position = entry.placement?.place ?? index + 1
      row.className = 'mp-help-player'; row.dataset.playerId = entry.id; row.setAttribute('role', 'listitem')
      row.classList.toggle('is-winning-place', position === 1)
      row.classList.toggle('is-out', entry.placement?.reason === 'eliminated')
      place.className = 'mp-help-place'; place.textContent = String(position); place.setAttribute('aria-label', `Place ${position}`)
      name.className = 'mp-help-player-name'; showName(name, profileFor(entry.id, entry.name))
      stack.className = 'mp-help-stack'; stack.textContent = amountText(entry.stack); stack.setAttribute('aria-label', `${amountText(entry.stack)} chips`)
      status.className = 'mp-help-status'; status.textContent = entry.placement?.reason === 'eliminated' ? 'OUT' : entry.placement?.reason === 'winner' ? 'WINNER' : entry.player?.allIn ? 'IN · ALL IN' : 'IN'
      row.append(place, name, stack, status); roster.appendChild(row)
    })
  }

  // Profile values remain text. The bounded full name is available to assistive
  // technology and the title even where the visual label needs an ellipsis.
  const profileName = (value: string | undefined, fallback = 'Player') => Array.from(value?.trim() || fallback).slice(0, 160).join('')
  function profileFor(playerId: string, fallback?: string): UIProfile {
    const profile = state?.profiles?.[playerId]
    return profile?.playerId === playerId ? { ...profile, displayName: profileName(profile.displayName, fallback) }
      : { playerId, displayName: profileName(fallback), avatarUrl: null }
  }
  function showName(node: HTMLElement, profile: UIProfile) {
    const name = profileName(profile.displayName)
    if (node.textContent !== name) node.textContent = name
    node.title = name; node.setAttribute('aria-label', name)
  }
  function clearAvatar(holder: HTMLElement) {
    const previous = avatarBindings.get(holder)
    if (previous?.image) { previous.image.onload = null; previous.image.onerror = null; previous.image.remove() }
    avatarBindings.delete(holder)
  }
  function showAvatar(holder: HTMLElement, profile: UIProfile) {
    // Only browser image loading handles hosted avatar URLs, including SVG. No
    // fetched SVG markup is inserted into the page or sent through a 3D loader.
    const url = typeof profile.avatarUrl === 'string' && profile.avatarUrl.length <= 8192 ? profile.avatarUrl : null
    const key = JSON.stringify([profile.playerId, url])
    if (avatarBindings.get(holder)?.key === key) return
    clearAvatar(holder)
    const binding = { key, image: null as HTMLImageElement | null }
    avatarBindings.set(holder, binding)
    holder.dataset.avatarState = url ? 'loading' : 'fallback'
    holder.dataset.playerId = profile.playerId
    if (!url) return
    const image = document.createElement('img')
    binding.image = image
    image.alt = ''; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'; image.hidden = true
    image.onload = () => {
      if (disposed || avatarBindings.get(holder) !== binding) return
      holder.dataset.avatarState = 'loaded'; image.hidden = false
    }
    image.onerror = () => {
      if (disposed || avatarBindings.get(holder) !== binding) return
      holder.dataset.avatarState = 'error'; image.hidden = true
    }
    holder.appendChild(image)
    image.src = url
  }
  function updateMenuVisibility() {
    const atMenu = !state, searching = atMenu && practiceBriefing
    menu.hidden = !atMenu || searching
    el('.mp-menu-brand').hidden = !atMenu || searching
    searchPanel.hidden = !searching
    el('.mp-theme-toggle').hidden = !atMenu
    shell.classList.toggle('mp-briefing-open', searching)
    if (searching !== briefingVisible) {
      briefingVisible = searching
      if (searching) {
        briefingFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
        const initial = practiceBriefing ? el('.mp-briefing-play') : searchPanel
        initial.focus({ preventScroll: true })
      } else {
        const previous = briefingFocus
        briefingFocus = null
        if (atMenu && previous?.isConnected && !previous.closest('[hidden]') && !previous.matches(':disabled')) previous.focus({ preventScroll: true })
      }
    }
  }
  function cancelBriefing() {
    if (practicePending) return
    practiceBriefing = false
    updateMenuVisibility()
  }
  function showBriefing() {
    if (state || disposed) return
    practiceBriefing = true; practicePending = false
    searchPanel.setAttribute('aria-busy', 'false')
    el('.mp-search h2').textContent = 'One table. Two worlds.'
    el('.mp-search-format').textContent = 'SOLO · YOU + THREE BOTS'
    el('.mp-search-message').textContent = 'Play a complete tournament against three bots.'
    el('.mp-search-count').hidden = true
    el('.mp-search-players').replaceChildren()
    const play = el<HTMLButtonElement>('.mp-briefing-play')
    play.firstChild!.textContent = 'PLAY '
    play.hidden = false; play.disabled = false
    el('.mp-search-cancel').firstChild!.textContent = 'MAIN MENU '
    updateMenuVisibility()
  }

  function isTurn() {
    return !!state && !!self && self.handId === state.handId && state.actorId === self.playerId && !['LOBBY', 'INTERMISSION', 'SHOWDOWN', 'COMPLETE'].includes(state.stage) && !ownPlacement()
  }
  function ownPlacement() { return self && state?.match?.placements.find(p => p.playerId === self!.playerId) }
  function resultIsVisible() { return !!state && state.handId === resultReadyHandId && !!ownPlacement() }
  function setResultReady(handId: string | null) {
    // Ignore a delayed callback from an earlier hand rather than closing a newer result.
    if (handId !== null && handId !== state?.handId) return
    if (resultReadyHandId === handId) return
    resultReadyHandId = handId
    result.hidden = !resultIsVisible()
    bottom.hidden = !state || state.stage === 'LOBBY' || !result.hidden
    syncHelpVisibility()
    renderClocks()
    layout()
  }
  const bettingStages = ['PREFLOP', 'FLOP', 'TURN', 'RIVER']
  const clockText = (remainingMs: number) => {
    const seconds = Math.max(0, Math.ceil(remainingMs / 1000))
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  }
  function textIfChanged(node: Element, text: string) { if (node.textContent !== text) node.textContent = text }
  function showTurnCaption(text: string) {
    textIfChanged(turnCaption, text)
    turnCaption.title = text
    turnCaption.setAttribute('aria-label', text)
  }
  function syncClocks() {
    const now = performance.now()
    if (!state || state.stage === 'LOBBY') { turnTiming = null; levelTiming = null }
    const timer = state?.turnTimer
    if (state && timer && timer.playerId === state.actorId && Number.isFinite(timer.durationMs) && timer.durationMs > 0 && Number.isFinite(timer.remainingMs)) {
      const turnId = `${state.handId}:${timer.turnId}`
      const deadline = now + Math.max(0, Math.min(timer.durationMs, timer.remainingMs))
      // A delayed/resync snapshot can shorten a turn, but cannot give time back.
      if (turnTiming?.turnId === turnId) turnTiming.deadline = Math.min(turnTiming.deadline, deadline)
      else turnTiming = { turnId, playerId: timer.playerId, durationMs: timer.durationMs, deadline }
    }
    const level = state?.tournament
    if (level && Number.isFinite(level.remainingMs)) {
      const deadline = now + Math.max(0, level.remainingMs)
      if (levelTiming?.level === level.level) levelTiming.deadline = Math.min(levelTiming.deadline, deadline)
      else levelTiming = { level: level.level, deadline }
    }
    renderClocks(now)
    if (!clockFrame && !disposed && (timer || level)) clockFrame = requestAnimationFrame(animateClocks)
  }
  function renderClocks(now = performance.now()) {
    const timer = state?.turnTimer
    const visible = !!state && !!timer && !!turnTiming && turnTiming.turnId === `${state.handId}:${timer.turnId}` &&
      timer.playerId === state.actorId && bettingStages.includes(state.stage) && state.match?.status !== 'FINISHED' && !resultIsVisible()
    const remaining = visible ? Math.max(0, turnTiming!.deadline - now) : 0
    const seconds = Math.ceil(remaining / 1000), urgent = visible && remaining <= 5000
    const reduced = visible && turnTiming!.durationMs === 10000
    seats.forEach((seat, index) => {
      const active = visible && state!.players.some(player => player.seat === index && player.id === turnTiming!.playerId && !player.folded && !player.allIn)
      const clock = seat.querySelector<HTMLOutputElement>('.mp-seat-clock')!
      const track = seat.querySelector<HTMLElement>('.mp-seat-time-track')!
      clock.hidden = track.hidden = !active
      seat.querySelector<HTMLElement>('.mp-seat-status')!.hidden = active
      seat.classList.toggle('is-time-urgent', active && urgent)
      if (!active) return
      textIfChanged(clock, `${reduced ? 'AFK' : 'MOVE'} · ${seconds}s`)
      clock.title = reduced ? '10-second AFK mode after two timeouts. Make a move to restore 30 seconds on your next turn.' : 'The turn expires with an automatic fold.'
      clock.setAttribute('aria-label', `${seconds} seconds remaining${reduced ? ', 10-second AFK mode' : ''}`)
      track.querySelector<HTMLElement>('i')!.style.transform = `scaleX(${Math.max(0, Math.min(1, remaining / turnTiming!.durationMs))})`
    })
    turnClock.hidden = !visible || !isTurn()
    turnClock.classList.toggle('is-time-urgent', urgent)
    if (!turnClock.hidden) {
      textIfChanged(turnClock.querySelector('strong')!, `${seconds}s`)
      textIfChanged(turnClock.querySelector('span')!, reduced ? 'AFK MODE · ACT TO RESTORE 30s' : 'AUTO-FOLD AT 0')
      turnClock.setAttribute('aria-label', `${seconds} seconds remaining. ${reduced ? '10-second AFK mode. Make a move to restore 30 seconds on your next turn.' : 'Automatic fold when time expires.'}`)
    }
    const level = state?.tournament
    tournament.hidden = !state || !level || state.stage === 'LOBBY' || state.match?.status === 'FINISHED' || resultIsVisible()
    if (!tournament.hidden && level) {
      textIfChanged(tournament.querySelector('strong')!, `TURBO · L${level.level} · ${amountText(state!.smallBlind)}/${amountText(state!.bigBlind)}`)
      textIfChanged(tournament.querySelector('span')!, level.nextSmallBlind !== null && level.nextBigBlind !== null ? `NEXT ${amountText(level.nextSmallBlind)}/${amountText(level.nextBigBlind)} IN ${clockText(Math.max(0, (levelTiming?.deadline ?? now) - now))}` : 'FINAL BLIND LEVEL')
      tournament.title = 'Blind increases apply to the next hand.'
    }
  }
  function animateClocks(now: number) {
    clockFrame = 0
    if (disposed) return
    if (now - lastClockFrame >= 90) { lastClockFrame = now; renderClocks(now) }
    if (state?.turnTimer || state?.tournament) clockFrame = requestAnimationFrame(animateClocks)
  }
  function canSelectWager() { return !!wager && isTurn() && !helpDialog.open }
  function clampWager(value: number) { return Math.max(wagerMin, Math.min(wagerMax, Math.round(Number.isFinite(value) ? value : wagerMin))) }
  function selectedAllIn() { return legal.some(a => a.type === 'allIn') && Number(number.value) === allInTotal }
  function setWager(value: number) {
    const amount = clampWager(value)
    number.value = slider.value = String(amount)
    slider.style.setProperty('--range-fill', `${wagerMax > wagerMin ? (amount - wagerMin) / (wagerMax - wagerMin) * 100 : 100}%`)
    const button = actions.querySelector<HTMLButtonElement>('[data-wager]')
    if (button) {
      const label = button.querySelector('span')!
      label.textContent = `${(wager?.type || (state?.currentBet ? 'raise' : 'bet')) === 'bet' ? 'BET' : 'RAISE TO'}${wager ? ` ${amountText(amount)}` : ''}`
      button.classList.toggle('is-all-in', selectedAllIn())
      button.title = selectedAllIn() ? 'Confirm all-in' : 'Confirm selected bet'
    }
    el<HTMLButtonElement>('[data-preset="allin"]').classList.toggle('is-selected', !!wager && selectedAllIn())
  }
  listen(slider, 'input', () => { if (!helpDialog.open) setWager(Number(slider.value)) })
  listen(number, 'change', () => { if (!helpDialog.open) setWager(Number(number.value)) })
  listen(number, 'keydown', ((event: KeyboardEvent) => { if (event.key === 'Enter') { event.preventDefault(); dispatchWager() } }) as EventListener)
  onClick('[data-preset="half"]', () => selectPot(.5))
  onClick('[data-preset="threequarters"]', () => selectPot(.75))
  onClick('[data-preset="allin"]', () => { if (canSelectWager() && legal.some(a => a.type === 'allIn')) setWager(allInTotal) })
  function selectPot(fraction: number) {
    if (!canSelectWager() || !state || !self) return
    const ownBet = state.players.find(p => p.id === self!.playerId)?.bet || 0
    const call = Math.max(0, state.currentBet - ownBet)
    // The raise total includes the call, then a fraction of the pot after calling.
    setWager(state.currentBet + Math.round((state.pot + call) * fraction))
  }
  function dispatchWager() {
    if (helpDialog.open || leaveConfirm.open || leavePending || !canSelectWager() || !wager) return
    setWager(Number(number.value))
    if (selectedAllIn()) dispatch('allIn')
    else dispatch(wager.type)
  }
  function dispatch(type: ActionType) {
    if (helpDialog.open || leaveConfirm.open || leavePending || !isTurn() || !state || !legal.some(a => a.type === type)) return
    const key = `${state.handId}:${state.seq}`
    if (sentKey === key) return
    const action: PokerAction = { type }
    if (type === 'bet' || type === 'raise') action.amount = clampWager(Number(number.value))
    sentKey = key
    setActionDisabled(true)
    showTurnCaption('ACTION SENT · WAITING FOR THE TABLE')
    callbacks.act(action)
  }
  function setActionDisabled(sent: boolean) {
    actions.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = helpDialog.open || sent || button.dataset.permitted !== 'true' })
    slider.disabled = number.disabled = sent || !canSelectWager()
    el<HTMLButtonElement>('[data-preset="half"]').disabled = sent || !canSelectWager()
    el<HTMLButtonElement>('[data-preset="threequarters"]').disabled = sent || !canSelectWager()
    el<HTMLButtonElement>('[data-preset="allin"]').disabled = sent || !canSelectWager() || !legal.some(a => a.type === 'allIn')
  }
  function buildActions() {
    actions.replaceChildren()
    const own = state?.players.find(p => p.id === self?.playerId)
    allInTotal = (own?.bet || 0) + (own?.stack || 0)
    const directWager = legal.find(a => a.type === 'raise' || a.type === 'bet')
    const shortAllInRaise = !directWager && legal.some(a => a.type === 'allIn') && allInTotal > (state?.currentBet || 0)
    wager = directWager || (shortAllInRaise ? { type: state?.currentBet ? 'raise' : 'bet', min: allInTotal, max: allInTotal } : undefined)
    wagerMin = Math.ceil(wager?.min ?? 0)
    wagerMax = Math.floor(wager?.max ?? wagerMin)
    if (wager && legal.some(a => a.type === 'allIn') && allInTotal > (state?.currentBet || 0)) wagerMax = Math.max(wagerMax, allInTotal)
    const check = legal.find(a => a.type === 'check')
    const call = legal.find(a => a.type === 'call')
    const onlyAllInCall = !check && !call && legal.some(a => a.type === 'allIn') && allInTotal <= (state?.currentBet || 0)
    const callType: ActionType = check ? 'check' : call ? 'call' : onlyAllInCall ? 'allIn' : 'check'
    const callAmount = call?.amount ?? (onlyAllInCall ? own?.stack ?? 0 : 0)
    const options = [
      { type: 'fold' as ActionType, label: 'FOLD', allowed: legal.some(a => a.type === 'fold'), run: () => dispatch('fold') },
      { type: callType, label: check || (!call && !onlyAllInCall) ? 'CHECK' : `CALL ${amountText(callAmount)}`, allowed: !!check || !!call || onlyAllInCall, run: () => dispatch(callType) },
      { type: wager?.type || 'raise', label: state?.currentBet ? 'RAISE TO' : 'BET', allowed: !!wager, run: dispatchWager },
    ]
    options.forEach((option, i) => {
      const button = document.createElement('button')
      button.type = 'button'; button.className = `mp-action mp-action-${i === 2 ? wager?.type || (state?.currentBet ? 'raise' : 'bet') : i === 0 ? 'fold' : callType === 'check' ? 'check' : 'call'}${i === 2 ? ' mp-action-wager' : ''}`
      button.dataset.action = option.type
      button.dataset.permitted = String(option.allowed)
      if (i === 2) button.dataset.wager = 'true'
      const label = document.createElement('span')
      label.textContent = option.label
      button.appendChild(label); button.addEventListener('click', option.run); actions.appendChild(button)
    })
    slider.min = number.min = String(wagerMin); slider.max = number.max = String(wagerMax)
    el('.mp-bet-control label').textContent = wager?.type === 'bet' ? 'BET TO' : 'RAISE TO'
    el('.mp-bet-range').textContent = wager ? `${amountText(wagerMin)} — ${amountText(wagerMax)}` : 'WAITING FOR YOUR TURN'
    setWager(wagerMin)
    setActionDisabled(false)
  }
  function renderLastHand() {
    const previous = state?.previousHand || (state?.stage === 'COMPLETE' && state.winners.length ? {
      handId: state.handId, worldMode: state.worldMode,
      winners: state.winners.map(winner => ({ ...winner, playerName: state!.players.find(p => p.id === winner.playerId)?.name || 'Player' })),
    } : undefined)
    lastHand.hidden = !previous?.winners.length || !state || state.stage === 'LOBBY'
    const signature = previous ? JSON.stringify([previous, previous.winners.map(winner => profileFor(winner.playerId, winner.playerName).displayName)]) : ''
    if (signature === lastResultSignature) return
    lastResultSignature = signature
    lastWinners.replaceChildren()
    if (!previous) { delete lastHand.dataset.handId; return }
    lastHand.dataset.handId = previous.handId
    const uniqueResults = new Set<string>()
    previous.winners.forEach((winner: Winner & { playerName: string }) => {
      // Only publicly awarded best-five cards may be displayed. An uncontested
      // hand stays private even if a malformed payload includes a card array.
      const cards = winner.handName !== 'UNCONTESTED' && winner.cards?.length === 5 &&
        new Set(winner.cards).size === 5 && winner.cards.every((card: Card) => /^[2-9TJQKA][cdhs]$/.test(card)) ? winner.cards : []
      const key = `${winner.playerId}:${winner.handName}:${[...cards].sort().join(',')}`
      if (uniqueResults.has(key)) return
      uniqueResults.add(key)
      const entry = document.createElement('article'), heading = document.createElement('div')
      entry.className = 'mp-last-winner'; entry.dataset.playerId = winner.playerId
      heading.className = 'mp-last-winner-label'
      const name = document.createElement('span'), separator = document.createElement('span')
      name.className = 'mp-last-winner-name'; showName(name, profileFor(winner.playerId, winner.playerName))
      separator.className = 'mp-last-separator'; separator.textContent = '—'
      heading.append(name, separator); entry.appendChild(heading)
      if (cards.length) {
        const hand = document.createElement('div')
        hand.className = 'mp-last-cards'; hand.setAttribute('aria-label', 'Winning five cards')
        cards.forEach((card: Card) => {
          const face = document.createElement('span')
          const appearance = CARD_SUITS[card[1] as keyof typeof CARD_SUITS]
          face.className = 'mp-last-card'
          face.style.color = appearance.color
          face.dataset.card = card; face.dataset.suit = card[1]
          face.setAttribute('role', 'img')
          face.setAttribute('aria-label', `${card[0] === 'T' ? '10' : card[0]}${appearance.symbol}`)
          face.innerHTML = cardCompactSvg(card)
          face.querySelector('svg')?.setAttribute('aria-hidden', 'true')
          hand.appendChild(face)
        })
        entry.appendChild(hand)
      }
      const detail = document.createElement('small')
      detail.className = 'mp-last-hand-name'
      detail.textContent = cards.length ? handText(winner.handName) : winner.handName === 'UNCONTESTED' ? 'Uncontested' : 'Cards not revealed'
      entry.appendChild(detail); lastWinners.appendChild(entry)
    })
  }
  function renderBets() {
    betAmounts.forEach(label => { label.hidden = true; label.textContent = ''; label.removeAttribute('aria-label'); delete label.dataset.playerId })
    if (!state || !['PREFLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN'].includes(state.stage)) return
    state.players.forEach(player => {
      const label = betAmounts[player.seat]
      if (!label || player.sittingOut || !Number.isSafeInteger(player.bet) || player.bet <= 0 || state!.match?.placements.some(p => p.playerId === player.id && p.reason === 'eliminated')) return
      label.textContent = amountText(player.bet)
      label.dataset.playerId = player.id
      label.setAttribute('aria-label', `${profileFor(player.id, player.name).displayName}: bet ${amountText(player.bet)}`)
      label.hidden = false
    })
  }
  function layout() {
    const width = shell.clientWidth || window.innerWidth, height = shell.clientHeight || window.innerHeight
    const compact = width <= 1024 && height <= 600
    // Reparent the one authoritative history view; resizing never duplicates or
    // freezes its public winners, cards or identity updates.
    const historyParent = compact ? helpHistory : sideStack
    if (lastHand.parentElement !== historyParent) historyParent.appendChild(lastHand)
    helpHistory.hidden = !compact || lastHand.hidden
    const barTop = bottom.hidden ? height - 25 : bottom.offsetTop
    const shellBounds = shell.getBoundingClientRect()
    const headerObstacles = compact ? [el('.mp-help'), el('.mp-utilities')].filter(node => node.getClientRects().length > 0).map(node => {
      const bounds = node.getBoundingClientRect()
      return { left: bounds.left - shellBounds.left, right: bounds.right - shellBounds.left, top: bounds.top - shellBounds.top, bottom: bounds.bottom - shellBounds.top }
    }) : []
    seatPositions.forEach(p => {
      const seat = seats[p.seat]
      if (!seat || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return
      const halfWidth = (seat.offsetWidth || (width <= 1000 ? 140 : 156)) / 2
      const halfHeight = (seat.offsetHeight || 62) / 2
      let x = Math.max(halfWidth + 10, Math.min(width - halfWidth - 10, p.x * width))
      // The scene owns the seat anchors. Short landscape screens need only a
      // small top inset; the old 100 px reserve squeezed all seats downward.
      const topInset = compact ? 8 : 100
      let y = Math.max(topInset + halfHeight, Math.min(barTop - halfHeight - (compact ? 6 : 10), p.y * height))
      // Phone edge seats avoid the left guide and right audio/exit controls.
      // Every pass starts from the projection, so these small nudges never accumulate.
      if (!seat.hidden) headerObstacles.forEach(obstacle => {
        if (x + halfWidth <= obstacle.left - 6 || x - halfWidth >= obstacle.right + 6 || y - halfHeight >= obstacle.bottom + 6 || y + halfHeight <= obstacle.top - 6) return
        if (obstacle.right <= width / 2) {
          const beside = obstacle.right + halfWidth + 8
          if (beside + halfWidth <= width / 2 - 6) x = Math.max(x, beside)
          else y = Math.max(y, obstacle.bottom + halfHeight + 6)
        } else {
          const beside = obstacle.left - halfWidth - 8
          if (beside - halfWidth >= width / 2 + 6) x = Math.min(x, beside)
          else y = Math.max(y, obstacle.bottom + halfHeight + 6)
        }
      })
      seat.style.left = `${x}px`; seat.style.top = `${y}px`
    })
    // The utility row can be wider than Last Hand. Reserve the actual history
    // column beside a seat before considering vertical scrolling.
    let sideHeight = height - 150
    sideStack.style.setProperty('--sidebar-height', `${Math.max(0, sideHeight)}px`)
    lastHand.style.removeProperty('width')
    if (!lastHand.hidden && !compact) {
      const natural = lastHand.getBoundingClientRect(), style = getComputedStyle(lastHand)
      const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
      const cardWidth = Math.max(0, ...Array.from(lastWinners.querySelectorAll<HTMLElement>('.mp-last-cards')).map(row => {
        const cards = Array.from(row.children) as HTMLElement[]
        return cards.reduce((sum, card) => sum + card.offsetWidth, 0) + Math.max(0, cards.length - 1) * (parseFloat(getComputedStyle(row).columnGap) || 0)
      }))
      const minimumWidth = Math.max(110, cardWidth) + padding
      let availableWidth = natural.width
      const occupied = seats.filter(seat => !seat.hidden).map(node => ({ node, rect: node.getBoundingClientRect() }))
      for (const entry of occupied) {
        let { rect } = entry
        if (rect.left < width / 2 || rect.top >= natural.bottom || rect.bottom <= natural.top) continue
        let besideSeat = natural.right - rect.right - 10
        if (lastWinners.childElementCount > 0 && besideSeat < minimumWidth && entry.node.classList.contains('mp-seat-2')) {
          // Keep cards or an uncontested result readable beside a long far-seat
          // nickname. Move only its HUD from the fresh projected position.
          const shift = Math.ceil(minimumWidth - besideSeat)
          if (rect.left - shift >= width / 2 + 10) {
            entry.node.style.left = `${parseFloat(entry.node.style.left) - shift}px`
            rect = entry.node.getBoundingClientRect(); entry.rect = rect
            besideSeat = natural.right - rect.right - 10
          }
        }
        if (besideSeat >= minimumWidth) availableWidth = Math.min(availableWidth, besideSeat)
      }
      lastHand.style.width = `${availableWidth}px`
      const column = lastHand.getBoundingClientRect(), sideRect = sideStack.getBoundingClientRect()
      for (const { rect } of occupied) {
        if (rect.left < column.right && rect.right > column.left && rect.top > sideRect.top) sideHeight = Math.min(sideHeight, rect.top - sideRect.top - 12)
      }
    }
    sideStack.style.setProperty('--sidebar-height', `${Math.max(0, sideHeight)}px`)
    pot.style.left = `${Math.max(.2, Math.min(.8, potPosition.x)) * 100}%`
    pot.style.top = `${Math.max(.22, Math.min(.7, potPosition.y)) * 100}%`
    betPositions.forEach(p => {
      const label = betAmounts[p.seat]
      if (!label || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return
      const halfWidth = (label.offsetWidth || 40) / 2
      const x = Math.max(halfWidth + 6, Math.min(width - halfWidth - 6, p.x * width))
      const y = Math.max(35, Math.min(barTop - 10, p.y * height))
      label.style.left = `${x}px`; label.style.top = `${y}px`
    })
  }
  function renderWorldMode() {
    const mode = presentedWorldMode ?? state?.worldMode
    shell.classList.toggle('mp-mirror', mode === 'MIRROR')
    const themeToggle = el('.mp-theme-toggle')
    themeToggle.setAttribute('aria-checked', String(mode === 'MIRROR'))
    themeToggle.title = mode === 'MIRROR' ? 'MIRROR world · switch to HOLDEM' : 'HOLDEM world · switch to MIRROR'
    shell.querySelectorAll<HTMLElement>('.mp-help-world').forEach(card => card.classList.toggle('is-current-world', card.dataset.world === mode))
  }
  function update(next: PublicState | null, personal: PrivateState | null) {
    if (!next) { closeLeaveConfirm(false); leavePending = false }
    if (!next || state?.handId !== next.handId) resultReadyHandId = null
    state = next; self = personal
    if (next) { practiceBriefing = false; practicePending = false; searchPanel.setAttribute('aria-busy', 'false') }
    const atMenu = !state, atLobby = state?.stage === 'LOBBY'
    updateMenuVisibility(); lobby.hidden = !atLobby
    el('.mp-exit').hidden = atMenu; pot.hidden = atMenu || !!atLobby
    lastHand.hidden = atMenu || !!atLobby
    shell.classList.toggle('mp-in-menu', atMenu); shell.classList.toggle('mp-in-lobby', !!atLobby)
    renderWorldMode()
    result.hidden = !resultIsVisible()
    syncHelpVisibility()
    bottom.hidden = atMenu || !!atLobby || !result.hidden
    renderBets()
    if (!state) {
      renderHelpRoster()
      lastResultSignature = ''; lastWinners.replaceChildren(); delete lastHand.dataset.handId
      seats.forEach(seat => { seat.hidden = true; clearAvatar(seat.querySelector<HTMLElement>('.mp-seat-avatar')!) })
      legal = []; wager = undefined; actionSignature = ''; sentKey = ''; syncClocks(); return
    }
    const isPreparing = state.stage === 'INTERMISSION'
    el('.mp-pot strong').textContent = amountText(state.pot)
    seats.forEach((seat, index) => {
      const player = state!.players.find(p => p.seat === index)
      const eliminated = player && state!.match?.placements.some(p => p.playerId === player.id && p.reason === 'eliminated')
      seat.hidden = !player || !!atLobby || !!eliminated
      if (!player) { clearAvatar(seat.querySelector<HTMLElement>('.mp-seat-avatar')!); delete seat.dataset.playerId; return }
      const own = player.id === self?.playerId, active = player.id === state!.actorId
      const profile = profileFor(player.id, player.name)
      seat.dataset.playerId = player.id
      const winner = state!.winners.some(w => w.playerId === player.id)
      seat.classList.toggle('is-self', own); seat.classList.toggle('is-active', active)
      seat.classList.toggle('is-folded', player.folded); seat.classList.toggle('is-winner', winner)
      seat.classList.toggle('is-sitting-out', !!player.sittingOut || !!eliminated)
      showName(seat.querySelector<HTMLElement>('.mp-seat-name')!, profile)
      showAvatar(seat.querySelector<HTMLElement>('.mp-seat-avatar')!, profile)
      const stack = seat.querySelector<HTMLElement>('.mp-seat-stack')!, stackText = amountText(player.stack)
      stack.textContent = stackText
      stack.style.setProperty('--stack-scale', String(Math.min(1, 7 / stackText.length)))
      seat.querySelector('.mp-seat-status')!.textContent = eliminated ? 'ELIMINATED' : !player.connected ? 'DISCONNECTED' : player.sittingOut ? 'NEXT HAND' : player.folded ? 'FOLDED' : player.allIn ? 'ALL IN' : active ? 'THINKING' : ''
    })
    renderLastHand()
    renderHelpRoster()
    const placement = ownPlacement()
    if (placement) {
      const champion = placement.place === 1
      result.classList.toggle('is-champion', champion)
      el('.mp-result-medallion > span').textContent = String(placement.place)
      el('.mp-result-kicker').textContent = champion ? 'TABLE CHAMPION' : 'MATCH COMPLETE'
      el('.mp-result-rating').textContent = 'SOLO · YOU + THREE BOTS'
      el('.mp-result-card h2').textContent = `You placed #${placement.place}`
      el('.mp-result-description').textContent = champion ? 'Congratulations on your victory!\nYou conquered the table in both worlds.' : 'Thanks for playing.\nA new table is another chance to win.'
      const resultPlayer = el('.mp-result-player')
      const profile = profileFor(placement.playerId, state.players.find(player => player.id === placement.playerId)?.name)
      resultPlayer.hidden = false; resultPlayer.dataset.playerId = placement.playerId
      showName(resultPlayer.querySelector<HTMLElement>('span')!, profile)
      showAvatar(resultPlayer.querySelector<HTMLElement>('.mp-profile-avatar')!, profile)
      el('.mp-replay').firstChild!.textContent = 'Play Again '
    }
    legal = isTurn() ? personal!.legalActions : []
    const signature = `${state.handId}:${state.seq}:${state.turnTimer?.turnId || ''}:${JSON.stringify(legal)}`
    if (signature !== actionSignature) { actionSignature = signature; sentKey = ''; buildActions() }
    const actor = state.players.find(p => p.id === state!.actorId)
    const caption = state.match?.status === 'FINISHED' ? 'FINAL HAND · SHOWDOWN' : sentKey === `${state.handId}:${state.seq}` ? 'ACTION SENT · WAITING FOR THE TABLE' : isTurn() ? 'YOUR MOVE' : isPreparing ? 'DEALER IS PREPARING THE NEXT HAND' : state.stage === 'COMPLETE' ? 'NEXT HAND STARTS AUTOMATICALLY' : state.stage === 'SHOWDOWN' ? 'SHOWDOWN' : actor ? `${profileFor(actor.id, actor.name).displayName.toUpperCase()} IS THINKING` : 'WAITING FOR THE TABLE'
    showTurnCaption(caption)
    turnCaption.classList.toggle('is-your-turn', isTurn())
    syncClocks()
    layout()
  }

  listen(window, 'resize', layout)
  listen(window, 'keydown', ((event: KeyboardEvent) => {
    if (!briefingVisible || leaveConfirm.open || helpDialog.open) return
    if (event.key === 'Escape') { event.preventDefault(); cancelBriefing(); return }
    if (event.key !== 'Tab') return
    const focusable = Array.from(shell.querySelectorAll<HTMLButtonElement>('.mp-utilities button, .mp-search button')).filter(button => !button.disabled && !button.closest('[hidden]'))
    if (!focusable.length) { event.preventDefault(); searchPanel.focus(); return }
    const current = focusable.indexOf(document.activeElement as HTMLButtonElement)
    if (current === -1 || (event.shiftKey && current === 0) || (!event.shiftKey && current === focusable.length - 1)) {
      event.preventDefault(); focusable[event.shiftKey ? focusable.length - 1 : 0].focus()
    }
  }) as EventListener)
  update(null, null)

  function setSeatPositions(positions: SeatPosition[]) { seatPositions = positions; layout() }
  function setBetPositions(positions: SeatPosition[]) { betPositions = positions; layout() }
  function setPotPosition(position: ScreenPoint) { if (Number.isFinite(position.x) && Number.isFinite(position.y)) { potPosition = position; layout() } }
  return {
    update,
    showBriefing,
    event(event) {
      if (!state || event.handId !== state.handId) return
      if (event.type === 'PAYOUT') { renderLastHand(); layout(); return }
    },
    setConnection(label) {
      el('.mp-connection > span').textContent = label
      el('.mp-connection').classList.toggle('is-connected', /solo|ready/i.test(label) && !/disconnected|connecting|unconfirmed/i.test(label))
    },
    setError(message) {
      const toast = el('.mp-toast')
      if (toastTimeout) clearTimeout(toastTimeout)
      toast.textContent = message; toast.hidden = !message; sentKey = ''; setActionDisabled(false)
      if (message) toastTimeout = setTimeout(() => { toast.hidden = true }, 6000)
    },
    setMuted(muted) {
      const button = el<HTMLButtonElement>('.mp-mute')
      button.textContent = muted ? '×♪' : '♪'; button.title = muted ? 'Unmute audio' : 'Mute audio'
      button.setAttribute('aria-label', button.title); button.setAttribute('aria-pressed', String(muted))
    },
    setWorldMode(mode) {
      if (presentedWorldMode === mode) return
      presentedWorldMode = mode; renderWorldMode(); layout()
    },
    setResultReady,
    setSeatPositions,
    setBetPositions,
    setPotPosition,
    setTablePositions(positions) { seatPositions = positions.seats; if (positions.bets) betPositions = positions.bets; setPotPosition(positions.pot) },
    dispose() {
      disposed = true
      closeHelp(false)
      closeLeaveConfirm(false)
      if (clockFrame) cancelAnimationFrame(clockFrame)
      if (toastTimeout) clearTimeout(toastTimeout)
      for (const holder of avatarBindings.keys()) clearAvatar(holder)
      listeners.forEach(dispose => dispose()); shell.remove()
    },
  }
}

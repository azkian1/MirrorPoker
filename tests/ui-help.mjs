// Local Chromium fixtures; no hosted hosted runtime claim.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const ts = createRequire(import.meta.url)('typescript')
const sources = ['ui/index.ts', 'shared/assets.ts', 'shared/poker-mark.ts', 'shared/card-art.ts']
const modules = new Map(await Promise.all(sources.map(async file => [file, ts.transpileModule(await fs.readFile(path.join(root, file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText])))
const css = await fs.readFile(path.join(root, 'ui/style.css'), 'utf8')
const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#hud{position:absolute;inset:0;margin:0}body{background:#20392a}${css}</style></head><body><div id="hud"></div><script>
window.clockNow=1000;window.frames=new Map();window.nextFrame=0;
performance.now=()=>clockNow;
window.requestAnimationFrame=callback=>{frames.set(++nextFrame,callback);return nextFrame};
window.cancelAnimationFrame=id=>frames.delete(id);
window.advanceClock=ms=>{clockNow+=ms;const pending=[...frames.values()];frames.clear();pending.forEach(callback=>callback(clockNow))};
</script><script type="module">${modules.get('ui/index.ts')}
window.actions=[];window.testUI=createUI(document.querySelector('#hud'),{solo(){},multiplayer(){},invite(){},start(){},next(){},replay(){},act(action){actions.push(action)},leave(){},mute(){}});</script></body></html>`
const { chromium } = await import('@playwright/test')
let executablePath = process.env.MIRROR_CHROMIUM

const output = path.join(root, '.local-check/ui-help')
await fs.mkdir(output, { recursive: true })
const browser = await chromium.launch({channel:"chromium", headless: true, ...(executablePath ? { executablePath } : {}) })
const errors = [], checks = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('http://mirror-ui.local/**', route => {
    const file = new URL(route.request().url()).pathname.slice(1)
    return route.fulfill(file ? { contentType: 'text/javascript', body: modules.get(file) || '' } : { contentType: 'text/html', body: html })
  })
  await page.goto('http://mirror-ui.local/')
  await page.waitForFunction(() => !!window.testUI)
  const players = ['You', 'Vesper', 'Onyx', 'Scarlet'].map((name, seat) => ({ id: `p${seat}`, name, seat, stack: [1000, 1800, 0, 0][seat], bet: 20, totalBet: 20, folded: false, allIn: seat === 2, connected: true, isBot: seat > 0 }))
  const base = { handId: 'hand-help', seq: 10, stage: 'PREFLOP', worldMode: 'NORMAL', players, board: [], pot: 1200, actorId: 'p0', dealerSeat: 1, smallBlind: 10, bigBlind: 20, currentBet: 20, minRaise: 20, winners: [], profiles: { p3: { playerId: 'p3', displayName: '<img src=x onerror=alert(1)>', avatarUrl: null } }, match: { format: 'solo', status: 'PLAYING', placements: [{ playerId: 'p3', place: 4, reason: 'eliminated' }], winnerId: null, participantIds: ['p0', 'p1', 'p2', 'p3'] }, turnTimer: { turnId: 'turn-help', playerId: 'p0', durationMs: 30000, remainingMs: 30000 }, tournament: { level: 1, levelDurationMs: 180000, remainingMs: 180000, nextSmallBlind: 15, nextBigBlind: 30 }, previousHand: { handId: 'previous', worldMode: 'NORMAL', winners: [{ playerId: 'p1', playerName: 'Vesper', amount: 400, handName: 'UNCONTESTED', cards: ['As', 'Ad', 'Kh', 'Qc', 'Js'] }] } }
  const personal = { handId: base.handId, playerId: 'p0', cards: ['As', 'Kd'], legalActions: [{ type: 'fold' }, { type: 'check' }, { type: 'raise', min: 40, max: 1020 }, { type: 'allIn' }] }
  const apply = (state = base, self = personal) => page.evaluate(({ state, self }) => testUI.update(state, self), { state, self })
  const helpStyle = () => page.locator('.mp-help').evaluate(node => {
    // Inspect the settled visual state rather than an in-flight hover/focus fade.
    getComputedStyle(node, '::after').opacity
    node.getAnimations({ subtree: true }).forEach(animation => animation.finish())
    const style = getComputedStyle(node), glow = getComputedStyle(node, '::after'), ui = node.closest('.mp-ui'), wager = ui.querySelector('.mp-action-wager'), rect = node.getBoundingClientRect()
    return { background: style.backgroundColor, color: style.color, font: style.fontFamily, uiFont: getComputedStyle(ui).fontFamily, wagerBackground: getComputedStyle(wager).backgroundColor, border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth], outline: style.outlineStyle, shadow: style.boxShadow, glow: { content: glow.content, background: glow.backgroundColor, opacity: Number(glow.opacity), left: parseFloat(glow.left), right: parseFloat(glow.right), bottom: parseFloat(glow.bottom), height: parseFloat(glow.height), filter: glow.filter, border: glow.borderTopWidth, shadow: glow.boxShadow }, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, headerChild: node.parentElement.classList.contains('mp-header'), utilitiesChild: !!node.closest('.mp-utilities') }
  })
  const assertHelpStyle = style => {
    assert.equal(style.background, 'rgb(182, 255, 0)', 'H uses the exact logo lime in either world')
    assert.equal(style.background, style.wagerBackground, 'H and the branded Raise control share their accent')
    assert.equal(style.color, 'rgb(16, 23, 19)')
    assert.equal(style.font, style.uiFont, 'H inherits the common UI font instead of a serif face')
    assert.deepEqual(style.border, ['0px', '0px', '0px', '0px'], 'H has no enclosing frame')
    assert.equal(style.outline, 'none', 'H never gains an enclosing focus ring')
    assert.equal(style.headerChild, true, 'H is a left-side header control')
    assert.equal(style.utilitiesChild, false, 'H is independent of the right-side utilities')
    assert.equal(style.shadow, 'none', 'The button surface has no outer or inset ring')
    assert.equal(style.glow.content, '""')
    assert.equal(style.glow.background, style.background, 'The lower glow uses the same branded lime')
    assert.equal(style.glow.border, '0px')
    assert.equal(style.glow.shadow, 'none')
    assert.ok(style.glow.opacity > 0 && style.glow.opacity <= 1)
    assert.ok(style.glow.left > 0 && style.glow.right > 0 && style.glow.bottom <= 0 && style.glow.height <= 6, 'Glow is a small area beneath H, not an enclosing frame')
    assert.match(style.glow.filter, /^blur\([\d.]+px\)$/)
  }
  assert.equal(await page.locator('.mp-help').isHidden(), true)
  assert.equal(await page.locator('.mp-world, .mp-left-mode, .mp-rank-guide').count(), 0)
  await apply()
  await page.locator('.mp-number').fill('250')
  await page.locator('.mp-number').dispatchEvent('change')
  await page.locator('.mp-help').click()
  assert.equal(await page.locator('.mp-help-dialog').isVisible(), true)
  assert.equal(await page.locator('.mp-help').getAttribute('aria-expanded'), 'true')
  assert.equal(await page.evaluate(() => document.activeElement.className), 'mp-icon mp-help-close')
  await page.evaluate(() => { document.querySelector('.mp-action-fold').click(); document.querySelector('.mp-action-wager').click(); advanceClock(1000) })
  assert.equal(await page.evaluate(() => actions.length), 0)
  assert.equal(await page.locator('.mp-turn-clock strong').textContent(), '29s')
  assert.equal(await page.locator('.mp-tournament > span').textContent(), 'NEXT 15/30 IN 2:59')
  assert.equal(await page.locator('.mp-tournament').evaluate(node => !!node.closest('.mp-help-dialog')), true)
  assert.deepEqual(await page.locator('.mp-help-world-normal .mp-help-ranks li').allTextContents(), ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'])
  assert.deepEqual(await page.locator('.mp-help-world-mirror .mp-help-ranks li').allTextContents(), ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'])
  assert.deepEqual(await page.locator('.mp-help-player').evaluateAll(rows => rows.map(row => row.dataset.playerId)), ['p1', 'p0', 'p2', 'p3'])
  assert.equal(await page.locator('.mp-help-player[data-player-id="p2"] .mp-help-status').textContent(), 'IN · ALL IN')
  assert.equal(await page.locator('.mp-help-player[data-player-id="p3"] .mp-help-status').textContent(), 'OUT')
  assert.equal(await page.locator('.mp-help-player[data-player-id="p3"] img').count(), 0)
  assert.equal(await page.locator('.mp-help-player[data-player-id="p3"] .mp-help-player-name').textContent(), '<img src=x onerror=alert(1)>')
  assert.equal(await page.locator('.mp-help-player.is-winning-place').count(), 1)
  assert.equal(await page.locator('.mp-help-player.is-winning-place .mp-help-status').textContent(), 'IN')
  await apply({ ...base, players: players.filter(player => player.id !== 'p3'), profiles: undefined, turnTimer: { ...base.turnTimer, remainingMs: 29500 } })
  assert.equal(await page.locator('.mp-help-player[data-player-id="p3"] .mp-help-player-name').textContent(), '<img src=x onerror=alert(1)>', 'Departed authoritative placements retain the stable profile name')
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.mp-help-dialog').isHidden(), true)
  assert.equal(await page.evaluate(() => document.activeElement.className), 'mp-icon mp-help')
  assert.equal(await page.locator('.mp-number').inputValue(), '250')
  assert.equal(await page.locator('.mp-action-fold').isDisabled(), false)
  await page.locator('.mp-action-wager').click()
  await page.locator('.mp-help').click()
  await page.locator('.mp-help-close').click()
  assert.equal(await page.locator('.mp-action-fold').isDisabled(), true, 'Help preserves a pending action lock')
  assert.equal(await page.evaluate(() => actions.length), 1)
  checks.push('native dialog focus, Escape, running turn and level clocks, legal action block and wager/sent-action preservation')
  checks.push('rank tables, chip sorting, authoritative elimination, zero-stack all-in, stable departed names and text-only profile insertion')

  for (const mode of ['NORMAL', 'MIRROR']) {
    for (const [width, height] of [[1280, 720], [844, 390], [667, 375]]) {
      await page.setViewportSize({ width, height })
      await apply({ ...base, seq: 11, worldMode: mode })
      assert.equal(await page.locator('.mp-last-hand').count(), 1)
      assert.equal(await page.locator('.mp-last-hand').evaluate(node => !!node.closest('.mp-help-history')), width <= 1024 && height <= 600)
      await page.mouse.move(width / 2, height / 2)
      await page.locator('.mp-action-fold').focus()
      const restingStyle = await helpStyle()
      assertHelpStyle(restingStyle)
      assert.ok(restingStyle.glow.opacity <= .5, 'Resting lower glow remains subtle')
      assert.ok(restingStyle.left >= 0 && restingStyle.left < width * .1 && restingStyle.top >= 0 && restingStyle.top < height * .1, 'H stays in the upper left corner on Desktop and phone landscape')
      await page.locator('.mp-help').hover()
      assertHelpStyle(await helpStyle())
      await page.mouse.move(width / 2, height / 2)
      await page.keyboard.press('Tab')
      await page.locator('.mp-help').focus()
      assert.equal(await page.locator('.mp-help').evaluate(node => node.matches(':focus-visible')), true)
      const focusedStyle = await helpStyle()
      assertHelpStyle(focusedStyle)
      assert.ok(focusedStyle.glow.opacity > restingStyle.glow.opacity, 'Keyboard focus is indicated by a stronger lower glow')
      await page.locator('.mp-help').press('Enter')
      assert.equal(await page.locator('.mp-last-card').count(), 0, 'Uncontested winner cards remain private in the help view')
      const metrics = await page.locator('.mp-help-dialog').evaluate(node => { const r = node.getBoundingClientRect(); return { width: r.width, height: r.height, left: r.left, top: r.top, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth } })
      assert.ok(metrics.left >= 0 && metrics.top >= 0 && metrics.width <= width && metrics.height <= height)
      assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, 'Help never scrolls horizontally')
      await page.screenshot({ path: path.join(output, `help-${mode.toLowerCase()}-${width}.png`) })
      await page.locator('.mp-help-close').click()
    }
  }
  await page.locator('.mp-help').click()
  await page.mouse.click(1, 1)
  assert.equal(await page.locator('.mp-help-dialog').isHidden(), true, 'Backdrop closes help')
  await page.evaluate(() => { const style = document.documentElement.style; style.setProperty('--safe-left', '44px'); style.setProperty('--safe-right', '44px'); style.setProperty('--safe-bottom', '21px') })
  await page.locator('.mp-help').click()
  const safeDialog = await page.locator('.mp-help-dialog').boundingBox()
  assert.ok(safeDialog.x >= 44 && safeDialog.x + safeDialog.width <= 667 - 44)
  assert.ok(safeDialog.y + safeDialog.height <= 375 - 21, 'Native top-layer guide respects host notch and home-indicator insets')
  await page.locator('.mp-help-close').click()
  await page.locator('.mp-help').click()
  await apply(null, null)
  assert.equal(await page.locator('.mp-help-dialog').isHidden(), true)
  assert.equal(await page.locator('.mp-help').isHidden(), true)
  await apply({ ...base, stage: 'LOBBY' })
  assert.equal(await page.locator('.mp-help').isHidden(), true)
  await apply()
  await page.locator('.mp-help').click()
  await apply({ ...base, match: { ...base.match, placements: [...base.match.placements, { playerId: 'p0', place: 3, reason: 'eliminated' }] } })
  await page.evaluate(() => testUI.setResultReady('hand-help'))
  assert.equal(await page.locator('.mp-help-dialog').isHidden(), true)
  assert.equal(await page.locator('.mp-help').isHidden(), true)
  await page.evaluate(() => document.querySelector('.mp-help').click())
  assert.equal(await page.locator('.mp-help-dialog').isHidden(), true, 'A hidden help trigger cannot reopen over a completed match result')
  await page.evaluate(() => testUI.dispose())
  assert.equal(await page.evaluate(() => frames.size), 0)
  assert.equal(await page.locator('.mp-ui').count(), 0)
  assert.deepEqual(errors, [])
  checks.push('both themes at desktop and two phone landscape sizes; native dialog safe insets; single responsive history view; backdrop/menu/lobby/result/dispose lifecycle')
  checks.push('upper-left H uses exact logo/RAISE lime and common UI font; no border or focus ring; one soft lower glow through hover and keyboard focus')
  console.log(JSON.stringify({ kind: 'LOCAL CHROMIUM UI FIXTURES — NOT HOSTED RUNTIME', checks, errors }, null, 2))
} finally { await browser.close() }

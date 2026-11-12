// Local Chromium UI fixtures only; this does not verify remote rooms.
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

const output = path.join(root, '.local-check/ui-turbo')
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
  const players = ['You', 'Vesper', 'Onyx', 'Scarlet'].map((name, seat) => ({ id: `p${seat}`, name, seat, stack: 1480, bet: 20, totalBet: 20, folded: false, allIn: false, connected: true, isBot: false }))
  const base = { handId: 'hand-1', seq: 10, stage: 'PREFLOP', worldMode: 'NORMAL', players, board: [], pot: 80, actorId: 'p0', dealerSeat: 1, smallBlind: 10, bigBlind: 20, currentBet: 20, minRaise: 20, winners: [], match: { status: 'PLAYING', placements: [], winnerId: null }, turnTimer: { turnId: 'turn-1', playerId: 'p0', durationMs: 30000, remainingMs: 30000 }, tournament: { level: 1, levelDurationMs: 180000, remainingMs: 180000, nextSmallBlind: 15, nextBigBlind: 30 } }
  const personal = { handId: base.handId, playerId: 'p0', cards: ['As', 'Kd'], legalActions: [{ type: 'fold' }, { type: 'check' }, { type: 'raise', min: 40, max: 1500 }, { type: 'allIn' }] }
  const apply = (state = base, self = personal) => page.evaluate(({ state, self }) => testUI.update(state, self), { state, self })
  const advance = ms => page.evaluate(ms => advanceClock(ms), ms)
  const seconds = () => page.locator('.mp-turn-clock strong').textContent()
  await apply()
  assert.equal(await seconds(), '30s')
  assert.equal(await page.locator('.mp-seat-clock:visible').count(), 1)
  assert.equal(await page.locator('.mp-seat-0 .mp-seat-clock').textContent(), 'MOVE · 30s')
  assert.equal(await page.locator('.mp-tournament strong').textContent(), 'TURBO · L1 · 10/20')
  assert.equal(await page.locator('.mp-tournament > span').textContent(), 'NEXT 15/30 IN 3:00')
  await page.locator('.mp-number').fill('250')
  await page.locator('.mp-number').dispatchEvent('change')
  await advance(1000)
  assert.equal(await seconds(), '29s')
  await apply({ ...base, turnTimer: { ...base.turnTimer, remainingMs: 29500 } })
  assert.equal(await seconds(), '29s', 'Same-turn snapshots never refill the locally elapsed clock')
  assert.equal(await page.locator('.mp-number').inputValue(), '250', 'Clock-only snapshots preserve wager selection')
  await page.locator('.mp-action-wager').click()
  await apply({ ...base, turnTimer: { ...base.turnTimer, remainingMs: 28000 } })
  assert.deepEqual(await page.evaluate(() => actions), [{ type: 'raise', amount: 250 }])
  assert.equal(await page.locator('.mp-action-fold').isDisabled(), true)
  assert.equal(await page.locator('.mp-turn-caption').textContent(), 'ACTION SENT · WAITING FOR THE TABLE')
  await page.evaluate(() => document.querySelector('.mp-action-fold').click())
  assert.equal(await page.evaluate(() => actions.length), 1, 'Pending action remains locked on timer snapshots')
  checks.push('interpolated seconds, monotonic resync, wager selection and pending action preservation')

  await apply({ ...base, seq: 11, turnTimer: { ...base.turnTimer, turnId: 'turn-2' } })
  assert.equal(await seconds(), '30s')
  await page.locator('.mp-help').click()
  await advance(1000)
  assert.equal(await seconds(), '29s', 'Help does not pause the authoritative turn clock display')
  assert.equal(await page.locator('.mp-tournament > span').textContent(), 'NEXT 15/30 IN 2:58', 'The level clock continues while help is open')
  assert.equal(await page.locator('.mp-tournament').isVisible(), true)
  await page.locator('.mp-help-close').click()
  await page.locator('.mp-exit').click()
  await advance(1000)
  assert.equal(await seconds(), '28s', 'Leave confirmation does not pause the authoritative turn clock display')
  await page.locator('.mp-confirm-stay').click()
  await advance(23000)
  assert.equal(await seconds(), '5s')
  assert.equal(await page.locator('.mp-seat-0').evaluate(el => el.classList.contains('is-time-urgent')), true)
  assert.equal(await page.locator('.mp-turn-clock').evaluate(el => el.classList.contains('is-time-urgent')), true)
  assert.ok(await page.locator('.mp-seat-0 .mp-seat-time-track > i').evaluate(el => Number(el.style.transform.match(/[\d.]+/)[0]) <= 1 / 6 + .001))
  await page.evaluate(() => document.querySelector('.mp-ui').getAnimations({ subtree: true }).forEach(animation => animation.finish()))
  assert.equal(await page.locator('.mp-seat-0').evaluate(el => getComputedStyle(el).borderTopColor), 'rgb(255, 128, 107)')
  assert.equal(await page.locator('.mp-seat-0 .mp-seat-marker').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 128, 107)')
  await page.screenshot({ path: path.join(output, 'last-five-seconds-normal.png') })
  await apply({ ...base, seq: 12, stage: 'FLOP', board: ['2c', '3d', '4h'], turnTimer: { ...base.turnTimer, turnId: 'turn-3' } })
  assert.equal(await seconds(), '30s', 'A new decision gets a new clock even for the same player on the next street')
  await apply({ ...base, seq: 13, worldMode: 'MIRROR', turnTimer: { ...base.turnTimer, turnId: 'turn-afk', durationMs: 10000, remainingMs: 10000 } })
  assert.equal(await seconds(), '10s')
  assert.equal(await page.locator('.mp-turn-clock > span').textContent(), 'AFK MODE · ACT TO RESTORE 30s')
  assert.equal(await page.locator('.mp-seat-0 .mp-seat-clock').textContent(), 'AFK · 10s')
  await advance(5000)
  await page.evaluate(() => document.querySelector('.mp-ui').getAnimations({ subtree: true }).forEach(animation => animation.finish()))
  assert.equal(await page.locator('.mp-seat-0').evaluate(el => getComputedStyle(el).borderTopColor), 'rgb(163, 41, 29)')
  await page.screenshot({ path: path.join(output, 'last-five-seconds-afk-mirror.png') })
  checks.push('new-decision reset, final-five-second urgent styles and explicit 10-second AFK recovery hint')

  const opponent = { ...base, seq: 14, actorId: 'p1', turnTimer: { ...base.turnTimer, turnId: 'opponent', playerId: 'p1' } }
  await apply(opponent)
  assert.equal(await page.locator('.mp-turn-clock').isHidden(), true)
  assert.equal(await page.locator('.mp-seat-1 .mp-seat-clock').isVisible(), true)
  assert.equal(await page.locator('.mp-seat-0 .mp-seat-clock').isHidden(), true)
  for (const stage of ['LOBBY', 'INTERMISSION', 'SHOWDOWN', 'COMPLETE']) {
    await apply({ ...base, stage })
    assert.equal(await page.locator('.mp-turn-clock').isHidden(), true)
    assert.equal(await page.locator('.mp-seat-clock:visible').count(), 0)
  }
  await apply({ ...base, turnTimer: undefined })
  assert.equal(await page.locator('.mp-seat-clock:visible').count(), 0)
  await apply({ ...base, turnTimer: { ...base.turnTimer, playerId: 'p2' } })
  assert.equal(await page.locator('.mp-seat-clock:visible').count(), 0, 'A mismatched clock cannot appear on the wrong actor')
  const placement = { ...base, match: { status: 'PLAYING', placements: [{ playerId: 'p0', place: 4, reason: 'eliminated' }], winnerId: null } }
  await apply(placement)
  await page.evaluate(id => testUI.setResultReady(id), base.handId)
  assert.equal(await page.locator('.mp-seat-clock:visible').count(), 0)
  assert.equal(await page.locator('.mp-tournament').isHidden(), true)
  checks.push('opponent seats and clock suppression outside betting, for invalid actor and under match results')

  await page.evaluate(() => testUI.update(null, null))
  await apply()
  await advance(61000)
  assert.equal(await seconds(), '0s')
  assert.equal(await page.evaluate(() => actions.length), 1, 'Clock presentation never sends its own timeout action')
  assert.equal(await page.locator('.mp-tournament > span').textContent(), 'NEXT 15/30 IN 1:59')
  const hand2 = { ...base, handId: 'hand-2', turnTimer: undefined }
  await apply(hand2, { ...personal, handId: hand2.handId })
  assert.equal(await page.locator('.mp-tournament > span').textContent(), 'NEXT 15/30 IN 1:59', 'A new hand does not refill the blind level clock')
  await apply({ ...base, smallBlind: 15, bigBlind: 30, tournament: { ...base.tournament, level: 2, nextSmallBlind: 25, nextBigBlind: 50 } })
  assert.equal(await page.locator('.mp-tournament strong').textContent(), 'TURBO · L2 · 15/30')
  assert.equal(await page.locator('.mp-tournament > span').textContent(), 'NEXT 25/50 IN 3:00')
  const previousHand = { handId: 'previous', worldMode: 'NORMAL', winners: [
    { playerId: 'p1', playerName: 'Vesper', amount: 400, handName: 'PAIR', cards: ['As', 'Ad', 'Kh', 'Qc', 'Js'] },
    { playerId: 'p2', playerName: 'Onyx', amount: 300, handName: 'PAIR', cards: ['As', 'Ad', 'Kh', 'Qc', 'Js'] },
    { playerId: 'p3', playerName: 'Scarlet', amount: 200, handName: 'PAIR', cards: ['As', 'Ad', 'Kh', 'Qc', 'Js'] },
  ] }
  const geometry=[]
  for (const [width, height] of [[960, 640], [1280, 720], [1920, 1080], [844, 390], [667, 375]]) for (const mode of ['NORMAL','MIRROR']) {
    const compact=height<=600, inset=compact?44:0, bottomInset=compact?21:0
    await page.setViewportSize({ width, height })
    await page.evaluate(({inset,bottomInset}) => {
      testUI.update(null,null)
      document.querySelector('#hud').style.inset=`0px ${inset}px ${bottomInset}px`
      for(const [side,value] of Object.entries({top:0,right:inset,bottom:bottomInset,left:inset}))document.documentElement.style.setProperty(`--safe-${side}`,`${value}px`)
    },{inset,bottomInset})
    await apply({ ...base, previousHand, worldMode:mode, turnTimer: { ...base.turnTimer, durationMs: 10000, remainingMs: 5000 } })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    const boxes = await page.evaluate(() => {
      const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }
      return { help: box('.mp-help'), utilities: box('.mp-utilities'), last: box('.mp-last-hand'), farSeat: box('.mp-seat-2'), seats: [0, 1, 2, 3].map(index => box(`.mp-seat-${index}`)), caption: box('.mp-turn-caption'), clock: box('.mp-turn-clock'), note: box('.mp-action-note'), seat: box('.mp-seat-0'), bar: box('.mp-bottom') }
    })
    assert.ok(boxes.caption.right < boxes.clock.left, 'Own-turn clock clears the actor caption')
    if(!compact)assert.ok(boxes.clock.right < boxes.note.left, 'Own-turn clock clears the play-chip note')
    assert.ok(boxes.seat.bottom < boxes.bar.top, 'Timed seat clears the action bar')
    assert.ok(boxes.utilities.left>=inset&&boxes.utilities.right<=width-inset)
    assert.ok(boxes.help.left>=inset&&boxes.help.right<width/2&&boxes.help.top>=0&&boxes.help.bottom<=height-bottomInset,'H remains in the upper left inside the host safe area')
    assert.ok(boxes.help.bottom<=boxes.utilities.bottom+1&&boxes.help.right<boxes.utilities.left,'H stays aligned with the top controls while occupying the opposite corner')
    for(const seat of boxes.seats)assert.ok(boxes.help.right<=seat.left||boxes.help.left>=seat.right||boxes.help.bottom<=seat.top||boxes.help.top>=seat.bottom,'The relocated H never overlaps a player panel')
    assert.ok(boxes.bar.left>=inset&&boxes.bar.right<=width-inset&&boxes.bar.bottom<=height-bottomInset)
    assert.equal(await page.locator('.mp-last-hand').count(),1,'Resizing keeps one authoritative history view')
    assert.equal(await page.locator('.mp-help-history > .mp-last-hand').count(),compact?1:0,'Mobile history moves inside H')
    assert.equal(await page.locator('.mp-tournament').evaluate(node=>node.closest('dialog')?.classList.contains('mp-help-dialog')),true)
    if(compact)assert.equal(await page.locator('.mp-last-hand').isHidden(),true,'Mobile history leaves space for the table while H is closed')
    else {
      assert.ok(boxes.last.top>=boxes.utilities.bottom+8,'Desktop Last Hand follows utilities directly')
      assert.ok(Math.abs(boxes.last.right-boxes.utilities.right)<1,'Desktop history and utilities share a right edge')
      assert.ok(boxes.last.right<=boxes.farSeat.left||boxes.last.left>=boxes.farSeat.right||boxes.last.bottom<boxes.farSeat.top,'Last Hand clears the far player panel')
    }
    await page.screenshot({path:path.join(output,`table-${width}x${height}-${mode.toLowerCase()}.png`)})
    await page.locator('.mp-help').click()
    const guide=await page.locator('.mp-help-dialog').evaluate(node=>{
      const r=node.getBoundingClientRect(),body=node.querySelector('.mp-help-body'),close=node.querySelector('.mp-help-close').getBoundingClientRect()
      return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,scrollWidth:body.scrollWidth,clientWidth:body.clientWidth,scrollHeight:body.scrollHeight,clientHeight:body.clientHeight,close:{left:close.left,right:close.right,top:close.top,bottom:close.bottom}}
    })
    assert.ok(guide.left>=inset&&guide.right<=width-inset&&guide.top>=0&&guide.bottom<=height-bottomInset,'Native guide fits the host safe area')
    assert.ok(guide.close.left>=guide.left&&guide.close.right<=guide.right&&guide.close.bottom<=guide.bottom,'Help close remains reachable')
    assert.ok(guide.scrollWidth<=guide.clientWidth,'Ranks and roster never force horizontal guide scrolling')
    assert.equal(await page.locator('.mp-help-world.is-current-world').getAttribute('data-world'),mode)
    assert.equal(await page.locator('.mp-help-player.is-winning-place').count(),1)
    assert.equal(await page.locator('.mp-help-player .mp-help-status').filter({hasText:'WINNER'}).count(),0,'Leading the stacks is not a declared tournament victory')
    if(compact) {
      assert.equal(await page.locator('.mp-last-card').count(),15,'Mobile help retains all public split-pot winners')
      assert.equal(await page.locator('.mp-last-hand').isVisible(),true)
      const history=await page.locator('.mp-last-winners').evaluate(node=>({scroll:node.scrollHeight,visible:node.clientHeight,overflow:getComputedStyle(node).overflowY}))
      assert.ok(history.scroll<=history.visible+1&&history.overflow==='visible','The guide uses one scroll area so no split winner is hidden in a nested history list')
    }
    await page.screenshot({path:path.join(output,`guide-${width}x${height}-${mode.toLowerCase()}.png`)})
    await page.locator('.mp-help-body').evaluate(node=>node.scrollTop=node.scrollHeight)
    if(compact)await page.screenshot({path:path.join(output,`guide-history-${width}x${height}-${mode.toLowerCase()}.png`)})
    await page.locator('.mp-help-close').click()
    geometry.push({width,height,mode,inset,bottomInset,boxes,guide})
    if(compact) {
      const headerAnchors={seats:[{seat:0,x:.09,y:.76},{seat:1,x:.04,y:.04},{seat:2,x:.96,y:.04},{seat:3,x:.91,y:.76}],pot:{x:.5,y:.385}}
      const seatBounds=()=>page.locator('.mp-seat').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}}))
      await page.evaluate(positions=>testUI.setTablePositions(positions),headerAnchors)
      const nudged=await seatBounds()
      for(const seat of nudged) {
        assert.ok(seat.left>=inset&&seat.right<=width-inset&&seat.bottom<boxes.bar.top,'Seats near header anchors remain inside the host safe area and above actions')
        for(const control of [boxes.help,boxes.utilities])assert.ok(seat.right<=control.left||seat.left>=control.right||seat.bottom<=control.top||seat.top>=control.bottom,'Projected upper seats clear both left H and right utilities')
      }
      for(let pass=0;pass<3;pass++)await page.evaluate(positions=>testUI.setTablePositions(positions),headerAnchors)
      assert.deepEqual(await seatBounds(),nudged,'Repeated projections do not accumulate header avoidance nudges')
      await page.evaluate(()=>testUI.setTablePositions({seats:[{seat:0,x:.09,y:.76},{seat:1,x:.12,y:.36},{seat:2,x:.88,y:.36},{seat:3,x:.91,y:.76}],pot:{x:.5,y:.385}}))
      assert.deepEqual(await seatBounds(),boxes.seats,'Removing header overlap restores the original projected seat positions')
    }
  }
  await fs.writeFile(path.join(output,'guide-geometry.json'),JSON.stringify(geometry,null,2))
  await page.locator('.mp-help').click()
  await page.evaluate(()=>window.historyNode=document.querySelector('.mp-last-hand'))
  await page.setViewportSize({width:1280,height:720})
  await page.evaluate(()=>{
    document.querySelector('#hud').style.inset='0px'
    for(const side of ['top','right','bottom','left'])document.documentElement.style.setProperty(`--safe-${side}`,'0px')
    window.dispatchEvent(new Event('resize'))
  })
  assert.equal(await page.locator('.mp-help-dialog').isVisible(),true,'Resizing an open guide keeps its native modal session')
  assert.equal(await page.locator('.mp-top-right > .mp-last-hand').count(),1)
  await page.setViewportSize({width:844,height:390})
  await page.evaluate(()=>{
    document.querySelector('#hud').style.inset='0px 44px 21px'
    for(const [side,value] of Object.entries({top:0,right:44,bottom:21,left:44}))document.documentElement.style.setProperty(`--safe-${side}`,`${value}px`)
    window.dispatchEvent(new Event('resize'))
  })
  assert.equal(await page.locator('.mp-help-history > .mp-last-hand').count(),1)
  assert.equal(await page.evaluate(()=>window.historyNode===document.querySelector('.mp-last-hand')),true,'Orientation changes move the current history node without recreating it')
  assert.equal(await page.locator('.mp-last-card').count(),15)
  assert.equal(await page.locator('.mp-help-close').evaluate(node=>node===document.activeElement),true,'Guide close remains focused through viewport rotation')
  await page.locator('.mp-help-close').click()
  assert.equal(await page.locator('.mp-help').evaluate(node=>node===document.activeElement),true,'Closing after viewport rotation returns focus to the relocated H')
  checks.push('three-minute levels across hands, H timer continuity, desktop history and both-world landscape guide inside 44/21 safe insets')
  checks.push('upper-left H clears every seat and right-side utilities at desktop and 667/844 phone sizes with 44px side and 21px bottom insets')
  checks.push('projected seats colliding with either header corner are corrected once and return to their original anchors after reprojection')
  checks.push('open guide survives viewport rotation while the single live history view moves between desktop and mobile')
  await page.locator('.mp-exit').click()
  await page.evaluate(() => testUI.dispose())
  assert.equal(await page.evaluate(() => frames.size), 0)
  assert.equal(await page.locator('.mp-ui').count(), 0)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ kind: 'LOCAL CHROMIUM UI FIXTURES — NOT HOSTED RUNTIME', checks, errors }, null, 2))
} finally { await browser.close() }

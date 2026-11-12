// Focused DOM/browser regressions. Uses project TypeScript and Chromium;
// this verifies UI behavior locally, in a real browser.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const ts = createRequire(import.meta.url)('typescript')
const source = await fs.readFile(path.join(root, 'ui/index.ts'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const assetsCompiled = ts.transpileModule(await fs.readFile(path.join(root,'shared/assets.ts'),'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { CARD_SUITS } = await import(`data:text/javascript;base64,${Buffer.from(assetsCompiled).toString('base64')}`)
const pokerMarkCompiled = ts.transpileModule(await fs.readFile(path.join(root,'shared/poker-mark.ts'),'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { POKER_MARK } = await import(`data:text/javascript;base64,${Buffer.from(pokerMarkCompiled).toString('base64')}`)
const cardArtCompiled = ts.transpileModule(await fs.readFile(path.join(root,'shared/card-art.ts'),'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const css = await fs.readFile(path.join(root, 'ui/style.css'), 'utf8')
const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#hud{position:absolute;inset:0;margin:0}body{background:radial-gradient(ellipse at 50% 40%,#3e2e39,#100e14)}${css}</style></head><body><div id="hud"></div><script type="module">${compiled}
window.records={actions:[],replay:0,leave:0};window.testUI=createUI(document.querySelector('#hud'),{solo(){},multiplayer(){},invite(){},start(){},next(){throw new Error('Next hand must never be called')},replay(){records.replay++},act(action){records.actions.push(action)},leave(){records.leave++},mute(){}});</script></body></html>`
const { chromium } = await import('@playwright/test')
let executablePath = process.env.MIRROR_CHROMIUM

const output = path.join(root,'.local-check/ui-v13')
await fs.mkdir(output,{recursive:true})
const report={kind:'LOCAL DOM CHROMIUM — NOT HOSTED RUNTIME',checks:{},screenshots:[],errors:[],avatarAssetRequests:[]}
const browser=await chromium.launch({channel:"chromium",headless:true,...(executablePath?{executablePath}: {})})
try {
  const page=await browser.newPage({viewport:{width:1280,height:720}})
  page.on('pageerror',error=>report.errors.push(error.message))
  await page.route('http://mirror-ui.local/',route=>route.fulfill({contentType:'text/html',body:html}))
  await page.route('http://mirror-ui.local/shared/assets.ts',route=>route.fulfill({contentType:'text/javascript',body:assetsCompiled}))
  await page.route('http://mirror-ui.local/shared/poker-mark.ts',route=>route.fulfill({contentType:'text/javascript',body:pokerMarkCompiled}))
  await page.route(`**/${POKER_MARK.assetURL}`,route=>{report.avatarAssetRequests.push(route.request().url());return route.fulfill({status:404,contentType:'text/plain',body:'Intentionally unavailable avatar asset'})})
  await page.route('http://mirror-ui.local/shared/card-art.ts',route=>route.fulfill({contentType:'text/javascript',body:cardArtCompiled}))
  await page.goto('http://mirror-ui.local/')
  await page.waitForFunction(()=>!!window.testUI)
  const players=['You','Vesper','Onyx','Scarlet'].map((name,seat)=>({id:`p${seat}`,name,seat,stack:980,bet:20,totalBet:20,folded:false,allIn:false,connected:true,isBot:seat!==0}))
  let seq=1
  const base={handId:'hand-1',seq,stage:'PREFLOP',worldMode:'NORMAL',players,board:[],pot:80,actorId:'p0',dealerSeat:1,smallBlind:10,bigBlind:20,currentBet:20,minRaise:20,winners:[],match:{status:'PLAYING',placements:[],winnerId:null}}
  const personal={handId:'hand-1',playerId:'p0',cards:['As','Kd'],legalActions:[{type:'fold'},{type:'check'},{type:'raise',min:40,max:1000},{type:'allIn'}]}
  const apply=async(state=base,self=personal)=>page.evaluate(({state,self})=>{document.body.style.background=state?.worldMode==='MIRROR'?'linear-gradient(135deg,#e5ded1,#cfc7ba)':'radial-gradient(ellipse at 50% 40%,#3e2e39,#100e14)';window.testUI.update(state,self)},{state,self})
  const reset=async()=>{base.seq=++seq; await apply(); await page.evaluate(()=>{records.actions=[]})}
  const capture=async(name)=>{const target=path.join(output,`${name}.png`);await page.screenshot({path:target});report.screenshots.push(target)}
  const normalRanks=['A','K','Q','J','T','9','8','7','6','5','4','3','2']
  const helpRanks=()=>page.locator('.mp-help-ranks').evaluateAll(lists=>lists.map(list=>[...list.children].map(rank=>rank.textContent)))
  assert.equal(await page.locator('.mp-menu-brand').isVisible(),true)
  const menuBrand=await page.locator('.mp-menu-brand').evaluate(node=>{window.initialMenuBrand=node;const r=node.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,src:node.querySelector('img').getAttribute('src')}})
  assert.deepEqual(menuBrand,{left:26,top:23,width:58,height:58,src:'assets/brand/loading-chip.svg'},'Hidden H leaves the original menu chip in the upper left')
  assert.equal(await page.locator('.mp-help').isHidden(),true)
  assert.equal(await page.locator('.mp-help-dialog').isHidden(),true)
  await apply()
  assert.equal(await page.locator('.mp-seat-avatar svg').count(),4)
  const avatarVectors=await page.locator('.mp-seat-avatar').evaluateAll(nodes=>nodes.map(node=>{
    const svg=node.querySelector('svg'),bounds=svg.getBBox()
    return {viewBox:svg.getAttribute('viewBox'),preserve:svg.getAttribute('preserveAspectRatio'),hidden:svg.getAttribute('aria-hidden'),focusable:svg.getAttribute('focusable'),paths:[...svg.querySelectorAll('path')].map(path=>({d:path.getAttribute('d'),fill:path.getAttribute('fill'),rule:path.getAttribute('fill-rule')})),bounds:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height},imageOrURL:node.querySelectorAll('img,image').length+[...node.querySelectorAll('*')].filter(element=>[...element.attributes].some(attribute=>['href','src'].includes(attribute.localName))).length}
  }))
  for(const avatar of avatarVectors){
    assert.equal(avatar.viewBox,POKER_MARK.viewBox)
    assert.equal(avatar.preserve,'xMidYMid meet')
    assert.equal(avatar.hidden,'true')
    assert.equal(avatar.focusable,'false')
    assert.deepEqual(avatar.paths,[{d:POKER_MARK.facePath,fill:'#fff',rule:null},{d:POKER_MARK.path,fill:'#000',rule:POKER_MARK.fillRule}])
    assert.ok(avatar.bounds.width>0&&avatar.bounds.height>0&&avatar.bounds.x>=0&&avatar.bounds.y>=0&&avatar.bounds.x+avatar.bounds.width<=POKER_MARK.width&&avatar.bounds.y+avatar.bounds.height<=POKER_MARK.height,'Inline mark has non-empty geometry inside its viewBox')
    assert.equal(avatar.imageOrURL,0)
  }
  assert.deepEqual(await page.locator('.mp-seat-name').allTextContents(),['You','Vesper','Onyx','Scarlet'])
  assert.equal(await page.locator('.mp-seat-name').filter({hasText:'BOT'}).count(),0)
  report.checks.sharedInlineSpadeAvatarsAndNoBotSuffix=avatarVectors
  await page.evaluate(()=>testUI.setTablePositions({seats:[{seat:0,x:.085,y:.77},{seat:1,x:.14,y:.37},{seat:2,x:.86,y:.37},{seat:3,x:.915,y:.77}],pot:{x:.5,y:.385}}))
  assert.equal(await page.locator('.mp-table-meta,.mp-world-rule,.mp-next,.mp-result').count(),0)
  assert.deepEqual(await page.locator('.mp-action-buttons button span').allTextContents(),['FOLD','CHECK','RAISE TO 40'])
  assert.deepEqual(await page.locator('.mp-bet-presets button').allTextContents(),['1/2 POT','3/4','ALLIN'])
  assert.equal(await page.locator('.mp-action-allIn').count(),0)
  assert.equal(await page.locator('.mp-wordmark,.mp-logo').count(),0)
  assert.equal(await page.locator('.mp-world,.mp-left-mode,.mp-rank-guide').count(),0)
  assert.equal(await page.locator('.mp-menu-brand').isHidden(),true)
  assert.equal(await page.locator('.mp-help').isVisible(),true)
  assert.equal(await page.locator('.mp-header > .mp-help').count(),1,'The table guide belongs to the left header instead of the right utility cluster')
  assert.equal(await page.locator('.mp-utilities .mp-help').count(),0)
  assert.deepEqual(await helpRanks(),[normalRanks,[...normalRanks].reverse()])
  assert.equal(await page.locator('.mp-world-meta,.mp-world-notice,.mp-world > i').count(),0)
  assert.equal(await page.locator('.mp-seat-badge,.mp-hand-log,.mp-log-entry').count(),0)
  assert.equal(await page.locator('.mp-last-hand').isHidden(),true)
  assert.deepEqual(await page.evaluate(()=>{
    const style=getComputedStyle(document.querySelector('.mp-action-area'))
    return {background:style.backgroundColor,image:style.backgroundImage,border:style.borderTopWidth,shadow:style.boxShadow,blur:style.backdropFilter}
  }),{background:'rgba(0, 0, 0, 0)',image:'none',border:'0px',shadow:'none',blur:'none'})
  report.checks.removedPanelsAndOrderedBar=true
  report.checks.transparentControlsAndNoDealerBadge=true
  const leaveDialog=page.locator('dialog.mp-leave-confirm')
  await page.locator('.mp-exit').click()
  assert.equal(await page.getByRole('dialog',{name:'Are you sure you want to leave?'}).isVisible(),true)
  assert.equal(await page.locator('.mp-confirm-stay').evaluate(node=>node===document.activeElement),true,'Stay is the safe initial focus')
  await page.keyboard.press('Tab')
  assert.equal(await page.locator('.mp-confirm-leave').evaluate(node=>node===document.activeElement),true,'Native modal traps focus within its two buttons')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await page.locator('.mp-confirm-stay').evaluate(node=>node===document.activeElement),true)
  await page.evaluate(()=>{
    document.querySelector('.mp-action-fold').click()
    document.querySelector('.mp-action-wager').click()
    document.querySelector('.mp-exit').click()
  })
  assert.deepEqual(await page.evaluate(()=>records.actions),[],'The modal blocks underlying poker actions, including synthetic input')
  assert.equal(await page.evaluate(()=>records.leave),0)
  await page.locator('.mp-confirm-stay').click()
  assert.equal(await leaveDialog.isVisible(),false)
  assert.equal(await page.locator('.mp-exit').evaluate(node=>node===document.activeElement),true,'Stay restores focus to the exit button')
  await page.locator('.mp-exit').click()
  await page.keyboard.press('Escape')
  assert.equal(await leaveDialog.isVisible(),false)
  await page.locator('.mp-exit').click()
  await page.mouse.click(8,8)
  assert.equal(await leaveDialog.isVisible(),false,'Clicking the backdrop stays at the table')
  assert.equal(await page.evaluate(()=>records.leave),0)
  for(const [width,height] of [[1280,720],[960,600]]) {
    await page.setViewportSize({width,height})
    await page.locator('.mp-exit').click()
    for(const mode of ['NORMAL','MIRROR']) {
      await page.evaluate(mode=>testUI.setWorldMode(mode),mode)
      const surface=await leaveDialog.evaluate(node=>{
        const bounds=node.getBoundingClientRect(),style=getComputedStyle(node)
        return {background:style.backgroundImage,color:style.color,fits:bounds.left>=0&&bounds.top>=0&&bounds.right<=innerWidth&&bounds.bottom<=innerHeight}
      })
      assert.equal(surface.fits,true)
      assert.equal(surface.color,mode==='MIRROR'?'rgb(16, 23, 19)':'rgb(238, 233, 222)')
      assert.match(surface.background,mode==='MIRROR'?/255, 253, 247/:/23, 58, 40/)
      await capture(`leave-confirm-${mode.toLowerCase()}-${width}`)
    }
    await page.locator('.mp-confirm-stay').click()
  }
  await page.evaluate(()=>testUI.setWorldMode(null))
  await page.setViewportSize({width:1280,height:720})
  await page.locator('.mp-exit').click()
  await page.evaluate(()=>testUI.update(null,null))
  assert.equal(await leaveDialog.isVisible(),false,'Returning to the menu clears a stale confirmation')
  assert.equal(await page.locator('.mp-menu-brand').isVisible(),true)
  assert.equal(await page.locator('.mp-menu-brand').evaluate(node=>node===window.initialMenuBrand),true,'Table transitions preserve the menu chip node')
  assert.equal(await page.locator('.mp-help').isHidden(),true,'H leaves the menu corner available for its chip logo')
  await apply()
  report.checks.themedLeaveConfirmationFocusCancellationAndInputGuard=true
  const helpDialog=page.locator('dialog.mp-help-dialog')
  await page.locator('.mp-help').click()
  assert.equal(await helpDialog.isVisible(),true)
  assert.equal(await page.locator('.mp-help-close').evaluate(node=>node===document.activeElement),true,'Help opens with an accessible close target focused')
  assert.equal(await page.locator('.mp-help').getAttribute('aria-expanded'),'true')
  assert.deepEqual(await helpRanks(),[normalRanks,[...normalRanks].reverse()])
  await page.evaluate(()=>{document.querySelector('.mp-action-fold').click();document.querySelector('.mp-action-wager').click();document.querySelector('.mp-exit').click()})
  assert.deepEqual(await page.evaluate(()=>records.actions),[],'Help blocks synthetic underlying poker actions')
  assert.equal(await leaveDialog.isVisible(),false,'Help cannot open a competing Leave dialog')
  assert.equal(await page.evaluate(()=>records.leave),0)
  await page.locator('.mp-help-close').click()
  assert.equal(await helpDialog.isVisible(),false)
  assert.equal(await page.locator('.mp-help').evaluate(node=>node===document.activeElement),true,'Closing help returns focus to H')
  assert.equal(await page.locator('.mp-help').getAttribute('aria-expanded'),'false')
  await page.locator('.mp-help').click()
  await page.keyboard.press('Escape')
  assert.equal(await helpDialog.isVisible(),false)
  await page.locator('.mp-help').click()
  await page.mouse.click(8,8)
  assert.equal(await helpDialog.isVisible(),false,'Clicking the guide backdrop returns to the table')
  await page.locator('.mp-help').click()
  await page.evaluate(()=>testUI.update(null,null))
  assert.equal(await helpDialog.isVisible(),false,'Returning to the menu closes help')
  await apply()
  report.checks.nativeHelpFocusCancellationAndActionGuards=true
  await page.locator('[data-preset="allin"]').click()
  assert.equal(await page.locator('.mp-number').inputValue(),'1000')
  assert.deepEqual(await page.evaluate(()=>records.actions),[])
  await page.locator('.mp-action-wager').click()
  assert.deepEqual(await page.evaluate(()=>records.actions),[{type:'allIn'}])
  assert.equal(await page.locator('.mp-action-fold').isDisabled(),true)
  report.checks.allInRequiresBetConfirmation=true
  await reset()
  await page.locator('[data-preset="half"]').click()
  assert.equal(await page.locator('.mp-number').inputValue(),'60')
  await page.locator('[data-preset="threequarters"]').click()
  assert.equal(await page.locator('.mp-number').inputValue(),'80','3/4 uses .75 rather than the former full-pot ratio')
  assert.equal(await page.locator('[data-preset="pot"]').count(),0)
  await page.locator('.mp-number').fill('75')
  await page.locator('.mp-number').press('Enter')
  assert.deepEqual(await page.evaluate(()=>records.actions),[{type:'raise',amount:75}])
  report.checks.potPresetsAndManualStreetTotal=true
  await reset()
  const owedState={...base,seq:++seq,pot:102,currentBet:100}
  const owedSelf={...personal,legalActions:[{type:'fold'},{type:'call',amount:80},{type:'raise',min:200,max:600}]}
  await apply(owedState,owedSelf)
  await page.locator('[data-preset="threequarters"]').click()
  assert.equal(await page.locator('.mp-number').inputValue(),'237','Raise total is currentBet + round(.75 * (pot + owed call))')
  assert.deepEqual(await page.evaluate(()=>records.actions),[],'Preset selection never submits an action')
  await page.locator('.mp-action-wager').click()
  assert.deepEqual(await page.evaluate(()=>records.actions),[{type:'raise',amount:237}])
  await reset()
  await apply({...owedState,seq:++seq},{...owedSelf,legalActions:[{type:'fold'},{type:'call',amount:80},{type:'raise',min:300,max:600}]})
  await page.locator('[data-preset="threequarters"]').click()
  assert.equal(await page.locator('.mp-number').inputValue(),'300','The server minimum still clamps the fractional preset')
  await apply({...owedState,seq:++seq,pot:10000},owedSelf)
  await page.locator('[data-preset="threequarters"]').click()
  assert.equal(await page.locator('.mp-number').inputValue(),'600','The server maximum still clamps the fractional preset')
  await apply({...owedState,seq:++seq,players:players.map((p,i)=>i?p:{...p,stack:1000000})},{...owedSelf,legalActions:[{type:'fold'},{type:'call',amount:80},{type:'raise',min:200,max:999000}]})
  assert.equal(await page.locator('.mp-slider').getAttribute('max'),'999000','Shorter visual slider preserves the growing authoritative legal maximum')
  assert.equal(await page.locator('.mp-number').getAttribute('max'),'999000')
  await page.locator('.mp-number').fill('520000')
  await page.locator('.mp-number').dispatchEvent('change')
  await page.locator('.mp-action-wager').click()
  assert.deepEqual(await page.evaluate(()=>records.actions),[{type:'raise',amount:520000}])
  report.checks.threeQuarterRatioOwedRoundingClampsAndGrowingLegalMax=true
  await reset()
  const shortState={...base,seq:++seq,currentBet:100,players:players.map((p,i)=>i? p:{...p,stack:100,bet:20})}
  await apply(shortState,{...personal,legalActions:[{type:'fold'},{type:'call',amount:80},{type:'allIn'}]})
  assert.equal(await page.locator('.mp-action-call span').textContent(),'CALL 80')
  assert.equal(await page.locator('.mp-number').inputValue(),'120')
  await page.locator('[data-preset="allin"]').click()
  await page.locator('.mp-action-wager').click()
  assert.deepEqual(await page.evaluate(()=>records.actions),[{type:'allIn'}])
  report.checks.shortAllInRaiseUsesServerLegalAction=true
  await reset()
  const callState={...base,seq:++seq,currentBet:100,players:players.map((p,i)=>i?p:{...p,stack:30,bet:20})}
  await apply(callState,{...personal,legalActions:[{type:'fold'},{type:'call',amount:30},{type:'allIn'}]})
  assert.equal(await page.locator('.mp-action-wager').isDisabled(),true)
  assert.equal(await page.locator('.mp-slider').isDisabled(),true)
  await page.locator('.mp-action-call').click()
  assert.deepEqual(await page.evaluate(()=>records.actions),[{type:'call'}])
  report.checks.allInCallDoesNotEnableRaise=true
  await reset()
  await apply({...base,seq:++seq,actorId:'p1'})
  assert.equal(await page.locator('.mp-action-buttons button:not([disabled])').count(),0)
  assert.equal(await page.locator('.mp-bet-presets button:not([disabled])').count(),0)
  report.checks.actorPermissions=true
  // Public street totals must be visible from the initial blind snapshot,
  // including spectators/reconnects that have no personal state or events.
  const betPoints=[{seat:0,x:.38,y:.57},{seat:1,x:.355,y:.44},{seat:2,x:.645,y:.44},{seat:3,x:.62,y:.57}]
  await page.evaluate(points=>testUI.setBetPositions(points),betPoints)
  const blindState={...base,seq:++seq,dealerSeat:0,players:players.map((p,i)=>({...p,bet:[0,10,20,0][i],totalBet:500+[0,10,20,0][i]}))}
  const betValues=()=>page.locator('.mp-bet-amount:not([hidden])').evaluateAll(nodes=>nodes.map(node=>({seat:node.dataset.seat,value:node.textContent})))
  await apply(blindState,null)
  assert.deepEqual(await betValues(),[{seat:'1',value:'10'},{seat:'2',value:'20'}])
  assert.equal(await page.locator('.mp-seat-status').filter({hasText:/BET/}).count(),0)
  assert.equal(await page.locator('.mp-action-buttons button:not([disabled])').count(),0)
  report.checks.initialBlindsWithoutEventsOrPrivateState=true
  const betUpdate={...blindState,seq:++seq,currentBet:980,players:blindState.players.map((p,i)=>({...p,bet:[980,90,90,0][i],totalBet:8000+i,allIn:i===0,stack:i===0?0:p.stack}))}
  await apply(betUpdate,null)
  assert.deepEqual(await betValues(),[{seat:'0',value:'980'},{seat:'1',value:'90'},{seat:'2',value:'90'}])
  await apply({...betUpdate,seq:++seq,players:betUpdate.players.map((p,i)=>({...p,bet:i===0?12345:p.bet}))},null)
  assert.equal(await page.locator('.mp-bet-amount-0').textContent(),'12,345')
  const contributionState={...blindState,seq:++seq,players:blindState.players.map((p,i)=>({...p,bet:[0,40,80,35][i],sittingOut:i===2,folded:i===3})),match:{status:'PLAYING',placements:[{playerId:'p1',place:4,reason:'eliminated'}],winnerId:null}}
  await apply(contributionState,null)
  assert.deepEqual(await betValues(),[{seat:'3',value:'35'}],'Folded committed chips remain labelled until collected; sitting out and eliminated seats do not')
  report.checks.streetTotalsUpdateCallRaiseAllInWithoutBoxDuplicate=true
  await apply({...betUpdate,seq:++seq,stage:'FLOP',players:betUpdate.players.map(p=>({...p,bet:0}))},null)
  assert.deepEqual(await betValues(),[])
  for(const stage of ['LOBBY','INTERMISSION','COMPLETE']){
    await apply({...betUpdate,seq:++seq,stage},null)
    assert.deepEqual(await betValues(),[],`No stale bets during ${stage}`)
  }
  await page.evaluate(()=>testUI.update(null,null))
  assert.deepEqual(await betValues(),[])
  report.checks.betsClearOnStreetCollectionPayoutIntermissionAndReset=true
  // Optional bet anchors preserve the original setTablePositions call shape.
  await page.evaluate(points=>testUI.setTablePositions({seats:[{seat:0,x:.085,y:.77},{seat:1,x:.14,y:.37},{seat:2,x:.86,y:.37},{seat:3,x:.915,y:.77}],pot:{x:.5,y:.385},bets:points}),betPoints)
  for(const [width,height] of [[1280,720],[960,600]]){
    await page.setViewportSize({width,height})
    for(const mode of ['NORMAL','MIRROR']){
      await apply({...blindState,seq:++seq,worldMode:mode},null)
      const labels=await page.locator('.mp-bet-amount:not([hidden])').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect(),style=getComputedStyle(node);return {seat:Number(node.dataset.seat),left:r.left,right:r.right,bottom:r.bottom,center:(r.left+r.right)/2,background:style.backgroundColor,color:style.color,pointerEvents:style.pointerEvents}}))
      labels.forEach(label=>{
        const point=betPoints.find(p=>p.seat===label.seat)
        assert.ok(Math.abs(label.center-point.x*width)<1)
        assert.ok(Math.abs(label.bottom-(point.y*height-(width<=1024&&height<=600?4:7)))<1,'Street total follows its projected anchor with the responsive card clearance')
        assert.ok(label.left>=0&&label.right<=width)
        assert.equal(label.background,'rgba(0, 0, 0, 0)')
        assert.equal(label.pointerEvents,'none')
        const rgb=label.color.match(/[\d.]+/g).map(Number)
        assert.ok(mode==='MIRROR'?Math.max(...rgb)<100:Math.min(...rgb)>180)
      })
      const transparentText=await page.evaluate(()=>{
        const surface=style=>({background:style.backgroundColor,image:style.backgroundImage,border:style.borderTopWidth,shadow:style.boxShadow,blur:style.backdropFilter,filter:style.filter,textShadow:style.textShadow})
        return [...document.querySelectorAll('.mp-pot,.mp-pot strong,.mp-pot .mp-small-label,.mp-bet-amount:not([hidden])')].map(node=>({node:node.className||node.tagName,style:surface(getComputedStyle(node)),pseudos:['::before','::after'].map(pseudo=>{const style=getComputedStyle(node,pseudo);return {content:style.content,...surface(style)}})}))
      })
      transparentText.forEach(node=>{
        assert.deepEqual(node.style,{background:'rgba(0, 0, 0, 0)',image:'none',border:'0px',shadow:'none',blur:'none',filter:'none',textShadow:'none'})
        node.pseudos.forEach(pseudo=>{
          assert.ok(['none','normal'].includes(pseudo.content),'Text has no generated visual layer')
          const {content,...style}=pseudo
          assert.deepEqual(style,node.style)
        })
      })
      report.checks[`transparentPotAndBets${mode}${width}`]=true
    }
  }
  await page.setViewportSize({width:1280,height:720})
  report.checks.betAnchorsResizeAndModeContrast=true
  await reset()
  const pairCards=['As','Ac','Kd','Qh','Js']
  const complete={...base,seq:++seq,stage:'COMPLETE',actorId:null,winners:[{playerId:'p1',amount:60,handName:'PAIR',cards:pairCards},{playerId:'p1',amount:20,handName:'PAIR',cards:pairCards}]}
  await apply(complete)
  await apply(complete)
  await page.evaluate(()=>testUI.event({handId:'hand-1',seq:100,eventId:'paid',type:'PAYOUT'}))
  assert.equal(await page.locator('.mp-last-winner').count(),1)
  assert.equal(await page.locator('.mp-last-winner-name').textContent(),'Vesper')
  assert.equal(await page.locator('.mp-last-hand-name').textContent(),'One pair')
  assert.deepEqual(await page.locator('.mp-last-card').evaluateAll(nodes=>nodes.map(node=>node.dataset.card)),pairCards)
  assert.equal((await page.locator('.mp-last-hand').textContent()).includes('wins'),false)
  assert.equal((await page.locator('.mp-last-hand').textContent()).includes('80'),false)
  assert.equal(await page.locator('.mp-match-result').isHidden(),true)
  report.checks.lastHandFallbackDeduplicatesSidePots=true
  const suitStyles=await page.locator('.mp-last-card').evaluateAll((nodes,palette)=>{
    const sample=document.createElement('span');document.body.appendChild(sample)
    const result=nodes.map(node=>{
      const appearance=palette[node.dataset.suit];sample.style.color=appearance.color
      const rank=node.querySelector('[data-card-rank]'),suit=node.querySelector('[data-card-suit]')
      return {card:node.dataset.card,suit:node.dataset.suit,color:getComputedStyle(node).color,rankColor:getComputedStyle(rank).stroke,suitColor:getComputedStyle(suit).fill,expectedColor:getComputedStyle(sample).color,label:node.getAttribute('aria-label'),expectedLabel:`${node.dataset.card[0]==='T'?'10':node.dataset.card[0]}${appearance.symbol}`,children:node.children.length,rank:rank.dataset.cardRank,printedSuit:suit.dataset.cardSuit,rankCount:node.querySelectorAll('[data-card-rank]').length,suitCount:node.querySelectorAll('[data-card-suit]').length,textCount:node.querySelectorAll('text').length,viewBox:node.querySelector('svg').getAttribute('viewBox')}
    });sample.remove();return result
  },CARD_SUITS)
  assert.equal(new Set(suitStyles.map(card=>card.suit)).size,4)
  suitStyles.forEach(card=>{
    assert.equal(card.color,card.expectedColor)
    assert.equal(card.rankColor,card.expectedColor)
    assert.equal(card.suitColor,card.expectedColor)
    assert.equal(card.label,card.expectedLabel)
    assert.equal(card.rank,card.card[0]==='T'?'10':card.card[0])
    assert.equal(card.printedSuit,card.suit)
    assert.equal(card.children,1,'LAST HAND uses one shared compact SVG')
    assert.equal(card.rankCount,1,'No repeated central rank')
    assert.equal(card.suitCount,1)
    assert.equal(card.textCount,0,'Rank and suit are vector paths, without font fallback')
    assert.equal(card.viewBox,'0 0 64 88')
  })
  assert.equal(await page.locator('.mp-last-card.is-red').count(),0)
  report.checks.lastHandSharedHeratexxVectorsAndFourSuitPalette=suitStyles
  const previousHand={handId:'hand-1',worldMode:'NORMAL',winners:[{...complete.winners[0],playerName:'Vesper remembered'},{...complete.winners[1],playerName:'Vesper remembered'}]}
  const nextState={...base,handId:'hand-2',seq:++seq,stage:'INTERMISSION',actorId:null,worldMode:'MIRROR',winners:[],previousHand,players:players.filter(p=>p.id!=='p1')}
  await apply(nextState,{...personal,handId:'hand-2',cards:[],legalActions:[]})
  await apply(nextState,{...personal,handId:'hand-2',cards:[],legalActions:[]})
  assert.equal(await page.locator('.mp-last-winner').count(),1)
  assert.equal(await page.locator('.mp-last-winner-name').textContent(),'Vesper remembered')
  assert.equal(await page.locator('.mp-last-hand').getAttribute('data-hand-id'),'hand-1')
  assert.equal(await page.locator('.mp-last-card').count(),5)
  report.checks.authoritativePreviousHandSurvivesResyncAndDeparture=true
  const splitResult={handId:'hand-split',worldMode:'NORMAL',winners:[
    {...complete.winners[0],playerName:'Vesper'},
    {...complete.winners[0],playerName:'Vesper',amount:40},
    {playerId:'p2',playerName:'Onyx',amount:40,handName:'PAIR',cards:pairCards},
    {playerId:'p3',playerName:'Scarlet',amount:100,handName:'FLUSH',cards:['2h','4h','8h','Th','Kh']},
  ]}
  await apply({...nextState,seq:++seq,previousHand:splitResult})
  assert.deepEqual(await page.locator('.mp-last-winner-name').allTextContents(),['Vesper','Onyx','Scarlet'])
  assert.equal(await page.locator('.mp-last-card').count(),15)
  const lastResult={handId:'hand-latest',worldMode:'MIRROR',winners:[{playerId:'p3',playerName:'Scarlet departed',amount:160,handName:'ROYAL_FLUSH',cards:['Ah','2h','3h','4h','5h']}]}
  await apply({...nextState,seq:++seq,previousHand:lastResult})
  assert.equal(await page.locator('.mp-last-winner').count(),1)
  assert.equal(await page.locator('.mp-last-winner-name').textContent(),'Scarlet departed')
  assert.equal(await page.locator('.mp-last-card').count(),5)
  assert.equal((await page.locator('.mp-last-hand').textContent()).includes('Vesper'),false)
  report.checks.lastHandReplacesHistoryAndListsSplitWinners=true
  const privateHand={...lastResult,handId:'hand-no-showdown',winners:[{playerId:'p3',playerName:'Scarlet',amount:100,handName:'UNCONTESTED',cards:pairCards}]}
  await apply({...nextState,seq:++seq,previousHand:privateHand,players:players.map(p=>({...p,cards:['2s','7d']}))})
  assert.equal(await page.locator('.mp-last-card').count(),0)
  assert.equal(await page.locator('.mp-last-hand-name').textContent(),'Uncontested')
  await apply({...nextState,seq:++seq,previousHand:{...privateHand,winners:[{...privateHand.winners[0],handName:'PAIR',cards:['As','Ac']}]}})
  assert.equal(await page.locator('.mp-last-card').count(),0)
  assert.equal(await page.locator('.mp-last-hand-name').textContent(),'Cards not revealed')
  await page.evaluate(()=>testUI.update(null,null))
  await apply({...nextState,seq:++seq,previousHand:lastResult})
  assert.equal(await page.locator('.mp-last-card').count(),5)
  assert.equal(await page.locator('.mp-last-winner-name').textContent(),'Scarlet departed')
  report.checks.uncontestedPrivacyAndReconnectRestoration=true
  assert.equal(await page.locator('.mp-ui').evaluate(node=>node.classList.contains('mp-mirror')),true)
  assert.deepEqual(await helpRanks(),[normalRanks,[...normalRanks].reverse()])
  assert.equal(await page.locator('.mp-world-meta,.mp-world-notice').count(),0)
  await apply({...nextState,seq:++seq,stage:'LOBBY'})
  assert.equal(await page.locator('.mp-help').isHidden(),true)
  await page.evaluate(()=>testUI.update(null,null))
  assert.equal(await page.locator('.mp-help').isHidden(),true)
  assert.equal(await page.locator('.mp-menu-brand').isVisible(),true)
  await page.evaluate(()=>testUI.setWorldMode('NORMAL'))
  await apply({...nextState,seq:++seq})
  assert.equal(await page.locator('.mp-ui').evaluate(node=>node.classList.contains('mp-mirror')),false,'Snapshot cannot bypass the presented-world override before the snap')
  await page.evaluate(()=>testUI.setWorldMode('MIRROR'))
  assert.equal(await page.locator('.mp-ui').evaluate(node=>node.classList.contains('mp-mirror')),true)
  assert.deepEqual(await helpRanks(),[normalRanks,[...normalRanks].reverse()],'Both reference tables stay correct in either presented world')
  await page.evaluate(()=>testUI.setWorldMode(null))
  report.checks.guideReferenceTablesAndPresentedWorld=true
  base.previousHand={...lastResult,winners:[{...lastResult.winners[0],handName:'PAIR',cards:pairCards}]}
  await reset()
  const controlBaselines={1280:{slider:485,sliderLeft:493,numberLeft:992,presetsLeft:1082,buttonsLeft:18},960:{slider:305,sliderLeft:397,numberLeft:716,presetsLeft:791,buttonsLeft:12},1920:{slider:1125,sliderLeft:493,numberLeft:1632,presetsLeft:1722,buttonsLeft:18}}
  for(const [width,height] of [[1280,720],[960,640],[1920,1080]]) for(const mode of ['NORMAL','MIRROR']) {
    await page.setViewportSize({width,height})
    await apply({...base,seq:++seq,worldMode:mode})
    await page.evaluate(()=>{for(const animation of document.querySelector('.mp-ui').getAnimations({subtree:true}))animation.finish()})
    const boxes=await page.evaluate(()=>{
      const box=selector=>{const r=(typeof selector==='string'?document.querySelector(selector):selector).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}}
      const icon=selector=>{const style=getComputedStyle(document.querySelector(selector));return {background:style.backgroundColor,color:style.color}}
      return {bar:box('.mp-bottom'),seats:[0,1,2,3].map(i=>box(`.mp-seat-${i}`)),seatLayouts:[...document.querySelectorAll('.mp-seat')].map(seat=>{const avatar=seat.querySelector('.mp-seat-avatar'),marker=seat.querySelector('.mp-seat-marker'),details=seat.querySelector('.mp-seat-details'),name=seat.querySelector('.mp-seat-name'),stack=seat.querySelector('.mp-seat-stack'),status=seat.querySelector('.mp-seat-status'),avatarStyle=getComputedStyle(avatar);return {box:box(seat),avatar:box(avatar),vector:box(avatar.querySelector('svg')),avatarSurface:{background:avatarStyle.backgroundColor,padding:avatarStyle.padding,border:avatarStyle.borderTopWidth},marker:box(marker),details:box(details),name:name.textContent,stack:stack.textContent,status:status.textContent,font:{name:parseFloat(getComputedStyle(name).fontSize),stack:parseFloat(getComputedStyle(stack).fontSize),status:parseFloat(getComputedStyle(status).fontSize)},statusInsideDetails:status.parentElement===details,vectorReady:avatar.querySelector('svg').getBBox().width>0}}),lastTitleAlign:getComputedStyle(document.querySelector('.mp-last-title')).textAlign,presets:box('.mp-bet-presets'),last:box('.mp-action-wager'),control:box('.mp-bet-control'),slider:box('.mp-slider'),sliderComputedWidth:parseFloat(getComputedStyle(document.querySelector('.mp-slider')).width),number:box('.mp-number'),buttons:[...document.querySelectorAll('.mp-action-buttons button')].map(box),mute:icon('.mp-mute'),exit:icon('.mp-exit'),horizontalOverflow:document.documentElement.scrollWidth>innerWidth}
    })
    boxes.seats.forEach(seat=>{assert.ok(seat.left>=0 && seat.right<=width);assert.ok(seat.bottom<boxes.bar.top)})
    for(const seat of boxes.seatLayouts){
      assert.ok(seat.box.width<=(width<=1100?148:156),'Short panels shrink with their contents')
      assert.ok(Math.abs((seat.box.bottom-seat.box.top)-(width<=1100?68:74))<1)
      assert.ok(Math.abs(seat.avatar.width-(width<=1100?38:42))<1)
      assert.ok(Math.abs(seat.avatar.width-(seat.avatar.bottom-seat.avatar.top))<1,'Avatar frame is square')
      assert.ok(Math.abs(seat.vector.width-seat.avatar.width)<1&&Math.abs(seat.vector.left-seat.avatar.left)<1,'Canonical spade mark fills the available avatar box')
      assert.deepEqual(seat.avatarSurface,{background:'rgba(0, 0, 0, 0)',padding:'0px',border:'0px'},'No extra logo frame or nested square is added around the spade mark')
      assert.ok(seat.avatar.right<seat.marker.left&&seat.marker.right<seat.details.left,'Avatar, status bar and details follow the reference order')
      assert.ok(seat.details.width<=75,'Text column uses max-content instead of stretching over the old empty right half')
      assert.ok(Math.abs((seat.box.right-seat.details.right)-(width<=1100?7:9))<1,'Only panel padding and border remain to the right of the content')
      assert.equal(seat.statusInsideDetails,true)
      assert.equal(seat.vectorReady,true)
      assert.ok(seat.font.name>=9.5&&seat.font.stack>=22&&seat.font.status>=8.5)
    }
    assert.deepEqual(boxes.seatLayouts.map(seat=>seat.name),['You','Vesper','Onyx','Scarlet'])
    const themeRGB=value=>value.match(/[\d.]+/g).slice(0,3).map(Number)
    if(mode==='NORMAL'){
      assert.ok(themeRGB(boxes.exit.color).every(value=>value>200))
    }else{
      assert.ok(themeRGB(boxes.exit.color).every(value=>value<100))
    }
    assert.deepEqual(await helpRanks(),[normalRanks,[...normalRanks].reverse()])
    assert.equal(boxes.lastTitleAlign,'right')
    const baseline=controlBaselines[width],half=baseline.slider/2
    assert.ok(Math.abs(boxes.slider.width-half)<=1,'Slider rectangle is exactly half the measured pre-v8 width')
    assert.ok(Math.abs(boxes.sliderComputedWidth-half)<=1,'Computed slider width is exactly half the measured pre-v8 width')
    assert.ok(Math.abs(boxes.slider.left-baseline.sliderLeft)<=1)
    assert.ok(Math.abs(boxes.number.left-(baseline.numberLeft-half))<=1,'Number field follows the shorter slider to the left')
    assert.ok(Math.abs(boxes.presets.left-(baseline.presetsLeft-half))<=1,'Presets follow the shorter slider to the left')
    assert.ok(Math.abs(boxes.buttons[0].left-baseline.buttonsLeft)<=1,'Actions remain anchored to the left edge')
    assert.ok(boxes.buttons[0].right<boxes.buttons[1].left&&boxes.buttons[1].right<boxes.buttons[2].left)
    assert.ok(boxes.control.left>boxes.last.right)
    assert.ok(boxes.slider.right<boxes.number.left&&boxes.number.right<boxes.presets.left)
    assert.equal(boxes.horizontalOverflow,false)
    assert.ok(boxes.presets.right<=width)
    if(mode==='MIRROR')for(const control of [boxes.mute,boxes.exit]){
      assert.ok(control.background.match(/[\d.]+/g).slice(0,3).map(Number).every(value=>value>230),'MIRROR top controls have light surfaces')
      assert.ok(control.color.match(/[\d.]+/g).slice(0,3).map(Number).every(value=>value<100),'MIRROR top symbols/text remain dark')
    }
    await capture(`table-ui-${mode.toLowerCase()}-${width}${height===640?'x640':''}`)
    const vectorLastHand=await page.locator('.mp-last-card').evaluateAll(nodes=>nodes.map(node=>{const rank=node.querySelector('[data-card-rank]'),suit=node.querySelector('[data-card-suit]');return {card:node.dataset.card,suit:node.dataset.suit,rank:rank.dataset.cardRank,printedSuit:suit.dataset.cardSuit,rankStroke:getComputedStyle(rank).stroke,suitFill:getComputedStyle(suit).fill}}))
    assert.deepEqual(vectorLastHand.map(card=>card.card),pairCards)
    assert.equal(new Set(vectorLastHand.map(card=>card.suit)).size,4)
    for(const card of vectorLastHand){assert.equal(card.rankStroke,card.suitFill);assert.equal(card.rank,suitStyles.find(sample=>sample.card===card.card).rank);assert.equal(card.printedSuit,card.suit);assert.equal(card.suitFill,suitStyles.find(sample=>sample.card===card.card).expectedColor)}
    report.checks[`vectorLastHand${mode}${width}`]=vectorLastHand
    report.checks[`halfSliderLeftControlsAndTheme${mode}${width}x${height}`]={baselineSliderWidth:baseline.slider,...boxes}
    await apply({...base,seq:++seq,worldMode:mode,players:players.map((player,index)=>({...player,stack:index?player.stack:1000000}))})
    const fullStack=await page.locator('.mp-seat-0 .mp-seat-stack').evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);const text=range.getBoundingClientRect(),details=node.parentElement.getBoundingClientRect();return {text:node.textContent,left:text.left,right:text.right,columnLeft:details.left,columnRight:details.right,overflow:getComputedStyle(node).overflow}})
    assert.equal(fullStack.text,'1,000,000')
    assert.ok(fullStack.left>=fullStack.columnLeft&&fullStack.right<=fullStack.columnRight+1,'Large stack remains complete inside the compact column')
    assert.equal(fullStack.overflow,'visible')
    report.checks[`completeLargeStack${mode}${width}`]=fullStack
  }
  await page.setViewportSize({width:960,height:600})
  const longName='Alexandria Long Player Name'
  await apply({...base,seq:++seq,players:players.map((player,index)=>({...player,name:index?player.name:longName,stack:index?player.stack:1000000}))})
  const completeName=await page.locator('.mp-seat-0 .mp-seat-name').evaluate(node=>{const text=node.getBoundingClientRect(),details=node.parentElement.getBoundingClientRect(),style=getComputedStyle(node);return {text:node.textContent,accessible:node.getAttribute('aria-label'),title:node.title,left:text.left,right:text.right,columnLeft:details.left,columnRight:details.right,overflow:style.overflow,ellipsis:style.textOverflow}})
  assert.equal(completeName.text,longName)
  assert.equal(completeName.accessible,longName)
  assert.equal(completeName.title,longName)
  assert.equal(completeName.overflow,'hidden')
  assert.equal(completeName.ellipsis,'ellipsis')
  assert.ok(completeName.left>=completeName.columnLeft&&completeName.right<=completeName.columnRight+1,'Long names remain in the bounded column with the full name accessible')
  report.checks.longNameEllipsisWithFullAccessibleName=completeName
  await apply({...base,seq:++seq,worldMode:'MIRROR'})
  const mirrorStyles=await page.evaluate(()=>{
    const seat=document.querySelector('.mp-seat-0'),style=getComputedStyle(seat)
    return {background:style.backgroundColor,name:getComputedStyle(seat.querySelector('.mp-seat-name')).color,stack:getComputedStyle(seat.querySelector('.mp-seat-stack')).color}
  })
  const channels=value=>value.match(/[\d.]+/g).map(Number)
  assert.ok(channels(mirrorStyles.background).slice(0,3).every(channel=>channel>=235))
  assert.ok(channels(mirrorStyles.background)[3]>=.9)
  assert.ok(channels(mirrorStyles.name).every(channel=>channel<65))
  assert.ok(channels(mirrorStyles.stack).every(channel=>channel<65))
  assert.equal(await page.locator('.mp-seat-badge').count(),0)
  await capture('mirror-last-hand-960')
  report.checks.mirrorWhiteSeatsAndBlackText=mirrorStyles
  for(const mode of ['NORMAL','MIRROR']) {
    const seatState={...base,seq:++seq,worldMode:mode,players:[{...players[0],stack:0,allIn:true},{...players[1],stack:321,cards:['Qh','Js']},{...players[2],stack:1900}],match:{status:'PLAYING',placements:[{playerId:'p1',place:4,reason:'eliminated'},{playerId:'p2',place:1,reason:'winner'}],winnerId:'p2'}}
    await page.evaluate(({state,self})=>{window.seatSnapshot=state;testUI.update(state,self)},{state:seatState,self:personal})
    assert.equal(await page.locator('.mp-seat-0').isVisible(),true,'Live all-in with zero chips retains its player panel')
    assert.equal(await page.locator('.mp-seat-0 .mp-seat-status').textContent(),'ALL IN')
    assert.equal(await page.locator('.mp-seat-1').isHidden(),true,'An authoritative elimination hides even a positive-stack panel')
    assert.equal(await page.locator('.mp-seat-2').isVisible(),true,'Winner placement does not hide the winner panel')
    assert.equal(await page.locator('.mp-seat-3').isHidden(),true,'An empty seat remains hidden')
    assert.deepEqual(await page.evaluate(()=>({count:seatSnapshot.players.length,cards:seatSnapshot.players.find(p=>p.id==='p1').cards})),{count:3,cards:['Qh','Js']},'UI visibility must not remove a player or their public revealed cards')
    await apply({...seatState,seq:++seq})
    assert.equal(await page.locator('.mp-seat-1').isHidden(),true,'Resync keeps the eliminated panel absent')
    assert.equal(await page.locator('.mp-seat-0').isVisible(),true)
    await page.locator('.mp-help').click()
    const rows=await page.locator('.mp-help-player').evaluateAll(nodes=>nodes.map(node=>({id:node.dataset.playerId,place:node.querySelector('.mp-help-place').textContent,status:node.querySelector('.mp-help-status').textContent,stack:node.querySelector('.mp-help-stack').textContent,winning:node.classList.contains('is-winning-place')})))
    assert.deepEqual(rows.map(row=>row.id),['p2','p0','p1'],'Chip leader sorts first; an authoritative elimination sorts last')
    assert.equal(rows.find(row=>row.id==='p0').status,'IN · ALL IN','A live zero-stack all-in remains in the tournament')
    assert.equal(rows.find(row=>row.id==='p1').status,'OUT')
    assert.equal(rows.find(row=>row.id==='p1').stack,'0')
    assert.equal(rows.find(row=>row.id==='p2').status,'WINNER')
    assert.deepEqual(rows.filter(row=>row.winning).map(row=>row.place),['1'],'Only first place uses the winning color')
    assert.match(await page.locator('.mp-help-prize').textContent(),/1 winner.*1st place only/)
    await page.locator('.mp-help-close').click()
    report.checks[`eliminatedSeatsAndLiveZeroStack${mode}`]=true
  }
  for(const mode of ['NORMAL','MIRROR']) for(const place of [4,3,2,1]) {
    const handId=`result-${mode}-${place}`,resultSelf={...personal,handId}
    const resultState={...base,handId,seq:++seq,stage:place===1?'COMPLETE':base.stage,worldMode:mode,match:{status:place===1?'FINISHED':'PLAYING',placements:[{playerId:'p0',place,reason:place===1?'winner':'eliminated'}],winnerId:place===1?'p0':null}}
    await apply(resultState,resultSelf)
    assert.equal(await page.locator('.mp-match-result').isHidden(),true,'Placement alone must leave final cards unobscured')
    assert.equal(await page.locator('.mp-bottom').isVisible(),true)
    if(place===1) assert.equal(await page.locator('.mp-turn-caption').textContent(),'FINAL HAND · SHOWDOWN','A finished match cannot promise an automatic next hand while final cards are shown')
    assert.equal(await page.evaluate(async()=>{let mutations=0;const observer=new MutationObserver(records=>{mutations+=records.length});observer.observe(document.querySelector('.mp-ui'),{attributes:true,subtree:true});for(let i=0;i<100;i++)testUI.setResultReady(null);await Promise.resolve();observer.disconnect();return mutations}),0,'Repeated null readiness from the render loop is a DOM no-op')
    assert.equal(await page.locator('.mp-action-buttons button:not([disabled])').count(),0,'Placement blocks actions before result readiness')
    assert.equal(await page.locator('.mp-slider').isDisabled(),true)
    assert.equal(await page.locator('.mp-number').isDisabled(),true)
    assert.equal(await page.locator('.mp-bet-presets button:not([disabled])').count(),0)
    const actionCount=await page.evaluate(()=>records.actions.length)
    await page.evaluate(()=>{for(const button of document.querySelectorAll('.mp-action-buttons button'))button.click()})
    assert.equal(await page.evaluate(()=>records.actions.length),actionCount)
    await page.evaluate(()=>testUI.setResultReady('stale-hand'))
    assert.equal(await page.locator('.mp-match-result').isHidden(),true)
    await page.evaluate(id=>testUI.setResultReady(id),handId)
    assert.equal(await page.locator('.mp-match-result').isVisible(),true)
    assert.equal(await page.locator('.mp-bottom').isHidden(),true)
    assert.equal(await page.locator('.mp-result-card h2').textContent(),`You placed #${place}`)
    if(place===1) assert.match(await page.locator('.mp-result-description').textContent(),/Congratulations on your victory/)
    assert.equal(await page.evaluate(async id=>{let mutations=0;const observer=new MutationObserver(records=>{mutations+=records.length});observer.observe(document.querySelector('.mp-ui'),{attributes:true,subtree:true});for(let i=0;i<100;i++)testUI.setResultReady(id);await Promise.resolve();observer.disconnect();return mutations},handId),0,'Repeated ready hand is a DOM no-op')
    await apply({...resultState,seq:++seq},resultSelf)
    await page.evaluate(()=>window.dispatchEvent(new Event('resize')))
    assert.equal(await page.locator('.mp-match-result').isVisible(),true,'Duplicate readiness, same-hand resync and resize keep the result ready')
    await page.evaluate(()=>testUI.setResultReady('older-result'))
    assert.equal(await page.locator('.mp-match-result').isVisible(),true,'A stale callback cannot close a newer ready result')
    await page.evaluate(()=>testUI.setResultReady(null))
    assert.equal(await page.locator('.mp-match-result').isHidden(),true)
    assert.equal(await page.locator('.mp-action-buttons button:not([disabled])').count(),0)
    await apply({...resultState,seq:++seq},resultSelf)
    assert.equal(await page.locator('.mp-match-result').isHidden(),true,'A same-hand snapshot cannot restore explicitly cleared readiness')
    await page.evaluate(id=>testUI.setResultReady(id),handId)
    report.checks[`explicitResultReadiness${mode}Place${place}`]=true
  }
  await capture('match-victory-960')
  const finalHand='result-MIRROR-1',finalSelf={...personal,handId:finalHand},finalState={...base,handId:finalHand,worldMode:'MIRROR',seq:++seq,match:{status:'FINISHED',placements:[{playerId:'p0',place:1,reason:'winner'}],winnerId:'p0'}}
  await page.locator('.mp-replay').click()
  assert.equal(await page.locator('.mp-match-result').isHidden(),true)
  await apply(finalState,finalSelf)
  assert.equal(await page.locator('.mp-match-result').isHidden(),true,'Replay clears readiness even when the callback has not supplied a new snapshot')
  await page.evaluate(id=>testUI.setResultReady(id),finalHand)
  await page.locator('.mp-result-leave').click()
  assert.equal(await leaveDialog.isVisible(),true)
  assert.equal(await page.locator('.mp-match-result').isVisible(),true,'Opening confirmation preserves the result')
  await page.locator('.mp-confirm-stay').click()
  assert.equal(await page.locator('.mp-match-result').isVisible(),true,'Stay preserves result readiness')
  assert.equal(await page.locator('.mp-result-leave').evaluate(node=>node===document.activeElement),true)
  await page.locator('.mp-result-leave').click()
  await page.evaluate(()=>{document.querySelector('.mp-confirm-leave').click();document.querySelector('.mp-confirm-leave').click();document.querySelector('.mp-exit').click()})
  assert.equal(await leaveDialog.isVisible(),false)
  assert.equal(await page.evaluate(()=>records.leave),1,'Confirm calls Leave exactly once and blocks another pending exit')
  assert.equal(await page.locator('.mp-match-result').isHidden(),true)
  await apply({...finalState,seq:++seq},finalSelf)
  assert.equal(await page.locator('.mp-match-result').isHidden(),true,'Leave clears readiness before its callback')
  await page.evaluate(id=>testUI.setResultReady(id),finalHand)
  await apply({...finalState,seq:++seq,match:{status:'PLAYING',placements:[],winnerId:null}},finalSelf)
  assert.equal(await page.locator('.mp-match-result').isHidden(),true)
  await page.evaluate(()=>testUI.update(null,null))
  await apply({...finalState,seq:++seq,match:{status:'PLAYING',placements:[],winnerId:null}},finalSelf)
  await page.locator('.mp-exit').click()
  assert.equal(await leaveDialog.isVisible(),true)
  assert.equal(await page.evaluate(()=>records.leave),1)
  await page.locator('.mp-confirm-leave').click()
  await apply({...finalState,seq:++seq},finalSelf)
  assert.equal(await page.locator('.mp-match-result').isHidden(),true)
  assert.equal(await page.evaluate(()=>records.replay),1)
  assert.equal(await page.evaluate(()=>records.leave),2)
  report.checks.matchPlacementReplayAndLeaveResetReadiness=true
  await page.evaluate(id=>testUI.setResultReady(id),finalHand)
  const nextResult={...finalState,handId:'new-result',seq:++seq}
  await apply(nextResult,{...finalSelf,handId:nextResult.handId})
  assert.equal(await page.locator('.mp-match-result').isHidden(),true,'Changing hand invalidates readiness')
  await page.evaluate(id=>testUI.setResultReady(id),finalHand)
  assert.equal(await page.locator('.mp-match-result').isHidden(),true,'An old hand callback cannot open the new hand result')
  await page.evaluate(id=>testUI.setResultReady(id),nextResult.handId)
  await page.evaluate(()=>testUI.update(null,null))
  await page.evaluate(()=>testUI.setResultReady('new-result'))
  await apply({...nextResult,seq:++seq},{...finalSelf,handId:nextResult.handId})
  assert.equal(await page.locator('.mp-match-result').isHidden(),true,'Null state clears readiness and rejects callbacks received in the menu')
  await apply({...nextResult,seq:++seq,match:{status:'PLAYING',placements:[],winnerId:null}},{...finalSelf,handId:nextResult.handId})
  await page.evaluate(id=>testUI.setResultReady(id),nextResult.handId)
  assert.equal(await page.locator('.mp-match-result').isHidden(),true,'Readiness alone cannot create a placement')
  report.checks.staleHandNullStateAndNoPlacementCannotShowResult=true
  await page.evaluate(()=>testUI.update(null,null))
  assert.equal(await page.locator('.mp-last-winner').count(),0)
  assert.equal(await page.locator('.mp-last-hand').isHidden(),true)
  assert.equal(await page.locator('.mp-match-result').isHidden(),true)
  report.checks.resetClearsLastHand=true
  assert.deepEqual(report.avatarAssetRequests,[],'Inline avatars issue no image request even while the old SVG URL is deliberately unavailable')
  report.checks.avatarAsset404HasNoRequests=true
  assert.deepEqual(report.errors,[])
  console.log(JSON.stringify(report,null,2))
} finally {
  await browser.close()
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2))
}

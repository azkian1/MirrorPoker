import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(resolve(root,'.test-output'), {recursive:true})
const build = spawnEsbuild(['tests/core-entry.ts','--bundle','--platform=node','--format=esm','--outfile=.test-output/core-bundle.mjs'],{cwd:root,encoding:'utf8'})
assert.equal(build.status,0,build.stderr)
const {PokerEngine,evaluate,compareHands,HandRanking,chooseBotAction,Table,Player,BettingRound,BettingAction,Action,toVendorCard} = await import('../.test-output/core-bundle.mjs')
const cards = text => text.split(' ')
const ev = (text,mode='NORMAL') => evaluate(cards(text),mode)
const rng = seed => () => ((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296)
function rigged(...drawHands) {
    let current=[...'cdhs'].flatMap(suit=>[...'23456789TJQKA'].map(rank=>rank+suit))
    const samples=Array(51).fill(.9999) // Deck constructor's shuffle keeps the initial order.
    for(const draw of drawHands) {
        const desired=[...current.filter(card=>!draw.includes(card)),...draw.toReversed()]
        for(let i=51;i>0;i--) {
            const j=current.indexOf(desired[i])
            assert.ok(j<=i)
            samples.push((j+.25)/(i+1))
            ;[current[i],current[j]]=[current[j],current[i]]
        }
    }
    return ()=>samples.length?samples.shift():.9999
}
const chips = engine => {const s=engine.getPublicState();return s.pot+s.players.reduce((n,p)=>n+p.stack,0)}
function passive(engine) {
    for(let guard=0;guard<100;guard++) {
        const state=engine.getPublicState()
        if(state.stage==='COMPLETE') return
        assert.ok(state.actorId)
        const legal=engine.getPrivateState(state.actorId).legalActions
        engine.act(state.actorId,{type:legal.some(a=>a.type==='check')?'check':'call'})
    }
    assert.fail('Hand did not complete')
}
function fixtureTable(stacks, draw) {
    const table=new Table({blinds:{small:10,big:20}},4,deck=>{
        const chosen=draw.map(toVendorCard)
        const ids=new Set(draw)
        const remaining=deck.filter(card=>!ids.has('23456789TJQKA'[card.rank]+'cdhs'[card.suit]))
        deck.splice(0,52,...remaining,...chosen.reverse())
    })
    stacks.forEach((stack,seat)=>table.sitDown(seat,stack))
    table.startHand(0)
    return table
}
function finishTable(table,mode='NORMAL') {
    for(let guard=0;table.handInProgress()&&guard<100;guard++) {
        if(table.bettingRoundInProgress()) {
            const legal=table.legalActions()
            table.actionTaken(legal.action&Action.CHECK?Action.CHECK:Action.CALL)
        } else if(!table.bettingRoundsCompleted()) table.endBettingRound()
        else table.showdown(mode)
    }
    assert.equal(table.handInProgress(),false)
}

test('all ten physical straights and straight flushes follow the approved table',()=>{
    const sequences=['A2345','23456','34567','45678','56789','6789T','789TJ','89TJQ','9TJQK','TJQKA']
    for(const mode of ['NORMAL','MIRROR']) {
        let previous
        let previousFlush
        sequences.forEach((sequence,index)=>{
            const normal=sequence.split('').map((rank,i)=>rank+'cdhsc'[i])
            const flush=sequence.split('').map(rank=>rank+'s')
            const hand=evaluate(normal,mode)
            const suited=evaluate(flush,mode)
            assert.equal(hand.category,HandRanking.STRAIGHT)
            assert.equal(suited.category,index===(mode==='NORMAL'?9:0)?HandRanking.ROYAL_FLUSH:HandRanking.STRAIGHT_FLUSH)
            if(previous) assert.equal(Math.sign(compareHands(hand,previous)),mode==='NORMAL'?1:-1)
            if(previousFlush) assert.equal(Math.sign(compareHands(suited,previousFlush)),mode==='NORMAL'?1:-1)
            previous=hand;previousFlush=suited
        })
    }
})

test('category, kickers, suits, two triples, quads and best five of seven',()=>{
    const quads=ev('2c 2d 2h 2s Ac Kd Qh','MIRROR')
    assert.equal(quads.category,HandRanking.FOUR_OF_A_KIND)
    assert.ok(quads.cards.includes('Qh'),'Mirror quad kicker must be Q, not A')
    assert.ok(compareHands(quads,ev('Ac Ad Ah As 2c 3d 4h','MIRROR'))>0)
    assert.equal(ev('Ac Ad Ah Kc Kd Kh 2s').category,HandRanking.FULL_HOUSE)
    assert.equal(ev('Ac Ad Ah Kc Kd Kh 2s','MIRROR').category,HandRanking.FULL_HOUSE)
    assert.ok(compareHands(ev('2c 2d Ah Ks Qc','MIRROR'),ev('Ac Ad 2h 3s 4c','MIRROR'))>0)
    assert.ok(compareHands(ev('Ac Ad Kc Qd 9h'),ev('As Ah Ks Qh 8c'))>0)
    assert.equal(compareHands(ev('Ac Kd Qh Js 9c'),ev('As Kh Qd Jc 9h')),0)
    assert.ok(compareHands(ev('Ac Ad Ah Ks Kh','MIRROR'),ev('2c 4c 6c 8c Tc','MIRROR'))>0)
    assert.equal(ev('Ac 2c 3c 4c 5c 6c 7d','MIRROR').category,HandRanking.ROYAL_FLUSH)
    assert.equal(ev('Ac 2c 3c 4c 5c 6c 7d').category,HandRanking.STRAIGHT_FLUSH)
    assert.throws(()=>ev('Ac Ac Kd Qh Js'))
})

test('invalid and out-of-turn actions do not mutate state, hands or event queue',()=>{
    const engine=new PokerEngine({random:rng(11)})
    engine.joinPlayer('a','A');engine.joinPlayer('b','B');engine.startHand();engine.drainEvents()
    const before=JSON.stringify(engine.getPublicState())
    const actor=engine.getPublicState().actorId
    for(const [id,action] of [[actor,{type:'raise',amount:21}],[actor,{type:'call',amount:0}],['other',{type:'fold'}],['b',{type:'bet',amount:NaN}]]) {
        assert.throws(()=>engine.act(id,action))
        assert.equal(JSON.stringify(engine.getPublicState()),before)
        assert.deepEqual(engine.drainEvents(),[])
    }
})

test('tournament blind changes post the active level and set legal minimums only on the next hand',()=>{
    const engine=new PokerEngine({random:rng(83)})
    const independent=new PokerEngine()
    for(let seat=0;seat<4;seat++)engine.joinPlayer('p'+seat,'Player '+seat)
    let state=engine.getPublicState()
    assert.deepEqual([state.smallBlind,state.bigBlind,state.minRaise],[10,20,20])
    assert.ok(state.players.every(player=>player.stack===1000))
    const assertLevel=(small,big)=>{
        const state=engine.getPublicState()
        assert.deepEqual([state.smallBlind,state.bigBlind,state.currentBet,state.minRaise],[small,big,big,big])
        assert.deepEqual(state.players.map(player=>player.bet).filter(Boolean).sort((a,b)=>a-b),[small,big])
        assert.equal(state.pot,small+big)
        assert.equal(engine.getPrivateState(state.actorId).legalActions.find(action=>action.type==='raise').min,big*2)
        assert.equal(chips(engine),4000)
    }
    engine.setBlinds(25,50)
    assert.equal(engine.getPublicState().minRaise,50)
    assert.ok(engine.getPublicState().players.every(player=>player.stack===1000),'Changing the level never transfers chips')
    assert.equal(independent.getPublicState().bigBlind,20,'Levels are owned by each engine instance')
    engine.startHand()
    assertLevel(25,50)
    while(engine.getPublicState().stage==='PREFLOP') {
        state=engine.getPublicState()
        const legal=engine.getPrivateState(state.actorId).legalActions
        engine.act(state.actorId,{type:legal.some(action=>action.type==='check')?'check':'call'})
    }
    state=engine.getPublicState()
    assert.equal(state.stage,'FLOP')
    assert.equal(state.minRaise,50)
    assert.equal(engine.getPrivateState(state.actorId).legalActions.find(action=>action.type==='bet').min,50)
    passive(engine)
    engine.setBlinds(50,100)
    assert.equal(engine.getPublicState().minRaise,100,'A paid hand exposes the next configured minimum')
    engine.startHand('MIRROR')
    assertLevel(50,100)
    passive(engine)
    engine.prepareNextHand('NORMAL')
    engine.setBlinds(75,150)
    assert.equal(engine.getPublicState().stage,'INTERMISSION')
    engine.startHand()
    assertLevel(75,150)
    passive(engine)
    assert.equal(chips(engine),4000)
})

test('invalid or mid-hand blind changes preserve public/private state and queued events',()=>{
    const engine=new PokerEngine({random:rng(91)})
    engine.joinPlayer('a','A');engine.joinPlayer('b','B')
    const invalid=[[0,20],[-10,20],[10,0],[20,20],[40,20],[1.5,20],[10,20.5],
        [NaN,20],[10,Infinity],[Number.MAX_SAFE_INTEGER+1,20],[10,Number.MAX_SAFE_INTEGER+1],['10',20],[10,null]]
    engine.drainEvents()
    const assertUnchanged=(changes)=>{
        const before=engine.getPublicState()
        const privateBefore=['a','b'].map(id=>engine.getPrivateState(id))
        for(const [small,big] of changes) {
            assert.throws(()=>engine.setBlinds(small,big))
            assert.deepEqual(engine.getPublicState(),before)
            assert.deepEqual(['a','b'].map(id=>engine.getPrivateState(id)),privateBefore)
            assert.deepEqual(engine.drainEvents(),[])
        }
    }
    assertUnchanged(invalid)
    engine.startHand()
    engine.drainEvents()
    assertUnchanged([[25,50],[10,20],...invalid])
    passive(engine)
    engine.drainEvents()
    assertUnchanged(invalid)
})

test('increased blinds cap forced bets to remaining stacks and preserve all-in eligibility',()=>{
    const engine=new PokerEngine({random:rng(72)})
    engine.joinPlayer('a','A');engine.joinPlayer('b','B')
    engine.setBlinds(600,1200)
    engine.startHand()
    const state=engine.getPublicState()
    assert.deepEqual([state.smallBlind,state.bigBlind],[600,1200])
    assert.deepEqual(state.players.map(player=>[player.stack,player.bet,player.allIn]),[[400,600,false],[0,1000,true]])
    assert.equal(chips(engine),2000)
    assert.equal(engine.getPrivateState(state.actorId).legalActions.find(action=>action.type==='call').amount,400)
    engine.act(state.actorId,{type:'call'})
    assert.equal(engine.getPublicState().stage,'COMPLETE')
    assert.equal(engine.getPublicState().board.length,5)
    assert.equal(chips(engine),2000)
})

test('fold remains legal when check is available so authority can fold an expired turn',()=>{
    for(const stage of ['PREFLOP','FLOP']) {
        const engine=new PokerEngine({random:rng(93)})
        engine.joinPlayer('a','A');engine.joinPlayer('b','B');engine.startHand()
        engine.act(engine.getPublicState().actorId,{type:'call'})
        if(stage==='FLOP')engine.act(engine.getPublicState().actorId,{type:'check'})
        const before=engine.getPublicState()
        assert.equal(before.stage,stage)
        assert.ok(engine.getPrivateState(before.actorId).legalActions.some(action=>action.type==='check'))
        assert.ok(engine.getPrivateState(before.actorId).legalActions.some(action=>action.type==='fold'))
        engine.act(before.actorId,{type:'fold'})
        const after=engine.getPublicState()
        assert.equal(after.stage,'COMPLETE')
        assert.deepEqual(after.board,before.board)
        assert.equal(after.players.find(player=>player.id===before.actorId).folded,true)
        assert.equal(after.winners[0].handName,'UNCONTESTED')
        assert.equal(chips(engine),2000)
    }
})

test('NORMAL and MIRROR remain fixed on every street for 2–4 players, conserving chips and privacy',()=>{
    for(const mode of ['NORMAL','MIRROR']) for(let size=2;size<=4;size++) {
        const engine=new PokerEngine({random:rng(100+size)})
        for(let seat=0;seat<size;seat++)engine.joinPlayer(String(seat),'Player '+seat,seat>0)
        engine.startHand(mode)
        assert.equal(chips(engine),size*1000)
        assert.ok(engine.getPublicState().players.every(p=>!p.cards))
        assert.equal(engine.getPrivateState('0').cards.length,2)
        const originalCards=engine.getPrivateState('0').cards
        const leaked=engine.getPublicState(); leaked.players[0].stack=0; leaked.board.push('As')
        assert.equal(chips(engine),size*1000)
        const seen=new Set()
        for(let guard=0;guard<100;guard++) {
            const state=engine.getPublicState()
            seen.add(state.stage)
            assert.equal(state.worldMode,mode)
            assert.deepEqual(engine.getPrivateState('0').cards,originalCards)
            if(state.stage==='COMPLETE')break
            const legal=engine.getPrivateState(state.actorId).legalActions
            engine.act(state.actorId,{type:legal.some(a=>a.type==='check')?'check':'call'})
        }
        assert.deepEqual([...seen],['PREFLOP','FLOP','TURN','RIVER','COMPLETE'])
        assert.equal(chips(engine),size*1000)
        const events=engine.drainEvents()
        assert.equal(events.filter(e=>e.type==='WORLD_CHANGED').length,0)
        assert.equal(events.find(e=>e.type==='HAND_STARTED').worldMode,mode)
        assert.deepEqual(events.filter(e=>e.type==='STREET_CHANGED').map(e=>e.board.length),[3,4,5])
        assert.ok(events.every((event,i)=>i===0||event.seq>events[i-1].seq))
        assert.equal(new Set(events.map(e=>e.eventId)).size,events.length)
        assert.ok(events.filter(e=>e.type!=='PAYOUT').every(e=>!('cards'in e)))
        const nextMode=mode==='NORMAL'?'MIRROR':'NORMAL'
        engine.prepareNextHand(nextMode)
        engine.startHand(nextMode)
        assert.equal(engine.getPublicState().worldMode,nextMode)
        assert.equal(engine.getPublicState().handId,'hand-2')
    }
})

test('preparation clears paid cards before selection events and preserves the previous hand id until dealing',()=>{
    const engine=new PokerEngine({random:rng(32)})
    engine.joinPlayer('a','A');engine.joinPlayer('b','B');engine.drainEvents()
    engine.prepareNextHand('MIRROR')
    let events=engine.drainEvents()
    assert.deepEqual(events.map(e=>[e.type,e.handId,e.worldMode]),[
        ['HAND_PREPARED','hand-0','MIRROR'],['WORLD_CHANGED','hand-0','MIRROR']])
    let state=engine.getPublicState()
    assert.equal(state.stage,'INTERMISSION')
    assert.equal(state.worldMode,'MIRROR')
    assert.equal(state.actorId,null)
    assert.equal(state.pot,0)
    assert.ok(state.players.every(p=>p.sittingOut))
    assert.deepEqual(engine.getPrivateState('a').cards,[])
    engine.startHand(state.worldMode)
    assert.deepEqual(engine.drainEvents().slice(0,2).map(e=>[e.type,e.handId,e.worldMode]),[
        ['HAND_STARTED','hand-1','MIRROR'],['CARDS_DEALT','hand-1',undefined]])
    passive(engine)
    state=engine.getPublicState()
    assert.equal(state.board.length,5)
    assert.equal(engine.getPrivateState('a').cards.length,2)
    assert.ok(state.winners.length>0)
    engine.drainEvents()
    engine.prepareNextHand('NORMAL')
    events=engine.drainEvents()
    assert.deepEqual(events.map(e=>[e.type,e.handId,e.worldMode]),[
        ['HAND_PREPARED','hand-1','NORMAL'],['WORLD_CHANGED','hand-1','NORMAL']])
    assert.ok(events[1].seq>events[0].seq)
    state=engine.getPublicState()
    assert.equal(state.stage,'INTERMISSION')
    assert.equal(state.worldMode,'NORMAL')
    assert.equal(state.handId,'hand-1')
    assert.equal(state.actorId,null)
    assert.deepEqual(state.board,[])
    assert.deepEqual(state.winners,[])
    assert.ok(state.players.every(p=>p.sittingOut&&!p.cards&&p.bet===0&&p.totalBet===0&&!p.allIn&&!p.folded))
    for(const id of ['a','b']) {
        assert.deepEqual(engine.getPrivateState(id).cards,[])
        assert.deepEqual(engine.getPrivateState(id).legalActions,[])
    }
    engine.prepareNextHand('NORMAL') // Re-selecting the same mode does not invent a flip.
    assert.deepEqual(engine.drainEvents().map(e=>e.type),['HAND_PREPARED'])
    engine.startHand(state.worldMode)
    assert.equal(engine.getPublicState().handId,'hand-2')
    assert.equal(engine.getPublicState().worldMode,'NORMAL')
    assert.equal(engine.getPrivateState('a').cards.length,2)
})

test('invalid preparation, insufficient players and attempts during a live hand do not mutate state or events',()=>{
    const engine=new PokerEngine({random:rng(18)})
    engine.joinPlayer('a','A');engine.drainEvents()
    const unchanged=(operation)=>{
        const state=engine.getPublicState()
        const self=engine.getPrivateState('a')
        assert.throws(operation)
        assert.deepEqual(engine.getPublicState(),state)
        assert.deepEqual(engine.getPrivateState('a'),self)
        assert.deepEqual(engine.drainEvents(),[])
    }
    unchanged(()=>engine.prepareNextHand('MIRROR'))
    unchanged(()=>engine.startHand('MIRROR'))
    engine.joinPlayer('b','B');engine.drainEvents()
    unchanged(()=>engine.prepareNextHand('INVALID'))
    unchanged(()=>engine.startHand('INVALID'))
    engine.startHand('MIRROR');engine.drainEvents()
    for(const stage of ['PREFLOP','FLOP','TURN','RIVER']) {
        while(engine.getPublicState().stage!==stage) {
            const state=engine.getPublicState()
            const legal=engine.getPrivateState(state.actorId).legalActions
            engine.act(state.actorId,{type:legal.some(a=>a.type==='check')?'check':'call'})
        }
        engine.drainEvents()
        unchanged(()=>engine.prepareNextHand('NORMAL'))
        unchanged(()=>engine.startHand('NORMAL'))
        if(stage==='RIVER')passive(engine)
    }
})

test('all-in runouts and payouts use the mode selected before the first card',()=>{
    for(const mode of ['NORMAL','MIRROR']) {
        const engine=new PokerEngine({random:rigged(cards('2c 2d Ac Ad 6s 8h Tc Qd Kh'))})
        engine.joinPlayer('p0','P0');engine.joinPlayer('p1','P1')
        engine.prepareNextHand(mode)
        engine.drainEvents()
        engine.startHand(mode)
        while(engine.getPublicState().stage!=='COMPLETE')engine.act(engine.getPublicState().actorId,{type:'allIn'})
        const state=engine.getPublicState()
        assert.equal(state.worldMode,mode)
        assert.equal(state.winners.length,1)
        assert.equal(state.winners[0].playerId,mode==='MIRROR'?'p0':'p1')
        assert.equal(chips(engine),2000)
        const events=engine.drainEvents()
        assert.equal(events.filter(e=>e.type==='WORLD_CHANGED').length,0)
        assert.deepEqual(events.filter(e=>e.type==='STREET_CHANGED').map(e=>e.board.length),[3,4,5])
        assert.equal(events.find(e=>e.type==='HAND_STARTED').worldMode,mode)
        assert.throws(()=>engine.prepareNextHand(mode==='NORMAL'?'MIRROR':'NORMAL'))
        assert.deepEqual(engine.getPublicState(),state,'A finished match retains its paid cards until restart')
        assert.deepEqual(engine.drainEvents(),[])
    }
})

test('fold wins with multiple contribution caps preserve the preflop/flop/turn board and never emit showdown',()=>{
    for(const mode of ['NORMAL','MIRROR'])for(const size of [2,3,4])for(const stage of ['PREFLOP','FLOP','TURN']){
        const engine=new PokerEngine({random:rng(340)})
        for(let i=0;i<size;i++)engine.joinPlayer('p'+i,'P'+i)
        engine.startHand(mode)
        for(let guard=0;engine.getPublicState().stage!==stage&&guard<30;guard++){
            const state=engine.getPublicState(),legal=engine.getPrivateState(state.actorId).legalActions
            engine.act(state.actorId,{type:legal.some(a=>a.type==='check')?'check':'call'})
        }
        const before=engine.getPublicState()
        assert.equal(before.stage,stage)
        assert.equal(before.board.length,{PREFLOP:0,FLOP:3,TURN:4}[stage])
        engine.drainEvents()
        if(stage==='PREFLOP')engine.act(before.actorId,{type:'raise',amount:200})
        else{
            engine.act(before.actorId,{type:'bet',amount:40})
            engine.act(engine.getPublicState().actorId,{type:'raise',amount:200})
        }
        for(let guard=0;engine.getPublicState().stage!=='COMPLETE'&&guard<4;guard++)engine.act(engine.getPublicState().actorId,{type:'fold'})
        const state=engine.getPublicState(),events=engine.drainEvents()
        assert.equal(state.stage,'COMPLETE')
        assert.equal(state.worldMode,mode)
        assert.deepEqual(state.board,before.board,'An uncontested hand must not deal another street')
        assert.equal(events.filter(e=>e.type==='STREET_CHANGED').length,0)
        assert.equal(events.filter(e=>e.type==='SHOWDOWN').length,0)
        assert.equal(events.at(-1).type,'PAYOUT')
        assert.equal(state.winners.length,1)
        assert.equal(state.winners[0].handName,'UNCONTESTED')
        assert.equal(state.winners[0].cards,undefined)
        assert.equal(state.winners[0].amount,stage==='PREFLOP'?(size===2?220:230):240+size*20,'Dead chips and unmatched raise caps all return through the same correct payout')
        assert.ok(state.players.every(player=>!player.cards))
        assert.equal(chips(engine),size*1000)
    }
})

test('two eligible all-in hands still run out all missing streets and reveal only eligible hands',()=>{
    for(const mode of ['NORMAL','MIRROR'])for(const stage of ['PREFLOP','FLOP','TURN']){
        const engine=new PokerEngine({random:rng(341)})
        for(let i=0;i<3;i++)engine.joinPlayer('p'+i,'P'+i)
        engine.startHand(mode)
        for(let guard=0;engine.getPublicState().stage!==stage&&guard<30;guard++){
            const state=engine.getPublicState(),legal=engine.getPrivateState(state.actorId).legalActions
            engine.act(state.actorId,{type:legal.some(a=>a.type==='check')?'check':'call'})
        }
        const before=engine.getPublicState()
        assert.equal(before.stage,stage)
        engine.drainEvents()
        engine.act(before.actorId,{type:'allIn'})
        engine.act(engine.getPublicState().actorId,{type:'fold'})
        engine.act(engine.getPublicState().actorId,{type:'allIn'})
        const state=engine.getPublicState(),events=engine.drainEvents()
        assert.equal(state.stage,'COMPLETE')
        assert.equal(state.board.length,5)
        assert.deepEqual(state.board.slice(0,before.board.length),before.board)
        assert.deepEqual(events.filter(e=>e.type==='STREET_CHANGED').map(e=>e.board.length),[3,4,5].filter(length=>length>before.board.length))
        assert.equal(events.filter(e=>e.type==='SHOWDOWN').length,1)
        assert.equal(events.at(-1).type,'PAYOUT')
        assert.equal(state.players.filter(player=>player.cards?.length===2).length,2)
        assert.ok(state.players.filter(player=>player.folded).every(player=>!player.cards))
        assert.ok(state.winners.every(winner=>winner.cards?.length===5&&winner.handName!=='UNCONTESTED'))
        assert.equal(chips(engine),3000)
    }
})

test('short all-in raise preserves full minimum and does not reopen an earlier caller',()=>{
    const players=[new Player(500),new Player(130),new Player(500)]
    const round=new BettingRound(players,0,20)
    round.actionTaken(BettingAction.RAISE,100)
    round.actionTaken(BettingAction.RAISE,130)
    assert.equal(round.minRaise(),100)
    assert.equal(round.legalActions().canRaise,true)
    assert.equal(round.legalActions().chipRange.min,230)
    round.actionTaken(BettingAction.MATCH)
    assert.equal(round.playerToAct(),0)
    assert.equal(round.legalActions().canRaise,false)
})

test('unequal all-ins distribute main/side pots using eligible hands and preserve odd chips',()=>{
    // P0 aces, P1 kings, P2 queens: main pot to P0; side to P1; uncalled 200 to P2.
    const table=fixtureTable([100,300,500],cards('Ac Ad Kc Kd Qc Qd 2s 5h 8c 9d Jh'))
    for(let guard=0;table.bettingRoundInProgress()&&guard<10;guard++) {
        const seat=table.playerToAct()
        const maximum=table.seats()[seat].totalChips()
        const legal=table.legalActions()
        table.actionTaken(legal.action&Action.RAISE?Action.RAISE:Action.CALL,maximum)
    }
    finishTable(table)
    assert.deepEqual(table.seats().slice(0,3).map(p=>p?.totalChips()??0),[300,400,200])
    const split=fixtureTable([101,301,501],cards('2c 3d 4c 6d 7c 8d Ts Js Qs Ks As'))
    finishTable(split)
    assert.equal(split.seats().reduce((n,p)=>n+(p?.totalChips()??0),0),903)
    assert.deepEqual(split.seats().slice(0,3).map(p=>p?.totalChips()),[101,301,501])
})

test('all-in remains eligible after multiple later betting streets',()=>{
    const table=fixtureTable([60,400,400,400],cards('Ac Ad Kc Kd Qc Qd Jc Jd 2s 5h 8c 9d Th'))
    while(table.bettingRoundInProgress()) {
        const seat=table.playerToAct()
        if(seat===0)table.actionTaken(Action.RAISE,60)
        else table.actionTaken(Action.CALL)
    }
    table.endBettingRound()
    // Three players continue betting after P0 is all-in.
    const first=table.playerToAct()
    table.actionTaken(Action.BET,40)
    assert.notEqual(table.playerToAct(),first)
    finishTable(table)
    assert.equal(table.seats()[0].totalChips(),240)
    assert.equal(table.seats().reduce((n,p)=>n+(p?.totalChips()??0),0),1260)
})

test('split main pot awards odd chip clockwise after the dealer',()=>{
    const table=fixtureTable([101,200,200],cards('2c 3d Kc Qd Kh Qs As Jc Tc 4h 7d'))
    table.actionTaken(Action.RAISE,101)
    table.actionTaken(Action.CALL)
    table.actionTaken(Action.CALL)
    finishTable(table)
    assert.deepEqual(table.seats().slice(0,3).map(p=>p?.totalChips()??0),[0,251,250])
})

test('a later fold removes eligibility from old main pot without donating an uncalled bet',()=>{
    const table=fixtureTable([100,300,500],cards('Ac Ad Kc Kd Qc Qd 2s 5h 8c 9d Jh'))
    table.actionTaken(Action.RAISE,100)
    table.actionTaken(Action.CALL)
    table.actionTaken(Action.CALL)
    table.endBettingRound()
    assert.equal(table.playerToAct(),1)
    table.actionTaken(Action.BET,50)
    table.actionTaken(Action.FOLD)
    finishTable(table)
    assert.deepEqual(table.seats().slice(0,3).map(p=>p?.totalChips()??0),[300,200,400])
})

test('short all-in blinds run out without forcing a zero-stack actor',()=>{
    for(const stacks of [[5,10],[10,5],[5,10,20]]) {
        const deck=stacks.length===2?cards('Ac Ad Kc Kd 2s 5h 8c 9d Jh'):cards('Ac Ad Kc Kd Qc Qd 2s 5h 8c 9d Jh')
        const table=fixtureTable(stacks,deck)
        finishTable(table)
        assert.equal(table.seats().reduce((sum,p)=>sum+(p?.totalChips()??0),0),stacks.reduce((a,b)=>a+b,0))
    }
})

test('a lone big blind already covering a short all-in blind runs out without a redundant fold opportunity',()=>{
    for(const mode of ['NORMAL','MIRROR']) {
        const table=fixtureTable([1,3999],cards('Ac Ad Kc Kd 2s 5h 8c 9d Jh'))
        assert.equal(table.bettingRoundInProgress(),false,'No opponent can call another bet and the big blind owes nothing')
        finishTable(table,mode)
        assert.deepEqual(table.seats().slice(0,2).map(p=>p?.totalChips()??0),mode==='NORMAL'?[2,3998]:[0,4000])
    }
})

test('a lone solvent small blind still acts when a larger all-in big blind has not been matched',()=>{
    for(const action of [Action.CALL,Action.FOLD]) {
        const table=fixtureTable([15,20],cards('Ac Ad Kc Kd 2s 5h 8c 9d Jh'))
        assert.equal(table.bettingRoundInProgress(),true)
        assert.equal(table.playerToAct(),0)
        assert.ok(table.legalActions().action&Action.CALL)
        table.actionTaken(action)
        finishTable(table)
        assert.equal(table.seats().reduce((sum,p)=>sum+(p?.totalChips()??0),0),35)
    }
})

test('covered all-in calls finish without offering a fold that can orphan an unmatched blind',()=>{
    for(const mode of ['NORMAL','MIRROR']) {
        const table=fixtureTable([19,9,3972],cards('Ac Ad Kc Kd Qc Qd 2s 5h 8c 9d Jh'))
        assert.equal(table.playerToAct(),0)
        table.actionTaken(Action.CALL)
        assert.equal(table.bettingRoundInProgress(),false,'The funded BB already covers both surviving all-ins')
        assert.throws(()=>table.actionTaken(Action.FOLD),/Betting round must be in progress/)
        table.endBettingRound()
        assert.ok(table.pots().every(pot=>pot.eligiblePlayers().length>0))
        assert.equal(table.communityCards().cards().length,5)
        table.showdown(mode)
        assert.equal(table.seats().reduce((sum,p)=>sum+(p?.totalChips()??0),0),4000)
    }
})

test('legal tournament play reaches short all-ins safely while genuine free-check folds retain privacy',()=>{
    for(const mode of ['NORMAL','MIRROR']) {
        const second=mode==='NORMAL'?'Ac Ad Kc Kd Qc Qd 2s 5h 8c 9d Th':'2c 2d 3c 3d 4c 4d 6s 8h Tc 9d Kh'
        const engine=new PokerEngine({random:rigged(
            cards('Ac Ad Kc Kd Qc Qd Jc Jd 2s 5h 8c 9d Th'),cards(second))})
        for(let seat=0;seat<4;seat++)engine.joinPlayer('p'+seat,'P'+seat)
        engine.startHand(mode)
        for(const id of ['p3','p0','p1'])engine.act(id,{type:'fold'})
        engine.surrenderPlayer('p0')
        assert.deepEqual(engine.getPublicState().players.map(p=>p.stack),[0,1324,1343,1333])
        engine.drainEvents()
        engine.startHand(mode)
        engine.act('p1',{type:'allIn'});engine.act('p2',{type:'call'});engine.act('p3',{type:'call'})
        engine.act('p2',{type:'check'});engine.act('p3',{type:'check'})
        const free=engine.getPrivateState('p2').legalActions
        assert.ok(free.some(action=>action.type==='check')&&free.some(action=>action.type==='fold'))
        engine.act('p2',{type:'fold'})
        let state=engine.getPublicState()
        assert.deepEqual(state.players.map(p=>p.stack),[0,3972,19,9])
        assert.equal(state.players.find(p=>p.id==='p2').cards,undefined)
        assert.ok(state.winners.every(w=>w.playerId!=='p2'))
        assert.ok(engine.drainEvents().filter(event=>event.type==='PAYOUT').every(event=>
            event.winners.every(w=>w.playerId!=='p2')),'A folded hand must not become a refund winner or reveal its best five')
        engine.startHand(mode)
        assert.equal(engine.getPublicState().actorId,'p2')
        engine.drainEvents()
        engine.act('p2',{type:'allIn'})
        state=engine.getPublicState()
        assert.equal(state.stage,'COMPLETE')
        assert.equal(state.actorId,null)
        assert.equal(state.board.length,5)
        assert.equal(chips(engine)+engine.getForfeitedChips(),4000)
        assert.ok(state.winners.every(w=>!state.players.find(p=>p.id===w.playerId).folded))
        const events=engine.drainEvents()
        assert.equal(events.filter(event=>event.type==='PAYOUT').length,1)
        assert.equal(events.filter(event=>event.type==='PLAYER_ACTED'&&event.playerId==='p1').length,0)
        assert.throws(()=>engine.act('p1',{type:'fold'}),/Not this player/)
        assert.deepEqual(engine.getPublicState(),state)
        assert.deepEqual(engine.drainEvents(),[])
    }
})

test('short preflop big blinds preserve full bring-in and minimum raise for competing solvent players',()=>{
    for(const mode of ['NORMAL','MIRROR'])for(const size of [3,4])for(const short of [5,15]) {
        const stacks=[1000,1000,short,...(size===4?[1000]:[])]
        const draw=size===3?'Ac Ad Kc Kd Qc Qd 2s 5h 8c 9d Th':'Ac Ad Kc Kd Qc Qd Jc Jd 2s 5h 8c 9d Th'
        const table=fixtureTable(stacks,cards(draw))
        assert.equal(table.currentBet(),20)
        assert.equal(table.legalActions().chipRange.min,40)
        while(table.bettingRoundInProgress()) {
            assert.ok(table.legalActions().action&Action.CALL)
            table.actionTaken(Action.CALL)
        }
        assert.deepEqual(table.seats().map(p=>p?.betSize()??null),[20,20,short,...(size===4?[20]:[null])])
        table.endBettingRound()
        assert.equal(table.pots().reduce((sum,pot)=>sum+pot.size(),0),(size-1)*20+short)
        finishTable(table,mode)
        assert.equal(table.seats().reduce((sum,p)=>sum+(p?.totalChips()??0),0),stacks.reduce((a,b)=>a+b,0))
    }
})

test('a nominal bring-in shrinks to the real all-in call when only one solvent opponent remains',()=>{
    for(const mode of ['NORMAL','MIRROR'])for(const action of [Action.CALL,Action.FOLD]) {
        const table=fixtureTable([19,1000,5],cards('Ac Ad Kc Kd Qc Qd 2s 5h 8c 9d Jh'))
        assert.equal(table.currentBet(),20,'Two solvent players initially owe the full bring-in')
        table.actionTaken(Action.CALL)
        assert.equal(table.playerToAct(),1,'The SB still owes a genuine decision')
        assert.equal(table.currentBet(),19)
        assert.equal(table.currentBet()-table.seats()[1].betSize(),9,'The real call is nine chips, without unmatched excess')
        assert.ok(table.legalActions().action&Action.CALL)
        assert.ok(table.legalActions().action&Action.FOLD)
        table.actionTaken(action)
        assert.equal(table.bettingRoundInProgress(),false)
        if(action===Action.CALL)assert.equal(table.seats()[1].betSize(),19)
        table.endBettingRound()
        assert.ok(table.pots().every(pot=>pot.eligiblePlayers().length>0))
        if(action===Action.CALL) {
            assert.deepEqual(table.pots().map(pot=>pot.size()),[15,28])
            assert.ok(table.pots().every(pot=>pot.eligiblePlayers().length>1),'No extra self-only one-chip pot')
        }
        table.showdown(mode)
        assert.equal(table.seats().reduce((sum,p)=>sum+(p?.totalChips()??0),0),1024)
        if(action===Action.FOLD)assert.ok(table.winners().flat().every(([seat])=>seat!==1),'A folded hand is never revealed as a payout winner')
    }
    for(const mode of ['NORMAL','MIRROR']) {
        const table=fixtureTable([1000,1000,5],cards('Ac Ad Kc Kd Qc Qd 2s 5h 8c 9d Jh'))
        assert.equal(table.currentBet(),20)
        table.actionTaken(Action.FOLD)
        assert.equal(table.currentBet(),10,'The remaining SB already covers the real short blind')
        assert.equal(table.bettingRoundInProgress(),false,'A covered SB gets no artificial extra call or fold')
        finishTable(table,mode)
        assert.equal(table.seats().reduce((sum,p)=>sum+(p?.totalChips()??0),0),2005)
    }
})

test('entering heads-up after any three/four-player elimination avoids a consecutive surviving big blind',()=>{
    for(const mode of ['NORMAL','MIRROR'])for(const size of [3,4]) {
        const busts=size===3?[[0],[1],[2]]:[[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]]
        for(const eliminated of busts) {
            const survivors=Array.from({length:size},(_,seat)=>seat).filter(seat=>!eliminated.includes(seat))
            const winner=survivors.includes(2)?2:survivors[0]
            const folded=survivors.find(seat=>seat!==winner)
            const ranks=mode==='NORMAL'?['A','K','Q','J']:['2','3','4','5']
            const others=Array.from({length:size},(_,seat)=>seat).filter(seat=>seat!==winner)
            const holes=Array.from({length:size},(_,seat)=>{
                const rank=ranks[seat===winner?0:others.indexOf(seat)+1]
                return `${rank}c ${rank}d`
            })
            const board=mode==='NORMAL'?'2s 5h 8c 9d Th':'6s 8h Tc 9d Kh'
            const table=fixtureTable(Array(size).fill(1000),cards([...holes,board].join(' ')))
            while(table.bettingRoundInProgress()) {
                const actor=table.playerToAct()
                const legal=table.legalActions()
                table.actionTaken(actor===folded?Action.FOLD:legal.action&Action.RAISE?Action.RAISE:Action.CALL,1000)
            }
            finishTable(table,mode)
            assert.deepEqual(table.seats().map((p,seat)=>p?seat:null).filter(seat=>seat!==null),survivors)
            assert.equal(table.seats().reduce((sum,p)=>sum+(p?.totalChips()??0),0),size*1000)
            let lastBigBlind=2
            for(let hand=0;hand<2;hand++) {
                table.startHand()
                const button=table.button()
                const bigBlind=survivors.find(seat=>seat!==button)
                assert.notEqual(bigBlind,lastBigBlind,`${mode}, ${size} players, eliminated ${eliminated}, hand ${hand}`)
                assert.equal(table.seats()[button].betSize(),10)
                assert.equal(table.seats()[bigBlind].betSize(),20)
                assert.equal(table.playerToAct(),button)
                table.actionTaken(Action.CALL);table.actionTaken(Action.CHECK);table.endBettingRound()
                assert.equal(table.playerToAct(),bigBlind,'The BB acts first after the flop')
                finishTable(table,mode)
                lastBigBlind=bigBlind
            }
        }
    }
})

test('river short all-in calls or raises settle after the last required actor without an extra human turn',()=>{
    for(const mode of ['NORMAL','MIRROR']) for(const shortRaise of [false,true]) {
        // 80 contributed by each player before the river; short caller has 145 left.
        const shortStack=shortRaise?240:225
        const table=fixtureTable([1000,1000,1000,shortStack],cards('Ac Ad Kc Kd Qc Qd Jc Jd 2s 5h 8c 9d Th'))
        while(table.bettingRoundInProgress())table.actionTaken(table.legalActions().action&Action.CHECK?Action.CHECK:Action.CALL)
        table.endBettingRound()
        table.actionTaken(Action.BET,20)
        while(table.bettingRoundInProgress())table.actionTaken(Action.CALL)
        table.endBettingRound()
        table.actionTaken(Action.BET,40)
        while(table.bettingRoundInProgress())table.actionTaken(Action.CALL)
        table.endBettingRound()
        assert.equal(table.roundOfBetting(),5)
        assert.equal(table.playerToAct(),1)
        table.actionTaken(Action.BET,shortRaise?140:160)
        assert.equal(table.playerToAct(),2)
        table.actionTaken(Action.CALL)
        assert.equal(table.playerToAct(),3)
        table.actionTaken(shortRaise?Action.RAISE:Action.CALL,shortRaise?160:undefined)
        assert.equal(table.playerToAct(),0)
        table.actionTaken(Action.CALL)
        if(shortRaise) {
            assert.equal(table.playerToAct(),1)
            assert.equal(!!(table.legalActions().action&Action.RAISE),false)
            table.actionTaken(Action.CALL)
            assert.equal(table.playerToAct(),2)
            table.actionTaken(Action.CALL)
        }
        assert.equal(table.bettingRoundInProgress(),false)
        table.endBettingRound()
        assert.equal(table.bettingRoundsCompleted(),true)
        assert.equal(table.pots().reduce((sum,pot)=>sum+pot.size(),0),shortRaise?960:945)
        table.showdown(mode)
        assert.equal(table.handInProgress(),false)
        assert.equal(table.seats().reduce((sum,p)=>sum+(p?.totalChips()??0),0),3000+shortStack)
    }
})

test('sharedPot marks actual ties, not different main/side-pot winners',()=>{
    const split=new PokerEngine({random:rigged(cards('Kh Kd Qh Qd Ac 2c 3c 4c 5c'))})
    split.joinPlayer('p0','P0');split.joinPlayer('p1','P1');split.startHand();passive(split)
    assert.equal(split.getPublicState().winners.length,2)
    assert.ok(split.getPublicState().winners.every(w=>w.sharedPot===true))
    assert.ok(split.drainEvents().find(e=>e.type==='PAYOUT').winners.every(w=>w.sharedPot===true))

    const separate=new PokerEngine({random:rigged(
        cards('Ac Ad Kc Kd Qc Qd 2s 5h 8c 9d Jh'),
        cards('2c 2d Ac Ad 3c 3d 6s 8h Tc Qd Kh'))})
    for(let i=0;i<3;i++)separate.joinPlayer('p'+i,'P'+i)
    separate.startHand()
    separate.act('p0',{type:'raise',amount:500})
    separate.act('p1',{type:'call'})
    separate.act('p2',{type:'fold'})
    separate.act('p1',{type:'check'})
    separate.act('p0',{type:'fold'})
    assert.deepEqual(separate.getPublicState().players.map(p=>p.stack),[500,1520,980])
    separate.startHand('MIRROR')
    while(separate.getPublicState().stage!=='COMPLETE')separate.act(separate.getPublicState().actorId,{type:'allIn'})
    assert.deepEqual(separate.getPublicState().winners.map(w=>[w.playerId,w.amount]),[['p0',1500],['p1',540],['p2',960]])
    assert.ok(separate.getPublicState().winners.every(w=>!w.sharedPot))
    assert.equal(chips(separate),3000)
})

test('late join plays the next hand, leave/rejoin preserves an existing seat, and busted seats do not act',()=>{
    const engine=new PokerEngine({random:rigged(
        cards('2c 2d Ac Ad 6s 8h Tc Qd Kh'),
        cards('2c 2d Ac Ad 3c 3d 6s 8h Tc Qd Kh'))})
    engine.joinPlayer('p0','P0');engine.joinPlayer('p1','P1');engine.startHand('MIRROR')
    engine.joinPlayer('late','Late')
    assert.equal(engine.getPrivateState('late').cards.length,0)
    assert.deepEqual(engine.getPrivateState('late').legalActions,[])
    engine.leavePlayer('p1') // Not the actor; seat/hand are retained until the turn.
    engine.joinPlayer('p1','P1')
    assert.equal(engine.getPublicState().players.find(p=>p.id==='p1').connected,true)
    engine.act('p0',{type:'allIn'});engine.act('p1',{type:'allIn'})
    assert.equal(engine.getPublicState().players.find(p=>p.id==='p1').stack,0)
    engine.startHand()
    assert.equal(engine.getPrivateState('late').cards.length,2)
    assert.equal(engine.getPrivateState('p1').cards.length,0)
    assert.deepEqual(engine.getPrivateState('p1').legalActions,[])
    passive(engine)
    assert.equal(engine.getPublicState().players.find(p=>p.id==='p1').stack,0)
})

test('folds, one-player payouts, disconnects and join during hand never strand the actor',()=>{
    const engine=new PokerEngine({random:rng(17)})
    engine.joinPlayer('a','A');engine.joinPlayer('b','B');engine.startHand()
    engine.joinPlayer('c','C')
    engine.leavePlayer(engine.getPublicState().actorId)
    assert.equal(engine.getPublicState().stage,'COMPLETE')
    assert.equal(engine.getPublicState().winners.length,1)
    assert.equal(engine.getPublicState().winners[0].handName,'UNCONTESTED')
    assert.ok(engine.getPublicState().players.every(p=>!p.cards))
    engine.startHand();passive(engine)
    assert.equal(engine.getPublicState().stage,'COMPLETE')
})

test('a seat released after departure retains its real folded balance or eventual all-in payout on rejoin',()=>{
    const folded=new PokerEngine({random:rng(41)})
    for(let i=0;i<3;i++)folded.joinPlayer('p'+i,'P'+i)
    folded.startHand('NORMAL')
    folded.act('p0',{type:'raise',amount:200})
    folded.act('p1',{type:'call'})
    folded.act('p2',{type:'fold'})
    assert.equal(folded.getPublicState().stage,'FLOP')
    assert.equal(folded.getPublicState().players.find(p=>p.id==='p1').stack,800)
    folded.leavePlayer('p1') // Folds at its turn, then the paid hand releases this seat.
    assert.equal(folded.getPublicState().stage,'COMPLETE')
    assert.ok(folded.getPublicState().players.every(p=>p.id!=='p1'))
    folded.joinPlayer('p1','Reconnected')
    assert.equal(folded.getPublicState().players.find(p=>p.id==='p1').stack,800)
    assert.equal(chips(folded),3000)

    const allIn=new PokerEngine({random:rigged(cards('Ac Ad Kc Kd 2s 5h 8c 9d Jh'))})
    allIn.joinPlayer('p0','P0');allIn.joinPlayer('p1','P1')
    allIn.startHand('NORMAL')
    allIn.act('p0',{type:'allIn'})
    assert.equal(allIn.getPublicState().players.find(p=>p.id==='p0').stack,0)
    allIn.leavePlayer('p0') // An all-in disconnected seat stays eligible for the pending pot.
    allIn.act('p1',{type:'allIn'})
    assert.equal(allIn.getPublicState().stage,'COMPLETE')
    assert.equal(allIn.getPublicState().winners.find(w=>w.playerId==='p0').amount,2000)
    assert.ok(allIn.getPublicState().players.every(p=>p.id!=='p0'))
    allIn.joinPlayer('p0','Reconnected')
    assert.equal(allIn.getPublicState().players.find(p=>p.id==='p0').stack,2000,'Restore the payout, not the zero stack at departure or a new 1000 buy-in')
    assert.equal(chips(allIn),2000)
})

test('a busted seat leaving and rejoining gets no rebuy and stays out of the following hand',()=>{
    const engine=new PokerEngine({random:rigged(
        cards('Ac Ad Kc Kd 2s 5h 8c 9d Jh'),
        cards('2c 2d Ac Ad 6s 8h Tc Qd Kh'),
    )})
    engine.joinPlayer('p0','P0');engine.joinPlayer('p1','P1')
    engine.startHand('NORMAL')
    engine.joinPlayer('late','Late')
    engine.act('p0',{type:'allIn'});engine.act('p1',{type:'allIn'})
    assert.equal(engine.getPublicState().players.find(p=>p.id==='p1').stack,0)
    engine.leavePlayer('p1')
    engine.joinPlayer('p1','Reconnected')
    assert.equal(engine.getPublicState().players.find(p=>p.id==='p1').stack,0)
    assert.equal(chips(engine),3000)
    engine.prepareNextHand('MIRROR')
    engine.startHand('MIRROR')
    assert.equal(engine.getPublicState().players.find(p=>p.id==='p1').sittingOut,true)
    assert.deepEqual(engine.getPrivateState('p1').cards,[])
    assert.deepEqual(engine.getPrivateState('p1').legalActions,[])
    assert.equal(engine.drainEvents().findLast(e=>e.type==='CARDS_DEALT').cardCount,4)
    for(let guard=0;engine.getPublicState().stage!=='COMPLETE'&&guard<100;guard++) {
        const state=engine.getPublicState()
        assert.notEqual(state.actorId,'p1')
        const legal=engine.getPrivateState(state.actorId).legalActions
        engine.act(state.actorId,{type:legal.some(a=>a.type==='check')?'check':'call'})
    }
    assert.equal(engine.getPublicState().stage,'COMPLETE')
    assert.equal(engine.getPublicState().players.find(p=>p.id==='p1').stack,0)
    assert.equal(chips(engine),3000)
})

test('bots use a pure restricted view and react to active rank order',()=>{
    const engine=new PokerEngine({random:rng(77)})
    engine.joinPlayer('a','A',true);engine.joinPlayer('b','B',true);engine.startHand()
    const actor=engine.getPublicState().actorId
    const observation={state:engine.getPublicState(),self:engine.getPrivateState(actor)}
    assert.ok(!('deck'in observation)&&!('hands'in observation))
    assert.ok(observation.state.players.every(p=>!p.cards))
    // A cheap raised pot permits a speculative call; an unopened pot never does.
    observation.state.currentBet=50
    const raise={type:'raise',min:80,max:1000}
    observation.self.cards=['2c','2d'];observation.self.legalActions=[{type:'call',amount:40},raise,{type:'fold'}]
    observation.state.worldMode='NORMAL'; const normal=chooseBotAction(observation)
    observation.state.worldMode='MIRROR';const mirror=chooseBotAction(observation)
    assert.equal(normal.type,'call');assert.equal(mirror.type,'raise')
    assert.ok(mirror.amount>=135&&mirror.amount<=190,'Mirror premium uses a legal, varied preflop reraise')
})

test('seeded bot/pressure play completes at least 300 hands without losing chips or hanging',()=>{
    let completed=0
    for(let seed=1;seed<=300;seed++) {
        const engine=new PokerEngine({random:rng(seed)})
        for(let seat=0;seat<4;seat++)engine.joinPlayer(String(seat),'Bot '+seat,true)
        const decision=rng(seed*13)
        for(let hand=0;hand<3;hand++) {
            if(engine.getPublicState().players.filter(p=>p.stack>0).length<2)break
            const mode=(seed+hand)%2===0?'NORMAL':'MIRROR'
            engine.prepareNextHand(mode)
            engine.startHand(mode)
            for(let guard=0;engine.getPublicState().stage!=='COMPLETE'&&guard<160;guard++) {
                assert.equal(chips(engine),4000)
                const actor=engine.getPublicState().actorId
                const legal=engine.getPrivateState(actor).legalActions
                const r=decision()
                const allIn=legal.find(a=>a.type==='allIn')
                const raise=legal.find(a=>a.type==='raise'||a.type==='bet')
                const action=r<0.1&&allIn?{type:'allIn'}:r<0.3&&raise?{type:raise.type,amount:raise.min}:engine.getBotAction(actor)
                engine.act(actor,action)
            }
            assert.equal(engine.getPublicState().stage,'COMPLETE',`seed ${seed}, hand ${hand}`)
            assert.equal(chips(engine),4000)
            completed++
        }
    }
    assert.ok(completed>=300)
})

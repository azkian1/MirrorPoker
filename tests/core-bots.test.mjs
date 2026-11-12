import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(resolve(root,'.test-output'), {recursive:true})
const build = spawnEsbuild(['tests/core-entry.ts','--bundle','--platform=node','--format=esm','--outfile=.test-output/core-bots-bundle.mjs'],{cwd:root,encoding:'utf8'})
assert.equal(build.status,0,build.stderr)
const { chooseBotAction, PokerEngine } = await import('../.test-output/core-bots-bundle.mjs')
const cards = text => text.split(' ')

function view(options={}) {
    const {stage='FLOP',worldMode='NORMAL',hole='As Ad',board='Ac 7h 2d',stack=2000,bet=0,currentBet=0,
        pot=200,field=1,seat=0,dealerSeat=0,handId='bot-fixture',playerId='bot',legal} = options
    const prior=(pot-bet-currentBet)/ (field+1)
    const player=(id,seat,bet,stack)=>({id,name:id,seat,stack,bet,totalBet:prior+bet,folded:false,allIn:false,connected:true,isBot:true})
    const players=[player(playerId,seat,bet,stack),...Array.from({length:field},(_,index)=>player('other'+index,(seat+index+1)%4,index===0?currentBet:0,2000))]
    const maximum=bet+stack
    const legalActions=legal??(currentBet>bet
        ? [{type:'fold'},{type:'call',amount:Math.min(currentBet-bet,stack)},{type:'raise',min:currentBet*2,max:maximum},{type:'allIn'}]
        : [{type:'fold'},{type:'check'},{type:stage==='PREFLOP'?'raise':'bet',min:stage==='PREFLOP'?40:20,max:maximum},{type:'allIn'}])
    return {state:{handId,seq:1,stage,worldMode,players,board:board?cards(board):[],pot,actorId:playerId,dealerSeat,
        smallBlind:10,bigBlind:20,currentBet,minRaise:20,winners:[]},
        self:{handId,playerId,cards:cards(hole),legalActions}}
}
const decision = options => chooseBotAction(view(options))
function freeze(value) { if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)}return value }
function sized(action,type,min,max) {
    assert.equal(action.type,type)
    assert.ok(Number.isSafeInteger(action.amount)&&action.amount>=min&&action.amount<=max,JSON.stringify(action)+` outside ${min}..${max}`)
}

test('all 1326 starting hands in each world never open-limp, including small blind completes',()=>{
    const deck=[...'cdhs'].flatMap(suit=>[...'23456789TJQKA'].map(rank=>rank+suit))
    for(const worldMode of ['NORMAL','MIRROR']) for(const bet of [0,10]) for(let a=0;a<deck.length;a++) for(let b=a+1;b<deck.length;b++) {
        const action=decision({stage:'PREFLOP',worldMode,hole:deck[a]+' '+deck[b],board:'',bet,currentBet:20,pot:30,field:3,seat:3,dealerSeat:0})
        assert.notEqual(action.type,'call',`${worldMode} ${deck[a]} ${deck[b]} SB ${bet}`)
        if(action.type==='raise')sized(action,'raise',44,70)
    }
})

test('world-aware premiums open and reraise using varied, bounded street totals',()=>{
    for(const [worldMode,hole] of [['NORMAL','As Ad'],['MIRROR','2s 2d']]) {
        sized(decision({stage:'PREFLOP',worldMode,hole,board:'',bet:10,currentBet:20,pot:30}),'raise',44,70)
        sized(decision({stage:'PREFLOP',worldMode,hole,board:'',bet:10,currentBet:50,pot:75}),'raise',135,190)
        sized(decision({stage:'PREFLOP',worldMode,hole,board:'',bet:50,currentBet:150,pot:230}),'raise',405,570)
        const pressured=decision({stage:'PREFLOP',worldMode,hole,board:'',stack:990,bet:10,currentBet:300,pot:400})
        if(pressured.type!=='allIn')sized(pressured,'raise',810,999)
    }
})

test('position widens a first-in range while a weak early-position hand folds',()=>{
    const options={stage:'PREFLOP',hole:'7h 6h',board:'',currentBet:20,pot:30,field:3,dealerSeat:0}
    sized(decision({...options,seat:0}),'raise',44,70)
    assert.deepEqual(decision({...options,seat:3}),{type:'fold'})
})

test('weak big blind keeps its free option and short forced blind calls remain legal',()=>{
    const checkLegal=[{type:'fold'},{type:'check'},{type:'raise',min:40,max:1000},{type:'allIn'}]
    assert.deepEqual(decision({stage:'PREFLOP',hole:'7c 2d',board:'',bet:20,currentBet:20,pot:60,field:3,legal:checkLegal}),{type:'check'})
    const allInBlind=view({stage:'PREFLOP',hole:'As Ad',board:'',bet:10,currentBet:20,pot:30,legal:[{type:'fold'},{type:'call',amount:10}]})
    allInBlind.state.players[1].stack=0;allInBlind.state.players[1].allIn=true
    assert.deepEqual(chooseBotAction(allInBlind),{type:'call'})
    assert.deepEqual(decision({stage:'PREFLOP',hole:'As Ad',board:'',stack:5,bet:10,currentBet:20,pot:30,
        legal:[{type:'fold'},{type:'call',amount:5},{type:'allIn'}]}),{type:'call'})
})

test('strong hands value bet all streets without automatically shoving a deep river',()=>{
    for(const [worldMode,hole,flop,turn,river] of [
        ['NORMAL','As Ad','Ac 7h 2d','Ac 7h 2d 9c','Ac 7h 2d 9c Kd'],
        ['MIRROR','2s 2d','2c 8h Ks','2c 8h Ks Tc','2c 8h Ks Tc Ah']]) {
        sized(decision({worldMode,hole,board:flop,pot:200}),'bet',76,160)
        sized(decision({worldMode,hole,board:turn,stage:'TURN',pot:200}),'bet',100,200)
        sized(decision({worldMode,hole,board:river,stage:'RIVER',pot:200}),'bet',90,250)
    }
})

test('postflop value raises and check-raises vary between 2.2 and 3 times total bet',()=>{
    for(const [worldMode,hole,flop] of [['NORMAL','As Ks','Qs Js Ts'],['MIRROR','Ac 2c','3c 4c 5c']]) {
        for(const [stage,board] of [['FLOP',flop],['TURN',flop+' 8d'],['RIVER',flop+' 8d 9h']]) {
            sized(decision({worldMode,hole,board,stage,bet:20,currentBet:100,pot:400}),'raise',220,300)
            sized(decision({worldMode,hole,board,stage,bet:0,currentBet:51,pot:400}),'raise',112,153)
        }
    }
})

test('seeded mix steals and reraises light in both worlds, with several opening sizes',()=>{
    for(const [worldMode,weak,playable,premium] of [['NORMAL','8c 3d','Jh Th','As Ad'],['MIRROR','8c Kd','5h 6h','2s 2d']]) {
        let steals=0,reraises=0,shortPushes=0
        const sizes=new Set()
        for(let seed=0;seed<128;seed++) {
            const common={stage:'PREFLOP',worldMode,board:'',pot:30,handId:'mix'+seed}
            const steal=decision({...common,hole:weak,currentBet:20})
            if(steal.type==='raise'){steals++;sized(steal,'raise',44,70)}
            else assert.equal(steal.type,'fold')
            const reraise=decision({...common,hole:playable,currentBet:50,pot:100})
            if(reraise.type==='raise'){reraises++;sized(reraise,'raise',135,190)}
            else assert.equal(reraise.type,'call','Playable hands still defend this cheap heads-up price')
            const open=decision({...common,hole:premium,currentBet:20})
            sized(open,'raise',44,70);sizes.add(open.amount)
            const short=decision({...common,hole:premium,currentBet:20,bet:10,stack:180})
            if(short.type==='allIn')shortPushes++
            else sized(short,'raise',44,70)
        }
        assert.ok(steals>=5&&steals<=40,`${worldMode}: ${steals} steals / 128`)
        assert.ok(reraises>=15&&reraises<=75,`${worldMode}: ${reraises} mixed reraises / 128`)
        assert.ok(shortPushes>=20&&shortPushes<=105,`${worldMode}: ${shortPushes} short pushes / 128`)
        assert.ok(sizes.size>=4,`${worldMode}: opening sizes ${[...sizes]}`)
    }
})

test('heads-up missed river hands sometimes bluff for a pot-sized amount, then fold to real pressure',()=>{
    let bluffs=0
    const amounts=new Set()
    for(let seed=0;seed<128;seed++) {
        const common={hole:'7c 2d',board:'As Kh Qc 9h 3s',stage:'RIVER',pot:200,handId:'river-mix'+seed}
        const action=decision(common)
        if(action.type==='bet'){bluffs++;sized(action,'bet',90,200);amounts.add(action.amount)}
        else assert.equal(action.type,'check')
        assert.deepEqual(decision({...common,currentBet:600,pot:800,stack:700}),{type:'fold'})
    }
    assert.ok(bluffs>=3&&bluffs<=28,`${bluffs} river bluffs / 128`)
    assert.ok(amounts.size>=3,'Bluffs use several legal sizes')
})

test('different public bot identities produce distinct, reproducible temperaments',()=>{
    const sequences=[]
    for(const playerId of ['bot-0','bot-1','bot-2','bot-3']) {
        const actions=[]
        for(let seed=0;seed<64;seed++) {
            const observation=freeze(view({playerId,stage:'PREFLOP',hole:'8c 3d',board:'',currentBet:20,pot:30,handId:'personality'+seed}))
            const first=chooseBotAction(observation)
            assert.deepEqual(chooseBotAction(observation),first)
            actions.push(JSON.stringify(first))
        }
        sequences.push(actions.join('|'))
    }
    assert.equal(new Set(sequences).size,4)
})

test('sizes clamp to legal minimum/maximum and short all-ins rather than inventing chips',()=>{
    assert.deepEqual(decision({pot:10}),{type:'bet',amount:20})
    assert.deepEqual(decision({stage:'PREFLOP',hole:'As Ad',board:'',stack:35,bet:10,currentBet:20,pot:30,
        legal:[{type:'fold'},{type:'call',amount:10},{type:'raise',min:40,max:45},{type:'allIn'}]}),{type:'allIn'})
    assert.deepEqual(decision({hole:'As Ks',board:'Qs Js Ts',currentBet:100,pot:400,
        legal:[{type:'fold'},{type:'call',amount:100},{type:'raise',min:200,max:210}]}),{type:'raise',amount:210})
})

test('low SPR commits strong value through raise-shove but folds expensive trash',()=>{
    assert.deepEqual(decision({hole:'As Ks',board:'Qs Js Ts',currentBet:100,pot:600,stack:500}),{type:'allIn'})
    assert.deepEqual(decision({hole:'7c 2d',board:'As Kh Qc 9h 3s',stage:'RIVER',currentBet:500,pot:1000,stack:600}),{type:'fold'})
})

test('a low-SPR OOP trap can check then check-push a bet, without hidden action history',()=>{
    let trap
    for(let seed=0;seed<30;seed++) {
        const observation=view({hole:'As Ks',board:'Qs Js Ts',pot:600,stack:500,seat:1,dealerSeat:0,handId:'trap'+seed})
        // Put the other player on the dealer button, hence last to act.
        observation.state.players[1].seat=0
        if(chooseBotAction(observation).type==='check'){trap=observation;break}
    }
    assert.ok(trap,'The stable OOP mix contains check traps')
    trap.state.currentBet=100;trap.state.pot+=100
    trap.state.players[1].bet=100;trap.state.players[1].stack-=100;trap.state.players[1].totalBet+=100
    trap.self.legalActions=[{type:'fold'},{type:'call',amount:100},{type:'raise',min:200,max:500},{type:'allIn'}]
    assert.deepEqual(chooseBotAction(trap),{type:'allIn'})
})

test('short raises that do not reopen action cannot induce a made-up raise or shove',()=>{
    for(const stage of ['PREFLOP','FLOP','TURN','RIVER']) {
        const board=stage==='PREFLOP'?'':stage==='FLOP'?'Qs Js Ts':stage==='TURN'?'Qs Js Ts 8d':'Qs Js Ts 8d 9h'
        assert.deepEqual(decision({hole:'As Ks',board,stage,bet:100,currentBet:130,pot:600,
            legal:[{type:'fold'},{type:'call',amount:30}]}),{type:'call'})
    }
})

test('shared board nuts never become a value shove and missed river draws gain no draw bonus',()=>{
    assert.deepEqual(decision({hole:'7c 2d',board:'As Ks Qs Js Ts',stage:'RIVER',pot:400}),{type:'check'})
    assert.deepEqual(decision({hole:'7c 2d',board:'As Ks Qs Js Ts',stage:'RIVER',pot:600,field:3}),{type:'check'})
    assert.deepEqual(decision({hole:'8h 7h',board:'Ah Kh 2c 3d Qs',stage:'RIVER',currentBet:250,pot:500}),{type:'fold'})
    for(const [worldMode,hole,board] of [['NORMAL','2c 3d','As Ks Qs Js Ts'],['MIRROR','Kc Qd','As 2s 3s 4s 5s']]) {
        assert.deepEqual(decision({worldMode,hole,board,stage:'RIVER',stack:1000,currentBet:1000,pot:2000,
            legal:[{type:'fold'},{type:'call',amount:1000},{type:'allIn'}]}),{type:'call'})
    }
})

test('private river nuts still value raise a pot bet or overbet at deep SPR',()=>{
    for(const currentBet of [200,400]) sized(decision({hole:'As Ks',board:'Qs Js Ts 8d 9h',stage:'RIVER',
        currentBet,pot:currentBet+200,stack:5000}),'raise',currentBet*2.2,currentBet*3)
})

test('a priced draw can call cheaply but does not pay an all-in overbet',()=>{
    const options={hole:'9h 8h',board:'Ah Kh 2c 3d',stage:'TURN',stack:2000}
    assert.deepEqual(decision({...options,currentBet:20,pot:220,legal:[{type:'fold'},{type:'call',amount:20}]}),{type:'call'})
    assert.deepEqual(decision({...options,currentBet:1800,pot:2000,legal:[{type:'fold'},{type:'call',amount:1800}]}),{type:'fold'})
})

test('postflop overpair and kickers follow the active world, not the printed rank',()=>{
    const options={hole:'As Ad',board:'Ks Jh 8c 5d 3s',stage:'RIVER',currentBet:200,pot:400,
        legal:[{type:'fold'},{type:'call',amount:200}]}
    assert.deepEqual(decision({...options,worldMode:'NORMAL'}),{type:'call'})
    assert.deepEqual(decision({...options,worldMode:'MIRROR'}),{type:'fold'})
})

test('side-pot money above the bot contribution cannot make an unprofitable call look cheap',()=>{
    const observation=view({hole:'8h 7h',board:'Ah Kh 2c 3d',stage:'TURN',stack:100,currentBet:1000,pot:2300,field:2,
        legal:[{type:'fold'},{type:'call',amount:100},{type:'allIn'}]})
    observation.state.players[0].totalBet=0
    observation.state.players[1].totalBet=1100
    observation.state.players[2].totalBet=1200
    observation.state.players[1].allIn=observation.state.players[2].allIn=true
    observation.state.players[1].stack=observation.state.players[2].stack=0
    assert.deepEqual(chooseBotAction(observation),{type:'fold'})
})

test('policy is deterministic, preserves its observation and ignores opponent hole-card fields',()=>{
    const observation=view({hole:'As Ad',board:'Ac 7h 2d',pot:200})
    const before=JSON.stringify(observation)
    const first=chooseBotAction(freeze(observation))
    assert.deepEqual(chooseBotAction(observation),first)
    assert.equal(JSON.stringify(observation),before)
    const withCards=JSON.parse(before)
    withCards.state.players[1].cards=['Ac','Ac']
    assert.deepEqual(chooseBotAction(withCards),first)
})

test('folded/sitting-out stacks do not change effective-stack commitment or opponent count',()=>{
    const observation=view({hole:'As Ks',board:'Qs Js Ts',currentBet:100,pot:600,stack:500})
    const first=chooseBotAction(observation)
    observation.state.players.push({id:'folded',name:'F',seat:2,stack:100000,bet:0,totalBet:0,folded:true,allIn:false,connected:true,isBot:true})
    observation.state.players.push({id:'sitting',name:'S',seat:3,stack:100000,bet:0,totalBet:0,folded:false,sittingOut:true,allIn:false,connected:true,isBot:true})
    assert.deepEqual(chooseBotAction(observation),first)
})

test('bot decisions do not consume the injected deck random source',()=>{
    let calls=0
    const engine=new PokerEngine({random:()=>{calls++;return .731}})
    engine.joinPlayer('a','A',true);engine.joinPlayer('b','B',true);engine.startHand()
    const before=calls
    engine.getBotAction(engine.getPublicState().actorId)
    assert.equal(calls,before)
})

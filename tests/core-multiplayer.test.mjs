import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnEsbuild } from '../scripts/test-tools.mjs'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(resolve(root, '.test-output'), { recursive: true })
const build = spawnEsbuild(['tests/core-entry.ts', '--bundle', '--platform=node', '--format=esm', '--outfile=.test-output/core-multiplayer-bundle.mjs'], { cwd: root, encoding: 'utf8' })
assert.equal(build.status, 0, build.stderr)
const { PokerEngine } = await import('../.test-output/core-multiplayer-bundle.mjs')

const cards = value => value.split(' ')
const rng = seed => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
const player = (engine, id) => engine.getPublicState().players.find(candidate => candidate.id === id)
const accounted = engine => {
    const state = engine.getPublicState()
    return state.pot + state.players.reduce((sum, candidate) => sum + candidate.stack, 0) + engine.getForfeitedChips()
}
function headsUp(random = rng(1)) {
    const engine = new PokerEngine({ random, maxPlayers: 2 })
    engine.joinPlayer('left', 'Left')
    engine.joinPlayer('right', 'Right')
    return engine
}
function passive(engine) {
    for (let guard = 0; guard < 100; guard++) {
        const state = engine.getPublicState()
        if (state.stage === 'COMPLETE') return
        assert.ok(state.actorId)
        const legal = engine.getPrivateState(state.actorId).legalActions
        engine.act(state.actorId, { type: legal.some(action => action.type === 'check') ? 'check' : 'call' })
    }
    assert.fail('Hand did not complete')
}
function rigged(...drawHands) {
    let current = [...'cdhs'].flatMap(suit => [...'23456789TJQKA'].map(rank => rank + suit))
    const samples = Array(51).fill(.9999)
    for (const draw of drawHands) {
        const desired = [...current.filter(card => !draw.includes(card)), ...draw.toReversed()]
        for (let index = 51; index > 0; index--) {
            const other = current.indexOf(desired[index])
            assert.ok(other <= index)
            samples.push((other + .25) / (index + 1))
            ;[current[index], current[other]] = [current[other], current[index]]
        }
    }
    return () => samples.length ? samples.shift() : .9999
}

test('Heads Up reserves physical seats 0 and 3 and rejects another identity', () => {
    const engine = headsUp()
    assert.deepEqual(engine.getPublicState().players.map(candidate => candidate.seat), [0, 3])
    assert.throws(() => engine.joinPlayer('third', 'Third'), /full/)
    assert.equal(accounted(engine), 2000)
    const fourMax = new PokerEngine()
    for (let seat = 0; seat < 4; seat++) fourMax.joinPlayer(String(seat), String(seat))
    assert.deepEqual(fourMax.getPublicState().players.map(candidate => candidate.seat), [0, 1, 2, 3])
    assert.throws(() => new PokerEngine({ maxPlayers: 3 }), /two or four/)
})

test('Heads Up button posts small blind and acts first preflop, big blind acts first on each later street', () => {
    for (const world of ['NORMAL', 'MIRROR']) {
        const engine = headsUp(rng(19))
        for (let hand = 0; hand < 8; hand++) {
            engine.prepareNextHand(world)
            engine.startHand(world)
            const button = hand % 2 === 0 ? 'left' : 'right'
            const other = button === 'left' ? 'right' : 'left'
            const state = engine.getPublicState()
            assert.equal(state.dealerSeat, button === 'left' ? 0 : 3)
            assert.equal(state.actorId, button)
            assert.equal(player(engine, button).bet, 10)
            assert.equal(player(engine, other).bet, 20)
            assert.equal(engine.getPrivateState(button).legalActions.find(action => action.type === 'call').amount, 10)
            engine.act(button, { type: 'call' })
            assert.equal(engine.getPublicState().actorId, other)
            engine.act(other, { type: 'check' })
            for (const street of ['FLOP', 'TURN', 'RIVER']) {
                assert.equal(engine.getPublicState().stage, street)
                assert.equal(engine.getPublicState().actorId, other)
                engine.act(other, { type: 'check' })
                assert.equal(engine.getPublicState().actorId, button)
                engine.act(button, { type: 'check' })
            }
            assert.equal(engine.getPublicState().stage, 'COMPLETE')
            assert.equal(accounted(engine), 2000)
        }
    }
})

test('Heads Up all-ins reveal a full board and reverse the paid winner with the world', () => {
    for (const world of ['NORMAL', 'MIRROR']) {
        const engine = headsUp(rigged(cards('Ac Ad Kc Kd 2s 5h 8c 9d Jh')))
        engine.startHand(world)
        assert.deepEqual(engine.getPrivateState('left').cards, cards('Ac Ad'))
        assert.deepEqual(engine.getPrivateState('right').cards, cards('Kc Kd'))
        assert.ok(engine.getPublicState().players.every(candidate => !candidate.cards))
        engine.act('left', { type: 'allIn' })
        engine.act('right', { type: 'allIn' })
        const state = engine.getPublicState()
        assert.equal(state.stage, 'COMPLETE')
        assert.equal(state.board.length, 5)
        assert.deepEqual(state.winners.map(winner => [winner.playerId, winner.amount]), [[world === 'NORMAL' ? 'left' : 'right', 2000]])
        assert.ok(state.players.every(candidate => candidate.cards.length === 2))
        assert.equal(state.actorId, null)
        assert.equal(accounted(engine), 2000)
    }
})

test('Heads Up short all-in blind caps the pot and returns uncommitted excess in both worlds', () => {
    for (const world of ['NORMAL', 'MIRROR']) {
        const engine = headsUp(rigged(cards('Ac Ad Kc Kd 2s 5h 8c 9d Jh'), cards('2c 2d Ac Ad 6s 8h Tc Qd Kh')))
        engine.startHand(world)
        engine.act('left', { type: 'fold' })
        assert.deepEqual(engine.getPublicState().players.map(candidate => candidate.stack), [990, 1010])
        engine.setBlinds(600, 1200)
        engine.startHand(world)
        assert.equal(engine.getPublicState().dealerSeat, 3)
        assert.equal(engine.getPublicState().actorId, 'right')
        assert.equal(player(engine, 'left').allIn, true)
        assert.deepEqual(engine.getPrivateState('right').legalActions, [{ type: 'fold' }, { type: 'call', amount: 390 }])
        engine.act('right', { type: 'call' })
        assert.equal(engine.getPublicState().stage, 'COMPLETE')
        assert.deepEqual(engine.getPublicState().players.map(candidate => candidate.stack), world === 'NORMAL' ? [0, 2000] : [1980, 20])
        assert.equal(accounted(engine), 2000)
    }
})

test('network disconnect retains current decision, cards, funded seat and later deals until authority acts', () => {
    const engine = headsUp()
    engine.startHand('MIRROR')
    engine.drainEvents()
    const before = engine.getPublicState()
    const privateBefore = engine.getPrivateState('left')
    engine.disconnectPlayer('left')
    const after = engine.getPublicState()
    assert.equal(after.actorId, 'left')
    assert.equal(after.stage, 'PREFLOP')
    assert.equal(after.pot, before.pot)
    assert.equal(player(engine, 'left').connected, false)
    assert.deepEqual(engine.getPrivateState('left'), privateBefore)
    assert.throws(() => engine.joinPlayer('outsider', 'Outsider'), /full/)
    const seq = after.seq
    engine.disconnectPlayer('left')
    assert.equal(engine.getPublicState().seq, seq, 'A duplicate disconnect is idempotent')
    engine.act('left', { type: 'fold' }) // The authority uses this when the existing timer expires.
    assert.equal(engine.getPublicState().stage, 'COMPLETE')
    assert.equal(engine.getPlayerBalance('left'), 990)
    assert.equal(engine.getPublicState().players.length, 2)
    engine.prepareNextHand('NORMAL')
    engine.startHand('NORMAL')
    assert.equal(engine.getPrivateState('left').cards.length, 2)
    assert.equal(player(engine, 'left').connected, false)
    engine.act('right', { type: 'call' })
    assert.equal(engine.getPublicState().actorId, 'left', 'Network loss must leave timeout policy to the session')
    const cardsBefore = engine.getPrivateState('left').cards
    const balanceBefore = engine.getPlayerBalance('left')
    const priorSeq = engine.getPublicState().seq
    engine.joinPlayer('left', 'Left')
    assert.equal(engine.getPublicState().seq, priorSeq + 1)
    assert.equal(engine.getPublicState().actorId, 'left')
    assert.equal(engine.getPlayerBalance('left'), balanceBefore)
    assert.deepEqual(engine.getPrivateState('left').cards, cardsBefore)
    engine.joinPlayer('left', 'Left')
    assert.equal(engine.getPublicState().seq, priorSeq + 1, 'Already connected hello does not produce another join effect')
    passive(engine)
    assert.equal(accounted(engine), 2000)
})

test('a reserved disconnected all-in winner retains the paid balance and seat', () => {
    const engine = headsUp(rigged(cards('Ac Ad Kc Kd 2s 5h 8c 9d Jh')))
    engine.startHand('NORMAL')
    engine.act('left', { type: 'allIn' })
    engine.disconnectPlayer('left')
    engine.act('right', { type: 'allIn' })
    assert.equal(engine.getPlayerBalance('left'), 2000)
    assert.equal(player(engine, 'left').seat, 0)
    assert.equal(player(engine, 'left').connected, false)
    engine.joinPlayer('left', 'Restored')
    assert.equal(engine.getPlayerBalance('left'), 2000)
    assert.equal(player(engine, 'left').name, 'Restored')
    assert.equal(accounted(engine), 2000)
})

test('surrender of the current actor folds legally, transfers settled residue and cannot mint a rebuy', () => {
    const engine = headsUp()
    engine.startHand()
    engine.surrenderPlayer('left')
    assert.equal(engine.getPublicState().stage, 'COMPLETE')
    assert.equal(engine.getPlayerBalance('left'), 0)
    assert.equal(player(engine, 'left').folded, true)
    assert.equal(engine.getForfeitedChips(), 0)
    assert.equal(engine.getPlayerBalance('right'), 2000)
    assert.deepEqual(engine.getPublicState().winners.map(winner => winner.playerId), ['right'])
    const seq = engine.getPublicState().seq
    engine.surrenderPlayer('left')
    assert.equal(engine.getPublicState().seq, seq)
    engine.joinPlayer('left', 'Reconnected')
    assert.equal(engine.getPlayerBalance('left'), 0)
    assert.equal(engine.getPublicState().players.length, 2)
    assert.equal(accounted(engine), 2000)
})

test('nonactor surrender waits for a legal fold and the paid hand before transferring uncommitted chips', () => {
    const engine = new PokerEngine({ random: rng(81) })
    for (let index = 0; index < 3; index++) engine.joinPlayer('p' + index, 'P' + index)
    engine.startHand()
    assert.equal(engine.getPublicState().actorId, 'p0')
    engine.surrenderPlayer('p2')
    assert.equal(engine.getPublicState().actorId, 'p0')
    assert.equal(player(engine, 'p2').folded, false)
    assert.equal(engine.getPlayerBalance('p2'), 980)
    assert.equal(engine.getForfeitedChips(), 0)
    engine.act('p0', { type: 'call' })
    engine.act('p1', { type: 'call' })
    assert.equal(player(engine, 'p2').folded, true)
    assert.equal(engine.getPublicState().stage, 'FLOP')
    assert.equal(engine.getForfeitedChips(), 0)
    passive(engine)
    assert.equal(engine.getPlayerBalance('p2'), 0)
    assert.equal(engine.getForfeitedChips(), 0)
    engine.prepareNextHand('MIRROR')
    engine.startHand('MIRROR')
    assert.deepEqual(engine.getPrivateState('p2').cards, [])
    assert.equal(player(engine, 'p2').sittingOut, true)
    passive(engine)
    assert.equal(accounted(engine), 3000)
})

test('surrendered all-in retains every pending pot entitlement then transfers the eventual paid balance', () => {
    for (const world of ['NORMAL', 'MIRROR']) {
        const engine = headsUp(rigged(cards('Ac Ad Kc Kd 2s 5h 8c 9d Jh')))
        engine.startHand(world)
        engine.act('left', { type: 'allIn' })
        engine.surrenderPlayer('left')
        assert.equal(player(engine, 'left').folded, false)
        assert.equal(player(engine, 'left').allIn, true)
        assert.equal(engine.getForfeitedChips(), 0)
        engine.act('right', { type: 'allIn' })
        assert.equal(engine.getPublicState().stage, 'COMPLETE')
        assert.equal(engine.getPublicState().board.length, 5)
        assert.equal(engine.getPlayerBalance('left'), 0)
        assert.equal(engine.getForfeitedChips(), 0)
        assert.equal(engine.getPlayerBalance('right'), 2000)
        assert.deepEqual(engine.getPublicState().winners.map(winner => winner.playerId), [world === 'NORMAL' ? 'left' : 'right'])
        assert.equal(accounted(engine), 2000)
    }
})

test('between-hand surrender retains identity, transfers once and cannot occupy another participant seat', () => {
    const engine = new PokerEngine({ random: rng(20) })
    for (let seat = 0; seat < 4; seat++) engine.joinPlayer(String(seat), String(seat))
    engine.surrenderPlayer('2')
    assert.equal(engine.getPlayerBalance('2'), 0)
    assert.equal(engine.getForfeitedChips(), 0)
    assert.equal(player(engine, '2').seat, 2)
    assert.throws(() => engine.joinPlayer('new', 'New'), /full/)
    engine.startHand('NORMAL')
    assert.deepEqual(engine.getPrivateState('2').cards, [])
    assert.equal(engine.getPublicState().players.length, 4)
    passive(engine)
    assert.equal(accounted(engine), 4000)
})

test('a surrendered all-in winner redistributes residue before three- and four-player all-in elimination', () => {
    for (const count of [3, 4]) for (const world of ['NORMAL', 'MIRROR']) {
        const holes = world === 'NORMAL' ? ['Ac Ad', 'Kc Kd', 'Qc Qd', 'Jc Jd'] : ['2c 2d', '3c 3d', '4c 4d', '5c 5d']
        const board = world === 'NORMAL' ? '2s 5h 8c 9d Th' : '6s 8h Tc 9d Kh'
        const draw = cards([...holes.slice(0, count), board].join(' '))
        const engine = new PokerEngine({ random: rigged(draw) })
        for (let seat = 0; seat < count; seat++) engine.joinPlayer('p' + seat, 'P' + seat)
        engine.startHand(world)
        while (engine.getPublicState().stage !== 'COMPLETE') {
            const actor = engine.getPublicState().actorId
            engine.act(actor, { type: 'allIn' })
            if (actor === 'p0') engine.surrenderPlayer(actor)
        }
        assert.deepEqual(engine.getPublicState().winners.map(winner => [winner.playerId, winner.amount]), [['p0', count * 1000]])
        assert.deepEqual(engine.getPublicState().players.map(candidate => candidate.stack), count === 3 ? [0, 1500, 1500] : [0, 1334, 1333, 1333])
        assert.equal(engine.getForfeitedChips(), 0)
        assert.equal(accounted(engine), count * 1000)
        engine.startHand(world)
        assert.deepEqual(engine.getPrivateState('p0').cards, [])
        passive(engine)
        assert.equal(accounted(engine), count * 1000)
    }
})

test('multiple surrendered all-ins settle original pots before dividing the combined residue', () => {
    const engine = new PokerEngine({ random: rigged(cards('Ac Ad Kc Kd Qc Qd Jc Jd 2s 5h 8c 9d Th')) })
    for (let seat = 0; seat < 4; seat++) engine.joinPlayer('p' + seat, 'P' + seat)
    engine.startHand('NORMAL')
    while (engine.getPublicState().stage !== 'COMPLETE') {
        const actor = engine.getPublicState().actorId
        engine.act(actor, { type: 'allIn' })
        if (actor === 'p0' || actor === 'p1') engine.surrenderPlayer(actor)
    }
    assert.deepEqual(engine.getPublicState().winners.map(winner => [winner.playerId, winner.amount]), [['p0', 4000]])
    assert.deepEqual(engine.getPublicState().players.map(candidate => candidate.stack), [0, 0, 2000, 2000])
    assert.equal(accounted(engine), 4000)
})

test('folded current-hand participants share residue and receive odd chips clockwise after the button', () => {
    const engine = new PokerEngine({ random: rigged(cards('Ac Ad Kc Kd Qc Qd Jc Jd 2s 3s 4s 5s 6s')) })
    for (let seat = 0; seat < 4; seat++) engine.joinPlayer('p' + seat, 'P' + seat)
    engine.startHand('NORMAL')
    engine.surrenderPlayer('p3')
    passive(engine)
    assert.deepEqual(engine.getPublicState().players.map(candidate => candidate.stack), [1333, 1334, 1333, 0])
    assert.equal(accounted(engine), 4000)

    const folded = new PokerEngine({ random: rng(91) })
    for (let seat = 0; seat < 4; seat++) folded.joinPlayer('p' + seat, 'P' + seat)
    folded.startHand('NORMAL')
    folded.surrenderPlayer('p3')
    folded.act('p0', { type: 'fold' })
    passive(folded)
    assert.equal(folded.getPlayerBalance('p0'), 1333, 'A folded hand keeps its uncommitted stack and share')
    assert.equal(accounted(folded), 4000)
})

test('between-hand residue cannot resurrect an eliminated player from the previously paid hand', () => {
    const engine = new PokerEngine({ random: rigged(cards('Qc Qd Ac Ad Kc Kd 2s 5h 8c 9d Jh')) })
    for (let seat = 0; seat < 3; seat++) engine.joinPlayer('p' + seat, 'P' + seat)
    engine.startHand('NORMAL')
    engine.act('p0', { type: 'raise', amount: 500 })
    engine.act('p1', { type: 'call' })
    engine.act('p2', { type: 'allIn' })
    engine.act('p0', { type: 'fold' })
    engine.act('p1', { type: 'call' })
    assert.deepEqual(engine.getPublicState().players.map(candidate => candidate.stack), [500, 2500, 0])
    engine.surrenderPlayer('p0')
    assert.deepEqual(engine.getPublicState().players.map(candidate => candidate.stack), [0, 3000, 0])
    assert.equal(engine.getForfeitedChips(), 0)
    assert.equal(accounted(engine), 3000)
})

test('residue burns only when every remaining eligible identity surrendered', () => {
    const engine = headsUp()
    engine.surrenderPlayer('left')
    assert.equal(engine.getPlayerBalance('right'), 2000)
    engine.surrenderPlayer('right')
    assert.equal(engine.getForfeitedChips(), 2000)
    assert.deepEqual(engine.getPublicState().players.map(candidate => candidate.stack), [0, 0])
    engine.surrenderPlayer('right')
    assert.equal(engine.getForfeitedChips(), 2000)
    assert.equal(accounted(engine), 2000)
})

test('residue includes a reserved disconnected participant and excludes a legacy departed seat', () => {
    const engine = new PokerEngine({ random: rng(73) })
    for (let seat = 0; seat < 3; seat++) engine.joinPlayer('p' + seat, 'P' + seat)
    engine.startHand('NORMAL')
    engine.act('p0', { type: 'call' })
    engine.act('p1', { type: 'call' })
    engine.act('p2', { type: 'check' })
    engine.disconnectPlayer('p2')
    engine.surrenderPlayer('p0')
    engine.leavePlayer('p1')
    assert.equal(engine.getPublicState().actorId, 'p2')
    engine.act('p2', { type: 'check' })
    assert.equal(engine.getPublicState().stage, 'COMPLETE')
    assert.equal(engine.getPlayerBalance('p0'), 0)
    assert.equal(engine.getPlayerBalance('p1'), 980)
    assert.equal(engine.getPlayerBalance('p2'), 2020)
    assert.equal(player(engine, 'p2').connected, false)
    assert.equal(engine.getForfeitedChips(), 0)
    assert.equal(accounted(engine) + engine.getPlayerBalance('p1'), 3000)
})

test('seeded Heads Up pressure play settles both worlds without invalid actors or chip loss', () => {
    for (let seed = 1; seed <= 120; seed++) {
        const engine = headsUp(rng(seed))
        const decision = rng(seed * 23)
        for (let hand = 0; hand < 4; hand++) {
            if (engine.getPublicState().players.filter(candidate => candidate.stack > 0).length < 2) break
            engine.startHand((seed + hand) % 2 ? 'MIRROR' : 'NORMAL')
            for (let guard = 0; guard < 100 && engine.getPublicState().stage !== 'COMPLETE'; guard++) {
                const state = engine.getPublicState()
                const legal = engine.getPrivateState(state.actorId).legalActions
                assert.ok(legal.length)
                assert.ok([0, 3].includes(player(engine, state.actorId).seat))
                const aggressive = legal.find(action => action.type === 'raise' || action.type === 'bet')
                const sample = decision()
                const action = sample < .15 && legal.some(choice => choice.type === 'allIn') ? { type: 'allIn' }
                    : sample < .3 && aggressive ? { type: aggressive.type, amount: aggressive.min }
                    : engine.getBotAction(state.actorId)
                engine.act(state.actorId, action)
                assert.equal(accounted(engine), 2000)
            }
            assert.equal(engine.getPublicState().stage, 'COMPLETE', `Seed ${seed}, hand ${hand}`)
        }
    }
})

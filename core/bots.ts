import type { BotObservation, Card, LegalAction, PokerAction, PublicPlayer, WorldMode } from '../shared/contracts.ts'
import { compareHands, evaluate, HandRanking } from './evaluator.ts'

const RANKS = '23456789TJQKA'
const DECK = [...'cdhs'].flatMap(suit => [...RANKS].map(rank => `${rank}${suit}` as Card))
// These are physical sequences, including the wheel, in both worlds.
const STRAIGHTS = ['A2345','23456','34567','45678','56789','6789T','789TJ','89TJQ','9TJQK','TJQKA']
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
const power = (rank: string, mode: WorldMode) => mode === 'NORMAL' ? RANKS.indexOf(rank) : 12 - RANKS.indexOf(rank)

function hash(text: string): number {
    let result = 2166136261
    for (let index = 0; index < text.length; index++) result = Math.imul(result ^ text.charCodeAt(index), 16777619)
    return result >>> 0
}

/** Public identity gives each opponent a persistent temperament, without history or a hidden hand. */
function personality(playerId: string) {
    // Avalanche the identity: adjacent IDs such as bot:1 / bot:2 must not
    // accidentally share their looseness and trickiness high bytes.
    let identity = hash(playerId)
    identity = Math.imul(identity ^ (identity >>> 16), 0x7feb352d)
    identity = Math.imul(identity ^ (identity >>> 15), 0x846ca68b)
    identity = (identity ^ (identity >>> 16)) >>> 0
    return {
        pressure: 0.25 + (identity & 255) / 255 * 0.75,
        looseness: ((identity >>> 8) & 255) / 255,
        trickiness: ((identity >>> 16) & 255) / 255,
    }
}

/** World-aware starting-hand heuristic; suits/connectivity retain their physical meaning. */
function startingStrength(cards: Card[], mode: WorldMode): number {
    const [high, low] = cards.map(card => power(card[0], mode)).sort((a,b) => b-a)
    if (high === low) return 0.46 + high / 12 * 0.5
    const gap = Math.abs(RANKS.indexOf(cards[0][0]) - RANKS.indexOf(cards[1][0]))
    const connected = gap === 1 || cards.some(card => card[0] === 'A') && cards.some(card => card[0] === '2')
    return high / 12 * 0.38 + low / 12 * 0.2 + (cards[0][1] === cards[1][1] ? 0.07 : 0)
        + (connected ? 0.08 : gap === 2 ? 0.04 : 0) + (low >= 8 ? 0.08 : 0)
}

/** Stable mixing, without consuming the table's deck RNG or retaining private state. */
function randomFor(observation: BotObservation): () => number {
    const { state, self } = observation
    const key = [state.handId, self.playerId, state.worldMode, state.stage, ...self.cards, ...state.board,
        state.currentBet, ...state.players.flatMap(player => [player.id, player.bet, player.stack, player.folded])].join(':')
    let seed = hash(key)
    return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296)
}

/** Draw outs are useful only before the river and must involve a hole card. */
function draws(hole: Card[], board: Card[], mode: WorldMode): { outs: number; nutBlocker: boolean } {
    const cards = [...hole, ...board]
    let flushOuts = 0
    let nutBlocker = false
    for (const suit of 'cdhs') {
        const suited = cards.filter(card => card[1] === suit)
        const own = hole.filter(card => card[1] === suit)
        if (!own.length) continue
        const boardSuit = board.filter(card => card[1] === suit).length
        const bestOwn = Math.max(...own.map(card => power(card[0], mode)))
        if (boardSuit >= 3 && bestOwn >= 11) nutBlocker = true
        if (board.length < 5 && suited.length === 4 && boardSuit < 4) flushOuts = 9
    }
    if (board.length >= 5) return { outs: 0, nutBlocker }
    const ranks = new Set(cards.map(card => card[0]))
    const boardRanks = new Set(board.map(card => card[0]))
    const missing = new Set<string>()
    for (const sequence of STRAIGHTS) {
        const absent = [...sequence].filter(rank => !ranks.has(rank))
        if (absent.length === 1 && hole.some(card => sequence.includes(card[0]) && !boardRanks.has(card[0]))) missing.add(absent[0])
    }
    // A flush and straight out can overlap. This is a conservative draw classification,
    // not an equity bonus: actual showdown equity below samples the shared evaluator.
    return { outs: Math.min(15, flushOuts + missing.size * 4 - (flushOuts ? missing.size : 0)), nutBlocker }
}

/** Bounded, deterministic equity against unknown hands, never the engine's real deck.
 * At most 28 heads-up / 18 multiway deals; 21 five-card candidates per evaluation.
 * Opponent betting ranges are handled conservatively in the decision layer, not by
 * pretending random-hand equity is a solver or a prediction of a known opponent.
 */
function showdownEquity(observation: BotObservation, opponents: number, random: () => number): number {
    const { state, self } = observation
    const known = new Set([...self.cards, ...state.board])
    const unknown = DECK.filter(card => !known.has(card))
    const samples = state.board.length === 5 ? (opponents === 1 ? 28 : 18)
        : state.board.length === 4 ? (opponents === 1 ? 20 : 14) : (opponents === 1 ? 18 : 12)
    const fixedHand = state.board.length === 5 ? evaluate([...self.cards, ...state.board], state.worldMode) : null
    let share = 0
    for (let sample = 0; sample < samples; sample++) {
        // Partial Fisher-Yates: a single deal has no repeated cards and all opponents
        // share the same runout. The input/public arrays are never shuffled in place.
        const deck = [...unknown]
        let used = 0
        const draw = () => {
            const index = used + Math.floor(random() * (deck.length - used))
            ;[deck[used], deck[index]] = [deck[index], deck[used]]
            return deck[used++]
        }
        const board = [...state.board]
        while (board.length < 5) board.push(draw())
        const ownHand = fixedHand ?? evaluate([...self.cards, ...board], state.worldMode)
        let tied = 1
        let beaten = false
        for (let opponent = 0; opponent < opponents; opponent++) {
            const other = evaluate([draw(), draw(), ...board], state.worldMode)
            const comparison = compareHands(ownHand, other)
            if (comparison < 0) beaten = true
            else if (comparison === 0) tied++
        }
        if (!beaten) share += 1 / tied
    }
    return share / samples
}

function sizedAction(choice: LegalAction | undefined, target: number, observation: BotObservation): PokerAction | null {
    if (!choice || choice.min === undefined || choice.max === undefined) return null
    const amount = clamp(Math.round(target), choice.min, choice.max)
    const me = observation.state.players.find(player => player.id === observation.self.playerId)!
    if (amount === me.bet + me.stack && observation.self.legalActions.some(action => action.type === 'allIn')) return { type: 'allIn' }
    return { type: choice.type, amount }
}

/** Pure policy: its entire input is the same public/private view a human receives. */
export function chooseBotAction(observation: BotObservation): PokerAction {
    const { state, self } = observation
    const choices = self.legalActions
    if (choices.length === 0) throw new Error('Bot has no legal action')
    const find = (type: PokerAction['type']) => choices.find(action => action.type === type)
    const me = state.players.find(player => player.id === self.playerId)
    if (!me || self.cards.length !== 2) throw new Error('Bot has no seated hand')
    const check = find('check')
    const call = find('call')
    const aggression = find('raise') ?? find('bet')
    const passive = (continueHand: boolean): PokerAction => {
        if (check) return { type: 'check' }
        if (continueHand && call) return { type: 'call' }
        if (find('fold')) return { type: 'fold' }
        // The engine normally always offers fold facing a bet. Keep fallback legal
        // for a restricted caller's view too, without inventing a reopened raise.
        if (call) return { type: 'call' }
        return sizedAction(aggression, aggression?.min ?? 0, observation) ?? { type: choices[0].type }
    }
    const opponents = state.players.filter(player => player.id !== self.playerId && !player.folded && !player.sittingOut)
    const solvent = opponents.filter(player => !player.allIn && player.stack > 0)
    const field = Math.max(1, opponents.length)
    const clockwise = (player: PublicPlayer) => (player.seat - state.dealerSeat + 4) % 4 || 4
    const last = [...opponents, me].sort((first, second) => clockwise(second) - clockwise(first))[0]
    const inPosition = last.id === me.id
    const price = call?.amount ?? 0
    // Side-pot money above our possible total contribution cannot justify a call.
    const ceiling = me.totalBet + price
    const eligiblePot = state.players.reduce((sum, player) => sum + Math.min(player.totalBet, ceiling), 0) + price
    const potOdds = price / Math.max(1, eligiblePot)
    const effective = Math.min(me.stack, Math.max(0, ...solvent.map(player => player.stack + player.bet - me.bet)))
    const spr = effective / Math.max(state.bigBlind, state.pot)
    const random = randomFor(observation)
    const mix = random()
    const sizing = random()
    const style = personality(self.playerId)
    // Different decisions can be bold or patient without making a replay/resync
    // reroll its action. Sizes use their own roll, independent of equity sampling.
    const openSize = state.bigBlind * (sizing < 0.22 ? 2.2 : sizing < 0.65 ? 2.5 : sizing < 0.90 ? 3 : 3.5)
    const raiseSize = (preflop: boolean) => state.currentBet * (preflop
        ? 2.7 + sizing * 0.8 + (inPosition ? 0 : 0.3)
        : 2.2 + sizing * 0.8)

    if (state.stage === 'PREFLOP') {
        const strength = startingStrength(self.cards, state.worldMode)
        const unopened = state.currentBet <= state.bigBlind
        if (unopened) {
            // Matching an all-in blind (or being too short even to cover the blind)
            // is an all-in call, not an open limp. Never fold a profitable forced call
            // merely because there is nobody left who can face another raise.
            if (!solvent.length || me.bet + me.stack <= state.currentBet) {
                const equity = clamp(0.26 + strength * 0.62 - (field - 1) * 0.065, 0, 1)
                return passive(equity >= potOdds + 0.025)
            }
            const threshold = (inPosition ? (field === 1 ? 0.32 : 0.36) : field === 1 ? 0.37 : 0.44)
                - style.looseness * 0.045
            const steal = inPosition && field <= 2 && strength >= 0.19 && mix < 0.06 + style.pressure * 0.14
            if (strength >= threshold || steal) {
                const shortPush = me.stack + me.bet <= state.bigBlind * 10 && strength >= 0.52 + (field - 1) * 0.04
                    && mix < 0.30 + style.pressure * 0.35
                const action = sizedAction(aggression, shortPush ? me.bet + me.stack : openSize, observation)
                if (action) return action
            }
            // Includes the small blind: entering an unraised pot is raise-or-fold.
            return passive(false)
        }
        const pressure = state.currentBet / state.bigBlind
        const premium = strength >= (pressure > 6 ? 0.83 : 0.77)
        const mixedReraise = strength >= 0.56 && pressure <= 5 && field <= 2 && mix < 0.12 + style.pressure * 0.22
        const lightReraise = inPosition && field === 1 && pressure <= 3.5 && strength >= 0.32
            && price <= me.stack * 0.08 && mix < style.trickiness * 0.055
        if ((premium || mixedReraise || lightReraise) && solvent.length) {
            const target = raiseSize(true)
            const action = sizedAction(aggression, target, observation)
            if (action) return action
        }
        // Facing a raise, defend affordable hands; price and field tighten the range.
        // Small pairs/suited connectors can see a cheap flop with remaining implied odds.
        const equity = clamp(0.26 + strength * 0.62 - (field - 1) * 0.065 - Math.min(0.16, pressure * 0.012), 0, 1)
        const pair = self.cards[0][0] === self.cards[1][0]
        const speculative = (pair || strength >= 0.38 - style.looseness * 0.035)
            && price <= state.bigBlind * 3 && me.stack - price >= price * 10
        const looseDefend = field <= 2 && strength >= 0.28 && price <= state.bigBlind * 2 && price <= me.stack * 0.08
            && equity >= potOdds && mix < 0.08 + style.looseness * 0.16
        const rangeFloor = (pressure > 10 ? 0.72 : pressure > 4 ? 0.50 : 0.37) - style.looseness * 0.025
        const defend = (equity > potOdds + 0.045 - style.looseness * 0.02 && strength >= rangeFloor) || speculative || looseDefend
        return passive(defend)
    }

    if (state.board.length < 3 || state.board.length > 5) return passive(false)
    // A royal entirely on the board guarantees every eligible player the same
    // hand. Calling cannot lose additional chips, including across unequal pots.
    if (state.board.length === 5 && evaluate(state.board, state.worldMode).category === HandRanking.ROYAL_FLUSH) return passive(true)
    const madeHand = evaluate([...self.cards, ...state.board], state.worldMode)
    const ownRoyal = madeHand.category === HandRanking.ROYAL_FLUSH
    const equity = ownRoyal ? 1 : showdownEquity(observation, field, random)
    const draw = draws(self.cards, state.board, state.worldMode)
    const facingBet = price > 0
    const betPressure = price / Math.max(state.bigBlind, state.pot - price)
    const pair = madeHand.category === HandRanking.PAIR
        ? madeHand.cards.find((card, index, cards) => cards.some((other, otherIndex) => index !== otherIndex && card[0] === other[0])) : undefined
    const underpair = pair && power(pair[0], state.worldMode) < Math.max(...state.board.map(card => power(card[0], state.worldMode)))
    // Random opponents contain many air hands. A large river bet represents a much
    // stronger range: a pair below the board cannot use all that random-hand equity
    // as justification for an expensive bluff catch. No draw bonus survives here.
    const bluffCatcherDiscount = state.stage === 'RIVER' && underpair && betPressure >= 0.5 ? Math.min(0.15, betPressure * 0.15) : 0
    const rangeDiscount = facingBet && !ownRoyal ? 0.065 + Math.min(0.14, betPressure * 0.11)
        + (field - 1) * 0.015 + bluffCatcherDiscount : 0
    const adjustedEquity = Math.max(0, equity - rangeDiscount)
    const float = field === 1 && state.stage !== 'RIVER' && (inPosition || draw.outs >= 4)
        && price <= state.pot * 0.20 && price <= me.stack * 0.07 && adjustedEquity >= potOdds
        && mix < 0.10 + style.looseness * 0.22
    const canContinue = adjustedEquity >= potOdds + 0.025 - style.looseness * 0.018 || float
    const lowSpr = spr <= 1.5
    const total = me.bet + me.stack

    if (facingBet) {
        const valueRaise = equity >= (state.stage === 'RIVER' ? 0.88 : 0.80) + (field - 1) * 0.025 && adjustedEquity >= 0.66
        const semiBluff = state.stage !== 'RIVER' && draw.outs >= 8 && adjustedEquity >= 0.33
            && field === 1 && canContinue && mix < 0.12 + style.pressure * 0.23
        const bluffRaise = field === 1 && inPosition && draw.nutBlocker && equity < 0.35
            && price <= state.pot * 0.25 && price <= me.stack * 0.05 && mix < style.trickiness * 0.045
        // At low SPR a good made hand/combo draw commits through a raise-shove;
        // a weak hand still takes the same pot-odds check/call/fold path below.
        const commit = lowSpr && canContinue && (adjustedEquity >= 0.64 || semiBluff)
        if ((valueRaise || semiBluff || bluffRaise || commit) && solvent.length) {
            const action = sizedAction(aggression, commit ? total : raiseSize(false), observation)
            if (action) return action
        }
        return passive(canContinue)
    }

    if (!solvent.length) return passive(false)
    // When short, a reproducible OOP mix checks strong hands to induce a bet.
    // If it gets bet into, the branch above can check-shove without hidden history.
    if (state.stage !== 'RIVER' && lowSpr && !inPosition && equity >= 0.80 && check && mix < 0.18 + style.trickiness * 0.22) return { type: 'check' }
    const river = state.stage === 'RIVER'
    const valueThreshold = (river ? 0.76 : state.stage === 'TURN' ? 0.62 : 0.56) - style.pressure * 0.035
    const valueBet = equity >= valueThreshold + (field - 1) * 0.045
    const semiBluff = !river && field === 1 && draw.outs >= 8 && equity >= 0.30
        && mix < (inPosition ? 0.38 : 0.20) + style.pressure * 0.22
    const probe = !river && field === 1 && inPosition && equity >= 0.35 && equity < valueThreshold
        && mix < 0.14 + style.pressure * 0.22
    // River bluffs exist even without a blocker, but stay heads-up, occasional and
    // pot-sized at most. A missed draw never becomes a loose all-in call.
    const bluff = field === 1 && inPosition && equity < 0.35
        && mix < (river ? 0.045 + style.trickiness * 0.075 + (draw.nutBlocker ? 0.04 : 0) : 0.08 + style.pressure * 0.13)
    if (valueBet || semiBluff || probe || bluff) {
        const fraction = river ? 0.45 + sizing * (equity >= 0.9 ? 0.80 : 0.45)
            : state.stage === 'TURN' ? 0.50 + sizing * 0.50 : 0.38 + sizing * 0.42
        const commit = lowSpr && !bluff && !probe && (equity >= 0.70 || draw.outs >= 12 && equity >= 0.48)
        const target = commit ? total : me.bet + state.pot * fraction
        const action = sizedAction(aggression, target, observation)
        if (action) return action
    }
    return passive(false)
}

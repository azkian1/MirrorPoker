import Table from '../vendor/poker-ts/src/lib/table.ts'
import { Action } from '../vendor/poker-ts/src/lib/dealer.ts'
import { shuffle } from '../vendor/poker-ts/src/util/array.ts'
import { chooseBotAction } from './bots.ts'
import { fromVendorCard, evaluate } from './evaluator.ts'
import type { Card, GameEvent, LegalAction, PokerAction, PrivateState, PublicPlayer, PublicState, Stage, Winner, WorldMode } from '../shared/contracts.ts'

type Seat = Omit<PublicPlayer, 'cards'> & { participating: boolean }
const BLINDS = { small: 10, big: 20 }
const BUY_IN = 1000
const ACTIONS = { fold: Action.FOLD, check: Action.CHECK, call: Action.CALL, bet: Action.BET, raise: Action.RAISE } as const

/** SDK-free authoritative adapter. Betting order, chip transfers and payouts use poker-ts. */
export class PokerEngine {
    private readonly table: Table
    private blinds = { ...BLINDS }
    private readonly seats: Seat[] = []
    private readonly hands = new Map<string, Card[]>()
    // Leaving a room is not a rebuy. Retain the paid balance when a seat is released.
    private readonly departed = new Map<string, { stack: number; isBot: boolean }>()
    private readonly legacyDepartures = new Set<string>()
    private readonly surrendered = new Set<string>()
    private readonly physicalSeats: readonly number[]
    private forfeitedChips = 0
    private events: GameEvent[] = []
    private handNumber = 0
    private seq = 0
    private stage: Stage = 'LOBBY'
    private world: WorldMode = 'NORMAL'
    private board: Card[] = []
    private winners: Winner[] = []
    private dealerSeat = 0

    constructor(options: { random?: () => number; maxPlayers?: 2 | 4 } = {}) {
        const random = options.random ?? Math.random
        if (options.maxPlayers !== undefined && options.maxPlayers !== 2 && options.maxPlayers !== 4)
            throw new Error('Maximum players must be two or four')
        this.physicalSeats = options.maxPlayers === 2 ? [0,3] : [0,1,2,3]
        this.table = new Table({ blinds: this.blinds }, 4, cards => shuffle(cards, random))
    }

    /** Tournament levels take effect only between hands, before forced bets are posted. */
    setBlinds(small: number, big: number): void {
        if (this.inHand()) throw new Error('Cannot change blinds during a running hand')
        if (!Number.isSafeInteger(small) || !Number.isSafeInteger(big) || small <= 0 || big <= small)
            throw new Error('Blinds must be positive safe integers with the small blind below the big blind')
        const blinds = { small, big }
        this.table.setForcedBets({ blinds })
        this.blinds = blinds
    }

    joinPlayer(id: string, name: string, isBot = false): void {
        if (!id || typeof id !== 'string' || !name || typeof name !== 'string') throw new Error('Player id and name are required')
        const existing = this.seats.find(player => player.id === id)
        if (existing) {
            const reconnected = !existing.connected
            const renamed = existing.name !== name.slice(0,40)
            existing.connected = true
            existing.name = name.slice(0,40)
            this.legacyDepartures.delete(id)
            if (reconnected || renamed) this.emit('PLAYER_JOINED', { playerId: id })
            return
        }
        if (this.seats.length >= this.physicalSeats.length) throw new Error('Table is full')
        const seat = this.physicalSeats.find(index => !this.seats.some(player => player.seat === index))!
        const prior = this.departed.get(id)
        const stack = prior?.stack ?? BUY_IN
        if (stack > 0) this.table.sitDown(seat, stack)
        this.seats.push({ id, name: name.slice(0,40), seat, stack, bet: 0, totalBet: 0,
            folded: false, allIn: false, connected: true, isBot: prior?.isBot ?? isBot, participating: false })
        this.departed.delete(id)
        this.emit('PLAYER_JOINED', { playerId: id })
    }

    leavePlayer(id: string): void {
        const player = this.requirePlayer(id)
        this.legacyDepartures.add(id)
        player.connected = false
        this.emit('PLAYER_LEFT', { playerId: id })
        if (!this.inHand()) {
            this.departed.set(id, { stack: player.stack, isBot: player.isBot })
            if (this.table.seats()[player.seat] !== null) this.table.standUp(player.seat)
            this.seats.splice(this.seats.indexOf(player), 1)
            this.legacyDepartures.delete(id)
        } else this.foldDisconnectedActors()
    }

    /** A network interruption reserves the original seat; session decision clocks still apply. */
    disconnectPlayer(id: string): void {
        const player = this.requirePlayer(id)
        if (!player.connected) return
        player.connected = false
        this.emit('PLAYER_LEFT', { playerId: id })
    }

    /** Voluntary surrender folds at the next legal turn and settles committed chips normally. */
    surrenderPlayer(id: string): void {
        this.requirePlayer(id)
        if (this.surrendered.has(id)) return
        this.surrendered.add(id)
        this.emit('PLAYER_LEFT', { playerId: id })
        if (this.inHand()) this.foldDisconnectedActors()
        else this.settleSurrenders(false)
    }

    /** Irrecoverable chips when every eligible recipient surrendered; ordinary residue stays in play. */
    getForfeitedChips(): number { return this.forfeitedChips }

    /** Clear the paid hand before the caller's between-hand presentation/gesture. */
    prepareNextHand(worldMode: WorldMode): void {
        if (this.inHand()) throw new Error('Cannot prepare during a running hand')
        this.validateWorld(worldMode)
        this.fundedPlayers()
        const changed = this.world !== worldMode
        this.world = worldMode
        this.stage = 'INTERMISSION'
        this.board = []
        this.winners = []
        this.hands.clear()
        for (const player of this.seats) {
            player.bet = player.totalBet = 0
            player.folded = player.allIn = player.participating = false
        }
        // Preparation belongs to the last paid hand; startHand increments the id.
        this.emit('HAND_PREPARED', { worldMode })
        if (changed) this.emit('WORLD_CHANGED', { worldMode })
    }

    startHand(worldMode: WorldMode = 'NORMAL'): void {
        if (this.inHand()) throw new Error('A hand is already running')
        this.validateWorld(worldMode)
        const active = this.fundedPlayers()
        this.handNumber++
        this.world = worldMode
        this.stage = 'PREFLOP'
        this.board = []
        this.winners = []
        this.hands.clear()
        for (const player of this.seats) {
            player.bet = player.totalBet = 0
            player.folded = false
            player.allIn = false
            player.participating = active.includes(player)
        }
        this.table.startHand()
        this.dealerSeat = this.table.button()
        const holes = this.table.holeCards()
        for (const player of active) {
            this.hands.set(player.id, holes[player.seat]!.map(fromVendorCard))
            const internal = this.table.seats()[player.seat]!
            player.bet = player.totalBet = internal.betSize()
            player.stack = internal.stack()
            player.allIn = player.stack === 0
        }
        this.emit('HAND_STARTED', { worldMode })
        this.emit('CARDS_DEALT', { cardCount: active.length * 2 })
        this.advance()
        this.foldDisconnectedActors()
    }

    act(id: string, action: PokerAction): void {
        const player = this.requirePlayer(id)
        if (!this.inHand() || this.actorId() !== id) throw new Error('Not this player’s turn')
        if (!action || typeof action !== 'object') throw new Error('Invalid action')
        const legal = this.legalActions(id).find(choice => choice.type === action.type)
        if (!legal) throw new Error('Action is not legal')
        if (action.type === 'bet' || action.type === 'raise') {
            if (!Number.isSafeInteger(action.amount) || action.amount! < legal.min! || action.amount! > legal.max!)
                throw new Error('Bet is outside the legal range')
        } else if (action.amount !== undefined) throw new Error('This action does not take an amount')
        // All validation completes before touching the donor engine or chip ledger.
        this.perform(player, action)
        this.foldDisconnectedActors()
    }

    getPublicState(): PublicState {
        const reveal = this.stage === 'COMPLETE' && this.board.length === 5 && this.seats.filter(p => p.participating && !p.folded).length > 1
        return {
            handId: this.handId(), seq: this.seq, stage: this.stage, worldMode: this.world,
            players: this.seats.map(({participating, ...player}) => ({ ...player, sittingOut: !participating,
                ...(reveal && participating && !player.folded ? { cards: [...(this.hands.get(player.id) ?? [])] } : {}) })),
            board: [...this.board], pot: this.inHand() ? this.seats.reduce((sum,p) => sum+p.totalBet,0) : 0,
            actorId: this.actorId(), dealerSeat: this.dealerSeat, smallBlind: this.blinds.small, bigBlind: this.blinds.big,
            currentBet: this.inHand() ? this.table.currentBet() : 0,
            minRaise: this.inHand() ? this.table.minRaise() : this.blinds.big,
            winners: this.winners.map(winner => ({...winner, ...(winner.cards ? {cards:[...winner.cards]} : {})})),
        }
    }

    getPrivateState(id: string): PrivateState {
        this.requirePlayer(id)
        return { handId: this.handId(), playerId: id, cards: [...(this.hands.get(id) ?? [])], legalActions: this.legalActions(id) }
    }
    /** Paid/available chips for match settlement, including a released disconnected seat. */
    getPlayerBalance(id: string): number | null {
        return this.seats.find(player => player.id === id)?.stack ?? this.departed.get(id)?.stack ?? null
    }
    drainEvents(): GameEvent[] {
        const result = this.events
        this.events = []
        return result.map(event => ({...event, ...(event.board ? {board:[...event.board]} : {}),
            ...(event.action ? {action:{...event.action}} : {}),
            ...(event.winners ? {winners:event.winners.map(w => ({...w, ...(w.cards ? {cards:[...w.cards]} : {})}))} : {}) }))
    }
    getBotAction(id: string): PokerAction {
        return chooseBotAction({ state: this.getPublicState(), self: this.getPrivateState(id) })
    }

    private perform(player: Seat, action: PokerAction): void {
        const oldBet = player.bet
        const currentBet = this.table.currentBet()
        const amount = action.type === 'allIn' ? player.bet + player.stack : action.amount
        const type = action.type === 'allIn'
            ? amount! <= currentBet ? 'call' : currentBet === 0 ? 'bet' : 'raise'
            : action.type
        const cost = type === 'call' ? Math.min(currentBet - player.bet, player.stack)
            : type === 'bet' || type === 'raise' ? amount! - player.bet : 0
        this.table.actionTaken(ACTIONS[type], amount)
        player.stack -= cost
        player.bet = oldBet + cost
        player.totalBet += cost
        player.folded ||= type === 'fold'
        player.allIn = !player.folded && player.stack === 0
        this.emit('PLAYER_ACTED', { playerId: player.id, action: {...action}, amount: cost })
        this.advance()
    }

    private advance(): void {
        while (this.table.handInProgress() && !this.table.bettingRoundInProgress()) {
            if (!this.table.bettingRoundsCompleted()) {
                this.table.endBettingRound()
                const newBoard = this.table.communityCards().cards().map(fromVendorCard)
                if (newBoard.length > this.board.length) this.revealStreets(newBoard)
                for (const player of this.seats) player.bet = 0
            }
            if (this.table.bettingRoundsCompleted()) { this.payOut(); return }
        }
    }

    private revealStreets(newBoard: Card[]): void {
        if (this.board.length < 3 && newBoard.length >= 3) {
            this.board = newBoard.slice(0,3); this.stage = 'FLOP'
            this.emit('STREET_CHANGED', {board:[...this.board]})
        }
        if (this.board.length < 4 && newBoard.length >= 4) {
            this.board = newBoard.slice(0,4); this.stage = 'TURN'
            this.emit('STREET_CHANGED', {board:[...this.board]})
        }
        if (this.board.length < 5 && newBoard.length >= 5) {
            this.board = newBoard.slice(0,5); this.stage = 'RIVER'
            this.emit('STREET_CHANGED', {board:[...this.board]})
        }
    }

    private payOut(): void {
        const eligible = this.seats.filter(player => player.participating && !player.folded)
        if (eligible.length > 1) {
            this.stage = 'SHOWDOWN'
            this.emit('SHOWDOWN', {board:[...this.board]})
        }
        this.table.showdown(this.world)
        const sharedSeats = new Set(this.table.winners().filter(pot => pot.length > 1)
            .flatMap(pot => pot.map(([seat]) => seat)))
        this.winners = []
        for (const player of this.seats) {
            const total = this.table.seats()[player.seat]?.totalChips() ?? 0
            const amount = total - player.stack
            if (amount > 0) {
                const result = eligible.length > 1 && this.board.length === 5
                    ? evaluate([...(this.hands.get(player.id) ?? []), ...this.board], this.world) : null
                this.winners.push({ playerId: player.id, amount, handName: result?.handName ?? 'UNCONTESTED',
                    ...(sharedSeats.has(player.seat) ? {sharedPot:true} : {}), ...(result ? { cards: result.cards } : {}) })
            }
            player.stack = total
            player.bet = player.totalBet = 0
            player.allIn = false
        }
        this.stage = 'COMPLETE'
        this.settleSurrenders(true)
        this.emit('PAYOUT', {winners:this.winners.map(winner => ({...winner}))})
        for (const player of [...this.seats]) if (this.legacyDepartures.has(player.id)) {
            this.departed.set(player.id, { stack: player.stack, isBot: player.isBot })
            if (this.table.seats()[player.seat] !== null) this.table.standUp(player.seat)
            this.seats.splice(this.seats.indexOf(player),1)
            this.legacyDepartures.delete(player.id)
        }
    }

    private legalActions(id: string): LegalAction[] {
        if (this.actorId() !== id) return []
        const player = this.requirePlayer(id)
        const range = this.table.legalActions()
        const choices: LegalAction[] = []
        for (const type of ['fold','check','call','bet','raise'] as const) if (range.action & ACTIONS[type]) {
            choices.push(type === 'bet' || type === 'raise'
                ? {type,min:range.chipRange!.min,max:range.chipRange!.max}
                : type === 'call' ? {type,amount:Math.min(this.table.currentBet()-player.bet,player.stack)} : {type})
        }
        const maximum = player.bet + player.stack
        if (player.stack > 0 && (maximum <= this.table.currentBet() ||
            (range.chipRange?.contains(maximum) && !!(range.action & (Action.BET | Action.RAISE))))) choices.push({type:'allIn'})
        return choices
    }
    private foldDisconnectedActors(): void {
        let guard = 0
        while (this.actorId()) {
            const player = this.requirePlayer(this.actorId()!)
            if (!this.legacyDepartures.has(player.id) && !this.surrendered.has(player.id)) break
            if (++guard > 4) throw new Error('Disconnected actor loop')
            this.perform(player,{type:'fold'})
        }
    }
    private actorId(): string | null {
        if (!this.inHand() || !this.table.bettingRoundInProgress()) return null
        return this.seats.find(player => player.seat === this.table.playerToAct())?.id ?? null
    }
    private inHand(): boolean { return this.stage !== 'LOBBY' && this.stage !== 'COMPLETE' && this.stage !== 'INTERMISSION' }
    private validateWorld(worldMode: WorldMode): void {
        if (worldMode !== 'NORMAL' && worldMode !== 'MIRROR') throw new Error('Invalid world mode')
    }
    private fundedPlayers(): Seat[] {
        const active = this.seats.filter(player => player.stack > 0 && !this.legacyDepartures.has(player.id) && !this.surrendered.has(player.id))
        if (active.length < 2 || active.length > 4) throw new Error('Need two to four funded players')
        return active
    }
    /** Settle every original pot first, then share abandoned balances before elimination. */
    private settleSurrenders(afterHand: boolean): void {
        let residue = 0
        for (const player of this.seats) if (this.surrendered.has(player.id)) {
            residue += player.stack
            player.stack = 0
            player.bet = player.totalBet = 0
            player.allIn = false
            if (this.table.seats()[player.seat] !== null) this.table.standUp(player.seat)
        }
        if (residue === 0) return
        // A just-settled all-in loser is still a recipient. Between hands, zero
        // stacks are already eliminated and must never receive a new buy-in.
        const recipients = this.seats.filter(player => !this.surrendered.has(player.id) &&
            !this.legacyDepartures.has(player.id) && (afterHand ? player.participating : player.stack > 0))
            .sort((a,b) => (a.seat-this.dealerSeat+3)%4 - (b.seat-this.dealerSeat+3)%4)
        if (recipients.length === 0) { this.forfeitedChips += residue; return }
        const share = Math.floor(residue/recipients.length)
        let odd = residue%recipients.length
        for (const player of recipients) {
            const amount = share + (odd-- > 0 ? 1 : 0)
            if (amount === 0) continue
            player.stack += amount
            const internal = this.table.seats()[player.seat]
            if (internal) internal.addToStack(amount)
            else this.table.sitDown(player.seat, amount)
        }
    }
    private handId(): string { return `hand-${this.handNumber}` }
    private requirePlayer(id: string): Seat {
        const player = this.seats.find(candidate => candidate.id === id)
        if (!player) throw new Error('Player is not seated')
        return player
    }
    private emit(type: GameEvent['type'], payload: Omit<GameEvent,'handId'|'eventId'|'seq'|'type'> = {}): void {
        this.seq++
        this.events.push({handId:this.handId(),eventId:`event-${this.seq}`,seq:this.seq,type,...payload})
    }
}

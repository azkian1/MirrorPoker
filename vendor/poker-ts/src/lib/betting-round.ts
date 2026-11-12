import assert from '../util/assert.ts'
import ChipRange from './chip-range.ts'
import type { SeatIndex } from '../types/seat-index.ts'
import type { Chips } from '../types/chips.ts'
import Round, { Action as RoundAction } from './round.ts'
import type { SeatArray } from '../types/seat-array.ts'

export enum Action {
    LEAVE,
    MATCH,
    RAISE
}

export class ActionRange {
    canRaise: boolean
    chipRange: ChipRange

    constructor(canRaise: boolean, chipRange: ChipRange = new ChipRange(0, 0) ) {
        this.canRaise = canRaise
        this.chipRange = chipRange
    }
}

export default class BettingRound {
    private readonly _players: SeatArray
    private _round: Round
    private _biggestBet: Chips
    private _minRaise: Chips
    private readonly _lastFacedBet = new Map<number, number>()

    constructor(players: SeatArray, firstToAct: SeatIndex, minRaise: Chips, biggestBet: Chips = 0) {
        this._round = new Round(players.map(player => !!player), firstToAct)
        this._players = players
        this._biggestBet = biggestBet
        this._minRaise = minRaise

        assert(firstToAct < players.length, 'Seat index must be in the valid range')
        assert(players[firstToAct], 'First player to act must exist')
    }

    inProgress(): boolean {
        return this._round.inProgress()
    }

    isContested(): boolean {
        return this._round.isContested();
    }

    playerToAct(): SeatIndex {
        return this._round.playerToAct()
    }

    biggestBet(): Chips {
        return this._biggestBet
    }

    /** Drop only an unmatched bring-in once nobody else can contest more chips. */
    capUnmatchedBet(maximum: Chips): void {
        assert(Number.isSafeInteger(maximum) && maximum >= 0 && maximum <= this._biggestBet,
            'The contested bet cap must not increase the betting target')
        this._biggestBet = maximum
    }

    minRaise(): Chips {
        return this._minRaise
    }

    players(): SeatArray {
        return this._round.activePlayers().map((isActive, index) => {
            return isActive ? this._players[index] : null
        })
    }

    activePlayers(): boolean[] {
        return this._round.activePlayers()
    }

    numActivePlayers(): number {
        return this._round.numActivePlayers()
    }

    legalActions(): ActionRange {
        const player = this._players[this._round.playerToAct()]
        assert(player !== null)
        const playerChips = player.totalChips()
        const faced = this._lastFacedBet.get(this._round.playerToAct())
        const canRaise = this._players.filter(p => p !== null && p.stack() > 0).length > 1 && playerChips > this._biggestBet &&
            (faced === undefined || this._biggestBet - faced >= this._minRaise)
        if (canRaise) {
            const minBet = this._biggestBet + this._minRaise
            const raiseRange = new ChipRange(Math.min(minBet, playerChips), playerChips)
            return new ActionRange(canRaise, raiseRange)
        } else {
            return new ActionRange(canRaise)
        }
    }

    actionTaken(action: Action, bet: Chips = 0) {
        const seat = this._round.playerToAct()
        const player = this._players[this._round.playerToAct()]
        assert(player !== null)
        if (action === Action.RAISE) {
            assert(this.isRaiseValid(bet))
            player.bet(bet)
            this._minRaise = Math.max(this._minRaise, bet - this._biggestBet)
            this._biggestBet = bet
            this._lastFacedBet.set(seat, this._biggestBet)
            let actionFlag = RoundAction.AGGRESSIVE
            if (player.stack() === 0) {
                actionFlag |= RoundAction.LEAVE
            }
            this._round.actionTaken(actionFlag)
        } else if (action === Action.MATCH) {
            this._lastFacedBet.set(seat, this._biggestBet)
            player.bet(Math.min(this._biggestBet, player.totalChips()))
            let actionFlag = RoundAction.PASSIVE
            if (player.stack() === 0) {
                actionFlag |= RoundAction.LEAVE
            }
            this._round.actionTaken(actionFlag)
        } else {
            assert(action === Action.LEAVE)
            this._round.actionTaken(RoundAction.LEAVE)
        }
    }

    private isRaiseValid(bet: Chips): boolean {
        const player = this._players[this._round.playerToAct()]
        assert(player !== null)
        const playerChips = player.stack() + player.betSize()
        const minBet = this._biggestBet + this._minRaise
        if (playerChips > this._biggestBet && playerChips < minBet) {
            return bet === playerChips
        }
        return bet >= minBet && bet <= playerChips
    }
}

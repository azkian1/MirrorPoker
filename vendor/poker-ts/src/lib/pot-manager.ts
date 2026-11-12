import Pot from './pot.ts'
import type { Chips } from '../types/chips.ts'
import type { SeatArray } from '../types/seat-array.ts'

/** Corrected cumulative contribution caps; folded chips retain their original seat. */
export default class PotManager {
    private readonly _pots: Pot[] = [new Pot()]
    private readonly committed = new Map<number, number>()
    private readonly folded = new Set<number>()
    pots(): Pot[] { return this._pots }
    betFolded(amount: Chips, seat: number): void {
        this.committed.set(seat, (this.committed.get(seat) ?? 0) + amount)
        this.folded.add(seat)
    }
    collectBetsForm(players: SeatArray): void {
        players.forEach((player, seat) => {
            if (player !== null) {
                const amount = player.betSize()
                this.committed.set(seat, (this.committed.get(seat) ?? 0) + amount)
                player.takeFromBet(amount)
            }
        })
        const caps = [...new Set(this.committed.values())].filter(n => n > 0).sort((a,b) => a-b)
        this._pots.length = 0
        let previous = 0
        for (const cap of caps) {
            const contributors = [...this.committed].filter(([,amount]) => amount >= cap).map(([seat]) => seat)
            const eligible = contributors.filter(seat => !this.folded.has(seat))
            const pot = new Pot()
            pot.add((cap - previous) * contributors.length)
            pot.setEligiblePlayers(eligible)
            this._pots.push(pot)
            previous = cap
        }
        if (this._pots.length === 0) this._pots.push(new Pot())
    }
}

import assert from '../util/assert.ts'
import Card from './card.ts'
import type CommunityCards from './community-cards.ts'
import type { HoleCards } from '../types/hole-cards.ts'

// Upstream categories/API retained; one world-aware best-five evaluator.
export enum HandRanking {
    HIGH_CARD, PAIR, TWO_PAIR, THREE_OF_A_KIND, STRAIGHT, FLUSH,
    FULL_HOUSE, FOUR_OF_A_KIND, STRAIGHT_FLUSH, ROYAL_FLUSH,
}
export type WorldMode = 'NORMAL' | 'MIRROR'
export type RankInfo = { rank: number; count: number }

export default class Hand {
    constructor(private readonly _ranking: HandRanking, private readonly _strength: number,
        private readonly _cards: Card[]) { assert(_cards.length === 5) }

    static create(holeCards: HoleCards, communityCards: CommunityCards, worldMode: WorldMode = 'NORMAL'): Hand {
        assert(communityCards.cards().length === 5, 'All community cards must be dealt')
        return Hand.of([...holeCards, ...communityCards.cards()], worldMode)
    }

    static of(cards: Card[], worldMode: WorldMode = 'NORMAL'): Hand {
        assert(worldMode === 'NORMAL' || worldMode === 'MIRROR', 'Invalid world mode')
        assert(cards.length >= 5 && cards.length <= 7, 'Evaluation needs five to seven cards')
        assert(new Set(cards.map(card => `${card.rank}:${card.suit}`)).size === cards.length, 'Duplicate cards')
        let best: Hand | undefined
        for (let a = 0; a < cards.length - 4; a++)
        for (let b = a + 1; b < cards.length - 3; b++)
        for (let c = b + 1; c < cards.length - 2; c++)
        for (let d = c + 1; d < cards.length - 1; d++)
        for (let e = d + 1; e < cards.length; e++) {
            const candidate = Hand.five([cards[a], cards[b], cards[c], cards[d], cards[e]], worldMode)
            if (!best || Hand.compare(candidate, best) < 0) best = candidate
        }
        assert(best !== undefined)
        return best
    }

    private static five(cards: Card[], mode: WorldMode): Hand {
        const power = (rank: number) => mode === 'NORMAL' ? rank : 12 - rank
        const groups = new Map<number, Card[]>()
        for (const card of cards) groups.set(card.rank, [...(groups.get(card.rank) ?? []), card])
        const ordered = [...groups.values()].sort((a,b) => b.length - a.length || power(b[0].rank) - power(a[0].rank))
        const unique = [...groups.keys()].sort((a,b) => a-b)
        const flush = cards.every(card => card.suit === cards[0].suit)
        // Ten physical straights: wheel index 0, Broadway index 9.
        let straight = -1
        if (unique.length === 5) {
            if (unique.join(',') === '0,1,2,3,12') straight = 0
            else if (unique[4] - unique[0] === 4) straight = unique[0] + 1
        }
        const royal = straight === (mode === 'NORMAL' ? 9 : 0)
        let ranking: HandRanking
        let key: number[]
        if (flush && straight >= 0) {
            ranking = royal ? HandRanking.ROYAL_FLUSH : HandRanking.STRAIGHT_FLUSH
            key = [mode === 'NORMAL' ? straight : 9 - straight]
        } else if (ordered[0].length === 4) {
            ranking = HandRanking.FOUR_OF_A_KIND; key = ordered.map(group => power(group[0].rank))
        } else if (ordered[0].length === 3 && ordered[1].length === 2) {
            ranking = HandRanking.FULL_HOUSE; key = ordered.map(group => power(group[0].rank))
        } else if (flush) {
            ranking = HandRanking.FLUSH; key = unique.map(power).sort((a,b) => b-a)
        } else if (straight >= 0) {
            ranking = HandRanking.STRAIGHT; key = [mode === 'NORMAL' ? straight : 9 - straight]
        } else {
            ranking = ordered[0].length === 3 ? HandRanking.THREE_OF_A_KIND
                : ordered[0].length === 2 ? (ordered[1].length === 2 ? HandRanking.TWO_PAIR : HandRanking.PAIR)
                : HandRanking.HIGH_CARD
            key = ordered.map(group => power(group[0].rank))
        }
        const strength = Array.from({length:5}, (_,i) => key[i] ?? 0).reduce((sum,n) => sum * 13 + n, 0)
        return new Hand(ranking, strength, ordered.flat())
    }

    static compare(first: Hand, second: Hand): number {
        return second.ranking() - first.ranking() || second.strength() - first.strength()
    }
    ranking(): HandRanking { return this._ranking }
    strength(): number { return this._strength }
    cards(): Card[] { return [...this._cards] }
}

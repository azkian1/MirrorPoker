import Hand, { HandRanking } from '../vendor/poker-ts/src/lib/hand.ts'
import VendorCard from '../vendor/poker-ts/src/lib/card.ts'
import type { Card, WorldMode } from '../shared/contracts.ts'

const RANKS = '23456789TJQKA'
const SUITS = 'cdhs'
export function toVendorCard(card: Card): VendorCard {
    if (typeof card !== 'string' || card.length !== 2 || !RANKS.includes(card[0]) || !SUITS.includes(card[1]))
        throw new Error('Invalid card')
    return new VendorCard(RANKS.indexOf(card[0]), SUITS.indexOf(card[1]))
}
export function fromVendorCard(card: VendorCard): Card { return `${RANKS[card.rank]}${SUITS[card.suit]}` as Card }
export interface EvaluatedHand { category: HandRanking; handName: string; strength: number; cards: Card[] }
export function evaluate(cards: Card[], worldMode: WorldMode): EvaluatedHand {
    const hand = Hand.of(cards.map(toVendorCard), worldMode)
    return { category: hand.ranking(), handName: HandRanking[hand.ranking()], strength: hand.strength(), cards: hand.cards().map(fromVendorCard) }
}
/** Positive means first wins, zero a true tie; suits are never compared. */
export function compareHands(first: EvaluatedHand, second: EvaluatedHand): number {
    return first.category - second.category || first.strength - second.strength
}
export { HandRanking }

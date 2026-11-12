import assert from '../util/assert.ts'
import Card, { CardRank, CardSuit } from './card.ts'
import { shuffle } from '../util/array.ts'

export default class Deck extends Array<Card> {
    static get [Symbol.species](): ArrayConstructor { return Array }
    private readonly shuffle: () => void
    private _size: number

    constructor(shuffleAlgorithm: (array: Card[]) => void = shuffle) {
        super()

        // Set the prototype explicitly when extending Array
        // See https://github.com/Microsoft/TypeScript/wiki/FAQ#why-doesnt-extending-built-ins-like-error-array-and-map-work
        Object.setPrototypeOf(this, Deck.prototype);

        let index = 0
        for (let suit = CardSuit.CLUBS; suit <= CardSuit.SPADES; suit++) {
            for (let rank = CardRank._2; rank <= CardRank.A; rank++) {
                this[index++] = new Card(rank, suit)
            }
        }

        this.shuffle = shuffleAlgorithm.bind(null, this)
        this._size = 52
        this.shuffle()
    }

    fillAndShuffle(): void {
        this._size = 52;
        this.shuffle()
    }

    draw(): Card {
        assert(this._size > 0, 'Cannot draw from an empty deck')
        return this[--this._size]
    }
}

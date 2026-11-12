/** Local replacement for Node assert; assertions are retained in the server bundle. */
export default function assert(value: unknown, message = 'Poker invariant failed'): asserts value {
    if (!value) throw new Error(message)
}

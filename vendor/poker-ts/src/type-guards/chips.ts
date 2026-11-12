import type { Chips } from '../types/chips.ts'

export function isChips(chips: any): chips is Chips {
    return typeof chips === 'number'
}

import type { Chips } from '../types/chips.ts'
import type { Blinds  } from '../types/blinds.ts'

export type ForcedBets = {
    ante?: Chips,
    blinds: Blinds,
}
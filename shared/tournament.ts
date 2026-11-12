/** Mirror Poker Turbo: 1000 chips (50 BB), three-minute levels, no antes. */
export const BLIND_LEVEL_MS = 3 * 60 * 1000
export const BLIND_LEVELS = [
  [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200],
  [150, 300], [200, 400], [300, 600], [400, 800], [600, 1200],
  [1000, 2000], [1500, 3000], [2000, 4000],
] as const
export const TURN_DURATION_MS = 30_000
export const AFK_TURN_DURATION_MS = 10_000
export const TURN_WARNING_MS = 5_000

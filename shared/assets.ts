/** Asset contract v12: metres, right-handed, +Y up, +Z toward camera. */
export type Vec3 = readonly [number, number, number]
export const DESIGN = { width: 1280, height: 720 } as const
export const CAMERA = { position: [0, 12.8, 11] as Vec3, target: [0, 1, -.15] as Vec3, fov: 33, near: .1, far: 80 }
export const TABLE = { width: 10, depth: 6, topY: .95, corner: .9 }
/** Platform accent: lime for light/active details, deep green for large material fills. */
export const PLATFORM_PALETTE = { lime: '#b6ff00', forest: '#17452f', ink: '#101713' } as const
export const CARD = { width: .64, height: .9, thickness: .004, textureWidth: 256, textureHeight: 360 }
/** Settled paper touches the actual felt, independently of seat/bet anchor heights. */
const feltY = TABLE.topY + .004
export const CARD_REST = {
  feltY, skinOffset: .0005, gap: .001,
  centerY: feltY + CARD.thickness / 2 + .0005 + .001,
  overlapStep: CARD.thickness + .0015,
} as const
/** One four-colour print palette shared by table cards and LAST HAND. */
export const CARD_SUITS = {
  h: { symbol: '♥', color: '#bd1231' },
  d: { symbol: '♦', color: '#126b9e' },
  c: { symbol: '♣', color: '#217340' },
  s: { symbol: '♠', color: '#101722' },
} as const
export const CHIP = { radius: .115, height: .04 }
export const CHIP_STACK = { valuePerChip: 75, perColumn: 10, columnSpacing: .25, bankrollLimit: 25, betLimit: 14, potLimit: 45 } as const
export const ANCHORS = {
  seats: [[-2.8,1,1.85],[-3.2,1,-1.55],[3.2,1,-1.55],[2.8,1,1.85]] as readonly Vec3[],
  bets: [[-2,1,.95],[-2.4,1,-.65],[2.4,1,-.65],[2,1,.95]] as readonly Vec3[],
  board: [[-1.44,1,-.28],[-.72,1,-.28],[0,1,-.28],[.72,1,-.28],[1.44,1,-.28]] as readonly Vec3[],
  deck: [-1.45,1,-1.98] as Vec3, pot: [0,1,.92] as Vec3,
  /** Centres of bounded three-column bankroll stacks, clear of every hole-card fan. */
  chips: [[-4.12,1.015,1.72],[-4.24,1.015,-1.60],[4.24,1.015,-1.60],[4.12,1.015,1.72]] as readonly Vec3[],
  dealerButtons: [[-1.98,1.015,2.19],[-2.36,1.015,-2.18],[2.36,1.015,-2.18],[1.98,1.015,2.19]] as readonly Vec3[],
  dealer: [0,.95,-3.22] as Vec3,
}
/** Local assets bundled with the standalone game. */
export const OPTIONAL_ASSETS = {
  dealerNormal: 'assets/dealer/normal-v3.png', dealerMirror: 'assets/dealer/mirror-v3.png',
  dealerHead: 'assets/dealer/head-natural-v14.png',
  dealerSnapRaise1: 'assets/dealer/snap-raise-1-v15.png',
  dealerSnapRaise2: 'assets/dealer/snap-raise-2-v15.png',
  dealerSnapReady: 'assets/dealer/snap-ready-v15.png',
  dealerSnapRelease: 'assets/dealer/snap-release-v15.png',
  dealerSnapMirrorRaise1: 'assets/dealer/snap-raise-1-mirror-v16.png',
  dealerSnapMirrorRaise2: 'assets/dealer/snap-raise-2-mirror-v16.png',
  dealerSnapMirrorReady: 'assets/dealer/snap-ready-mirror-v16.png',
  dealerSnapMirrorRelease: 'assets/dealer/snap-release-mirror-v16.png',
}
/** Presentation seconds: lift before release, hold, then lower inside the 1.8 s predeal pause. */
export const DEALER_SNAP = { ready: .56, release: .72, hold: .16, duration: 1.4 } as const
export interface AtlasMetadata {
  image: string; frameWidth: number; frameHeight: number; columns: number; rows: number
  fps: number; pivot: [number, number]; premultipliedAlpha: boolean
  clips: Record<string, { start: number; count: number; loop: boolean }>
}

import { CARD_SUITS } from './assets.ts'
import type { Card } from './contracts.ts'

/** Heratexx CC0 vector outlines, adapted for a jumbo two-corner / single-pip print.
 * Original SVGs and source/licence notice: assets/cards/heratexx-source/.
 * Coordinates are source outlines, never a font or Unicode suit substitution.
 */
export const CARD_RANK_PATHS = {
  '2': 'm-225-225c-20-40 25-235 225-235S225-325 225-225c0 200-450 385-450 685H225V300',
  '3': 'M-260 300s30 160 230 160S250 350 250 150C250 0 200-120 0-120c-50 0-100 30-110 40L200-460H-250v140',
  '4': 'M270 200H-300V175L150-460V460m100 0H50',
  '5': 'M-255 285s35 175 235 175S255 320 255 120 100-200 0-200c-200 0-210 85-210 85l35-345H170',
  '6': 'm-250 100a250 250 0 01500 0V210a250 250 0 01-500 0V-210A250 250 0 010-460c150 0 180 60 200 85',
  '7': 'M-90 460c0-360 225-660 355-920H-265v140',
  '8': 'm-1-50a205 205 0 112 0H-1a255 255 0 102 0z',
  '9': 'm250-100a250 250 0 01-500 0V-210a250 250 0 01500 0V210A250 250 0 010 460c-150 0-180-60-200-85',
  T: 'M-50 310a150 150 0 00300 0V-310a150 150 0 00-300 0V0ZM-260-430V430',
  J: 'M-250 220v30a100 100 0 00400 0V-460m100 0H50',
  Q: 'm-260 100c350 0 220 360 520 360M-175 0V-285a175 175 0 01350 0V285a175 175 0 01-350 0z',
  K: 'M-10-70 185 440m100 20H85M-170 155 185-440m100-20H85M-85 460H-285m100 0V-460m100 0H-285',
  A: 'M120 130H-120M270 460H110m90-10L0-460-200 450m90 10H-270',
} as const

export const CARD_SUIT_PATHS = {
  s: 'M0-500C-100-250-355-100-355 185a150 150 0 00300 0 10 10 0 0120 0c0 200-50 215-95 315H130C85 400 35 385 35 185a10 10 0 0120 0 150 150 0 00300 0C355-100 100-250 0-500',
  h: 'm0-300c0-100 100-200 200-200S400-400 400-250C400 0 0 400 0 500 0 400-400 0-400-250c0-150 100-250 200-250S0-400 0-300',
  d: 'm-400 0C-350 0 0-450 0-500 0-450 350 0 400 0 350 0 0 450 0 500 0 450-350 0-400 0',
  c: 'M40 150a10 10 0 0120 0A210 210 0 10135-50 10 10 0 01120-65a210 210 0 10-220 0 10 10 0 01-15 15 210 210 0 1075 200 10 10 0 0120 0c0 250 0 250-100 350H130C30 400 30 400 30 150',
} as const
export type CardArtRank = keyof typeof CARD_RANK_PATHS
export type CardArtSuit = keyof typeof CARD_SUIT_PATHS

// Actual native SVG getBBox centres. The donor's club outline is asymmetric:
// centring the old viewBox itself would shift both its corner and central pip.
export const CARD_RANK_CENTERS: Record<CardArtRank, readonly [number, number]> = {
  '2': [-2.16553, 0], '3': [-5, 0], '4': [-15, 0], '5': [0, 0], '6': [0, 0],
  '7': [0, 0], '8': [0, 0], '9': [0, 0], T: [-5, 0], J: [0, -5], Q: [0, 0], K: [0, 0], A: [0, 0],
}
export const CARD_SUIT_BOUNDS: Record<CardArtSuit, readonly [number, number, number, number]> = {
  s: [-355, -500, 710, 1000], h: [-400, -500, 800, 1000], d: [-400, -500, 800, 1000],
  c: [-456.801544, -453.885468, 933.603027, 953.885559],
}
export const CARD_ART = {
  width: 256, height: 360, paper: '#fffef9', rim: '#a4aaa0', cornerRadius: 13, rankStroke: 150,
  index: { x: 52, y: 61, scaleX: .115, scaleY: .094 },
  cornerPip: { x: 47, y: 145, width: 45, height: 52 },
  centralPip: { x: 128, y: 180, width: 112, height: 140 },
} as const

export function cardArtParts(card: Card) {
  const rank = card[0] as CardArtRank, suit = card[1] as CardArtSuit
  return { rank, suit, color: CARD_SUITS[suit].color, rankPath: CARD_RANK_PATHS[rank], suitPath: CARD_SUIT_PATHS[suit] }
}
export function suitPlacement(suit: CardArtSuit, x: number, y: number, width: number, height: number) {
  const [left, top, w, h] = CARD_SUIT_BOUNDS[suit]
  return { x, y, scale: Math.min(width / w, height / h), centerX: left + w / 2, centerY: top + h / 2 }
}
function rankSvg(rank: CardArtRank, color: string, x: number, y: number, sx: number, sy: number) {
  const [cx, cy] = CARD_RANK_CENTERS[rank]
  return `<path data-card-rank="${rank === 'T' ? '10' : rank}" d="${CARD_RANK_PATHS[rank]}" transform="translate(${x} ${y}) scale(${sx} ${sy}) translate(${-cx} ${-cy})" fill="none" stroke="${color}" stroke-width="${CARD_ART.rankStroke}" stroke-linecap="round" stroke-linejoin="round"/>`
}
function suitSvg(suit: CardArtSuit, color: string, x: number, y: number, width: number, height: number) {
  const p = suitPlacement(suit, x, y, width, height)
  return `<path data-card-suit="${suit}" d="${CARD_SUIT_PATHS[suit]}" transform="translate(${x} ${y}) scale(${p.scale}) translate(${-p.centerX} ${-p.centerY})" fill="${color}"/>`
}
/** Full face uses exactly the Canvas factory's vector layout. No network/font loading. */
export function cardFaceSvg(card: Card): string {
  const { rank, suit, color } = cardArtParts(card), a = CARD_ART, i = a.index, p = a.cornerPip, center = a.centralPip
  const index = rankSvg(rank, color, i.x, i.y, i.scaleX, i.scaleY) + suitSvg(suit, color, p.x, p.y, p.width, p.height)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 360" aria-hidden="true"><rect width="256" height="360" rx="13" fill="${a.paper}"/><rect x="2" y="2" width="252" height="356" rx="11" fill="none" stroke="${a.rim}" stroke-width="1.2"/>${index}<g transform="translate(256 360) rotate(180)">${index}</g>${suitSvg(suit, color, center.x, center.y, center.width, center.height)}</svg>`
}
/** Compact LAST HAND variant shares the actual outlines/inks, with one rank above one pip. */
export function cardCompactSvg(card: Card): string {
  const { rank, suit, color } = cardArtParts(card)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 88" aria-hidden="true"><rect x=".5" y=".5" width="63" height="87" rx="6" fill="${CARD_ART.paper}" stroke="${CARD_ART.rim}" stroke-width="1"/>${rankSvg(rank, color, 32, 29, .060, .048)}${suitSvg(suit, color, 32, 70, 26, 28)}</svg>`
}

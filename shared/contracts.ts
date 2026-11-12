/** Wire protocol 1, state contract v2. All amounts are integer play chips. */
export const PROTOCOL_VERSION = 1 as const
export type WorldMode = 'NORMAL' | 'MIRROR'
export type Rank = '2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'T'|'J'|'Q'|'K'|'A'
export type Suit = 'c'|'d'|'h'|'s'
export type Card = `${Rank}${Suit}`
export type Stage = 'LOBBY'|'INTERMISSION'|'PREFLOP'|'FLOP'|'TURN'|'RIVER'|'SHOWDOWN'|'COMPLETE'
export type ActionType = 'fold'|'check'|'call'|'bet'|'raise'|'allIn'
/** bet/raise amount means total contribution on the current street, not increment. */
export interface PokerAction { type: ActionType; amount?: number }
export interface LegalAction { type: ActionType; amount?: number; min?: number; max?: number }
export interface PublicPlayer {
  id: string; name: string; seat: number; stack: number; bet: number; totalBet: number
  folded: boolean; allIn: boolean; connected: boolean; isBot: boolean; sittingOut?: boolean
  cards?: Card[] // only revealed at showdown for eligible hands; absent during betting
}
export interface Winner { playerId: string; amount: number; handName: string; cards?: Card[]; sharedPot?: boolean }
export interface LastHandResult {
  handId: string
  worldMode: WorldMode
  winners: (Winner & { playerName: string })[]
}
export interface PlayerPlacement { playerId: string; place: number; reason: 'eliminated'|'winner' }
export type MatchFormat = 'headsUp'|'fourMax'|'solo'
/** Only public presentation fields from the authenticated authority. */
export interface PublicProfile { playerId: string; displayName: string; avatarUrl: string|null }
export interface MatchState {
  status: 'WAITING'|'PLAYING'|'FINISHED'
  placements: PlayerPlacement[]
  winnerId: string|null
  format?: MatchFormat
  matchId?: string
  participantIds?: string[]
  rated?: boolean
}
/** Authority-owned decision clock; turnId changes for every new decision. */
export interface TurnTimer {
  turnId: string; playerId: string; durationMs: number; remainingMs: number
}
/** Applied blind level; an expired level is applied at the next deal. */
export interface TournamentState {
  level: number; levelDurationMs: number; remainingMs: number
  nextSmallBlind: number|null; nextBigBlind: number|null
}
export interface PublicState {
  handId: string; seq: number; stage: Stage; worldMode: WorldMode
  players: PublicPlayer[]; board: Card[]; pot: number; actorId: string|null
  dealerSeat: number; smallBlind: number; bigBlind: number; currentBet: number; minRaise: number
  winners: Winner[]
  previousHand?: LastHandResult // most recent completed hand, persists through the next deal/resync
  hostId?: string|null // room start permission, supplied by PokerSession
  match?: MatchState // authoritative elimination/overall winner; per-hand payout stays in winners
  turnTimer?: TurnTimer // human decisions only; resync never restarts this clock
  tournament?: TournamentState
  profiles?: Record<string, PublicProfile>
}
export interface PrivateState { handId: string; playerId: string; cards: Card[]; legalActions: LegalAction[] }
export interface BotObservation { state: PublicState; self: PrivateState }
export type EventType = 'HAND_PREPARED'|'HAND_STARTED'|'CARDS_DEALT'|'PLAYER_ACTED'|'STREET_CHANGED'|'WORLD_CHANGED'|'SHOWDOWN'|'PAYOUT'|'PLAYER_JOINED'|'PLAYER_LEFT'
/** Public animation events contain no hole cards until showdown. */
export interface GameEvent {
  handId: string; eventId: string; seq: number; type: EventType
  playerId?: string; action?: PokerAction; amount?: number; worldMode?: WorldMode
  cardCount?: number
  board?: Card[]; winners?: Winner[]
}
export type ClientCommand =
  | { type: 'hello'; version: 1 }
  | { type: 'snapshot' }
  | { type: 'ping'; nonce: string }
  | { type: 'surrender'; actionId: string }
  | { type: 'start'; actionId: string; mode: 'solo'|'multiplayer' }
  | { type: 'next'; handId: string; actionId: string }
  | { type: 'act'; handId: string; actionId: string; action: PokerAction }
export type ServerMessage =
  | { type: 'welcome'; version: 1; playerId: string }
  | { type: 'pong'; nonce: string }
  | { type: 'snapshot'; state: PublicState; privateState: PrivateState; events?: GameEvent[] }
  | { type: 'error'; code: string; message: string; actionId?: string }

export function isClientCommand(value: unknown): value is ClientCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const c = value as Record<string, unknown>
  const id = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 128
  if (c.type === 'hello') return c.version === 1
  if (c.type === 'snapshot') return true
  if (c.type === 'ping') return id(c.nonce)
  if (c.type === 'surrender') return id(c.actionId)
  if (c.type === 'start') return id(c.actionId) && (c.mode === 'solo' || c.mode === 'multiplayer')
  if (c.type === 'next') return id(c.handId) && id(c.actionId)
  if (c.type !== 'act' || !id(c.handId) || !id(c.actionId) || !c.action || typeof c.action !== 'object') return false
  const a = c.action as Record<string, unknown>
  return ['fold','check','call','bet','raise','allIn'].includes(a.type as string) &&
    (a.amount === undefined || (Number.isSafeInteger(a.amount) && (a.amount as number) >= 0))
}

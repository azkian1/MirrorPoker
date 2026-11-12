import type { MatchFormat, PublicProfile } from './contracts.ts'

export const MATCH_SIZE: Readonly<Record<MatchFormat, number>> = { headsUp:2, fourMax:4, solo:4 }

/** Keep only bounded, safe URL data; SVG is rendered by an HTML image, never markup. */
export function publicProfile(playerId:string, name:string, avatar:unknown):PublicProfile {
  const displayName=Array.from(name.trim()||'Player').slice(0,80).join('')
  const avatarUrl=typeof avatar==='string'&&avatar.length<=4096&&/^https?:\/\/[^\s]+$/i.test(avatar)?avatar:null
  return {playerId,displayName,avatarUrl}
}

import type { Creator, Provider } from './types'

export const PROVIDERS: Provider[] = ['x', 'spotify', 'twitch', 'github', 'fomo']
/** Who a NEW launch can name. Spotify is out while Spotify refuses its sign-in (403): those fees could never be claimed. */
export const LAUNCH_PROVIDERS: Provider[] = ['x', 'twitch', 'github', 'fomo']

export const LABEL: Record<Provider, string> = { x: 'X', spotify: 'Spotify', twitch: 'Twitch', github: 'GitHub', fomo: 'FOMO' }

/** How each platform is paid. Mirrors the docs, section 9. */
export const PAID_BY: Record<Provider, 'claim' | 'push'> = { x: 'claim', spotify: 'claim', twitch: 'claim', github: 'claim', fomo: 'push' }

export const HINT: Record<Provider, string> = {
  x: 'An X handle with or without the @.',
  spotify: 'An artist name or a profile link (open.spotify.com/user/…).',
  twitch: 'A channel name or a twitch.tv link.',
  github: 'A username or a github.com link.',
  fomo: 'A FOMO handle.',
}

/** The name written into a token's description: "Fees to <this> via EARN". */
export function feeName(c: Pick<Creator, 'provider' | 'handle' | 'id'>): string {
  switch (c.provider) {
    case 'x': return `@${c.handle}`
    case 'spotify': return `spotify:${c.id}`
    default: return `${c.provider}:${c.handle}`
  }
}

export const feeLine = (c: Pick<Creator, 'provider' | 'handle' | 'id'> | null) => `Fees to ${c ? feeName(c) : '@handle'} via EARN`

/**
 * The description line for a token's recipients: one account keeps the classic form, a split
 * lists every share. Rows without an account yet read as "@handle".
 */
export function splitLine(rows: { creator: Pick<Creator, 'provider' | 'handle' | 'id'> | null; bps: number }[]): string {
  if (rows.length <= 1) return feeLine(rows[0]?.creator ?? null)
  // Largest share first, matching the line the server writes into the token.
  const ordered = [...rows].sort((a, b) => b.bps - a.bps)
  return `Fees: ${ordered.map((r) => `${Math.round(r.bps / 100)}% ${r.creator ? feeName(r.creator) : '@handle'}`).join(', ')} via EARN`
}

/** "@a", "@a +2": the largest recipient and how many more. */
export function recipientsLabel(t: { creator: Creator; recipients?: { creator: Creator }[] }): string {
  const n = t.recipients?.length ?? 1
  return n > 1 ? `${at(t.creator)} +${n - 1}` : at(t.creator)
}

export function profilePath(c: Pick<Creator, 'provider' | 'handle' | 'id'>): string {
  return c.provider === 'spotify' ? `/spotify/${encodeURIComponent(c.id)}` : `/${c.provider}/${encodeURIComponent(c.handle)}`
}

export const at = (c: Pick<Creator, 'provider' | 'handle' | 'name'>) => (c.provider === 'spotify' ? c.name : `@${c.handle}`)

/**
 * What people paste into the account search: "@name", "x.com/name", "https://twitter.com/name?s=21", a Twitch or GitHub
 * profile link. Reduced to the bare handle (Spotify and FOMO searches are left as typed).
 */
export function cleanHandle(provider: Provider, q: string): string {
  let s = q.trim()
  const hosts: Partial<Record<Provider, RegExp>> = {
    x: /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i,
    twitch: /^(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/([A-Za-z0-9_]{3,25})/i,
    github: /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})/i,
  }
  const m = hosts[provider]?.exec(s)
  if (m) return m[1]!
  if (provider === 'x' || provider === 'twitch' || provider === 'github') s = s.replace(/^@+/, '')
  return s
}

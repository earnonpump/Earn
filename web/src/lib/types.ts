export type Provider = 'x' | 'twitch' | 'github' | 'spotify' | 'fomo'

export type Creator = { provider: Provider; id: string; handle: string; name: string; avatar: string; verified: boolean }

/** One recipient of a token's creator fees. bps = percent × 100; a token's recipients always total 10,000. */
export type Recipient = { creator: Creator; bps: number }

export type Token = {
  mint: string
  name: string
  symbol: string
  image: string
  description: string
  createdAt: number
  graduated: boolean
  marketCapUsd: number
  /** Earned: claimed + waiting on chain. For $EARN: collected + pending buybacks. */
  feesUsd: number | null
  pendingBuybackUsd?: number
  /** Custom pair: the token this coin is paired with, and its fees in that token. */
  pair?: { mint: string; symbol: string; decimals: number; feesAmount: number }
  accruingUsd: number
  launchTx: string
  /** The largest-share recipient (the only one for a single-recipient token). */
  creator: Creator
  /** Every recipient with its share. Length 1 for a single-recipient token. */
  recipients?: Recipient[]
  platform?: boolean
  feeRecipient?: string
}

export type Claim = { signature: string; time: number; grossUsd: number; recipientUsd: number; treasuryUsd?: number; creator: Creator }
export type Payout = { signature: string; time: number; usd: number; mode: 'usdc' | 'sol'; creator: Creator; tokenImage?: string }

export type TokenDetail = Token & {
  priceUsd: number
  change24h: number
  volume24hUsd: number
  holders: number
  trades24h: number
  curveProgress: number
  owedUsd: number | null
  receivedUsd: number | null
  claims: Claim[]
  payouts: Payout[]
}

export type CreatorDetail = {
  creator: Creator
  tokens: Token[]
  owedUsd: number
  settlingUsd: number
  accruingUsd: number
  paidUsd: number
  lastPaidAt: number | null
  payouts: Payout[]
  claims: Claim[]
  fomoWallet?: { address: string; status: 'confirmed' | 'pending' } | null
  feeAddress: string
}

export type Buyback = {
  mint: string; wallet: string; pendingUsd: number; pendingSol: number; collectedUsd: number; totalUsd: number
  count?: number; boughtBackSol?: number; boughtBackUsd?: number; burnedTokens?: number; burnedPct?: number
  recent?: { time: number; sol: number; tokens: number; buySig: string; burnSig: string }[]
}
export type Stats = {
  feesAllTimeUsd: number
  claimedAllTimeUsd?: number
  accruingUsd?: number
  buyback?: Buyback | null
  paidAllTimeUsd: number
  owedUsd: number
  readyToSendUsd: number
  protocolAllTimeUsd?: number
  recipientsPaid: number
  launches: number
  programId: string
  treasury?: string
  recipientBps?: number
}

export type TopCreator = { creator: Creator; tokens: number; feesUsd: number; paidUsd: number; tokenImage?: string }
export type Analytics = { feesUsd: number; claimedUsd?: number; accruingUsd?: number; buyback?: Buyback | null; protocolUsd?: number; paidUsd: number; owedUsd: number; daily: { day: string; feesUsd: number; launches: number }[] }
export type Me = { accounts: { creator: Creator; owedUsd: number; owedLamports: number; tokens?: { mint: string; symbol: string; decimals: number; owedUnits: string; owed: number; owedUsd: number }[] }[] }
export type Page<T> = { items: T[]; total: number }
export type SortKey = 'fees' | 'mcap' | 'recent'
export type Range = '24h' | '7d' | '30d' | 'all'

export type Platform = { launchesOpen: boolean; token: Token | null }

export type Burns = {
  count: number; burnedTokens: number; burnedPct: number; boughtBackSol: number; usdSpent: number; lastAt: number | null
  mint: string | null; pendingSol: number; pendingUsd: number
  items: { time: number; sol: number; tokens: number; buySig: string; burnSig: string }[]
}

export type TickerFee = { sol: number; to: string; mint: string; name: string; symbol: string; launchedAt: number; freeAt: number }

/** Custom pairs: a token a coin can be paired with (its creator fees accrue in it). */
export type PairItem = { mint: string; symbol: string; name: string; image: string; priceUsd: number; liquidityUsd?: number; kind?: 'listed' | 'curve' | 'pool'; decimals?: number }

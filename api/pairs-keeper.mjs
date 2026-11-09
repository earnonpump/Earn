/**
 * Custom pairs, keeper side: a coin paired with token Q pays its creator fees IN Q. One claim per (fee address, Q):
 *
 *   create the fee address's Q account (idempotent; pump.fun's collect needs it to exist)
 *   sweep_creator_fee on each coin's curve / pool that holds unswept Q (new-style trades keep it there)
 *   collect_creator_fee_v2 (pump.fun creator vault → fee address's Q account), collect_coin_creator_fee once graduated
 *   harvest_token / harvest_split_token (fee address's Q account → EARN's vault for Q, credited 100% to the creator(s))
 *
 * All permissionless; the keeper only pays fees and rent. Builders come from lib/pairs.mjs (vendored from ~/pairs).
 */
import { ComputeBudgetProgram, PublicKey } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import * as pairs from '../lib/pairs.mjs'
import { accountAddress, splitAddress, tokenLedgerAddress } from '../lib/earn.mjs'

const MAX_SWEEPS = 3

/** Everything waiting in Q for this fee address across its paired coins (smallest units of Q). */
export async function pendingTokenFor(conn, { feeAddress, coins, quote }) {
  const fee = new PublicKey(feeAddress)
  let total = 0n, collectable = 0n
  const perCoin = []
  for (const c of coins) {
    const p = await pairs.pendingQuoteFees(conn, { mint: c.mint, quote, creator: fee })
    perCoin.push({ mint: c.mint, unswept: p.curveUnswept + p.poolUnswept, graduated: p.graduated, p })
  }
  // the two vaults are per creator, not per coin: read once
  const vaults = perCoin[0]?.p ?? { curve: 0n, amm: 0n }
  collectable = vaults.curve + vaults.amm
  const atFee = await conn.getAccountInfo(pairs.ata(fee, new PublicKey(quote.mint), new PublicKey(quote.tokenProgram)))
  const atFeeAmount = atFee ? pairs.tokenAccountAmount(atFee.data) : 0n
  total = perCoin.reduce((s, c) => s + c.unswept, 0n) + collectable + atFeeAmount
  return { total, perCoin, collectable, atFee: atFeeAmount, anyGraduated: perCoin.some((c) => c.graduated) }
}

/**
 * The claim instructions for one fee address in Q, or null when nothing waits. `split`: { splitKeyHex, recipientKeysHex }
 * for a split fee address (recipients' ledgers are created first, idempotently); otherwise `keyHex`.
 */
export async function buildTokenClaim(conn, earn, { payer, feeAddress, keyHex = null, split = null, coins, quote, minUnits = 1n }) {
  const fee = new PublicKey(feeAddress), Q = new PublicKey(quote.mint), prog = new PublicKey(quote.tokenProgram)
  const pending = await pendingTokenFor(conn, { feeAddress, coins, quote })
  if (pending.total < minUnits || pending.total === 0n) return null
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })]
  const feeQ = pairs.ata(fee, Q, prog)
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(payer, feeQ, fee, Q, prog))
  const sweepers = pending.perCoin.filter((c) => c.unswept > 0n).sort((a, b) => (b.unswept > a.unswept ? 1 : -1)).slice(0, MAX_SWEEPS)
  for (const c of sweepers) {
    if (c.p.curveUnswept > 0n) ixs.push(await pairs.sweepCurveCreatorFeeIx(conn, { mint: c.mint, payer, creator: fee, quote }))
    if (c.p.poolUnswept > 0n) ixs.push(await pairs.sweepPoolCreatorFeeIx(conn, { mint: c.mint, payer, creator: fee, quote }))
  }
  // pump.fun's creator vault Q account must exist for its collect; PumpSwap's only matters once a coin graduated
  const vault = pairs.creatorVaultAddress(fee)
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(payer, pairs.ata(vault, Q, prog), vault, Q, prog))
  ixs.push(await pairs.collectCreatorFeeV2Ix(conn, { creator: fee, quote }))
  if (pending.anyGraduated || pending.collectable > 0n) {
    const auth = pairs.ammCreatorVaultAuthority(fee)
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(payer, pairs.ata(auth, Q, prog), auth, Q, prog))
    ixs.push(await pairs.collectCoinCreatorFeeIx(conn, { creator: fee, quote }))
  }
  if (split) {
    const keys = split.recipientKeysHex.map((k) => Buffer.from(k, 'hex'))
    for (const k of keys) ixs.push(await earn.methods.initTokenLedger([...k]).accountsPartial({ ledger: tokenLedgerAddress(k, Q), mint: Q, payer }).instruction())
    const splitKey = Buffer.from(split.splitKeyHex, 'hex')
    ixs.push(await earn.methods.harvestSplitToken([...splitKey]).accountsPartial({ feeAddress: fee, split: splitAddress(splitKey), mint: Q, feeToken: feeQ, payer, tokenProgram: prog })
      .remainingAccounts(keys.map((k) => ({ pubkey: tokenLedgerAddress(k, Q), isSigner: false, isWritable: true }))).instruction())
  } else {
    const key = Buffer.from(keyHex, 'hex')
    ixs.push(await earn.methods.harvestToken([...key]).accountsPartial({ feeAddress: fee, mint: Q, feeToken: feeQ, payer, tokenProgram: prog }).instruction())
  }
  return { ixs, expected: pending.total, perCoin: pending.perCoin }
}

export { accountAddress }

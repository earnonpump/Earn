// The automated $EARN go-live, against the real pump.fun program on the local validator (./run-tests.sh):
// the watcher must fire on the launch wallet's OWN create of EARN, fast, and on nothing else.
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { Connection, Keypair, LAMPORTS_PER_SOL, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { openDb, kvSet } from '../api/db.mjs'
import { startLaunchWatcher } from '../api/launch-watch.mjs'
import { TOKEN_2022, ata, buyExactSolInIx, createV2Ix, loadGlobal, pumpProgram } from '../lib/pump.mjs'

const conn = new Connection(`http://127.0.0.1:${process.env.LOCAL_RPC_PORT ?? 8997}`, 'confirmed')
const wallet = Keypair.generate(), stranger = Keypair.generate()
const db = openDb(':memory:')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function launch({ payer, creator, symbol, name = 'Earn' }) {
  const mint = Keypair.generate()
  const pump = pumpProgram(conn), global = await loadGlobal(conn)
  const { blockhash } = await conn.getLatestBlockhash()
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [
    await createV2Ix(pump, { mint: mint.publicKey, user: payer.publicKey, name, symbol, uri: 'https://gateway.pinata.cloud/ipfs/bafkreif54orioftrk6fvayq6ky4xrx2oqesktvhigmc76ftmyk2n2pjrdu', creator }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(payer.publicKey, mint.publicKey, TOKEN_2022), payer.publicKey, mint.publicKey, TOKEN_2022),
    await buyExactSolInIx(pump, global, { mint: mint.publicKey, user: payer.publicKey, creator, lamports: BigInt(LAMPORTS_PER_SOL / 10) }),
  ] }).compileToV0Message())
  tx.sign([payer, mint])
  const sig = await conn.sendTransaction(tx)
  await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, 'confirmed')
  return { mint: mint.publicKey.toBase58(), confirmedAt: Date.now() }
}

const lives = []
let stop = () => {}
const quiet = { info: () => {}, error: (m) => console.error(m) }

before(async () => {
  for (const k of [wallet, stranger]) {
    const s = await conn.requestAirdrop(k.publicKey, 10 * LAMPORTS_PER_SOL)
    await conn.confirmTransaction({ signature: s, ...(await conn.getLatestBlockhash()) })
  }
  // The poll runs once at start; after that only the websocket can fire within the test's time.
  stop = startLaunchWatcher({ db, conn, wallet: wallet.publicKey.toBase58(), symbol: 'EARN', pollMs: 600_000, log: quiet,
    goLive: async ({ mint, coin }) => { lives.push({ mint, coin, at: Date.now() }); kvSet(db, 'platform', JSON.stringify({ mint })) } })
  await sleep(1500) // let the socket subscribe
})
after(() => stop())

test('a stranger naming the wallet as creator is a mention, not the launch: ignored', async () => {
  await launch({ payer: stranger, creator: wallet.publicKey, symbol: 'EARN' })
  await sleep(4000)
  assert.equal(lives.length, 0)
})

test('the wallet creating another ticker is ignored', async () => {
  await launch({ payer: wallet, creator: wallet.publicKey, symbol: 'NOPE', name: 'Nope' })
  await sleep(4000)
  assert.equal(lives.length, 0)
})

test("the wallet's own create of EARN goes live within seconds, and only once", async () => {
  const { mint, confirmedAt } = await launch({ payer: wallet, creator: wallet.publicKey, symbol: 'EARN' })
  for (let i = 0; i < 100 && !lives.length; i++) await sleep(100)
  assert.equal(lives.length, 1, 'went live')
  assert.equal(lives[0].mint, mint)
  assert.equal(lives[0].coin.symbol, 'EARN'); assert.equal(lives[0].coin.name, 'Earn')
  assert.equal(lives[0].coin.creator, wallet.publicKey.toBase58())
  const ms = lives[0].at - confirmedAt
  console.log(`went live ${ms} ms after the create confirmed`)
  assert.ok(ms < 5000, `fast (${ms} ms)`)
  await launch({ payer: wallet, creator: wallet.publicKey, symbol: 'EARN' }) // a second EARN later changes nothing
  await sleep(3000)
  assert.equal(lives.length, 1)
})

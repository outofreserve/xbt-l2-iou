# Bitcoin Layer 2 IOU System

A dual-layer blockchain simulation where Nostr-style events act as tradeable
IOUs 1:1 backed by Bitcoin locked in HTLCs.

- **Layer 1** — canonical settlement chain. Validates HTLC backing against a
  Bitcoin full node (RPC interface + simulated in-memory node), mints/burns
  IOUs, enforces protocol-mandated automatic preimage reveal, and anchors
  Layer 2 checkpoints.
- **Layer 2** — fast-lane chain for low-latency P2P IOU transfers, mined
  every 10ms with checkpoints committed back to Layer 1 every 1,000 blocks
  (~10s).

## Layout

```
src/
  types/        shared types: events (kinds 29000-29005), block headers/bodies, layer params
  crypto/       sha256/sha256d, merkle tree, secp256k1 keys/sign/verify
  state/        account ledger, HTLC registry, event-applying state machine
  validation/   canonical event id, signing, schema/business-rule validation
  bitcoin/      BitcoinRpcClient interface + SimulatedBitcoinNode (in-memory)
  consensus/    PoW mining, difficulty retargeting, chain validation/selection
  network/      fee-priority mempool, pub/sub relay (with offline simulation)
  l1/           Layer1Chain (HTLC validation, auto preimage reveal, Bitcoin watcher, PoW mining)
  l2/           Layer2Chain (transfers, fee collection, auto-checkpointing, L1 resync/fallback)
tests/          vitest suite (consensus, L1<->Bitcoin, redemption/reorg, checkpointing, mempool)
main.ts         end-to-end demo scenario
```

## Running

```bash
npm install
npm run build   # tsc emit to dist/
npm test        # vitest run
npm start        # runs the end-to-end demo (tsx main.ts)
```

## Demo scenario (`main.ts`)

1. A user locks 100 BTC in a (simulated) Bitcoin HTLC.
2. The issuer submits an `iou_creation` event; Layer 1 verifies the HTLC has
   6+ confirmations before minting 100 BTC of IOUs to the issuer.
3. IOUs are traded on Layer 2 (issuer → Alice/Bob, Alice → Bob), 1,000 L2
   blocks are mined, triggering an automatic checkpoint that Layer 1 includes
   in its next block header (`layer2_state_root` / `layer2_block_range`).
4. The Layer 2 relay is simulated as offline; a transfer is submitted
   directly to Layer 1 instead (fallback mechanism), then the relay recovers
   and Layer 2 resyncs its ledger from Layer 1.
5. Alice submits a `redemption_request`; the issuer's preimage is
   automatically revealed within the same/next L1 block (no issuer choice),
   the simulated Bitcoin HTLC is spent with that preimage, and once the
   spend reaches 6+ confirmations the corresponding IOUs are burned from
   Alice's balance. Bitcoin reorgs are handled by reverting confirmations and
   marking the redemption `reorg_pending` until the chain re-stabilizes.

Performance metrics (wall-clock demo time, L1/L2 blocks mined, L2 mining
throughput, state resync time) are printed at the end.

## Swapping in a real Bitcoin node

`src/bitcoin/rpc-client.ts` defines a `BitcoinRpcClient` interface
(`getUtxo`, `getBlockHeight`, `findHtlcSpend`, `getMempoolTx`, ...). This
project uses `SimulatedBitcoinNode` (`src/bitcoin/simulated-node.ts`), a
purely in-memory implementation, so the whole system runs without any real
Bitcoin infrastructure. To go live, implement the same interface against a
real `bitcoind` (e.g. via JSON-RPC using `getrawtransaction`,
`gettxout`/`gettxoutproof`, `getblockcount`, mempool/ZMQ watching for HTLC
spends) and pass that implementation to `Layer1Chain` instead — no other
code needs to change.

## Notes / simplifications

- Nostr event signing follows NIP-01 shape (id = sha256 of a canonical
  serialization, secp256k1 schnorr-style signing via `@noble/secp256k1`) but
  is not a full NIP-01/NIP-19 implementation.
- Difficulty is modeled as leading-zero-bits against a fixed max target
  rather than Bitcoin's compact `nBits` encoding; retargeting math (ratio of
  actual vs. expected time, clamped to 0.25x–4x) mirrors Bitcoin's approach.
- Demo-scale initial difficulty is intentionally trivial so PoW mining is
  near-instantaneous while still being real (nonce search against a target).

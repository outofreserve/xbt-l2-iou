/**
 * Bitcoin Layer 2 IOU System — end-to-end demo scenario.
 *
 * Walks through the full lifecycle described in the spec:
 *   1. A user locks 100 BTC in a (simulated) Bitcoin HTLC.
 *   2. The issuer creates IOUs on Layer 1, backed 1:1 by that HTLC.
 *   3. Users trade IOUs on Layer 2 (fast lane), which periodically
 *      checkpoints its state root back to Layer 1.
 *   4. The Layer 2 relay goes offline; a user falls back to submitting a
 *      transfer directly to Layer 1, then the relay recovers and Layer 2
 *      resyncs from Layer 1.
 *   5. A holder redeems IOUs on Layer 1: the issuer's preimage is revealed
 *      automatically (protocol-mandated), the (simulated) Bitcoin HTLC is
 *      spent, and once it reaches 6 confirmations the IOUs are burned.
 *
 * Run with: `npm start` (or `npx tsx main.ts`).
 */
import { generateKeyPair, type KeyPair } from './src/crypto/keys.js';
import { sha256Hex } from './src/crypto/hash.js';
import { createEvent } from './src/validation/events.js';
import { EventKind, type IouCreationEvent, type RedemptionRequestEvent, type TransferEvent } from './src/types/index.js';
import { SimulatedBitcoinNode } from './src/bitcoin/simulated-node.js';
import { Relay } from './src/network/relay.js';
import { PreimageVault } from './src/l1/preimage-vault.js';
import { Layer1Chain } from './src/l1/chain.js';
import { Layer2Chain } from './src/l2/chain.js';
import { CHECKPOINT_INTERVAL_L2_BLOCKS } from './src/types/index.js';
import { randomBytes } from 'node:crypto';

const SATS_PER_BTC = 100_000_000;

function section(title: string): void {
  console.log(`\n${'='.repeat(70)}\n${title}\n${'='.repeat(70)}`);
}

function fmtSats(sats: number): string {
  return `${sats.toLocaleString()} sats (${(sats / SATS_PER_BTC).toFixed(8)} BTC)`;
}

async function main(): Promise<void> {
  const t0 = performance.now();

  section('ACTORS');
  const issuer: KeyPair = generateKeyPair();
  const alice: KeyPair = generateKeyPair();
  const bob: KeyPair = generateKeyPair();
  const l1Miner: KeyPair = generateKeyPair();
  const l2Miner: KeyPair = generateKeyPair();
  console.log(`issuer:   ${issuer.publicKey}`);
  console.log(`alice:    ${alice.publicKey}`);
  console.log(`bob:      ${bob.publicKey}`);
  console.log(`l1 miner: ${l1Miner.publicKey}`);
  console.log(`l2 miner: ${l2Miner.publicKey}`);

  const bitcoin = new SimulatedBitcoinNode();
  const relay = new Relay();
  const preimageVault = new PreimageVault();

  const l1Chain = new Layer1Chain({
    bitcoinClient: bitcoin,
    relay,
    preimageVault,
    minerAddress: l1Miner.publicKey,
    initialTargetBits: 4,
    minerMinFeeSatoshis: 1,
  });
  const l2Chain = new Layer2Chain({
    relay,
    l1Chain,
    minerAddress: l2Miner.publicKey,
    minerPrivateKey: l2Miner.privateKey,
    initialTargetBits: 2,
    minerMinFeeSatoshis: 0,
  });

  // ---------------------------------------------------------------------
  // Step 1: lock 100 BTC in a simulated Bitcoin HTLC
  // ---------------------------------------------------------------------
  section('STEP 1: Lock 100 BTC in Bitcoin HTLC');
  const lockAmount = 100 * SATS_PER_BTC;
  const preimage = randomBytes(32).toString('hex');
  const preimageHash = sha256Hex(Buffer.from(preimage, 'hex'));
  const { address: htlcAddress, txid, vout } = await bitcoin.lockHtlc({
    amountSatoshis: lockAmount,
    preimageHash,
  });
  console.log(`HTLC funded: address=${htlcAddress} txid=${txid} vout=${vout}`);
  console.log(`amount=${fmtSats(lockAmount)} preimage_hash=${preimageHash}`);
  await bitcoin.mineBlocks(6);
  console.log(`mined 6 Bitcoin confirmations (height=${await bitcoin.getBlockCount()})`);
  preimageVault.register(issuer.publicKey, preimageHash, preimage, issuer.privateKey);

  // ---------------------------------------------------------------------
  // Step 2: issuer creates IOUs on Layer 1, backed by the HTLC
  // ---------------------------------------------------------------------
  section('STEP 2: Issuer creates IOUs on Layer 1');
  const iouCreation = createEvent<IouCreationEvent>(
    {
      pubkey: issuer.publicKey,
      created_at: Date.now(),
      kind: EventKind.IOU_CREATION,
      type: 'iou_creation',
      btc_htlc_address: htlcAddress,
      btc_txid: txid,
      btc_output_index: vout,
      amount_satoshis: lockAmount,
      preimage_hash: preimageHash,
      issuer: issuer.publicKey,
    },
    issuer.privateKey,
  );
  const creationResult = await l1Chain.submitEvent(iouCreation);
  console.log(`iou_creation submitted: accepted=${creationResult.accepted}`, creationResult.errors);
  const tMineL1Start = performance.now();
  await l1Chain.mineBlock();
  const tMineL1End = performance.now();
  console.log(`L1 height=${l1Chain.getHeight()} block time=${(tMineL1End - tMineL1Start).toFixed(2)}ms`);
  console.log(`issuer L1 balance: ${fmtSats(l1Chain.getLedgerBalance(issuer.publicKey, issuer.publicKey))}`);

  // ---------------------------------------------------------------------
  // Step 3: users trade IOUs on Layer 2 (fast lane)
  // ---------------------------------------------------------------------
  section('STEP 3: Trade IOUs on Layer 2');
  l2Chain.resyncFromL1();
  console.log(`issuer L2 balance after resync: ${fmtSats(l2Chain.getBalance(issuer.publicKey, issuer.publicKey))}`);

  const aliceAllocation = 30 * SATS_PER_BTC;
  const bobAllocation = 20 * SATS_PER_BTC;
  const issuerToAlice = createEvent<TransferEvent>(
    {
      pubkey: issuer.publicKey,
      created_at: Date.now(),
      kind: EventKind.TRANSFER,
      type: 'transfer',
      from: issuer.publicKey,
      to: alice.publicKey,
      issuer: issuer.publicKey,
      amount: aliceAllocation,
      fee: 500,
    },
    issuer.privateKey,
  );
  const issuerToBob = createEvent<TransferEvent>(
    {
      pubkey: issuer.publicKey,
      created_at: Date.now(),
      kind: EventKind.TRANSFER,
      type: 'transfer',
      from: issuer.publicKey,
      to: bob.publicKey,
      issuer: issuer.publicKey,
      amount: bobAllocation,
      fee: 500,
    },
    issuer.privateKey,
  );
  console.log('issuer->alice:', l2Chain.submitTransfer(issuerToAlice));
  console.log('issuer->bob:  ', l2Chain.submitTransfer(issuerToBob));
  l2Chain.mineBlock();

  const aliceToBob = createEvent<TransferEvent>(
    {
      pubkey: alice.publicKey,
      created_at: Date.now(),
      kind: EventKind.TRANSFER,
      type: 'transfer',
      from: alice.publicKey,
      to: bob.publicKey,
      issuer: issuer.publicKey,
      amount: 5 * SATS_PER_BTC,
      fee: 250,
    },
    alice.privateKey,
  );
  console.log('alice->bob (P2P trade):', l2Chain.submitTransfer(aliceToBob));
  l2Chain.mineBlock();

  console.log(`alice L2 balance: ${fmtSats(l2Chain.getBalance(issuer.publicKey, alice.publicKey))}`);
  console.log(`bob L2 balance:   ${fmtSats(l2Chain.getBalance(issuer.publicKey, bob.publicKey))}`);
  console.log(`l2 miner L2 fee balance: ${fmtSats(l2Chain.getBalance(issuer.publicKey, l2Miner.publicKey))}`);

  section(`STEP 3b: mine to ${CHECKPOINT_INTERVAL_L2_BLOCKS} L2 blocks to trigger auto-checkpoint`);
  const tL2Start = performance.now();
  while (l2Chain.getHeight() < CHECKPOINT_INTERVAL_L2_BLOCKS) {
    l2Chain.mineBlock();
  }
  const tL2End = performance.now();
  console.log(
    `L2 height=${l2Chain.getHeight()} mined in ${(tL2End - tL2Start).toFixed(2)}ms ` +
      `(${(l2Chain.getHeight() / ((tL2End - tL2Start) / 1000)).toFixed(0)} blocks/sec)`,
  );
  await l1Chain.mineBlock(); // L1 includes the checkpoint submitted by L2
  const l1Tip = l1Chain.chain[l1Chain.chain.length - 1];
  console.log(
    `L1 block #${l1Tip.header.height} layer2_state_root=${l1Tip.header.layer2_state_root.slice(0, 16)}… ` +
      `layer2_block_range=[${l1Tip.header.layer2_block_range}]`,
  );

  // ---------------------------------------------------------------------
  // Step 4: L2 relay outage -> fallback to Layer 1 -> recovery -> resync
  // ---------------------------------------------------------------------
  section('STEP 4: Layer 2 relay outage -> fallback to Layer 1 -> recovery');
  relay.setOnline(false);
  console.log(`relay online=${relay.isOnline()}`);
  const fallbackAttempt = l2Chain.submitTransfer(
    createEvent<TransferEvent>(
      {
        pubkey: issuer.publicKey,
        created_at: Date.now(),
        kind: EventKind.TRANSFER,
        type: 'transfer',
        from: issuer.publicKey,
        to: alice.publicKey,
        issuer: issuer.publicKey,
        amount: 10 * SATS_PER_BTC,
        fee: 100,
      },
      issuer.privateKey,
    ),
  );
  console.log('L2 submit while offline:', fallbackAttempt);

  const fallbackTransfer = createEvent<TransferEvent>(
    {
      pubkey: issuer.publicKey,
      created_at: Date.now(),
      kind: EventKind.TRANSFER,
      type: 'transfer',
      from: issuer.publicKey,
      to: alice.publicKey,
      issuer: issuer.publicKey,
      amount: 10 * SATS_PER_BTC,
      fee: 100,
    },
    issuer.privateKey,
  );
  const fallbackResult = await l1Chain.submitEvent(fallbackTransfer);
  console.log('fallback submitted directly to L1:', fallbackResult);
  await l1Chain.mineBlock();
  console.log(`alice L1 balance after fallback: ${fmtSats(l1Chain.getLedgerBalance(issuer.publicKey, alice.publicKey))}`);

  relay.setOnline(true);
  console.log(`relay recovered, online=${relay.isOnline()}`);
  const tResyncStart = performance.now();
  l2Chain.resyncFromL1();
  const tResyncEnd = performance.now();
  console.log(`state resync time: ${(tResyncEnd - tResyncStart).toFixed(3)}ms`);
  console.log(`alice L2 balance after resync: ${fmtSats(l2Chain.getBalance(issuer.publicKey, alice.publicKey))}`);

  // ---------------------------------------------------------------------
  // Step 5: holder redeems IOUs; automatic preimage reveal; HTLC spent; burn
  // ---------------------------------------------------------------------
  section('STEP 5: Alice redeems IOUs on Layer 1');
  const redeemAmount = 10 * SATS_PER_BTC;
  const redemptionRequest = createEvent<RedemptionRequestEvent>(
    {
      pubkey: alice.publicKey,
      created_at: Date.now(),
      kind: EventKind.REDEMPTION_REQUEST,
      type: 'redemption_request',
      holder: alice.publicKey,
      issuer: issuer.publicKey,
      amount: redeemAmount,
    },
    alice.privateKey,
  );
  const redemptionResult = await l1Chain.submitEvent(redemptionRequest);
  console.log('redemption_request submitted:', redemptionResult);

  console.log('\n--- mining L1 block: issuer MUST auto-reveal preimage this block or next ---');
  await l1Chain.mineBlock();
  const htlcAfterReveal = l1Chain.state.htlcRegistry.get(htlcAddress);
  console.log(`HTLC preimage revealed on-chain: ${htlcAfterReveal?.preimage ? 'YES' : 'no (next block)'}`);

  console.log('\n--- mining L1 blocks while Bitcoin HTLC spend gains confirmations ---');
  for (let i = 0; i < 12; i++) {
    await bitcoin.mineBlocks(1);
    await l1Chain.mineBlock();
    const pending = [...l1Chain.state.pendingRedemptions.values()][0];
    console.log(`  bitcoin height=${await bitcoin.getBlockCount()} redemption confirmed=${pending.confirmed}`);
    if (pending.confirmed) break;
  }

  const finalHtlc = l1Chain.state.htlcRegistry.get(htlcAddress);
  console.log(`\nHTLC status=${finalHtlc?.status} amount_redeemed=${fmtSats(finalHtlc?.amount_redeemed ?? 0)}`);
  console.log(`alice L1 balance after redemption: ${fmtSats(l1Chain.getLedgerBalance(issuer.publicKey, alice.publicKey))}`);
  console.log(`total minted:  ${fmtSats(l1Chain.state.totalMinted())}`);
  console.log(`total burned:  ${fmtSats(l1Chain.state.totalBurned())}`);
  console.log(`circulating:   ${fmtSats(l1Chain.state.circulatingSupply())}`);

  // ---------------------------------------------------------------------
  // Performance metrics
  // ---------------------------------------------------------------------
  section('PERFORMANCE METRICS');
  const totalElapsedMs = performance.now() - t0;
  const l2EventCount = l2Chain.chain.reduce((sum, b) => sum + b.body.events.length, 0);
  const l1EventCount = l1Chain.chain.reduce((sum, b) => sum + b.body.events.length, 0);
  console.log(`total demo wall time:       ${totalElapsedMs.toFixed(2)}ms`);
  console.log(`L1 blocks mined:            ${l1Chain.getHeight()}`);
  console.log(`L2 blocks mined:            ${l2Chain.getHeight()}`);
  console.log(`L1 events processed:        ${l1EventCount}`);
  console.log(`L2 events processed:        ${l2EventCount}`);
  console.log(
    `L2 mining throughput:       ${(l2Chain.getHeight() / ((tL2End - tL2Start) / 1000)).toFixed(0)} blocks/sec ` +
      `(target: 100 blocks/sec @ 10ms/block)`,
  );
  console.log(`state resync (L2<-L1) time: ${(tResyncEnd - tResyncStart).toFixed(3)}ms`);
  console.log('\nFinal balances (issuer-scoped ledger):');
  console.log('  L1:', l1Chain.state.ledger.entries());
  console.log('  L2:', l2Chain.ledger.entries());
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exitCode = 1;
});

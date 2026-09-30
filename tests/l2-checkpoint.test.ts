import { describe, it, expect, beforeEach } from 'vitest';
import { generateKeyPair, type KeyPair } from '../src/crypto/keys.js';
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../src/crypto/hash.js';
import { createEvent } from '../src/validation/events.js';
import { EventKind, type IouCreationEvent, type TransferEvent, CHECKPOINT_INTERVAL_L2_BLOCKS } from '../src/types/index.js';
import { SimulatedBitcoinNode } from '../src/bitcoin/simulated-node.js';
import { Relay } from '../src/network/relay.js';
import { PreimageVault } from '../src/l1/preimage-vault.js';
import { Layer1Chain } from '../src/l1/chain.js';
import { Layer2Chain } from '../src/l2/chain.js';

async function mintToIssuer(bitcoin: SimulatedBitcoinNode, l1: Layer1Chain, issuer: KeyPair, amount: number) {
  const preimage = randomBytes(32).toString('hex');
  const preimageHash = sha256Hex(Buffer.from(preimage, 'hex'));
  const { address, txid, vout } = await bitcoin.lockHtlc({ amountSatoshis: amount, preimageHash });
  await bitcoin.mineBlocks(6);
  const event = createEvent<IouCreationEvent>(
    {
      pubkey: issuer.publicKey,
      created_at: Date.now(),
      kind: EventKind.IOU_CREATION,
      type: 'iou_creation',
      btc_htlc_address: address,
      btc_txid: txid,
      btc_output_index: vout,
      amount_satoshis: amount,
      preimage_hash: preimageHash,
      issuer: issuer.publicKey,
    },
    issuer.privateKey,
  );
  await l1.submitEvent(event);
  await l1.mineBlock();
}

describe('Layer 2 -> Layer 1 checkpointing', () => {
  let bitcoin: SimulatedBitcoinNode;
  let relay: Relay;
  let l1: Layer1Chain;
  let l2: Layer2Chain;
  let issuer: KeyPair;

  beforeEach(async () => {
    bitcoin = new SimulatedBitcoinNode();
    relay = new Relay();
    const vault = new PreimageVault();
    l1 = new Layer1Chain({ bitcoinClient: bitcoin, relay, preimageVault: vault, minerAddress: generateKeyPair().publicKey });
    const l2Miner = generateKeyPair();
    l2 = new Layer2Chain({ relay, l1Chain: l1, minerAddress: l2Miner.publicKey, minerPrivateKey: l2Miner.privateKey });
    issuer = generateKeyPair();
    await mintToIssuer(bitcoin, l1, issuer, 10_000_000_000);
    l2.resyncFromL1();
  });

  it('does not submit a checkpoint before reaching the interval', () => {
    for (let i = 0; i < CHECKPOINT_INTERVAL_L2_BLOCKS - 1; i++) l2.mineBlock();
    expect(l2.getHeight()).toBe(CHECKPOINT_INTERVAL_L2_BLOCKS - 1);
  });

  it('automatically submits a checkpoint every CHECKPOINT_INTERVAL_L2_BLOCKS blocks, and L1 includes it', async () => {
    const holder = generateKeyPair();
    const transfer = createEvent<TransferEvent>(
      {
        pubkey: issuer.publicKey,
        created_at: Date.now(),
        kind: EventKind.TRANSFER,
        type: 'transfer',
        from: issuer.publicKey,
        to: holder.publicKey,
        issuer: issuer.publicKey,
        amount: 1_000_000,
        fee: 10,
      },
      issuer.privateKey,
    );
    expect(l2.submitTransfer(transfer).accepted).toBe(true);

    for (let i = 0; i < CHECKPOINT_INTERVAL_L2_BLOCKS; i++) l2.mineBlock();
    expect(l2.getHeight()).toBe(CHECKPOINT_INTERVAL_L2_BLOCKS);

    const l1Block = await l1.mineBlock();
    const checkpointEvent = l1Block.body.events.find((e) => e.kind === EventKind.CHECKPOINT);
    expect(checkpointEvent).toBeDefined();
    expect(l1Block.header.layer2_block_range).toEqual([1, CHECKPOINT_INTERVAL_L2_BLOCKS]);
    expect(l1Block.header.layer2_state_root).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computes a state root that changes when L2 balances change', () => {
    const rootBefore = l2.submitCheckpoint().layer2_state_root;

    const holder = generateKeyPair();
    const transfer = createEvent<TransferEvent>(
      {
        pubkey: issuer.publicKey,
        created_at: Date.now(),
        kind: EventKind.TRANSFER,
        type: 'transfer',
        from: issuer.publicKey,
        to: holder.publicKey,
        issuer: issuer.publicKey,
        amount: 500_000,
        fee: 5,
      },
      issuer.privateKey,
    );
    l2.submitTransfer(transfer);
    l2.mineBlock();

    const rootAfter = l2.submitCheckpoint().layer2_state_root;
    expect(rootAfter).not.toBe(rootBefore);
  });

  it('resyncs L2 state from L1 after a relay outage', async () => {
    relay.setOnline(false);
    const holder = generateKeyPair();
    const fallbackTransfer = createEvent<TransferEvent>(
      {
        pubkey: issuer.publicKey,
        created_at: Date.now(),
        kind: EventKind.TRANSFER,
        type: 'transfer',
        from: issuer.publicKey,
        to: holder.publicKey,
        issuer: issuer.publicKey,
        amount: 2_000_000,
        fee: 0,
      },
      issuer.privateKey,
    );
    // L2 submission fails while offline...
    expect(l2.submitTransfer(fallbackTransfer).accepted).toBe(false);
    // ...so it's submitted directly to L1 instead.
    const l1Result = await l1.submitEvent(fallbackTransfer);
    expect(l1Result.accepted).toBe(true);
    await l1.mineBlock();

    relay.setOnline(true);
    l2.resyncFromL1();
    expect(l2.getBalance(issuer.publicKey, holder.publicKey)).toBe(2_000_000);
  });
});

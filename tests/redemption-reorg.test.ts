import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { generateKeyPair, type KeyPair } from '../src/crypto/keys.js';
import { sha256Hex } from '../src/crypto/hash.js';
import { createEvent } from '../src/validation/events.js';
import { EventKind, type IouCreationEvent, type RedemptionRequestEvent, type TransferEvent } from '../src/types/index.js';
import { SimulatedBitcoinNode } from '../src/bitcoin/simulated-node.js';
import { Relay } from '../src/network/relay.js';
import { PreimageVault } from '../src/l1/preimage-vault.js';
import { Layer1Chain } from '../src/l1/chain.js';

async function setupFundedIssuer(bitcoin: SimulatedBitcoinNode) {
  const issuer = generateKeyPair();
  const preimage = randomBytes(32).toString('hex');
  const preimageHash = sha256Hex(Buffer.from(preimage, 'hex'));
  const amount = 5_000_000_000;
  const { address, txid, vout } = await bitcoin.lockHtlc({ amountSatoshis: amount, preimageHash });
  await bitcoin.mineBlocks(6);
  return { issuer, preimage, preimageHash, amount, address, txid, vout };
}

describe('redemption flow: automatic preimage reveal + Bitcoin-confirmed burn', () => {
  let bitcoin: SimulatedBitcoinNode;
  let relay: Relay;
  let vault: PreimageVault;
  let l1: Layer1Chain;

  beforeEach(() => {
    bitcoin = new SimulatedBitcoinNode();
    relay = new Relay();
    vault = new PreimageVault();
    l1 = new Layer1Chain({
      bitcoinClient: bitcoin,
      relay,
      preimageVault: vault,
      minerAddress: generateKeyPair().publicKey,
    });
  });

  async function mintAndAllocate(holder: KeyPair) {
    const { issuer, preimage, preimageHash, amount, address, txid, vout } = await setupFundedIssuer(bitcoin);
    vault.register(issuer.publicKey, preimageHash, preimage, issuer.privateKey);

    const creation = createEvent<IouCreationEvent>(
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
    await l1.submitEvent(creation);
    await l1.mineBlock();

    // Give the whole balance directly to the holder via an L1 transfer, so
    // the holder can request redemption.
    const transfer = createEvent<TransferEvent>(
      {
        pubkey: issuer.publicKey,
        created_at: Date.now(),
        kind: EventKind.TRANSFER,
        type: 'transfer' as const,
        from: issuer.publicKey,
        to: holder.publicKey,
        issuer: issuer.publicKey,
        amount,
        fee: 0,
      },
      issuer.privateKey,
    );
    await l1.submitEvent(transfer);
    await l1.mineBlock();

    return { issuer, address, amount };
  }

  it('automatically reveals the preimage within one block of the redemption request', async () => {
    const holder = generateKeyPair();
    const { issuer, address, amount } = await mintAndAllocate(holder);

    const redemption = createEvent<RedemptionRequestEvent>(
      {
        pubkey: holder.publicKey,
        created_at: Date.now(),
        kind: EventKind.REDEMPTION_REQUEST,
        type: 'redemption_request',
        holder: holder.publicKey,
        issuer: issuer.publicKey,
        amount,
      },
      holder.privateKey,
    );
    const submit = await l1.submitEvent(redemption);
    expect(submit.accepted).toBe(true);

    await l1.mineBlock(); // redemption_request applied this block
    expect(l1.state.htlcRegistry.get(address)?.preimage).toBeUndefined();

    await l1.mineBlock(); // preimage_reveal must happen by this block
    expect(l1.state.htlcRegistry.get(address)?.preimage).toBeDefined();
  });

  it('burns the holder balance only once the HTLC spend reaches 6 confirmations', async () => {
    const holder = generateKeyPair();
    const { issuer, address, amount } = await mintAndAllocate(holder);

    const redemption = createEvent<RedemptionRequestEvent>(
      {
        pubkey: holder.publicKey,
        created_at: Date.now(),
        kind: EventKind.REDEMPTION_REQUEST,
        type: 'redemption_request',
        holder: holder.publicKey,
        issuer: issuer.publicKey,
        amount,
      },
      holder.privateKey,
    );
    await l1.submitEvent(redemption);
    await l1.mineBlock(); // apply redemption_request
    await l1.mineBlock(); // auto preimage_reveal

    // Not yet enough confirmations: balance intact.
    await bitcoin.mineBlocks(1);
    await l1.mineBlock(); // broadcasts the HTLC spend
    expect(l1.getLedgerBalance(issuer.publicKey, holder.publicKey)).toBe(amount);

    for (let i = 0; i < 6; i++) {
      await bitcoin.mineBlocks(1);
      await l1.mineBlock();
    }

    expect(l1.getLedgerBalance(issuer.publicKey, holder.publicKey)).toBe(0);
    expect(l1.state.htlcRegistry.get(address)?.status).toBe('redeemed');
    expect(l1.state.totalBurned(issuer.publicKey)).toBe(amount);
  });

  it('handles a Bitcoin reorg by marking the HTLC reorg_pending until re-stabilized', async () => {
    const holder = generateKeyPair();
    const { issuer, address, amount } = await mintAndAllocate(holder);

    const redemption = createEvent<RedemptionRequestEvent>(
      {
        pubkey: holder.publicKey,
        created_at: Date.now(),
        kind: EventKind.REDEMPTION_REQUEST,
        type: 'redemption_request',
        holder: holder.publicKey,
        issuer: issuer.publicKey,
        amount,
      },
      holder.privateKey,
    );
    await l1.submitEvent(redemption);
    await l1.mineBlock(); // apply redemption_request
    await l1.mineBlock(); // auto preimage_reveal

    await bitcoin.mineBlocks(1);
    await l1.mineBlock(); // broadcasts + 1 confirmation

    await bitcoin.mineBlocks(3);
    await l1.mineBlock(); // 4 confirmations total — still pending

    // Reorg unwinds the last 4 Bitcoin blocks, un-confirming the spend tx.
    await bitcoin.forceReorg(4);
    await l1.mineBlock();
    expect(l1.state.htlcRegistry.get(address)?.status).toBe('reorg_pending');
    expect(l1.getLedgerBalance(issuer.publicKey, holder.publicKey)).toBe(amount); // not burned

    // Chain re-stabilizes: spend gets remined and reaches 6 confirmations again.
    for (let i = 0; i < 6; i++) {
      await bitcoin.mineBlocks(1);
      await l1.mineBlock();
    }

    expect(l1.getLedgerBalance(issuer.publicKey, holder.publicKey)).toBe(0);
    expect(l1.state.htlcRegistry.get(address)?.status).toBe('redeemed');
  });
});

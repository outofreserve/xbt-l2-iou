import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { generateKeyPair, type KeyPair } from '../src/crypto/keys.js';
import { sha256Hex } from '../src/crypto/hash.js';
import { createEvent } from '../src/validation/events.js';
import { EventKind, type IouCreationEvent } from '../src/types/index.js';
import { SimulatedBitcoinNode } from '../src/bitcoin/simulated-node.js';
import { validateHtlcCreation } from '../src/l1/htlc-validator.js';
import { Relay } from '../src/network/relay.js';
import { PreimageVault } from '../src/l1/preimage-vault.js';
import { Layer1Chain } from '../src/l1/chain.js';

function lockedHtlc(preimageHash: string, amount = 5_000_000_000) {
  return { amountSatoshis: amount, preimageHash };
}

describe('Layer 1 <-> simulated Bitcoin node integration', () => {
  let bitcoin: SimulatedBitcoinNode;
  let issuer: KeyPair;
  let preimage: string;
  let preimageHash: string;

  beforeEach(() => {
    bitcoin = new SimulatedBitcoinNode();
    issuer = generateKeyPair();
    preimage = randomBytes(32).toString('hex');
    preimageHash = sha256Hex(Buffer.from(preimage, 'hex'));
  });

  it('rejects HTLC validation with fewer than 6 confirmations', async () => {
    const { address, txid, vout } = await bitcoin.lockHtlc(lockedHtlc(preimageHash));
    await bitcoin.mineBlocks(3); // only 3 confirmations
    const event: IouCreationEvent = {
      id: '',
      sig: '',
      pubkey: issuer.publicKey,
      created_at: Date.now(),
      kind: EventKind.IOU_CREATION,
      type: 'iou_creation',
      btc_htlc_address: address,
      btc_txid: txid,
      btc_output_index: vout,
      amount_satoshis: 5_000_000_000,
      preimage_hash: preimageHash,
      issuer: issuer.publicKey,
    };
    const result = await validateHtlcCreation(event, bitcoin);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('confirmations'))).toBe(true);
  });

  it('accepts HTLC validation once 6+ confirmations, matching amount/address/preimage hash', async () => {
    const { address, txid, vout } = await bitcoin.lockHtlc(lockedHtlc(preimageHash));
    await bitcoin.mineBlocks(6);
    const event: IouCreationEvent = {
      id: '',
      sig: '',
      pubkey: issuer.publicKey,
      created_at: Date.now(),
      kind: EventKind.IOU_CREATION,
      type: 'iou_creation',
      btc_htlc_address: address,
      btc_txid: txid,
      btc_output_index: vout,
      amount_satoshis: 5_000_000_000,
      preimage_hash: preimageHash,
      issuer: issuer.publicKey,
    };
    const result = await validateHtlcCreation(event, bitcoin);
    expect(result.valid).toBe(true);
  });

  it('rejects HTLC validation when the declared amount does not match the UTXO', async () => {
    const { address, txid, vout } = await bitcoin.lockHtlc(lockedHtlc(preimageHash));
    await bitcoin.mineBlocks(6);
    const event: IouCreationEvent = {
      id: '',
      sig: '',
      pubkey: issuer.publicKey,
      created_at: Date.now(),
      kind: EventKind.IOU_CREATION,
      type: 'iou_creation',
      btc_htlc_address: address,
      btc_txid: txid,
      btc_output_index: vout,
      amount_satoshis: 999, // wrong amount
      preimage_hash: preimageHash,
      issuer: issuer.publicKey,
    };
    const result = await validateHtlcCreation(event, bitcoin);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('amount mismatch'))).toBe(true);
  });

  it('rejects HTLC validation for an unknown/nonexistent UTXO', async () => {
    const event: IouCreationEvent = {
      id: '',
      sig: '',
      pubkey: issuer.publicKey,
      created_at: Date.now(),
      kind: EventKind.IOU_CREATION,
      type: 'iou_creation',
      btc_htlc_address: 'htlc1nonexistent',
      btc_txid: 'ff'.repeat(32),
      btc_output_index: 0,
      amount_satoshis: 1000,
      preimage_hash: preimageHash,
      issuer: issuer.publicKey,
    };
    const result = await validateHtlcCreation(event, bitcoin);
    expect(result.valid).toBe(false);
  });

  it('end-to-end: submitting a valid iou_creation event through Layer1Chain mints IOUs to the issuer', async () => {
    const { address, txid, vout } = await bitcoin.lockHtlc(lockedHtlc(preimageHash));
    await bitcoin.mineBlocks(6);

    const relay = new Relay();
    const vault = new PreimageVault();
    const l1 = new Layer1Chain({
      bitcoinClient: bitcoin,
      relay,
      preimageVault: vault,
      minerAddress: generateKeyPair().publicKey,
    });

    const event = createEvent<IouCreationEvent>(
      {
        pubkey: issuer.publicKey,
        created_at: Date.now(),
        kind: EventKind.IOU_CREATION,
        type: 'iou_creation',
        btc_htlc_address: address,
        btc_txid: txid,
        btc_output_index: vout,
        amount_satoshis: 5_000_000_000,
        preimage_hash: preimageHash,
        issuer: issuer.publicKey,
      },
      issuer.privateKey,
    );

    const submitResult = await l1.submitEvent(event);
    expect(submitResult.accepted).toBe(true);

    await l1.mineBlock();
    expect(l1.getLedgerBalance(issuer.publicKey, issuer.publicKey)).toBe(5_000_000_000);
    expect(l1.state.totalMinted(issuer.publicKey)).toBe(5_000_000_000);
  });

  it('rejects iou_creation submission through Layer1Chain when Bitcoin confirmations are insufficient', async () => {
    const { address, txid, vout } = await bitcoin.lockHtlc(lockedHtlc(preimageHash));
    await bitcoin.mineBlocks(2); // not enough

    const relay = new Relay();
    const vault = new PreimageVault();
    const l1 = new Layer1Chain({
      bitcoinClient: bitcoin,
      relay,
      preimageVault: vault,
      minerAddress: generateKeyPair().publicKey,
    });

    const event = createEvent<IouCreationEvent>(
      {
        pubkey: issuer.publicKey,
        created_at: Date.now(),
        kind: EventKind.IOU_CREATION,
        type: 'iou_creation',
        btc_htlc_address: address,
        btc_txid: txid,
        btc_output_index: vout,
        amount_satoshis: 5_000_000_000,
        preimage_hash: preimageHash,
        issuer: issuer.publicKey,
      },
      issuer.privateKey,
    );

    const submitResult = await l1.submitEvent(event);
    expect(submitResult.accepted).toBe(false);
    expect(l1.getLedgerBalance(issuer.publicKey, issuer.publicKey)).toBe(0);
  });
});

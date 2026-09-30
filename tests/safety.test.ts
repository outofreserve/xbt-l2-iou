import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '../src/crypto/keys.js';
import { sha256Hex } from '../src/crypto/hash.js';
import { createEvent, validateEventSchema } from '../src/validation/events.js';
import { EventKind, type IouCreationEvent, type RedemptionRequestEvent, type TransferEvent } from '../src/types/index.js';
import { SimulatedBitcoinNode } from '../src/bitcoin/simulated-node.js';
import { Relay } from '../src/network/relay.js';
import { PreimageVault } from '../src/l1/preimage-vault.js';
import { Layer1Chain } from '../src/l1/chain.js';
import { Layer2Chain } from '../src/l2/chain.js';
import { StateMachine } from '../src/state/state-machine.js';

describe('money and replay safety', () => {
  it('rejects non-integer, non-finite, and overflowing monetary values', () => {
    const sender = generateKeyPair();
    const receiver = generateKeyPair();
    for (const [amount, fee] of [[NaN, 0], [1.5, 0], [1, Infinity], [Number.MAX_SAFE_INTEGER, 1]]) {
      const event = createEvent<TransferEvent>({
        pubkey: sender.publicKey, created_at: Date.now(), kind: EventKind.TRANSFER,
        type: 'transfer', from: sender.publicKey, to: receiver.publicKey,
        issuer: sender.publicKey, amount, fee,
      }, sender.privateKey);
      expect(validateEventSchema(event).valid).toBe(false);
    }
    const ambiguousRecipient = createEvent<TransferEvent>({
      pubkey: sender.publicKey, created_at: Date.now(), kind: EventKind.TRANSFER,
      type: 'transfer', from: sender.publicKey, to: 'someone:else',
      issuer: sender.publicKey, amount: 1, fee: 0,
    }, sender.privateKey);
    expect(validateEventSchema(ambiguousRecipient).valid).toBe(false);
    const state = new StateMachine();
    expect(() => state.ledger.credit(sender.publicKey, receiver.publicKey, NaN)).toThrow();
    expect(() => state.ledger.credit(sender.publicKey, receiver.publicKey, 1.5)).toThrow();
  });

  it('rejects replayed transfers on both chains and drops stale L2 mempool on resync', async () => {
    const bitcoin = new SimulatedBitcoinNode();
    const relay = new Relay();
    const issuer = generateKeyPair();
    const recipient = generateKeyPair();
    const miner = generateKeyPair();
    const l1 = new Layer1Chain({ bitcoinClient: bitcoin, relay, preimageVault: new PreimageVault(), minerAddress: miner.publicKey });
    const l2 = new Layer2Chain({ l1Chain: l1, relay, minerAddress: miner.publicKey, minerPrivateKey: miner.privateKey });
    const preimageHash = sha256Hex('secret');
    const { address, txid, vout } = await bitcoin.lockHtlc({ amountSatoshis: 100, preimageHash });
    await bitcoin.mineBlocks(6);
    const creation = createEvent<IouCreationEvent>({
      pubkey: issuer.publicKey, created_at: Date.now(), kind: EventKind.IOU_CREATION,
      type: 'iou_creation', btc_htlc_address: address, btc_txid: txid, btc_output_index: vout,
      amount_satoshis: 100, preimage_hash: preimageHash, issuer: issuer.publicKey,
    }, issuer.privateKey);
    expect((await l1.submitEvent(creation)).accepted).toBe(true);
    await l1.mineBlock();
    l2.resyncFromL1();
    const transfer = createEvent<TransferEvent>({
      pubkey: issuer.publicKey, created_at: Date.now(), kind: EventKind.TRANSFER,
      type: 'transfer', from: issuer.publicKey, to: recipient.publicKey,
      issuer: issuer.publicKey, amount: 10, fee: 0,
    }, issuer.privateKey);
    expect((await l1.submitEvent(transfer)).accepted).toBe(true);
    expect((await l1.submitEvent(transfer)).accepted).toBe(false);
    await l1.mineBlock();
    expect((await l1.submitEvent(transfer)).accepted).toBe(false);
    expect(l1.getLedgerBalance(issuer.publicKey, recipient.publicKey)).toBe(10);

    expect(l2.submitTransfer(transfer).accepted).toBe(false);
    const l2Transfer = createEvent<TransferEvent>({
      pubkey: issuer.publicKey, created_at: Date.now() + 1, kind: EventKind.TRANSFER,
      type: 'transfer', from: issuer.publicKey, to: recipient.publicKey,
      issuer: issuer.publicKey, amount: 5, fee: 0,
    }, issuer.privateKey);
    expect(l2.submitTransfer(l2Transfer).accepted).toBe(true);
    l2.resyncFromL1();
    expect(l2.mempool.size()).toBe(0);
    expect(l2.submitTransfer(l2Transfer).accepted).toBe(true);
    l2.mineBlock();
    expect(l2.submitTransfer(l2Transfer).accepted).toBe(false);
  });

  it('reserves outstanding redemption balances against transfers and other redemptions', async () => {
    const issuer = generateKeyPair();
    const holder = generateKeyPair();
    const state = new StateMachine();
    state.ledger.credit(issuer.publicKey, holder.publicKey, 100);
    const request = (amount: number, created_at: number) => createEvent<RedemptionRequestEvent>({
      pubkey: holder.publicKey, created_at, kind: EventKind.REDEMPTION_REQUEST,
      type: 'redemption_request', holder: holder.publicKey, issuer: issuer.publicKey, amount,
    }, holder.privateKey);
    state.applyEvent(request(80, 1));
    expect(state.availableBalance(issuer.publicKey, holder.publicKey)).toBe(20);
    expect(() => state.applyEvent(request(21, 2))).toThrow();
    const transfer = createEvent<TransferEvent>({
      pubkey: holder.publicKey, created_at: 3, kind: EventKind.TRANSFER,
      type: 'transfer', from: holder.publicKey, to: issuer.publicKey,
      issuer: issuer.publicKey, amount: 21, fee: 0,
    }, holder.privateKey);
    expect(() => state.applyEvent(transfer)).toThrow();
    expect(state.ledger.getBalance(issuer.publicKey, holder.publicKey)).toBe(100);
  });
});

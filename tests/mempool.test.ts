import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '../src/crypto/keys.js';
import { createEvent } from '../src/validation/events.js';
import { EventKind, type TransferEvent, type RedemptionRequestEvent } from '../src/types/index.js';
import { Mempool, eventPriority } from '../src/network/mempool.js';

function makeTransfer(fee: number, senderKey = generateKeyPair(), issuer = generateKeyPair().publicKey) {
  return createEvent<TransferEvent>(
    {
      pubkey: senderKey.publicKey,
      created_at: Date.now(),
      kind: EventKind.TRANSFER,
      type: 'transfer',
      from: senderKey.publicKey,
      to: generateKeyPair().publicKey,
      issuer,
      amount: 1000,
      fee,
    },
    senderKey.privateKey,
  );
}

describe('fee-priority mempool simulation', () => {
  it('orders transfer events highest-fee-first', () => {
    const mempool = new Mempool();
    const low = makeTransfer(5);
    const high = makeTransfer(500);
    const medium = makeTransfer(50);

    mempool.add(low);
    mempool.add(high);
    mempool.add(medium);

    const batch = mempool.peekBatch(3) as TransferEvent[];
    expect(batch.map((e) => e.fee)).toEqual([500, 50, 5]);
  });

  it('preserves FIFO order among equal-fee events', () => {
    const mempool = new Mempool();
    const first = makeTransfer(10);
    const second = makeTransfer(10);
    mempool.add(first);
    mempool.add(second);
    const batch = mempool.peekBatch(2) as TransferEvent[];
    expect(batch.map((e) => e.id)).toEqual([first.id, second.id]);
  });

  it('popBatch removes the returned events from the mempool', () => {
    const mempool = new Mempool();
    mempool.add(makeTransfer(1));
    mempool.add(makeTransfer(2));
    expect(mempool.size()).toBe(2);
    const popped = mempool.popBatch(1);
    expect(popped).toHaveLength(1);
    expect(mempool.size()).toBe(1);
  });

  it('simulates rising congestion: as fee competition increases, only top payers get included in a capacity-limited block', () => {
    const mempool = new Mempool();
    const fees = [1, 5, 10, 2, 8, 20, 3, 15, 7, 12];
    for (const fee of fees) mempool.add(makeTransfer(fee));

    const blockCapacity = 4;
    const included = mempool.popBatch(blockCapacity) as TransferEvent[];
    const includedFees = included.map((e) => e.fee).sort((a, b) => b - a);
    expect(includedFees).toEqual([20, 15, 12, 10]);
    expect(mempool.size()).toBe(fees.length - blockCapacity);

    // Congestion metric: remaining mempool is still larger than one block's
    // worth of capacity, i.e. "moderate/high" congestion by the same logic
    // Layer1Chain uses.
    expect(mempool.size()).toBeGreaterThan(0);
  });

  it('protocol-critical events (no fee market) always outrank fee-paying transfers', () => {
    const mempool = new Mempool();
    const transfer = makeTransfer(1_000_000); // very high fee
    const issuer = generateKeyPair();
    const redemptionRequest = createEvent<RedemptionRequestEvent>(
      {
        pubkey: issuer.publicKey,
        created_at: Date.now(),
        kind: EventKind.REDEMPTION_REQUEST,
        type: 'redemption_request' as const,
        holder: issuer.publicKey,
        issuer: issuer.publicKey,
        amount: 1,
      },
      issuer.privateKey,
    );
    mempool.add(transfer);
    mempool.add(redemptionRequest);
    expect(eventPriority(redemptionRequest)).toBe(Number.POSITIVE_INFINITY);
    const batch = mempool.peekBatch(2);
    expect(batch[0].id).toBe(redemptionRequest.id);
  });
});

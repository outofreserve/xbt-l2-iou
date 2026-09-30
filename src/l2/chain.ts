/**
 * Layer 2 fast lane: low-latency P2P IOU transfers.
 *
 * Maintains its own in-memory ledger (seeded/resynced from Layer 1),
 * processes transfer events in ~10ms blocks, collects miner fees, and
 * periodically checkpoints its state root back to Layer 1 (every
 * `CHECKPOINT_INTERVAL_L2_BLOCKS` blocks). If the L2 relay goes offline,
 * callers fall back to submitting transfers directly to Layer 1; on
 * recovery, `resyncFromL1` re-seeds the L2 ledger from L1 truth.
 */
import { merkleRoot } from '../crypto/merkle.js';
import { headerHash, mineHeader } from '../consensus/pow.js';
import { adjustDifficulty } from '../consensus/difficulty.js';
import { Ledger } from '../state/ledger.js';
import { validateEventSchema, createEvent } from '../validation/events.js';
import { Mempool } from '../network/mempool.js';
import type { Relay } from '../network/relay.js';
import type { Layer1Chain } from '../l1/chain.js';
import {
  CHECKPOINT_INTERVAL_L2_BLOCKS,
  EventKind,
  L2_PARAMS,
  type CheckpointEvent,
  type FeeCollected,
  type Layer2Block,
  type Layer2BlockHeader,
  type Pubkey,
  type TransferEvent,
} from '../types/index.js';

export interface L2ChainOptions {
  relay: Relay;
  l1Chain: Layer1Chain;
  minerAddress: Pubkey;
  minerPrivateKey: Uint8Array;
  initialTargetBits?: number;
  minerMinFeeSatoshis?: number;
}

export interface SubmitResult {
  accepted: boolean;
  errors: string[];
}

export class Layer2Chain {
  ledger = new Ledger();
  readonly chain: Layer2Block[] = [];
  readonly mempool = new Mempool();
  private relay: Relay;
  private l1Chain: Layer1Chain;
  private minerAddress: Pubkey;
  private minerPrivateKey: Uint8Array;
  private targetBits: number;
  private minerMinFeeSatoshis: number;
  private lastRetargetTimestamp = Date.now();
  private lastCheckpointHeight = 0;
  private log: string[] = [];
  private appliedEventIds = new Set<string>();

  constructor(opts: L2ChainOptions) {
    this.relay = opts.relay;
    this.l1Chain = opts.l1Chain;
    this.minerAddress = opts.minerAddress;
    this.minerPrivateKey = opts.minerPrivateKey;
    this.targetBits = opts.initialTargetBits ?? 2;
    this.minerMinFeeSatoshis = opts.minerMinFeeSatoshis ?? 0;
  }

  getHeight(): number {
    return this.chain.length;
  }

  getTipHash(): string {
    return this.chain.length ? this.chain[this.chain.length - 1].hash : '0'.repeat(64);
  }

  getBalance(issuer: Pubkey, holder: Pubkey): number {
    return this.ledger.getBalance(issuer, holder);
  }

  private logLine(msg: string): void {
    this.log.push(msg);
    // eslint-disable-next-line no-console
    console.log(`[L2] ${msg}`);
  }

  getLog(): string[] {
    return this.log;
  }

  /** Re-seeds the L2 ledger from the current Layer 1 ledger (used on relay recovery / cold start). */
  resyncFromL1(): void {
    const l1Entries = this.l1Chain.state.ledger.entries();
    const fresh = new Ledger();
    for (const [key, amount] of l1Entries) {
      const [issuer, holder] = key.split(':');
      fresh.credit(issuer, holder, amount);
    }
    this.ledger = fresh;
    this.mempool.clear();
    this.logLine(`resynced L2 ledger from Layer 1 (${l1Entries.length} balances)`);
  }

  /**
   * Submits a transfer to the L2 mempool. Returns accepted=false (without
   * throwing) if the relay is offline, signaling the caller to fall back to
   * submitting the transfer directly to Layer 1.
   */
  submitTransfer(event: TransferEvent): SubmitResult {
    if (!this.relay.isOnline()) {
      return { accepted: false, errors: ['relay offline: fall back to Layer 1 submission'] };
    }
    const schemaResult = validateEventSchema(event);
    if (!schemaResult.valid) return { accepted: false, errors: schemaResult.errors };
    if (this.appliedEventIds.has(event.id) || this.mempool.has(event.id) || this.l1Chain.hasAppliedEvent(event.id)) {
      return { accepted: false, errors: ['event already submitted'] };
    }

    const bal = this.ledger.getBalance(event.issuer, event.from);
    if (bal < event.amount + event.fee) {
      return { accepted: false, errors: [`insufficient L2 balance: ${bal} < ${event.amount + event.fee}`] };
    }

    this.mempool.add(event);
    this.relay.publishEvent(event);
    return { accepted: true, errors: [] };
  }

  private nextTargetBits(height: number): number {
    if (height === 0 || height % L2_PARAMS.difficultyAdjustmentBlocks !== 0) {
      return this.targetBits;
    }
    const now = Date.now();
    const actualTimespanMs = now - this.lastRetargetTimestamp;
    const expectedTimespanMs = L2_PARAMS.difficultyAdjustmentBlocks * L2_PARAMS.blockIntervalMs;
    const newBits = adjustDifficulty(this.targetBits, actualTimespanMs, expectedTimespanMs);
    this.lastRetargetTimestamp = now;
    return newBits;
  }

  /** Mines and appends the next Layer 2 block, applying mempool transfers and collecting miner fees. */
  mineBlock(): Layer2Block {
    const height = this.chain.length;
    const batch = this.mempool.popBatch(L2_PARAMS.eventsPerBlock) as TransferEvent[];
    const blockEvents: TransferEvent[] = [];
    const feesCollected: FeeCollected[] = [];

    for (const event of batch) {
      try {
        if (this.l1Chain.hasAppliedEvent(event.id)) {
          this.logLine(`transfer ${event.id} already settled on L1`);
          continue;
        }
        this.ledger.debit(event.issuer, event.from, event.amount + event.fee);
        this.ledger.credit(event.issuer, event.to, event.amount);
        this.ledger.credit(event.issuer, this.minerAddress, event.fee);
        this.appliedEventIds.add(event.id);
        blockEvents.push(event);
        feesCollected.push({ sender: event.from, amount_satoshis: event.fee });
      } catch (err) {
        this.logLine(`transfer ${event.id} rejected: ${(err as Error).message}`);
      }
    }

    const targetBits = this.nextTargetBits(height + 1);
    this.targetBits = targetBits;

    const headerBase: Omit<Layer2BlockHeader, 'nonce'> = {
      version: 1,
      height: height + 1,
      parent_hash: this.getTipHash(),
      timestamp: Date.now(),
      target_bits: targetBits,
      merkle_root: merkleRoot(blockEvents.map((e) => e.id)),
      miner_address: this.minerAddress,
      miner_min_fee_satoshis: this.minerMinFeeSatoshis,
    };

    const { nonce, hash } = mineHeader({ ...headerBase, nonce: 0 });
    const header: Layer2BlockHeader = { ...headerBase, nonce };
    const block: Layer2Block = { header, body: { events: blockEvents, fees_collected: feesCollected }, hash };
    this.chain.push(block);
    this.relay.publishL2Block(block);

    if (block.header.height - this.lastCheckpointHeight >= CHECKPOINT_INTERVAL_L2_BLOCKS) {
      this.submitCheckpoint();
    }

    return block;
  }

  /** Computes the L2 state root and submits a checkpoint event to Layer 1. */
  submitCheckpoint(): CheckpointEvent {
    const startHeight = this.lastCheckpointHeight + 1;
    const endHeight = this.chain.length;
    const stateRoot = merkleRoot(this.ledger.snapshot());

    const unsigned = {
      pubkey: this.minerAddress,
      created_at: Date.now(),
      kind: EventKind.CHECKPOINT,
      type: 'checkpoint' as const,
      layer2_state_root: stateRoot,
      layer2_block_range: [startHeight, endHeight] as [number, number],
    };
    const event = createEvent<CheckpointEvent>(unsigned, this.minerPrivateKey);
    this.l1Chain.acceptCheckpoint(event);
    this.lastCheckpointHeight = endHeight;
    this.logLine(
      `checkpoint submitted to L1: range=[${startHeight},${endHeight}] state_root=${stateRoot.slice(0, 12)}…`,
    );
    return event;
  }

  recomputeHeaderHash(header: Layer2BlockHeader): string {
    return headerHash(header as unknown as Record<string, unknown>);
  }
}

/**
 * Layer 1 chain: the canonical, Bitcoin-anchored settlement layer.
 *
 * Responsibilities per spec:
 *  - Validate iou_creation events against the Bitcoin full node (HTLC
 *    existence/confirmations/amount/script).
 *  - Automatically reveal preimages (protocol-mandated, same/next block)
 *    once a redemption_request lands.
 *  - Watch the Bitcoin mempool/chain for the corresponding HTLC spend and,
 *    once it reaches 6+ confirmations, burn the holder's IOUs and update
 *    the HTLC registry.
 *  - Accept Layer 2 checkpoints and include them in blocks.
 *  - Mine SHA256d PoW blocks on a configurable (demo-accelerated) interval,
 *    retargeting difficulty every `difficultyAdjustmentBlocks` blocks.
 */
import { sha256Hex } from '../crypto/hash.js';
import { merkleRoot } from '../crypto/merkle.js';
import { headerHash, mineHeader } from '../consensus/pow.js';
import { adjustDifficulty } from '../consensus/difficulty.js';
import { StateMachine, StateTransitionError } from '../state/state-machine.js';
import { validateEventSchema, createEvent } from '../validation/events.js';
import { Mempool } from '../network/mempool.js';
import type { Relay } from '../network/relay.js';
import type { BitcoinRpcClient } from '../bitcoin/rpc-client.js';
import { validateHtlcCreation, REQUIRED_CONFIRMATIONS } from './htlc-validator.js';
import { PreimageVault } from './preimage-vault.js';
import {
  EventKind,
  L1_PARAMS,
  type CheckpointEvent,
  type FeeCollected,
  type IouEvent,
  type Layer1Block,
  type Layer1BlockHeader,
  type Pubkey,
  type PreimageRevealEvent,
} from '../types/index.js';

export interface L1ChainOptions {
  bitcoinClient: BitcoinRpcClient;
  relay: Relay;
  preimageVault: PreimageVault;
  minerAddress: Pubkey;
  initialTargetBits?: number;
  minerMinFeeSatoshis?: number;
}

export interface SubmitResult {
  accepted: boolean;
  errors: string[];
}

export class Layer1Chain {
  readonly state = new StateMachine();
  readonly chain: Layer1Block[] = [];
  readonly mempool = new Mempool();
  private bitcoin: BitcoinRpcClient;
  private relay: Relay;
  private preimageVault: PreimageVault;
  private minerAddress: Pubkey;
  private targetBits: number;
  private minerMinFeeSatoshis: number;
  private lastRetargetTimestamp = Date.now();
  private latestCheckpoint: CheckpointEvent | null = null;
  private pendingCheckpoints: CheckpointEvent[] = [];
  private spendRequested = new Set<string>(); // htlc addresses we've asked Bitcoin to spend
  private lastObservedConfirmations = new Map<string, number>();
  private log: string[] = [];

  constructor(opts: L1ChainOptions) {
    this.bitcoin = opts.bitcoinClient;
    this.relay = opts.relay;
    this.preimageVault = opts.preimageVault;
    this.minerAddress = opts.minerAddress;
    this.targetBits = opts.initialTargetBits ?? 4;
    this.minerMinFeeSatoshis = opts.minerMinFeeSatoshis ?? 1;
  }

  getHeight(): number {
    return this.chain.length;
  }

  getTipHash(): string {
    return this.chain.length ? this.chain[this.chain.length - 1].hash : '0'.repeat(64);
  }

  getLedgerBalance(issuer: Pubkey, holder: Pubkey): number {
    return this.state.ledger.getBalance(issuer, holder);
  }

  private logLine(msg: string): void {
    this.log.push(msg);
    // eslint-disable-next-line no-console
    console.log(`[L1] ${msg}`);
  }

  getLog(): string[] {
    return this.log;
  }

  /**
   * Validates and (if valid) admits an event to the L1 mempool. iou_creation
   * events additionally require a passing Bitcoin HTLC check before
   * acceptance, per spec.
   */
  async submitEvent(event: IouEvent): Promise<SubmitResult> {
    const schemaResult = validateEventSchema(event);
    if (!schemaResult.valid) return { accepted: false, errors: schemaResult.errors };

    if (event.kind === EventKind.IOU_CREATION) {
      const htlcResult = await validateHtlcCreation(event, this.bitcoin);
      if (!htlcResult.valid) return { accepted: false, errors: htlcResult.errors };
    }

    if (event.kind === EventKind.REDEMPTION_REQUEST) {
      const bal = this.state.ledger.getBalance(event.issuer, event.holder);
      if (bal < event.amount - 1e-9) {
        return { accepted: false, errors: [`insufficient balance: ${bal} < ${event.amount}`] };
      }
    }

    this.mempool.add(event);
    this.relay.publishEvent(event);
    return { accepted: true, errors: [] };
  }

  /** Accepts a Layer 2 checkpoint (submitted directly by the L2 chain, bypassing the public mempool fee auction). */
  acceptCheckpoint(checkpoint: CheckpointEvent): void {
    this.pendingCheckpoints.push(checkpoint);
  }

  /** Builds any protocol-mandated automatic preimage_reveal events for pending redemptions. */
  private buildAutoPreimageReveals(): PreimageRevealEvent[] {
    const reveals: PreimageRevealEvent[] = [];
    for (const pr of this.state.pendingRedemptions.values()) {
      if (pr.confirmed || pr.preimageRevealed) continue;
      const htlcs = this.state.htlcRegistry.all().filter((h) => h.issuer === pr.issuer);
      for (const htlc of htlcs) {
        if (htlc.preimage) continue; // already revealed on-chain
        const secret = this.preimageVault.get(pr.issuer, htlc.preimage_hash);
        if (!secret) continue;
        const unsigned = {
          pubkey: pr.issuer,
          created_at: Date.now(),
          kind: EventKind.PREIMAGE_REVEAL,
          type: 'preimage_reveal' as const,
          issuer: pr.issuer,
          preimage: secret.preimage,
          preimage_hash: htlc.preimage_hash,
        };
        reveals.push(createEvent<PreimageRevealEvent>(unsigned, secret.privateKey));
      }
    }
    return reveals;
  }

  /** Bitcoin watcher: requests spends for revealed-but-unclaimed HTLCs, and confirms redemptions with 6+ confs. */
  private async watchBitcoinRedemptions(): Promise<void> {
    for (const pr of this.state.pendingRedemptions.values()) {
      if (pr.confirmed || !pr.preimageRevealed || !pr.htlcAddress) continue;
      const htlc = this.state.htlcRegistry.get(pr.htlcAddress);
      if (!htlc || !htlc.preimage) continue;

      if (!this.spendRequested.has(pr.htlcAddress)) {
        // Simulates the holder's wallet immediately broadcasting the claim
        // transaction once the preimage becomes available on L1.
        await this.bitcoin.spendHtlc({ address: pr.htlcAddress, preimage: htlc.preimage });
        this.spendRequested.add(pr.htlcAddress);
        this.logLine(`redemption ${pr.id}: HTLC spend broadcast for ${pr.htlcAddress}`);
      }

      const spend = await this.bitcoin.findHtlcSpend(pr.htlcAddress);
      if (!spend) continue;

      const prevConfirmations = this.lastObservedConfirmations.get(pr.htlcAddress) ?? 0;
      if (spend.confirmations < REQUIRED_CONFIRMATIONS) {
        // A drop in confirmations vs. what we previously observed indicates
        // a Bitcoin reorg unwound the spend; a still-growing confirmation
        // count below the threshold is just normal pending confirmation.
        if (spend.confirmations < prevConfirmations) {
          this.state.markReorgPending(pr.htlcAddress);
          this.logLine(
            `reorg detected on ${pr.htlcAddress}: confirmations dropped from ${prevConfirmations} to ${spend.confirmations}`,
          );
        }
        this.lastObservedConfirmations.set(pr.htlcAddress, spend.confirmations);
        continue;
      }

      this.lastObservedConfirmations.set(pr.htlcAddress, spend.confirmations);
      this.state.confirmRedemption(pr.id, pr.htlcAddress);
      this.logLine(
        `redemption ${pr.id}: confirmed with ${spend.confirmations} confirmations; burned ${pr.amount} sats from ${pr.holder}`,
      );
    }
  }

  private nextTargetBits(height: number): number {
    if (height === 0 || height % L1_PARAMS.difficultyAdjustmentBlocks !== 0) {
      return this.targetBits;
    }
    const now = Date.now();
    const actualTimespanMs = now - this.lastRetargetTimestamp;
    const expectedTimespanMs = L1_PARAMS.difficultyAdjustmentBlocks * L1_PARAMS.blockIntervalMs;
    const newBits = adjustDifficulty(this.targetBits, actualTimespanMs, expectedTimespanMs);
    this.lastRetargetTimestamp = now;
    return newBits;
  }

  /** Mines and appends the next Layer 1 block, applying mempool events, auto-reveals, and checkpoint intake. */
  async mineBlock(): Promise<Layer1Block> {
    await this.watchBitcoinRedemptions();

    const height = this.chain.length;
    const blockEvents: IouEvent[] = [];
    const feesCollected: FeeCollected[] = [];

    for (const reveal of this.buildAutoPreimageReveals()) {
      try {
        this.state.applyEvent(reveal);
        blockEvents.push(reveal);
      } catch (err) {
        this.logLine(`auto preimage_reveal rejected: ${(err as Error).message}`);
      }
    }

    for (const checkpoint of this.pendingCheckpoints.splice(0)) {
      this.state.applyEvent(checkpoint);
      blockEvents.push(checkpoint);
      this.latestCheckpoint = checkpoint;
    }

    const batch = this.mempool.popBatch(L1_PARAMS.eventsPerBlock);
    for (const event of batch) {
      try {
        this.state.applyEvent(event, { minerAddress: this.minerAddress });
        blockEvents.push(event);
        if (event.kind === EventKind.TRANSFER) {
          feesCollected.push({ sender: event.from, amount_satoshis: event.fee });
        }
      } catch (err) {
        if (err instanceof StateTransitionError) {
          this.logLine(`event ${event.id} rejected: ${err.message}`);
        } else {
          throw err;
        }
      }
    }

    const targetBits = this.nextTargetBits(height + 1);
    this.targetBits = targetBits;

    const bitcoinHeight = await this.bitcoin.getBlockCount();
    const bitcoinHash = await this.bitcoin.getBestBlockHash();

    const congestion =
      this.mempool.size() > L1_PARAMS.eventsPerBlock
        ? 'high'
        : this.mempool.size() > L1_PARAMS.eventsPerBlock / 10
          ? 'moderate'
          : 'low';

    const headerBase: Omit<Layer1BlockHeader, 'nonce'> = {
      version: 1,
      height: height + 1,
      parent_hash: this.getTipHash(),
      timestamp: Date.now(),
      target_bits: targetBits,
      merkle_root: merkleRoot(blockEvents.map((e) => e.id)),
      layer2_state_root: this.latestCheckpoint?.layer2_state_root ?? sha256Hex(''),
      layer2_block_range: this.latestCheckpoint?.layer2_block_range ?? [0, 0],
      miner_address: this.minerAddress,
      bitcoin_block_height: bitcoinHeight,
      bitcoin_block_hash: bitcoinHash,
      miner_min_fee_satoshis: this.minerMinFeeSatoshis,
      network_congestion: congestion,
    };

    const { nonce, hash } = mineHeader({ ...headerBase, nonce: 0 });
    const header: Layer1BlockHeader = { ...headerBase, nonce };

    const block: Layer1Block = { header, body: { events: blockEvents, fees_collected: feesCollected }, hash };
    this.chain.push(block);
    this.relay.publishL1Block(block);
    this.logLine(
      `block #${block.header.height} mined (hash=${hash.slice(0, 12)}…, events=${blockEvents.length}, bits=${targetBits})`,
    );
    return block;
  }

  recomputeHeaderHash(header: Layer1BlockHeader): string {
    return headerHash(header as unknown as Record<string, unknown>);
  }
}

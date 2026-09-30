/**
 * Shared type definitions for the Bitcoin Layer 2 IOU System.
 *
 * Events follow a NIP-01-ish Nostr event envelope, with domain-specific
 * "kind" numbers 29000-29004 carrying the IOU protocol payload in `content`
 * (parsed) plus convenience typed fields for internal use.
 */

// ---------------------------------------------------------------------------
// Primitive aliases
// ---------------------------------------------------------------------------

/** Hex-encoded secp256k1 x-only or compressed pubkey, used as a Nostr pubkey. */
export type Pubkey = string;
/** Hex-encoded schnorr/ecdsa signature. */
export type Signature = string;
/** Hex-encoded sha256 digest. */
export type Sha256Hex = string;

export type IssuerHolderKey = string; // `${issuer}:${holder}`

export function ledgerKey(issuer: Pubkey, holder: Pubkey): IssuerHolderKey {
  return `${issuer}:${holder}`;
}

// ---------------------------------------------------------------------------
// Event kinds
// ---------------------------------------------------------------------------

export const EventKind = {
  IOU_CREATION: 29000,
  REDEMPTION_REQUEST: 29001,
  PREIMAGE_REVEAL: 29002,
  TRANSFER: 29003,
  CHECKPOINT: 29004,
  FEE_SIGNAL: 29005,
} as const;

export type EventKindValue = (typeof EventKind)[keyof typeof EventKind];

interface BaseEvent {
  id: Sha256Hex;
  pubkey: Pubkey;
  created_at: number; // ms epoch
  kind: EventKindValue;
  sig: Signature;
}

export interface IouCreationEvent extends BaseEvent {
  kind: 29000;
  type: 'iou_creation';
  btc_htlc_address: string;
  btc_txid: string;
  btc_output_index: number;
  amount_satoshis: number;
  preimage_hash: Sha256Hex;
  issuer: Pubkey;
}

export interface RedemptionRequestEvent extends BaseEvent {
  kind: 29001;
  type: 'redemption_request';
  holder: Pubkey;
  issuer: Pubkey;
  amount: number;
}

export interface PreimageRevealEvent extends BaseEvent {
  kind: 29002;
  type: 'preimage_reveal';
  issuer: Pubkey;
  preimage: string; // hex
  preimage_hash: Sha256Hex;
}

export interface TransferEvent extends BaseEvent {
  kind: 29003;
  type: 'transfer';
  from: Pubkey;
  to: Pubkey;
  issuer: Pubkey;
  amount: number;
  fee: number;
}

export interface CheckpointEvent extends BaseEvent {
  kind: 29004;
  type: 'checkpoint';
  layer2_state_root: Sha256Hex;
  layer2_block_range: [number, number];
}

export interface FeeSignalEvent extends BaseEvent {
  kind: 29005;
  type: 'fee_signal';
  miner: Pubkey;
  min_fee_satoshis: number;
  layer: 'l1' | 'l2';
}

export type IouEvent =
  | IouCreationEvent
  | RedemptionRequestEvent
  | PreimageRevealEvent
  | TransferEvent
  | CheckpointEvent
  | FeeSignalEvent;

// ---------------------------------------------------------------------------
// Block headers / bodies
// ---------------------------------------------------------------------------

export interface Layer1BlockHeader {
  version: number;
  height: number;
  parent_hash: Sha256Hex;
  timestamp: number;
  target_bits: number;
  nonce: number;
  merkle_root: Sha256Hex;
  layer2_state_root: Sha256Hex;
  layer2_block_range: [number, number];
  miner_address: Pubkey;
  bitcoin_block_height: number;
  bitcoin_block_hash: Sha256Hex;
  miner_min_fee_satoshis: number;
  network_congestion: string;
}

export interface FeeCollected {
  sender: Pubkey;
  amount_satoshis: number;
}

export interface Layer1BlockBody {
  events: IouEvent[];
  fees_collected: FeeCollected[];
}

export interface Layer1Block {
  header: Layer1BlockHeader;
  body: Layer1BlockBody;
  hash: Sha256Hex;
}

export interface Layer2BlockHeader {
  version: number;
  height: number;
  parent_hash: Sha256Hex;
  timestamp: number;
  target_bits: number;
  nonce: number;
  merkle_root: Sha256Hex;
  miner_address: Pubkey;
  miner_min_fee_satoshis: number;
}

export interface Layer2BlockBody {
  events: TransferEvent[];
  fees_collected: FeeCollected[];
}

export interface Layer2Block {
  header: Layer2BlockHeader;
  body: Layer2BlockBody;
  hash: Sha256Hex;
}

// ---------------------------------------------------------------------------
// HTLC registry
// ---------------------------------------------------------------------------

export type HtlcStatus = 'active' | 'redeeming' | 'redeemed' | 'reorg_pending';

export interface HtlcEntry {
  htlc_address: string;
  issuer: Pubkey;
  amount_locked: number;
  amount_redeemed: number;
  preimage_hash: Sha256Hex;
  preimage?: string;
  status: HtlcStatus;
  btc_txid: string;
  btc_output_index: number;
  confirmations: number;
}

// ---------------------------------------------------------------------------
// Network params (protocol constants, parameterized per layer)
// ---------------------------------------------------------------------------

export interface LayerParams {
  blockIntervalMs: number;
  eventsPerBlock: number;
  difficultyAdjustmentBlocks: number;
}

export const L1_PARAMS: LayerParams = {
  blockIntervalMs: 100,
  eventsPerBlock: 500_000,
  difficultyAdjustmentBlocks: 6_000, // every 10 minutes @ 100ms/block
};

export const L2_PARAMS: LayerParams = {
  blockIntervalMs: 10,
  eventsPerBlock: 10_000,
  difficultyAdjustmentBlocks: 1_000, // every 10 seconds @ 10ms/block
};

export const CHECKPOINT_INTERVAL_L2_BLOCKS = 1_000;

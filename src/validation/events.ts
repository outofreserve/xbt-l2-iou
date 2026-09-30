/**
 * Nostr-style (NIP-01 compatible) event construction, id computation, and
 * signature verification, plus per-kind schema validation for the IOU
 * protocol event kinds (29000-29005).
 */
import { sha256Hex } from '../crypto/hash.js';
import { signMessage, verifySignature } from '../crypto/keys.js';
import { EventKind, type IouEvent, type Pubkey } from '../types/index.js';

type Unsigned<T extends IouEvent> = Omit<T, 'id' | 'sig'>;

/** Canonical JSON (sorted keys) used both for id derivation and signing. */
function canonicalize(obj: Record<string, unknown>): string {
  const sortedKeys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of sortedKeys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

export function computeEventId(unsigned: Record<string, unknown>): string {
  const { id: _id, sig: _sig, ...rest } = unsigned as Record<string, unknown>;
  return sha256Hex(canonicalize(rest));
}

/** Builds and signs an event from an unsigned payload + the signer's private key. */
export function createEvent<T extends IouEvent>(
  unsigned: Unsigned<T>,
  privateKey: Uint8Array,
): T {
  const id = computeEventId(unsigned as unknown as Record<string, unknown>);
  const sig = signMessage(id, privateKey);
  return { ...(unsigned as object), id, sig } as T;
}

export function verifyEventSignature(event: IouEvent, signerPubkey?: Pubkey): boolean {
  const { id, sig, ...rest } = event as unknown as Record<string, unknown>;
  const recomputedId = computeEventId(rest);
  if (recomputedId !== id) return false;
  const pubkey = signerPubkey ?? event.pubkey;
  return verifySignature(sig as string, id as string, pubkey);
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function ok(): ValidationResult {
  return { valid: true, errors: [] };
}
function fail(...errors: string[]): ValidationResult {
  return { valid: false, errors };
}

function validPubkey(value: unknown): boolean {
  return typeof value === 'string' && /^(?:[0-9a-f]{64}|0[23][0-9a-f]{64})$/.test(value);
}

/** Structural + signature validation, independent of external state (ledger/Bitcoin). */
export function validateEventSchema(event: IouEvent): ValidationResult {
  if (!event || typeof event !== 'object') return fail('invalid event');
  const errors: string[] = [];

  if (typeof event.id !== 'string' || typeof event.sig !== 'string' || typeof event.pubkey !== 'string' ||
      !event.id || !event.sig || !event.pubkey) errors.push('missing id/sig/pubkey');
  if (!validPubkey(event.pubkey)) errors.push('invalid pubkey');
  if (!Number.isSafeInteger(event.created_at) || event.created_at < 0) errors.push('invalid created_at');
  try {
    if (!verifyEventSignature(event)) errors.push('invalid signature');
  } catch {
    errors.push('invalid signature');
  }

  switch (event.kind) {
    case EventKind.IOU_CREATION:
      if (event.type !== 'iou_creation') errors.push('invalid event type');
      if (!event.btc_htlc_address) errors.push('missing btc_htlc_address');
      if (!event.btc_txid) errors.push('missing btc_txid');
      if (!Number.isSafeInteger(event.btc_output_index) || event.btc_output_index < 0)
        errors.push('invalid btc_output_index');
      if (!Number.isSafeInteger(event.amount_satoshis) || event.amount_satoshis <= 0)
        errors.push('amount_satoshis must be a positive safe integer');
      if (!event.preimage_hash) errors.push('missing preimage_hash');
      if (event.issuer !== event.pubkey) errors.push('issuer must sign its own iou_creation event');
      break;
    case EventKind.REDEMPTION_REQUEST:
      if (event.type !== 'redemption_request') errors.push('invalid event type');
      if (!validPubkey(event.holder) || !validPubkey(event.issuer)) errors.push('invalid holder/issuer');
      if (!Number.isSafeInteger(event.amount) || event.amount <= 0)
        errors.push('amount must be a positive safe integer');
      if (event.holder !== event.pubkey) errors.push('holder must sign their own redemption_request');
      break;
    case EventKind.PREIMAGE_REVEAL:
      if (event.type !== 'preimage_reveal') errors.push('invalid event type');
      if (typeof event.preimage !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(event.preimage) ||
          typeof event.preimage_hash !== 'string' || !/^[0-9a-f]{64}$/.test(event.preimage_hash))
        errors.push('invalid preimage/preimage_hash');
      if (event.issuer !== event.pubkey) errors.push('issuer must sign its own preimage_reveal');
      break;
    case EventKind.TRANSFER:
      if (event.type !== 'transfer') errors.push('invalid event type');
      if (!validPubkey(event.from) || !validPubkey(event.to) || !validPubkey(event.issuer))
        errors.push('invalid from/to/issuer');
      if (!Number.isSafeInteger(event.amount) || event.amount <= 0)
        errors.push('amount must be a positive safe integer');
      if (!Number.isSafeInteger(event.fee) || event.fee < 0)
        errors.push('fee must be a non-negative safe integer');
      if (!Number.isSafeInteger(event.amount + event.fee))
        errors.push('amount plus fee exceeds safe integer range');
      if (event.from !== event.pubkey) errors.push('sender must sign their own transfer');
      break;
    case EventKind.CHECKPOINT:
      if (event.type !== 'checkpoint') errors.push('invalid event type');
      if (!event.layer2_state_root) errors.push('missing layer2_state_root');
      if (!Array.isArray(event.layer2_block_range) || event.layer2_block_range.length !== 2 ||
          !event.layer2_block_range.every((n) => Number.isSafeInteger(n) && n >= 0) ||
          event.layer2_block_range[0] > event.layer2_block_range[1])
        errors.push('invalid layer2_block_range');
      break;
    case EventKind.FEE_SIGNAL:
      if (event.type !== 'fee_signal') errors.push('invalid event type');
      if (!validPubkey(event.miner)) errors.push('invalid miner');
      if (!Number.isSafeInteger(event.min_fee_satoshis) || event.min_fee_satoshis < 0)
        errors.push('min_fee_satoshis must be a non-negative safe integer');
      break;
    default:
      errors.push('unknown event kind');
  }

  return errors.length ? fail(...errors) : ok();
}

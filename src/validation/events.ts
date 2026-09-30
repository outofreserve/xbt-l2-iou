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

/** Structural + signature validation, independent of external state (ledger/Bitcoin). */
export function validateEventSchema(event: IouEvent): ValidationResult {
  const errors: string[] = [];

  if (!event.id || !event.sig || !event.pubkey) errors.push('missing id/sig/pubkey');
  if (!verifyEventSignature(event)) errors.push('invalid signature');

  switch (event.kind) {
    case EventKind.IOU_CREATION:
      if (!event.btc_htlc_address) errors.push('missing btc_htlc_address');
      if (!event.btc_txid) errors.push('missing btc_txid');
      if (event.amount_satoshis <= 0) errors.push('amount_satoshis must be positive');
      if (!event.preimage_hash) errors.push('missing preimage_hash');
      if (event.issuer !== event.pubkey) errors.push('issuer must sign its own iou_creation event');
      break;
    case EventKind.REDEMPTION_REQUEST:
      if (event.amount <= 0) errors.push('amount must be positive');
      if (event.holder !== event.pubkey) errors.push('holder must sign their own redemption_request');
      break;
    case EventKind.PREIMAGE_REVEAL:
      if (!event.preimage || !event.preimage_hash) errors.push('missing preimage/preimage_hash');
      if (event.issuer !== event.pubkey) errors.push('issuer must sign its own preimage_reveal');
      break;
    case EventKind.TRANSFER:
      if (event.amount <= 0) errors.push('amount must be positive');
      if (event.fee < 0) errors.push('fee must be non-negative');
      if (event.from !== event.pubkey) errors.push('sender must sign their own transfer');
      break;
    case EventKind.CHECKPOINT:
      if (!event.layer2_state_root) errors.push('missing layer2_state_root');
      if (event.layer2_block_range[0] > event.layer2_block_range[1])
        errors.push('invalid layer2_block_range');
      break;
    case EventKind.FEE_SIGNAL:
      if (event.min_fee_satoshis < 0) errors.push('min_fee_satoshis must be non-negative');
      break;
  }

  return errors.length ? fail(...errors) : ok();
}

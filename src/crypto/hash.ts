/**
 * Hashing helpers. Bitcoin-style double SHA256 for PoW block hashing,
 * plain SHA256 for hex-in/hex-out convenience used by preimage hashes etc.
 */
import { createHash } from 'node:crypto';

export function sha256(data: Buffer | string): Buffer {
  return createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data) : data)
    .digest();
}

export function sha256Hex(data: Buffer | string): string {
  return sha256(data).toString('hex');
}

/** SHA256(SHA256(x)) — used for block header PoW hashing. */
export function sha256d(data: Buffer | string): Buffer {
  return sha256(sha256(data));
}

export function sha256dHex(data: Buffer | string): string {
  return sha256d(data).toString('hex');
}

/** Interprets a hex-encoded hash as a big integer for difficulty comparisons. */
export function hexToBigInt(hex: string): bigint {
  return BigInt('0x' + (hex.length ? hex : '0'));
}

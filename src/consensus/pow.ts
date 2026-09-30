/**
 * Proof-of-work primitives: header hashing (SHA256d) and difficulty
 * target math. Difficulty is represented as `bits`: the number of
 * leading-zero bits required of the target relative to the maximum
 * 256-bit target (higher bits => smaller target => harder to satisfy),
 * analogous to Bitcoin's compact difficulty but simplified to a plain
 * integer for this simulation.
 */
import { sha256d } from '../crypto/hash.js';

export const MAX_TARGET = (1n << 256n) - 1n;

export function targetFromBits(bits: number): bigint {
  const b = BigInt(Math.max(0, Math.min(255, Math.floor(bits))));
  return MAX_TARGET >> b;
}

function bitLength(n: bigint): number {
  if (n <= 0n) return 0;
  return n.toString(2).length;
}

export function bitsFromTarget(target: bigint): number {
  const clamped = target > MAX_TARGET ? MAX_TARGET : target < 1n ? 1n : target;
  const bits = 256 - bitLength(clamped);
  return Math.max(0, Math.min(255, bits));
}

/** Canonical JSON (sorted keys) used as the PoW pre-image. */
function canonicalize(obj: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

export function headerHash(header: Record<string, unknown>): string {
  return sha256d(canonicalize(header)).toString('hex');
}

export function hashMeetsTarget(hashHex: string, bits: number): boolean {
  const hashInt = BigInt('0x' + hashHex);
  return hashInt <= targetFromBits(bits);
}

/**
 * Mines a header by scanning `nonce` until the header hash satisfies the
 * target implied by `header.target_bits`. Returns the winning nonce+hash.
 * `maxIterations` guards against pathological difficulty settings in tests.
 */
export function mineHeader<H extends { nonce: number; target_bits: number }>(
  header: H,
  maxIterations = 50_000_000,
): { nonce: number; hash: string } {
  for (let nonce = 0; nonce < maxIterations; nonce++) {
    const candidate = { ...header, nonce };
    const hash = headerHash(candidate as unknown as Record<string, unknown>);
    if (hashMeetsTarget(hash, header.target_bits)) {
      return { nonce, hash };
    }
  }
  throw new Error('mineHeader: exceeded maxIterations without finding a valid nonce');
}

/** Approximate relative "work" represented by a target (for longest-chain-by-work comparisons). */
export function workForBits(bits: number): bigint {
  const target = targetFromBits(bits);
  return MAX_TARGET / (target + 1n);
}

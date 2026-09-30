/**
 * Chain validation (header linkage + PoW) and longest-chain-by-work
 * selection, generic over L1/L2 block shapes.
 */
import { hashMeetsTarget, workForBits } from './pow.js';

export interface MinimalHeader {
  height: number;
  parent_hash: string;
  target_bits: number;
}

export interface MinimalBlock<H extends MinimalHeader> {
  header: H;
  hash: string;
}

export interface ChainValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates that `blocks` form a single, correctly-linked, PoW-valid chain.
 * `computeHash` recomputes a block's hash from its header for comparison
 * against the stored `hash` (guards against tampering).
 */
export function validateChain<H extends MinimalHeader>(
  blocks: Array<MinimalBlock<H>>,
  computeHash: (header: H) => string,
  genesisParentHash = '0'.repeat(64),
): ChainValidationResult {
  const errors: string[] = [];
  let prevHash = genesisParentHash;

  for (let i = 0; i < blocks.length; i++) {
    const { header, hash } = blocks[i];
    const recomputed = computeHash(header);
    if (recomputed !== hash) {
      errors.push(`block ${header.height}: stored hash does not match recomputed hash`);
    }
    if (!hashMeetsTarget(hash, header.target_bits)) {
      errors.push(`block ${header.height}: hash does not satisfy target_bits=${header.target_bits}`);
    }
    if (header.parent_hash !== prevHash) {
      errors.push(
        `block ${header.height}: parent_hash mismatch (expected ${prevHash}, got ${header.parent_hash})`,
      );
    }
    if (i > 0 && header.height !== blocks[i - 1].header.height + 1) {
      errors.push(`block ${header.height}: non-sequential height`);
    }
    prevHash = hash;
  }

  return { valid: errors.length === 0, errors };
}

export function totalWork<H extends MinimalHeader>(blocks: Array<MinimalBlock<H>>): bigint {
  return blocks.reduce((sum, b) => sum + workForBits(b.header.target_bits), 0n);
}

/** Longest-chain-by-cumulative-work rule: picks the candidate chain with the most total work. */
export function selectBestChain<H extends MinimalHeader>(
  candidates: Array<Array<MinimalBlock<H>>>,
): Array<MinimalBlock<H>> {
  if (candidates.length === 0) return [];
  let best = candidates[0];
  let bestWork = totalWork(best);
  for (let i = 1; i < candidates.length; i++) {
    const work = totalWork(candidates[i]);
    if (work > bestWork) {
      best = candidates[i];
      bestWork = work;
    }
  }
  return best;
}

import { describe, it, expect } from 'vitest';
import { headerHash, mineHeader, hashMeetsTarget, targetFromBits, workForBits } from '../src/consensus/pow.js';
import { adjustDifficulty } from '../src/consensus/difficulty.js';
import { validateChain, selectBestChain, totalWork } from '../src/consensus/chain.js';

describe('proof of work', () => {
  it('mines a header whose hash satisfies the target', () => {
    const header = { version: 1, height: 1, parent_hash: '0'.repeat(64), target_bits: 8, nonce: 0 };
    const { nonce, hash } = mineHeader(header);
    expect(hashMeetsTarget(hash, 8)).toBe(true);
    expect(headerHash({ ...header, nonce })).toBe(hash);
  });

  it('higher bits => smaller target => harder (fewer valid hashes)', () => {
    expect(targetFromBits(8)).toBeLessThan(targetFromBits(4));
    expect(targetFromBits(4)).toBeLessThan(targetFromBits(0));
  });

  it('work increases as target decreases (difficulty increases)', () => {
    expect(workForBits(8)).toBeGreaterThan(workForBits(4));
  });

  it('rejects a hash that does not satisfy an artificially strict target', () => {
    // A hash of all 0xff bytes cannot satisfy any nontrivial positive-bits target.
    const allOnes = 'f'.repeat(64);
    expect(hashMeetsTarget(allOnes, 4)).toBe(false);
  });
});

describe('difficulty adjustment', () => {
  it('increases difficulty (higher bits) when blocks come in faster than expected', () => {
    const newBits = adjustDifficulty(4, /* actual */ 5_000, /* expected */ 10_000);
    expect(newBits).toBeGreaterThan(4);
  });

  it('decreases difficulty (lower bits) when blocks come in slower than expected', () => {
    const newBits = adjustDifficulty(8, /* actual */ 20_000, /* expected */ 10_000);
    expect(newBits).toBeLessThan(8);
  });

  it('clamps adjustment to at most 4x per retarget', () => {
    const hugeBits = adjustDifficulty(4, /* actual */ 100, /* expected */ 1_000_000);
    const modestBits = adjustDifficulty(4, /* actual */ 250_000, /* expected */ 1_000_000);
    // A 10000x speedup should not produce more difficulty increase than a 4x-clamped speedup.
    expect(hugeBits).toBe(modestBits);
  });
});

describe('chain validation and longest-chain-by-work selection', () => {
  function buildChain(length: number, bits: number) {
    const blocks: Array<{ header: { height: number; parent_hash: string; target_bits: number; nonce: number }; hash: string }> = [];
    let parentHash = '0'.repeat(64);
    for (let h = 1; h <= length; h++) {
      const header = { height: h, parent_hash: parentHash, target_bits: bits, nonce: 0 };
      const { nonce, hash } = mineHeader(header);
      const full = { ...header, nonce };
      blocks.push({ header: full, hash });
      parentHash = hash;
    }
    return blocks;
  }

  it('validates a correctly linked, PoW-valid chain', () => {
    const chain = buildChain(5, 4);
    const result = validateChain(chain, (h) => headerHash(h));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('detects broken parent-hash linkage', () => {
    const chain = buildChain(3, 4);
    chain[2] = { ...chain[2], header: { ...chain[2].header, parent_hash: 'deadbeef'.repeat(8) } };
    const result = validateChain(chain, (h) => headerHash(h));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('parent_hash mismatch'))).toBe(true);
  });

  it('detects a tampered hash that does not match the recomputed header hash', () => {
    const chain = buildChain(3, 4);
    chain[1] = { ...chain[1], hash: 'a'.repeat(64) };
    const result = validateChain(chain, (h) => headerHash(h));
    expect(result.valid).toBe(false);
  });

  it('selects the chain with the greatest cumulative work as the best chain (longest chain rule)', () => {
    const shortHardChain = buildChain(3, 12); // fewer blocks but much higher difficulty
    const longEasyChain = buildChain(3, 4); // same length, lower difficulty -> less work
    const best = selectBestChain([longEasyChain, shortHardChain]);
    expect(totalWork(best)).toEqual(totalWork(shortHardChain));
  });
});

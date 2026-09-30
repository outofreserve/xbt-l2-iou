/**
 * Simple binary merkle tree over a list of items, hashed with SHA256.
 * Odd levels duplicate the last node (Bitcoin-style).
 */
import { sha256Hex } from './hash.js';

export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) {
    return sha256Hex('');
  }
  let level = leaves.map((leaf) => sha256Hex(leaf));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256Hex(left + right));
    }
    level = next;
  }
  return level[0];
}

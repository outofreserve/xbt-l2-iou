/**
 * Difficulty retargeting, modeled after Bitcoin's algorithm: compare the
 * actual time taken for the last `adjustmentInterval` blocks against the
 * expected time, and scale the target proportionally (clamped to
 * [0.25x, 4x] per-adjustment to avoid wild swings).
 */
import { targetFromBits, bitsFromTarget, MAX_TARGET } from './pow.js';

const RATIO_SCALE = 1_000_000n;
const MIN_RATIO = RATIO_SCALE / 4n; // 0.25x
const MAX_RATIO = RATIO_SCALE * 4n; // 4x

export function adjustDifficulty(
  currentBits: number,
  actualTimespanMs: number,
  expectedTimespanMs: number,
): number {
  if (actualTimespanMs <= 0) actualTimespanMs = 1;
  let ratio = BigInt(Math.round((actualTimespanMs / expectedTimespanMs) * Number(RATIO_SCALE)));
  if (ratio < MIN_RATIO) ratio = MIN_RATIO;
  if (ratio > MAX_RATIO) ratio = MAX_RATIO;

  const oldTarget = targetFromBits(currentBits);
  let newTarget = (oldTarget * ratio) / RATIO_SCALE;
  if (newTarget > MAX_TARGET) newTarget = MAX_TARGET;
  if (newTarget < 1n) newTarget = 1n;
  return bitsFromTarget(newTarget);
}

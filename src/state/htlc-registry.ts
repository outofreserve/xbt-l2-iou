/**
 * HTLC registry: Map<htlc_address, HtlcEntry>.
 *
 * Tracks Bitcoin HTLCs backing outstanding IOU supply. Entries move through
 * active -> redeeming -> redeemed as redemption requests / preimage reveals
 * / Bitcoin HTLC spends are processed, with a reorg_pending state used while
 * a Bitcoin spend awaits the required confirmation depth.
 */
import type { HtlcEntry, HtlcStatus, Pubkey, Sha256Hex } from '../types/index.js';

export class HtlcRegistry {
  private entries = new Map<string, HtlcEntry>();

  register(entry: HtlcEntry): void {
    if (this.entries.has(entry.htlc_address)) {
      throw new Error(`HTLC already registered: ${entry.htlc_address}`);
    }
    this.entries.set(entry.htlc_address, { ...entry });
  }

  get(htlcAddress: string): HtlcEntry | undefined {
    return this.entries.get(htlcAddress);
  }

  findByPreimageHash(issuer: Pubkey, preimageHash: Sha256Hex): HtlcEntry[] {
    return [...this.entries.values()].filter(
      (e) => e.issuer === issuer && e.preimage_hash === preimageHash,
    );
  }

  /** Total outstanding (locked - redeemed) satoshis backing `issuer`'s IOUs. */
  outstandingBackingFor(issuer: Pubkey): number {
    let total = 0;
    for (const e of this.entries.values()) {
      if (e.issuer === issuer) total += e.amount_locked - e.amount_redeemed;
    }
    return total;
  }

  setStatus(htlcAddress: string, status: HtlcStatus): void {
    const e = this.entries.get(htlcAddress);
    if (!e) throw new Error(`unknown HTLC: ${htlcAddress}`);
    e.status = status;
  }

  recordPreimage(issuer: Pubkey, preimageHash: Sha256Hex, preimage: string): void {
    for (const e of this.entries.values()) {
      if (e.issuer === issuer && e.preimage_hash === preimageHash) {
        e.preimage = preimage;
      }
    }
  }

  applyRedemption(htlcAddress: string, amount: number): void {
    const e = this.entries.get(htlcAddress);
    if (!e) throw new Error(`unknown HTLC: ${htlcAddress}`);
    e.amount_redeemed += amount;
    e.status = e.amount_redeemed >= e.amount_locked ? 'redeemed' : 'active';
  }

  all(): HtlcEntry[] {
    return [...this.entries.values()];
  }

  clone(): HtlcRegistry {
    const r = new HtlcRegistry();
    for (const [k, v] of this.entries) r.entries.set(k, { ...v });
    return r;
  }
}

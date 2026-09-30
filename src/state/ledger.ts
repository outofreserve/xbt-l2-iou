/**
 * Account ledger: Map<(issuer_pubkey, holder_pubkey), satoshis>.
 *
 * Balances represent IOUs — claims the holder has on the issuer, ultimately
 * redeemable for Bitcoin locked in the issuer's HTLC(s).
 */
import { ledgerKey, type IssuerHolderKey, type Pubkey } from '../types/index.js';

export class Ledger {
  private balances = new Map<IssuerHolderKey, number>();

  getBalance(issuer: Pubkey, holder: Pubkey): number {
    return this.balances.get(ledgerKey(issuer, holder)) ?? 0;
  }

  /** Credits `holder` with `amount` IOUs issued by `issuer`. Used on iou_creation and transfer-in. */
  credit(issuer: Pubkey, holder: Pubkey, amount: number): void {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('credit amount must be a non-negative safe integer');
    const key = ledgerKey(issuer, holder);
    const next = (this.balances.get(key) ?? 0) + amount;
    if (!Number.isSafeInteger(next)) throw new Error('balance exceeds safe integer range');
    this.balances.set(key, next);
  }

  /** Debits `holder`'s balance of `issuer`'s IOUs. Throws on insufficient balance. */
  debit(issuer: Pubkey, holder: Pubkey, amount: number): void {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('debit amount must be a non-negative safe integer');
    const key = ledgerKey(issuer, holder);
    const current = this.balances.get(key) ?? 0;
    if (current < amount) {
      throw new Error(
        `insufficient balance: ${holder} has ${current} of issuer ${issuer}'s IOUs, needs ${amount}`,
      );
    }
    this.balances.set(key, current - amount);
  }

  /** Burns `amount` from holder's balance (redemption). Same effect as debit, kept for clarity. */
  burn(issuer: Pubkey, holder: Pubkey, amount: number): void {
    this.debit(issuer, holder, amount);
  }

  entries(): Array<[IssuerHolderKey, number]> {
    return [...this.balances.entries()].filter(([, v]) => v !== 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** Deterministic snapshot of all nonzero balances, for state-root hashing. */
  snapshot(): string[] {
    return this.entries().map(([key, amount]) => `${key}:${amount}`);
  }

  clone(): Ledger {
    const l = new Ledger();
    for (const [k, v] of this.balances) l.balances.set(k, v);
    return l;
  }
}

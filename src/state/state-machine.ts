/**
 * State machine applying IouEvents to the Ledger + HtlcRegistry.
 *
 * Event application is intentionally narrow: business-rule validation
 * (signatures, Bitcoin UTXO checks, etc.) happens in src/validation and
 * src/l1 before an event reaches `applyEvent`. This module is the pure
 * state-transition function described by the spec's consensus rules.
 */
import { Ledger } from './ledger.js';
import { HtlcRegistry } from './htlc-registry.js';
import { sha256Hex } from '../crypto/hash.js';
import {
  EventKind,
  type IouEvent,
  type Pubkey,
  type Sha256Hex,
} from '../types/index.js';

export interface PendingRedemption {
  id: string;
  holder: Pubkey;
  issuer: Pubkey;
  amount: number;
  requestedAt: number;
  preimageRevealed: boolean;
  htlcAddress?: string;
  confirmed: boolean;
}

export class StateTransitionError extends Error {}

export class StateMachine {
  readonly ledger = new Ledger();
  readonly htlcRegistry = new HtlcRegistry();
  readonly pendingRedemptions = new Map<string, PendingRedemption>();
  /** issuer -> minted total (for supply accounting/metrics) */
  private mintedTotal = new Map<Pubkey, number>();
  private burnedTotal = new Map<Pubkey, number>();

  totalMinted(issuer?: Pubkey): number {
    if (issuer) return this.mintedTotal.get(issuer) ?? 0;
    return [...this.mintedTotal.values()].reduce((a, b) => a + b, 0);
  }

  totalBurned(issuer?: Pubkey): number {
    if (issuer) return this.burnedTotal.get(issuer) ?? 0;
    return [...this.burnedTotal.values()].reduce((a, b) => a + b, 0);
  }

  circulatingSupply(): number {
    return this.totalMinted() - this.totalBurned();
  }

  /**
   * Applies a single validated event to state. Throws StateTransitionError
   * on invariant violation. `context.minerAddress`, when provided, receives
   * the fee from a TRANSFER event (used when a layer directly settles
   * transfers, e.g. the Layer 1 fallback path).
   */
  applyEvent(event: IouEvent, context: { minerAddress?: Pubkey } = {}): void {
    switch (event.kind) {
      case EventKind.IOU_CREATION: {
        if (this.htlcRegistry.get(event.btc_htlc_address)) {
          throw new StateTransitionError(
            `HTLC already registered: ${event.btc_htlc_address}`,
          );
        }
        this.htlcRegistry.register({
          htlc_address: event.btc_htlc_address,
          issuer: event.issuer,
          amount_locked: event.amount_satoshis,
          amount_redeemed: 0,
          preimage_hash: event.preimage_hash,
          status: 'active',
          btc_txid: event.btc_txid,
          btc_output_index: event.btc_output_index,
          confirmations: 6,
        });
        // 1:1 supply creation: issuer is minted IOUs matching locked BTC,
        // held by the issuer until distributed via transfers.
        this.ledger.credit(event.issuer, event.issuer, event.amount_satoshis);
        this.mintedTotal.set(
          event.issuer,
          (this.mintedTotal.get(event.issuer) ?? 0) + event.amount_satoshis,
        );
        break;
      }

      case EventKind.REDEMPTION_REQUEST: {
        const bal = this.ledger.getBalance(event.issuer, event.holder);
        if (bal < event.amount - 1e-9) {
          throw new StateTransitionError(
            `redemption_request exceeds balance: holder=${event.holder} issuer=${event.issuer} bal=${bal} amount=${event.amount}`,
          );
        }
        this.pendingRedemptions.set(event.id, {
          id: event.id,
          holder: event.holder,
          issuer: event.issuer,
          amount: event.amount,
          requestedAt: event.created_at,
          preimageRevealed: false,
          confirmed: false,
        });
        break;
      }

      case EventKind.PREIMAGE_REVEAL: {
        const computed = sha256Hex(Buffer.from(event.preimage, 'hex'));
        if (computed !== event.preimage_hash) {
          throw new StateTransitionError(
            `preimage does not match hash: computed=${computed} expected=${event.preimage_hash}`,
          );
        }
        this.htlcRegistry.recordPreimage(event.issuer, event.preimage_hash, event.preimage);
        for (const pr of this.pendingRedemptions.values()) {
          if (pr.issuer === event.issuer && !pr.confirmed) {
            const htlcs = this.htlcRegistry.findByPreimageHash(event.issuer, event.preimage_hash);
            if (htlcs.length > 0) {
              pr.preimageRevealed = true;
              pr.htlcAddress = pr.htlcAddress ?? htlcs[0].htlc_address;
            }
          }
        }
        break;
      }

      case EventKind.TRANSFER: {
        const totalDebit = event.amount + event.fee;
        this.ledger.debit(event.issuer, event.from, totalDebit);
        this.ledger.credit(event.issuer, event.to, event.amount);
        if (event.fee > 0 && context.minerAddress) {
          this.ledger.credit(event.issuer, context.minerAddress, event.fee);
        }
        break;
      }

      case EventKind.CHECKPOINT:
        // Checkpoints are recorded by the L1 chain (checkpoint log); no
        // ledger/htlc mutation occurs here.
        break;

      case EventKind.FEE_SIGNAL:
        // Informational; miner fee signals are surfaced via block headers.
        break;

      default:
        throw new StateTransitionError(`unknown event kind: ${(event as IouEvent).kind}`);
    }
  }

  /**
   * Confirms a redemption once the Bitcoin full node has observed the HTLC
   * spend with the correct preimage and it has reached the required
   * confirmation depth. Burns IOUs from the holder and updates the HTLC
   * registry's amount_redeemed.
   */
  confirmRedemption(redemptionId: string, htlcAddress: string): void {
    const pr = this.pendingRedemptions.get(redemptionId);
    if (!pr) throw new StateTransitionError(`unknown pending redemption: ${redemptionId}`);
    if (pr.confirmed) return;
    const htlc = this.htlcRegistry.get(htlcAddress);
    if (!htlc) throw new StateTransitionError(`unknown HTLC: ${htlcAddress}`);
    this.ledger.burn(pr.issuer, pr.holder, pr.amount);
    this.htlcRegistry.applyRedemption(htlcAddress, pr.amount);
    this.burnedTotal.set(pr.issuer, (this.burnedTotal.get(pr.issuer) ?? 0) + pr.amount);
    pr.confirmed = true;
    pr.htlcAddress = htlcAddress;
  }

  markReorgPending(htlcAddress: string): void {
    this.htlcRegistry.setStatus(htlcAddress, 'reorg_pending');
  }
}

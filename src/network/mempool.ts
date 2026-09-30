/**
 * Fee-priority mempool for pending IOU protocol events.
 *
 * Transfer events carry a user-set fee (satoshis) and are prioritized by
 * highest-fee-first (a simple free-market fee auction). Protocol-critical
 * events without a fee market (iou_creation, redemption_request,
 * preimage_reveal, checkpoint) are always prioritized ahead of transfers,
 * since e.g. preimage reveal is protocol-mandated to happen within one
 * block of the redemption request.
 */
import { EventKind, type IouEvent } from '../types/index.js';

export function eventPriority(event: IouEvent): number {
  if (event.kind === EventKind.TRANSFER) return event.fee;
  return Number.POSITIVE_INFINITY;
}

interface MempoolEntry {
  event: IouEvent;
  priority: number;
  receivedAt: number;
}

export class Mempool {
  private entries = new Map<string, MempoolEntry>();
  private seq = 0;

  add(event: IouEvent): void {
    if (this.entries.has(event.id)) return;
    this.entries.set(event.id, {
      event,
      priority: eventPriority(event),
      receivedAt: this.seq++,
    });
  }

  remove(ids: Iterable<string>): void {
    for (const id of ids) this.entries.delete(id);
  }

  size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Returns up to `maxCount` highest-priority (highest fee first) events, FIFO within equal priority. */
  peekBatch(maxCount: number): IouEvent[] {
    const sorted = [...this.entries.values()].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.receivedAt - b.receivedAt;
    });
    return sorted.slice(0, maxCount).map((e) => e.event);
  }

  /** Pops (removes and returns) up to `maxCount` highest-priority events. */
  popBatch(maxCount: number): IouEvent[] {
    const batch = this.peekBatch(maxCount);
    this.remove(batch.map((e) => e.id));
    return batch;
  }

  clear(): void {
    this.entries.clear();
  }

  all(): IouEvent[] {
    return [...this.entries.values()].map((e) => e.event);
  }
}

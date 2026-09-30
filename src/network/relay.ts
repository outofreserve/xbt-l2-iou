/**
 * Minimal in-memory Nostr-style relay: publish/subscribe for IOU protocol
 * events and block propagation, standing in for a real Nostr relay
 * connection (wss://relay...) in this single-process simulation.
 */
import type { IouEvent, Layer1Block, Layer2Block } from '../types/index.js';

type EventListener = (event: IouEvent) => void;
type L1BlockListener = (block: Layer1Block) => void;
type L2BlockListener = (block: Layer2Block) => void;

export class Relay {
  private eventListeners = new Set<EventListener>();
  private l1BlockListeners = new Set<L1BlockListener>();
  private l2BlockListeners = new Set<L2BlockListener>();
  private online = true;

  setOnline(online: boolean): void {
    this.online = online;
  }

  isOnline(): boolean {
    return this.online;
  }

  publishEvent(event: IouEvent): void {
    if (!this.online) return;
    for (const cb of this.eventListeners) cb(event);
  }

  subscribeEvents(cb: EventListener): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  publishL1Block(block: Layer1Block): void {
    if (!this.online) return;
    for (const cb of this.l1BlockListeners) cb(block);
  }

  subscribeL1Blocks(cb: L1BlockListener): () => void {
    this.l1BlockListeners.add(cb);
    return () => this.l1BlockListeners.delete(cb);
  }

  publishL2Block(block: Layer2Block): void {
    if (!this.online) return;
    for (const cb of this.l2BlockListeners) cb(block);
  }

  subscribeL2Blocks(cb: L2BlockListener): () => void {
    this.l2BlockListeners.add(cb);
    return () => this.l2BlockListeners.delete(cb);
  }
}

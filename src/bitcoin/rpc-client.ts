/**
 * Bitcoin RPC client interface.
 *
 * This is the boundary Layer 1 validators use to talk to a Bitcoin full
 * node. In production you would implement this against a real `bitcoind`
 * JSON-RPC endpoint (e.g. using a library such as `bitcoin-core` or a thin
 * fetch-based wrapper around `getblockcount`, `gettxout`,
 * `getrawtransaction`, `getmempoolentry`, `getrawmempool`, etc). For this
 * simulation/demo repo, `SimulatedBitcoinNode` (see ./simulated-node.ts)
 * implements this same interface entirely in memory so the whole system is
 * runnable and testable without a real Bitcoin node.
 *
 * ## Swapping in a real bitcoind client
 * 1. Implement `BitcoinRpcClient` with a class that calls a real JSON-RPC
 *    endpoint (`getblockcount`, `gettxout`, `getrawtransaction`,
 *    `decodescript`, `getrawmempool`, `getblockhash`/`getblock` for reorg
 *    detection, etc).
 * 2. `lockHtlc`, `spendHtlc`, `mineBlocks`, and `forceReorg` are
 *    simulation-only helpers currently required by this interface.
 *    A real adapter requires separating wallet/broadcast operations from
 *    the read-only validation surface and redesigning redemption settlement.
 *    Swapping clients alone does not make this system safe for real funds.
 */

export interface UtxoInfo {
  txid: string;
  vout: number;
  address: string;
  amountSatoshis: number;
  confirmations: number;
  spent: boolean;
  scriptType: 'htlc' | 'other';
  preimageHash?: string;
}

export interface HtlcSpendInfo {
  txid: string;
  preimage: string;
  confirmations: number;
}

export interface BitcoinRpcClient {
  getBlockCount(): Promise<number>;
  getBestBlockHash(): Promise<string>;

  /** Looks up a UTXO by outpoint, or null if spent/unknown. */
  getUtxo(txid: string, vout: number): Promise<UtxoInfo | null>;

  /** Confirmations for a given txid; 0 = mempool only, -1 = unknown. */
  getConfirmations(txid: string): Promise<number>;

  /**
   * Looks for a transaction (mempool or chain) spending the HTLC funding
   * output at `address`, extracting the revealed preimage if present.
   */
  findHtlcSpend(address: string): Promise<HtlcSpendInfo | null>;

  /** Registers a callback invoked whenever a new block is produced. */
  onNewBlock(cb: (height: number, hash: string) => void): void;

  // --- Simulation-only helpers (not part of a real bitcoind RPC surface) ---

  /** Simulates a user locking `amountSatoshis` BTC into a new HTLC address. */
  lockHtlc(params: {
    amountSatoshis: number;
    preimageHash: string;
    address?: string;
  }): Promise<{ address: string; txid: string; vout: number }>;

  /** Simulates the redeemer broadcasting a transaction spending the HTLC with `preimage`. */
  spendHtlc(params: { address: string; preimage: string }): Promise<{ spendTxid: string }>;

  /** Mines `n` simulated Bitcoin blocks, confirming mempool transactions. */
  mineBlocks(n: number): Promise<void>;

  /** Simulates a chain reorg that unwinds the last `depth` blocks. */
  forceReorg(depth: number): Promise<void>;
}

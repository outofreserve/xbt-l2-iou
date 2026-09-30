/**
 * In-memory simulated Bitcoin node implementing BitcoinRpcClient.
 *
 * Models just enough of Bitcoin's UTXO/mempool/block semantics to exercise
 * the Layer 1 validator's HTLC verification, redemption watching, and
 * reorg-handling logic without a real bitcoind.
 */
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../crypto/hash.js';
import type { BitcoinRpcClient, HtlcSpendInfo, UtxoInfo } from './rpc-client.js';

interface FundingTx {
  txid: string;
  vout: number;
  address: string;
  amountSatoshis: number;
  preimageHash: string;
  confirmedAtHeight: number | null; // null = still in mempool
}

interface SpendTx {
  txid: string;
  address: string; // htlc address being spent
  preimage: string;
  confirmedAtHeight: number | null;
}

function randHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

export class SimulatedBitcoinNode implements BitcoinRpcClient {
  private height: number;
  private blockHashes: string[] = [];
  private fundingTxs = new Map<string, FundingTx>(); // key: `${txid}:${vout}`
  private spendsByAddress = new Map<string, SpendTx>();
  private newBlockCbs: Array<(height: number, hash: string) => void> = [];

  constructor(startingHeight = 800_000) {
    this.height = startingHeight;
    this.blockHashes[this.height] = sha256Hex(`genesis-${startingHeight}`);
  }

  async getBlockCount(): Promise<number> {
    return this.height;
  }

  async getBestBlockHash(): Promise<string> {
    return this.blockHashes[this.height];
  }

  async getUtxo(txid: string, vout: number): Promise<UtxoInfo | null> {
    const f = this.fundingTxs.get(`${txid}:${vout}`);
    if (!f) return null;
    const spend = this.spendsByAddress.get(f.address);
    const confirmations = f.confirmedAtHeight === null ? 0 : this.height - f.confirmedAtHeight + 1;
    return {
      txid: f.txid,
      vout: f.vout,
      address: f.address,
      amountSatoshis: f.amountSatoshis,
      confirmations,
      spent: !!spend,
      scriptType: 'htlc',
      preimageHash: f.preimageHash,
    };
  }

  async getConfirmations(txid: string): Promise<number> {
    for (const f of this.fundingTxs.values()) {
      if (f.txid === txid) {
        return f.confirmedAtHeight === null ? 0 : this.height - f.confirmedAtHeight + 1;
      }
    }
    for (const s of this.spendsByAddress.values()) {
      if (s.txid === txid) {
        return s.confirmedAtHeight === null ? 0 : this.height - s.confirmedAtHeight + 1;
      }
    }
    return -1;
  }

  async findHtlcSpend(address: string): Promise<HtlcSpendInfo | null> {
    const s = this.spendsByAddress.get(address);
    if (!s) return null;
    const confirmations = s.confirmedAtHeight === null ? 0 : this.height - s.confirmedAtHeight + 1;
    return { txid: s.txid, preimage: s.preimage, confirmations };
  }

  onNewBlock(cb: (height: number, hash: string) => void): void {
    this.newBlockCbs.push(cb);
  }

  async lockHtlc(params: {
    amountSatoshis: number;
    preimageHash: string;
    address?: string;
  }): Promise<{ address: string; txid: string; vout: number }> {
    const address = params.address ?? `htlc1${randHex(20)}`;
    const txid = randHex(32);
    const vout = 0;
    this.fundingTxs.set(`${txid}:${vout}`, {
      txid,
      vout,
      address,
      amountSatoshis: params.amountSatoshis,
      preimageHash: params.preimageHash,
      confirmedAtHeight: null,
    });
    return { address, txid, vout };
  }

  async spendHtlc(params: { address: string; preimage: string }): Promise<{ spendTxid: string }> {
    const spendTxid = randHex(32);
    this.spendsByAddress.set(params.address, {
      txid: spendTxid,
      address: params.address,
      preimage: params.preimage,
      confirmedAtHeight: null,
    });
    return { spendTxid };
  }

  async mineBlocks(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      this.height += 1;
      // Confirm any pending funding/spend txs into this new block.
      for (const f of this.fundingTxs.values()) {
        if (f.confirmedAtHeight === null) f.confirmedAtHeight = this.height;
      }
      for (const s of this.spendsByAddress.values()) {
        if (s.confirmedAtHeight === null) s.confirmedAtHeight = this.height;
      }
      const hash = sha256Hex(`block-${this.height}-${randHex(4)}`);
      this.blockHashes[this.height] = hash;
      for (const cb of this.newBlockCbs) cb(this.height, hash);
    }
  }

  /**
   * Simulates a chain reorg unwinding the last `depth` blocks: any
   * funding/spend tx confirmed within that window reverts to "mempool"
   * (confirmedAtHeight = null), forcing consumers to re-await confirmations.
   */
  async forceReorg(depth: number): Promise<void> {
    const reorgFloor = this.height - depth + 1;
    this.height -= depth;
    if (this.height < 0) this.height = 0;
    this.blockHashes.length = this.height + 1;
    for (const f of this.fundingTxs.values()) {
      if (f.confirmedAtHeight !== null && f.confirmedAtHeight >= reorgFloor) {
        f.confirmedAtHeight = null;
      }
    }
    for (const s of this.spendsByAddress.values()) {
      if (s.confirmedAtHeight !== null && s.confirmedAtHeight >= reorgFloor) {
        s.confirmedAtHeight = null;
      }
    }
  }
}

/**
 * HTLC validation for incoming iou_creation events: verifies the declared
 * Bitcoin UTXO exists, is unspent, has 6+ confirmations, and matches the
 * declared amount / address / preimage hash — the gate that prevents
 * minting IOUs without real Bitcoin backing.
 */
import type { BitcoinRpcClient } from '../bitcoin/rpc-client.js';
import type { IouCreationEvent } from '../types/index.js';

export interface HtlcCheckResult {
  valid: boolean;
  errors: string[];
}

export const REQUIRED_CONFIRMATIONS = 6;

export async function validateHtlcCreation(
  event: IouCreationEvent,
  btc: BitcoinRpcClient,
): Promise<HtlcCheckResult> {
  const errors: string[] = [];
  const utxo = await btc.getUtxo(event.btc_txid, event.btc_output_index);

  if (!utxo) {
    return { valid: false, errors: ['HTLC UTXO not found on Bitcoin chain/mempool'] };
  }
  if (utxo.spent) errors.push('HTLC UTXO is already spent');
  if (utxo.confirmations < REQUIRED_CONFIRMATIONS) {
    errors.push(
      `insufficient confirmations: have ${utxo.confirmations}, need ${REQUIRED_CONFIRMATIONS}`,
    );
  }
  if (utxo.amountSatoshis !== event.amount_satoshis) {
    errors.push(
      `amount mismatch: UTXO has ${utxo.amountSatoshis}, event declares ${event.amount_satoshis}`,
    );
  }
  if (utxo.address !== event.btc_htlc_address) {
    errors.push(`address mismatch: UTXO address ${utxo.address} != declared ${event.btc_htlc_address}`);
  }
  if (utxo.scriptType !== 'htlc') {
    errors.push('UTXO script does not match expected HTLC pattern');
  }
  if (utxo.preimageHash !== event.preimage_hash) {
    errors.push('preimage_hash does not match HTLC script');
  }

  return { valid: errors.length === 0, errors };
}

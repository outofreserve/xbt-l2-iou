/**
 * Preimage vault: holds HTLC preimages on behalf of issuers so that Layer 1
 * can perform the protocol-mandated *automatic* preimage reveal (same or
 * next block after a redemption request — issuers have no choice or delay
 * option). In a real deployment each issuer's own node would hold its
 * secrets and be compelled by protocol/slashing rules to reveal; here a
 * single vault simulates that compelled behavior for all issuers.
 */
import type { Pubkey, Sha256Hex } from '../types/index.js';

export interface PreimageSecret {
  preimage: string; // hex
  privateKey: Uint8Array; // issuer's signing key, to sign the auto-generated reveal event
}

export class PreimageVault {
  private secrets = new Map<string, PreimageSecret>();

  private key(issuer: Pubkey, preimageHash: Sha256Hex): string {
    return `${issuer}:${preimageHash}`;
  }

  register(issuer: Pubkey, preimageHash: Sha256Hex, preimage: string, privateKey: Uint8Array): void {
    this.secrets.set(this.key(issuer, preimageHash), { preimage, privateKey });
  }

  get(issuer: Pubkey, preimageHash: Sha256Hex): PreimageSecret | undefined {
    return this.secrets.get(this.key(issuer, preimageHash));
  }
}

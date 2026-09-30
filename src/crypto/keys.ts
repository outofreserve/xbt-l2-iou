/**
 * secp256k1 keypair + signing helpers, wrapping @noble/secp256k1.
 *
 * Wires up the sync HMAC-SHA256 implementation (via @noble/hashes) so that
 * `secp.sign` / `secp.verify` can be used synchronously, matching the
 * "signature" field semantics of Nostr-style events in this system.
 */
import * as secp from '@noble/secp256k1';
import { hmac } from '@noble/hashes/hmac';
import { sha256 as nobleSha256 } from '@noble/hashes/sha256';

secp.etc.hmacSha256Sync = (key: Uint8Array, ...msgs: Uint8Array[]) =>
  hmac(nobleSha256, key, secp.etc.concatBytes(...msgs));

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: string; // hex, compressed
}

export function generateKeyPair(): KeyPair {
  const privateKey = secp.utils.randomPrivateKey();
  const publicKey = secp.etc.bytesToHex(secp.getPublicKey(privateKey, true));
  return { privateKey, publicKey };
}

export function signMessage(messageHex: string, privateKey: Uint8Array): string {
  const msgHash = nobleSha256(secp.etc.hexToBytes(messageHex));
  const sig = secp.sign(msgHash, privateKey);
  return sig.toCompactHex();
}

export function verifySignature(
  signatureHex: string,
  messageHex: string,
  publicKeyHex: string,
): boolean {
  try {
    const msgHash = nobleSha256(secp.etc.hexToBytes(messageHex));
    return secp.verify(signatureHex, msgHash, publicKeyHex);
  } catch {
    return false;
  }
}

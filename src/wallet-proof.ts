import { getAddress, verifyMessage, type Address, type Hex } from "viem";
import { getWalletMessageToSign, isLiteralAddress, WALLET_SIGNATURE_TYPE } from "./contract.js";

export interface AuthorWallet {
  address?: unknown;
  timestamp?: unknown;
  signature?: { signature?: unknown; type?: unknown } | undefined;
}

// The three outcomes of BSIP-22. "unknown" is an entry of a signature type this verifier does not
// implement: it is neither valid nor invalid, and it is not a proven wallet.
export type WalletProofResult =
  | { outcome: "valid"; address: Address }
  | { outcome: "invalid"; error: string }
  | { outcome: "unknown"; error: string };

const invalid = (error: string): WalletProofResult => ({ outcome: "invalid", error });

// A proof may be dated at most this far ahead of the verifier's clock. Fixed, not configurable, so that
// verifiers differ only by their clocks and never by choice.
export const WALLET_TIMESTAMP_ALLOWANCE_SECONDS = 300;

// r || s || v: 65 bytes as 0x followed by 130 hex digits.
const SIGNATURE_REGEXP = /^0x[0-9a-fA-F]{130}$/;

// Half the secp256k1 curve order. A signature whose s is above this has a twin with s' = n - s that
// recovers the same address, so only the low form is accepted (EIP-2).
const SECP256K1_HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

// viem recovers an address from the 0/1 form of v and from a high s as readily as from the canonical
// form. Verifiers must agree on one encoding, so both are checked here, before recovery.
const checkSignatureEncoding = (signature: unknown): string | undefined => {
  if (typeof signature !== "string" || !SIGNATURE_REGEXP.test(signature)) {
    return "wallet signature must be 65 bytes: 0x followed by 130 hex characters";
  }
  const v = Number.parseInt(signature.slice(130, 132), 16);
  if (v !== 27 && v !== 28) {
    return "wallet signature must end in the byte 0x1b or 0x1c (v of 27 or 28). The 0 or 1 form is not valid";
  }
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  if (s === 0n || s > SECP256K1_HALF_ORDER) {
    return "wallet signature must use the low form of s";
  }
  return undefined;
};

// Verifies one entry of `author.wallets` against the key address of the author's signing key, as
// BSIP-22 (Author Wallet Proofs) defines it. pkc-js only checks the entry's shape, so without this anyone
// could list a wallet they do not control.
//
// The order is BSIP-22's: the shape every entry has, then signature.type, then the eip191 rules. An entry
// of another type is unknown, so the eip191 rules for address and timestamp are not applied to it.
//
// Stateless on purpose: no "newest timestamp wins" cache. The proof names the author's key, so only that
// key can publish with it, and a reader can reproduce the check from the entry alone. No RPC either: an
// EIP-191 signature from an ordinary account is checked by recovery.
//
// The README's "verify a wallet entry" snippet for UI clients is a copy of these rules. Change them together.
export const verifyWalletProof = async ({
  wallet,
  authorKeyAddress,
  nowSeconds = Math.floor(Date.now() / 1000)
}: {
  wallet: AuthorWallet | undefined;
  authorKeyAddress: string;
  nowSeconds?: number;
}): Promise<WalletProofResult> => {
  // 1. The shape, whatever the type.
  if (typeof wallet !== "object" || wallet === null) {
    return invalid("has no wallet for this chain");
  }
  if (typeof wallet.address !== "string") {
    return invalid("wallet address must be a string");
  }
  if (typeof wallet.timestamp !== "number" || !Number.isInteger(wallet.timestamp)) {
    return invalid("wallet timestamp must be an integer");
  }
  const proof = wallet.signature;
  if (typeof proof !== "object" || proof === null || typeof proof.signature !== "string" || typeof proof.type !== "string") {
    return invalid("wallet signature must be an object with a string signature and a string type");
  }

  // 2. The type.
  if (proof.type !== WALLET_SIGNATURE_TYPE) {
    return {
      outcome: "unknown",
      error: `wallet signature type ${JSON.stringify(proof.type)} is unknown, only "${WALLET_SIGNATURE_TYPE}" can be verified`
    };
  }

  // 3. The eip191 rules.
  if (!isLiteralAddress(wallet.address)) {
    return invalid("wallet address must be a literal 0x address, not a name");
  }
  if (wallet.timestamp < 0) {
    return invalid("wallet timestamp must not be negative");
  }
  if (wallet.timestamp > nowSeconds + WALLET_TIMESTAMP_ALLOWANCE_SECONDS) {
    return invalid(`wallet timestamp is more than ${WALLET_TIMESTAMP_ALLOWANCE_SECONDS} seconds in the future`);
  }
  const encodingError = checkSignatureEncoding(proof.signature);
  if (encodingError) {
    return invalid(encodingError);
  }

  let valid = false;
  try {
    valid = await verifyMessage({
      address: wallet.address as Address,
      message: getWalletMessageToSign(authorKeyAddress, wallet.address, wallet.timestamp),
      signature: proof.signature as Hex
    });
  } catch {
    valid = false;
  }

  if (!valid) {
    return invalid("wallet signature does not prove the wallet belongs to this author");
  }

  return { outcome: "valid", address: getAddress(wallet.address) };
};

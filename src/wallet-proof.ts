import { getAddress, verifyMessage, type Address, type Hex } from "viem";
import { getWalletMessageToSign, isLiteralAddress, WALLET_SIGNATURE_TYPE } from "./contract.js";

export interface AuthorWallet {
  address?: unknown;
  timestamp?: unknown;
  signature?: { signature?: unknown; type?: unknown } | undefined;
}

export type WalletProofResult = { address: Address } | { error: string };

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

// Verifies one entry of `author.wallets` against the key address of the author's signing key.
// pkc-js only checks the entry's shape, so without this anyone could list a wallet they do not control.
//
// Follows the "Author Wallet Proofs" BSIP draft.
//
// Stateless on purpose: no "newest timestamp wins" cache. The proof names the author's key, so only that
// key can publish with it, and a reader can reproduce the check from the entry alone. No RPC either: an
// EIP-191 signature from an ordinary account is checked by recovery.
export const verifyWalletProof = async ({
  wallet,
  authorKeyAddress,
  nowSeconds = Math.floor(Date.now() / 1000)
}: {
  wallet: AuthorWallet | undefined;
  authorKeyAddress: string;
  nowSeconds?: number;
}): Promise<WalletProofResult> => {
  if (typeof wallet !== "object" || wallet === null) {
    return { error: "has no wallet for this chain" };
  }
  if (!isLiteralAddress(wallet.address)) {
    return { error: "wallet address must be a literal 0x address, not a name" };
  }
  if (typeof wallet.timestamp !== "number" || !Number.isInteger(wallet.timestamp) || wallet.timestamp < 0) {
    return { error: "wallet timestamp must be an integer" };
  }
  if (wallet.timestamp > nowSeconds + WALLET_TIMESTAMP_ALLOWANCE_SECONDS) {
    return { error: `wallet timestamp is more than ${WALLET_TIMESTAMP_ALLOWANCE_SECONDS} seconds in the future` };
  }
  if (wallet.signature?.type !== WALLET_SIGNATURE_TYPE) {
    return {
      error: `wallet signature type must be "${WALLET_SIGNATURE_TYPE}", got ${JSON.stringify(wallet.signature?.type)}`
    };
  }
  const signature = wallet.signature.signature;
  const encodingError = checkSignatureEncoding(signature);
  if (encodingError) {
    return { error: encodingError };
  }

  let valid = false;
  try {
    valid = await verifyMessage({
      address: wallet.address as Address,
      message: getWalletMessageToSign(authorKeyAddress, wallet.timestamp),
      signature: signature as Hex
    });
  } catch {
    valid = false;
  }

  if (!valid) {
    return { error: "wallet signature does not prove the wallet belongs to this author" };
  }

  return { address: getAddress(wallet.address) };
};

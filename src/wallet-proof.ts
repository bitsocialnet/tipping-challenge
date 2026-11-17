import { getAddress, verifyMessage, type Address, type Hex } from "viem";
import { getWalletMessageToSign, isLiteralAddress, WALLET_SIGNATURE_TYPE } from "./contract.js";

export interface AuthorWallet {
  address?: unknown;
  timestamp?: unknown;
  signature?: { signature?: unknown; type?: unknown } | undefined;
}

export type WalletProofResult = { address: Address } | { error: string };

// Verifies one `author.wallets[chainTicker]` entry against the key address of the author's signing key.
// pkc-js only checks the entry's shape, so without this anyone could list a wallet they do not control.
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
  if (wallet.timestamp > nowSeconds) {
    return { error: "wallet timestamp is in the future" };
  }
  if (wallet.signature?.type !== WALLET_SIGNATURE_TYPE) {
    return {
      error: `wallet signature type must be "${WALLET_SIGNATURE_TYPE}", got ${JSON.stringify(wallet.signature?.type)}`
    };
  }
  const signature = wallet.signature.signature;
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    return { error: "wallet signature must be a 0x hex string" };
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

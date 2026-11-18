// The tipping/v1 contract: everything a publishing client and a community node have to agree on.
// Nothing in this file touches the network or pkc-js, so a client can import it without pulling in the
// challenge itself.

import { isAddress } from "viem";

export const TIPPING_V1_TOKENS_OPTION = "tipping/v1/tokens";
export const TIPPING_V1_FEE_RECIPIENT_OPTION = "tipping/v1/feeRecipient";

export const WALLET_DOMAIN_SEPARATOR = "bitsocial-author-wallet";
export const WALLET_SIGNATURE_TYPE = "eip191";

export const MAX_TOKENS = 64;

export type TipTokenType = "native" | "erc20" | "erc721";

export interface TipFeePercent {
  percent: string;
}

export interface TipFeeFlat {
  amount: string;
  token?: string;
}

export type TipFee = TipFeePercent | TipFeeFlat;

export interface TipToken {
  // The numeric chain ID, e.g. 1 for Ethereum mainnet. Chains are never named by ticker in this contract:
  // a ticker is a label anyone can reuse, a chain ID is what a wallet and an RPC actually agree on.
  chainId: number;
  type: TipTokenType;
  address?: string;
  minAmount?: string;
  fee?: TipFee;
}

export interface TipClaim {
  chainId: number;
  txHash: string;
  feeTxHash?: string;
}

// What the challenge writes into the tip reply's comment update.
export interface VerifiedTip {
  chainId: number;
  txHash: string;
  type: TipTokenType;
  token?: string;
  from: string;
  to: string;
  amount?: string;
  tokenId?: string;
  fee?: {
    txHash: string;
    to: string;
    amount: string;
    token?: string;
  };
}

const TOKEN_TYPES: readonly TipTokenType[] = ["native", "erc20", "erc721"];
const TOKEN_KEYS = ["chainId", "type", "address", "minAmount", "fee"];
const CLAIM_KEYS = ["chainId", "txHash", "feeTxHash"];

const ADDRESS_REGEXP = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH_REGEXP = /^0x[0-9a-fA-F]{64}$/;
const UNSIGNED_INTEGER_REGEXP = /^(0|[1-9]\d*)$/;
// At most four decimal places, so a percentage is an exact integer once scaled by 10^4.
const PERCENT_REGEXP = /^\d+(\.\d{1,4})?$/;
const PERCENT_SCALE = 10_000n;

// A chain ID is a JSON number, a positive integer. "1" (a string) is not one.
export const isChainId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const CHAIN_ID_HINT = "a positive integer such as 1 for Ethereum mainnet, written as a number, not a string";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A literal address only. An ENS name here would need an RPC to resolve and would change meaning when
// the name is repointed.
export const isLiteralAddress = (value: unknown): value is string =>
  typeof value === "string" && ADDRESS_REGEXP.test(value);

// An address an owner typed into the settings. Mixed case must carry a valid EIP-55 checksum, so one wrong
// character in a token or fee address is caught at edit time instead of sending fees nowhere. All
// lowercase is accepted as pasted from a block explorer.
export const isConfigAddress = (value: unknown): value is string => isLiteralAddress(value) && isAddress(value);

const CONFIG_ADDRESS_HINT = "a 0x address, all lowercase or with a valid checksum";

export const isTxHash = (value: unknown): value is string =>
  typeof value === "string" && TX_HASH_REGEXP.test(value);

const parsePositiveInteger = (value: unknown, where: string): bigint => {
  if (typeof value !== "string" || !UNSIGNED_INTEGER_REGEXP.test(value)) {
    throw new Error(
      `${where} must be a string holding an unsigned integer in the token's smallest unit, got ${JSON.stringify(value)}`
    );
  }
  const parsed = BigInt(value);
  if (parsed === 0n) {
    throw new Error(`${where} must be greater than 0`);
  }
  return parsed;
};

// Returns the percentage scaled by 10^4, so "2.5" is 25000n.
const parsePercent = (value: unknown, where: string): bigint => {
  if (typeof value !== "string" || !PERCENT_REGEXP.test(value)) {
    throw new Error(
      `${where} must be a string holding a percentage with at most 4 decimal places (e.g. "2.5"), got ${JSON.stringify(value)}`
    );
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const scaled = BigInt(whole) * PERCENT_SCALE + BigInt(fraction.padEnd(4, "0"));
  if (scaled === 0n) {
    throw new Error(`${where} must be greater than 0. Leave fee out to charge nothing`);
  }
  if (scaled > 100n * PERCENT_SCALE) {
    throw new Error(`${where} must not exceed 100`);
  }
  return scaled;
};

const parseFee = (fee: unknown, type: TipTokenType, where: string): TipFee => {
  if (!isPlainObject(fee)) {
    throw new Error(`${where} must be an object: {"percent": "2.5"} or {"amount": "1000"}`);
  }
  for (const key of Object.keys(fee)) {
    if (key !== "percent" && key !== "amount" && key !== "token") {
      throw new Error(`${where} has an unknown key "${key}"`);
    }
  }

  const hasPercent = fee["percent"] !== undefined;
  const hasAmount = fee["amount"] !== undefined;
  if (hasPercent === hasAmount) {
    throw new Error(`${where} must have exactly one of "percent" or "amount"`);
  }

  if (hasPercent) {
    if (type === "erc721") {
      throw new Error(`${where}.percent is not possible for an erc721 token: an NFT cannot be split. Use a flat "amount"`);
    }
    if (fee["token"] !== undefined) {
      throw new Error(`${where}.token is only for a flat erc721 fee: a percentage is paid in the tipped token`);
    }
    parsePercent(fee["percent"], `${where}.percent`);
    return { percent: fee["percent"] as string };
  }

  parsePositiveInteger(fee["amount"], `${where}.amount`);

  if (type === "erc721") {
    if (!isConfigAddress(fee["token"])) {
      throw new Error(
        `${where}.token is required for an erc721 token and must be the address of the ERC-20 the fee is paid in: ${CONFIG_ADDRESS_HINT}`
      );
    }
    return { amount: fee["amount"] as string, token: fee["token"] };
  }

  if (fee["token"] !== undefined) {
    throw new Error(`${where}.token is only for an erc721 token: a ${type} fee is paid in the tipped token`);
  }
  return { amount: fee["amount"] as string };
};

export const tokenKey = (token: Pick<TipToken, "chainId" | "type" | "address">): string =>
  `${token.chainId}\n${token.type === "native" ? "native" : (token.address ?? "").toLowerCase()}`;

// Parses and fully validates the tipping/v1/tokens option. Throws an Error written for a community owner.
// The challenge uses this both when settings are saved and on every request, so a list accepted at edit
// time can never be read differently later.
export const parseTipTokens = (raw: string | undefined): TipToken[] => {
  const option = TIPPING_V1_TOKENS_OPTION;
  if (raw === undefined) {
    throw new Error(`${option} is required`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${option} is not valid JSON: ${(e as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${option} must be a JSON array of token entries`);
  }
  if (parsed.length === 0) {
    throw new Error(`${option} must list at least one token`);
  }
  if (parsed.length > MAX_TOKENS) {
    throw new Error(`${option} has ${parsed.length} entries, the maximum is ${MAX_TOKENS}`);
  }

  const seen = new Map<string, number>();

  return parsed.map((entry, index): TipToken => {
    const where = `${option}[${index}]`;
    if (!isPlainObject(entry)) {
      throw new Error(`${where} must be an object`);
    }
    if (entry["chainTicker"] !== undefined) {
      throw new Error(
        `${where} uses chainTicker. tipping/v1 identifies a chain by its numeric chainId only (${CHAIN_ID_HINT})`
      );
    }
    for (const key of Object.keys(entry)) {
      if (!TOKEN_KEYS.includes(key)) {
        throw new Error(`${where} has an unknown key "${key}". Known keys: ${TOKEN_KEYS.join(", ")}`);
      }
    }

    const { chainId, type, address, minAmount, fee } = entry;

    if (!isChainId(chainId)) {
      throw new Error(`${where}.chainId must be ${CHAIN_ID_HINT}, got ${JSON.stringify(chainId)}`);
    }
    if (typeof type !== "string" || !(TOKEN_TYPES as readonly string[]).includes(type)) {
      throw new Error(`${where}.type must be one of ${TOKEN_TYPES.join(", ")}, got ${JSON.stringify(type)}`);
    }
    const tokenType = type as TipTokenType;

    const token: TipToken = { chainId, type: tokenType };

    if (tokenType === "native") {
      if (address !== undefined) {
        throw new Error(`${where}.address must be left out for the native coin`);
      }
    } else {
      if (!isConfigAddress(address)) {
        throw new Error(
          `${where}.address must be the token contract's address (${CONFIG_ADDRESS_HINT}), got ${JSON.stringify(address)}`
        );
      }
      token.address = address;
    }

    if (minAmount !== undefined) {
      if (tokenType === "erc721") {
        throw new Error(`${where}.minAmount is not possible for an erc721 token: a tip is always one NFT`);
      }
      parsePositiveInteger(minAmount, `${where}.minAmount`);
      token.minAmount = minAmount as string;
    }

    if (fee !== undefined) {
      token.fee = parseFee(fee, tokenType, `${where}.fee`);
    }

    const key = tokenKey(token);
    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) {
      throw new Error(`${where} is the same token as entry ${firstIndex}: list each token once`);
    }
    seen.set(key, index);

    return token;
  });
};

export const tokensHaveFee = (tokens: readonly TipToken[]): boolean => tokens.some((token) => token.fee !== undefined);

// The fee a tip of `amount` owes under `token`'s rule. Percentages round down. `feeToken` undefined means
// the fee is paid in the chain's native coin. Returns undefined when nothing is owed.
export const getRequiredFee = (
  token: TipToken,
  amount: bigint
): { amount: bigint; feeToken: string | undefined } | undefined => {
  const fee = token.fee;
  if (!fee) return undefined;

  if ("percent" in fee) {
    const owed = (amount * parsePercent(fee.percent, "fee.percent")) / (100n * PERCENT_SCALE);
    if (owed === 0n) return undefined;
    return { amount: owed, feeToken: token.address };
  }

  return {
    amount: BigInt(fee.amount),
    feeToken: token.type === "erc721" ? fee.token : token.address
  };
};

// Parses the challenge answer a client sends as its tip claim: the JSON text of
// `{ chainId, txHash, feeTxHash? }`. Challenge answers are strings, so the object travels serialised.
export const parseTipClaimAnswer = (answer: string): TipClaim => {
  let value: unknown;
  try {
    value = JSON.parse(answer);
  } catch {
    throw new Error("the tip claim must be JSON text: { chainId, txHash, feeTxHash? }");
  }
  return parseTipClaim(value);
};

// Validates a tip claim object. Throws an Error written for the author.
// Unknown keys are refused: the challenge writes its verified result under the same name in the comment
// update, and a claim must not be able to carry fields that look like that result.
export const parseTipClaim = (value: unknown): TipClaim => {
  if (!isPlainObject(value)) {
    throw new Error("tip must be an object: { chainId, txHash, feeTxHash? }");
  }
  if (value["chainTicker"] !== undefined) {
    throw new Error(`tip uses chainTicker. A tip claim names its chain by numeric chainId only (${CHAIN_ID_HINT})`);
  }
  for (const key of Object.keys(value)) {
    if (!CLAIM_KEYS.includes(key)) {
      throw new Error(`tip has an unknown key "${key}". A tip claim only carries ${CLAIM_KEYS.join(", ")}`);
    }
  }
  const { chainId, txHash, feeTxHash } = value;
  if (!isChainId(chainId)) {
    throw new Error(`tip.chainId must be ${CHAIN_ID_HINT}`);
  }
  if (!isTxHash(txHash)) {
    throw new Error("tip.txHash must be a transaction hash: 0x followed by 64 hex characters");
  }
  if (feeTxHash !== undefined && !isTxHash(feeTxHash)) {
    throw new Error("feeTxHash must be a transaction hash: 0x followed by 64 hex characters");
  }

  const claim: TipClaim = { chainId, txHash: txHash.toLowerCase() };
  if (feeTxHash !== undefined) claim.feeTxHash = feeTxHash.toLowerCase();
  return claim;
};

// The exact string an author's wallet signs (EIP-191) to prove it belongs to that author. Built by hand:
// the field order and the absence of whitespace are part of the format.
export const getWalletMessageToSign = (authorPublicKey: string, timestamp: number): string =>
  `{"domainSeparator":"${WALLET_DOMAIN_SEPARATOR}","authorPublicKey":"${authorPublicKey}","timestamp":${timestamp}}`;

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const base58Encode = (bytes: Uint8Array): string => {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = "1" + encoded;
  }
  return encoded;
};

// identity multihash (0x00, length 0x24) of the libp2p protobuf for an ed25519 public key
// (0x08 0x01 = key type ed25519, 0x12 0x20 = 32 bytes of key data).
const ED25519_PEER_ID_PREFIX = [0x00, 0x24, 0x08, 0x01, 0x12, 0x20];

// The key address ("12D3KooW...") of an author's signing key: the libp2p PeerId of the ed25519 public
// key found in `signature.publicKey`. This is the identity a wallet proof is bound to. It is never
// `author.address`, which is `author.name || keyAddress` and follows a name when the name is repointed.
export const getKeyAddressFromPublicKey = (publicKeyBase64: string): string => {
  if (typeof publicKeyBase64 !== "string") {
    throw new Error("public key must be a base64 string");
  }
  const publicKey = Uint8Array.from(Buffer.from(publicKeyBase64, "base64"));
  if (publicKey.length !== 32) {
    throw new Error(`public key must be 32 bytes of ed25519 key, got ${publicKey.length} bytes`);
  }
  return base58Encode(Uint8Array.from([...ED25519_PEER_ID_PREFIX, ...publicKey]));
};

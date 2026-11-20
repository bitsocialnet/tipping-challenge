import { concat, custom, numberToHex, pad, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { _setTransportFactoryForTests } from "../src/chain.js";
import {
  getKeyAddressFromPublicKey,
  getParentBindingSuffix,
  getWalletMessageToSign,
  TIPPING_V1_FEE_RECIPIENT_OPTION,
  TIPPING_V1_TOKENS_OPTION,
  type TipToken
} from "../src/contract.js";
import type { CommunityChallengeSetting, GetChallengeArgsInput } from "../src/types.js";

// --- a fake chain, served through a real viem client ------------------------------------------------

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface FakeLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

export interface FakeTx {
  from: Address;
  to: Address | null;
  value?: bigint;
  status?: "success" | "reverted";
  // The transaction's calldata. Left out, it is the parent binding for PARENT_CID alone, which is what a
  // native tip on the default parent carries. Set it to test a missing or a different binding.
  input?: Hex;
  logs?: FakeLog[];
}

export class FakeChain {
  txs = new Map<string, FakeTx>();
  requests: string[] = [];
  failWith: Error | undefined;
  // What this RPC answers to eth_chainId. Left undefined, it reports whichever chain ID it was asked to
  // serve, like a correctly configured endpoint. Set it to make the endpoint sit on the wrong chain.
  reportChainId: number | undefined;
  failChainId: Error | undefined;
  private nextBlock = 100;
  private blockOf = new Map<string, number>();

  add(hash: string, tx: FakeTx): string {
    this.txs.set(hash.toLowerCase(), tx);
    this.blockOf.set(hash.toLowerCase(), this.nextBlock++);
    return hash;
  }

  private request = async (
    { method, params }: { method: string; params?: unknown },
    servedChainId: number
  ): Promise<unknown> => {
    this.requests.push(method);
    if (method === "eth_chainId") {
      if (this.failChainId) throw this.failChainId;
      return numberToHex(this.reportChainId ?? servedChainId);
    }
    if (this.failWith) throw this.failWith;
    const args = (params ?? []) as unknown[];

    if (method === "eth_getTransactionReceipt") {
      const hash = (args[0] as string).toLowerCase();
      const tx = this.txs.get(hash);
      if (!tx) return null;
      const blockNumber = numberToHex(this.blockOf.get(hash)!);
      return {
        transactionHash: hash,
        transactionIndex: "0x0",
        blockHash: pad("0xb1", { size: 32 }),
        blockNumber,
        from: tx.from,
        to: tx.to,
        contractAddress: null,
        cumulativeGasUsed: "0x5208",
        gasUsed: "0x5208",
        effectiveGasPrice: "0x1",
        logsBloom: pad("0x0", { size: 256 }),
        status: tx.status === "reverted" ? "0x0" : "0x1",
        type: "0x2",
        logs: (tx.logs ?? []).map((log, index) => ({
          ...log,
          blockHash: pad("0xb1", { size: 32 }),
          blockNumber,
          logIndex: numberToHex(index),
          transactionHash: hash,
          transactionIndex: "0x0",
          removed: false
        }))
      };
    }

    if (method === "eth_getTransactionByHash") {
      const hash = (args[0] as string).toLowerCase();
      const tx = this.txs.get(hash);
      if (!tx) return null;
      return {
        hash,
        blockHash: pad("0xb1", { size: 32 }),
        blockNumber: numberToHex(this.blockOf.get(hash)!),
        transactionIndex: "0x0",
        from: tx.from,
        to: tx.to,
        value: numberToHex(tx.value ?? 0n),
        gas: "0x5208",
        gasPrice: "0x1",
        maxFeePerGas: "0x1",
        maxPriorityFeePerGas: "0x1",
        nonce: "0x0",
        input: tx.input ?? getParentBindingSuffix(PARENT_CID),
        type: "0x2",
        chainId: "0x1",
        accessList: [],
        v: "0x0",
        r: pad("0x1", { size: 32 }),
        s: pad("0x1", { size: 32 }),
        yParity: "0x0"
      };
    }

    throw new Error(`FakeChain: unexpected RPC method ${method}`);
  };

  install(): void {
    _setTransportFactoryForTests(({ chainId }) =>
      custom({ request: (args: { method: string; params?: unknown }) => this.request(args, chainId) }, { retryCount: 0 })
    );
  }
}

export const uninstallFakeChain = (): void => _setTransportFactoryForTests(undefined);

const addressTopic = (address: Address): Hex => pad(address.toLowerCase() as Hex, { size: 32 });

export const erc20Transfer = (token: Address, from: Address, to: Address, amount: bigint): FakeLog => ({
  address: token,
  topics: [TRANSFER_TOPIC, addressTopic(from), addressTopic(to)],
  data: pad(numberToHex(amount), { size: 32 })
});

export const erc721Transfer = (token: Address, from: Address, to: Address, tokenId: bigint): FakeLog => ({
  address: token,
  topics: [TRANSFER_TOPIC, addressTopic(from), addressTopic(to), pad(numberToHex(tokenId), { size: 32 })],
  data: "0x"
});

let hashCounter = 0;
export const newTxHash = (): string => pad(numberToHex(++hashCounter + 0xabc000), { size: 32 });

// --- authors -------------------------------------------------------------------------------------------

// Throwaway keys for tests only. They hold nothing and are never used on a real chain.
const testPrivateKey = (seed: number): Hex => pad(numberToHex(seed), { size: 32 });

export interface TestAuthor {
  // base64 ed25519 public key, as found in signature.publicKey
  publicKey: string;
  keyAddress: string;
  wallet: ReturnType<typeof privateKeyToAccount>;
}

export const makeAuthor = (seed: number): TestAuthor => {
  const publicKey = Buffer.from(new Uint8Array(32).fill(seed)).toString("base64");
  return {
    publicKey,
    keyAddress: getKeyAddressFromPublicKey(publicKey),
    wallet: privateKeyToAccount(testPrivateKey(seed + 1000))
  };
};

export const WALLET_TIMESTAMP = 1_700_000_000;

export const signWallet = async (
  author: TestAuthor,
  overrides: { message?: string; timestamp?: number; type?: string; address?: string } = {}
) => {
  const timestamp = overrides.timestamp ?? WALLET_TIMESTAMP;
  const signature = await author.wallet.signMessage({
    message: overrides.message ?? getWalletMessageToSign(author.keyAddress, author.wallet.address, timestamp)
  });
  return {
    address: overrides.address ?? author.wallet.address,
    timestamp,
    signature: { signature, type: overrides.type ?? "eip191" }
  };
};

// --- community and request ----------------------------------------------------------------------------

export const PARENT_CID = "QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR";
export const PARENT_TIMESTAMP = 1_750_000_000;
export const AFTER_PARENT = PARENT_TIMESTAMP + 600;

// Calldata that ends with the parent binding for `parentCid`, after `callData` if there is any.
export const withBinding = (parentCid: string = PARENT_CID, callData: Hex = "0x"): Hex =>
  concat([callData, getParentBindingSuffix(parentCid)]);

export interface FakeCommunity {
  publicKey: string;
  address: string;
  comments: Map<string, unknown>;
  landedSignatures: Set<string>;
  storage: Map<string, unknown>;
  asCommunity(): GetChallengeArgsInput["community"];
}

export const makeCommunity = (publicKey = "12D3KooWCommunityOne", storage = new Map<string, unknown>()): FakeCommunity => {
  const comments = new Map<string, unknown>();
  const landedSignatures = new Set<string>();
  const fake = {
    publicKey,
    address: "community.bso",
    comments,
    landedSignatures,
    storage,
    asCommunity: () =>
      ({
        publicKey,
        address: "community.bso",
        _dbHandler: {
          queryComment: (cid: string) => comments.get(cid),
          queryCommentBySignatureEncoded: (signature: string) =>
            landedSignatures.has(signature) ? { cid: "landed" } : undefined
        },
        _pkc: {
          _createStorageLRU: async () => ({
            getItem: async (key: string) => storage.get(key),
            setItem: async (key: string, value: unknown) => {
              storage.set(key, value);
            }
          })
        }
      }) as unknown as GetChallengeArgsInput["community"]
  };
  return fake;
};

export const addParentComment = async (
  community: FakeCommunity,
  author: TestAuthor,
  options: { wallets?: Record<string, unknown> | null; walletKey?: string; cid?: string; timestamp?: number } = {}
): Promise<void> => {
  const wallets =
    options.wallets === null
      ? undefined
      : (options.wallets ?? { [options.walletKey ?? "eth"]: await signWallet(author) });
  community.comments.set(options.cid ?? PARENT_CID, {
    cid: options.cid ?? PARENT_CID,
    timestamp: options.timestamp ?? PARENT_TIMESTAMP,
    author: { displayName: "recipient", ...(wallets ? { wallets } : {}) },
    signature: { type: "ed25519", signature: "parentSignature", publicKey: author.publicKey, signedPropertyNames: [] }
  });
};

let publicationCounter = 0;

export const makeRequest = async (
  author: TestAuthor,
  options: {
    // The tip claim. It travels as the pre-answer of the tipping challenge, as JSON text.
    tip?: unknown;
    // A pre-answer sent verbatim, for text that is not the JSON of a claim.
    rawAnswer?: string;
    parentCid?: string | null;
    wallets?: Record<string, unknown> | null;
    // The key the author's wallet entry sits under. tipping/v1 does not read it.
    walletKey?: string;
    signature?: string;
  } = {}
): Promise<GetChallengeArgsInput["challengeRequestMessage"]> => {
  const wallets =
    options.wallets === null
      ? undefined
      : (options.wallets ?? { [options.walletKey ?? "eth"]: await signWallet(author) });
  const comment: Record<string, unknown> = {
    content: "great post",
    timestamp: AFTER_PARENT,
    communityPublicKey: "communityPublicKey",
    protocolVersion: "1.0.0",
    author: {
      address: author.keyAddress,
      publicKey: author.keyAddress,
      ...(wallets ? { wallets } : {})
    },
    signature: {
      type: "ed25519",
      signature: options.signature ?? `publicationSignature${++publicationCounter}`,
      publicKey: author.publicKey,
      signedPropertyNames: ["content", "timestamp", "author", "parentCid"]
    }
  };
  if (options.parentCid !== null) comment["parentCid"] = options.parentCid ?? PARENT_CID;
  const answer = options.rawAnswer ?? (options.tip !== undefined ? JSON.stringify(options.tip) : undefined);
  return {
    comment,
    // Pre-answers are keyed by challenge index as a decimal string. The tipping challenge is index 0.
    ...(answer !== undefined ? { challengeAnswers: { "0": answer } } : {})
  } as unknown as GetChallengeArgsInput["challengeRequestMessage"];
};

export const buildSettings = (params: {
  tokens?: TipToken[] | string;
  feeRecipient?: string;
  rpcUrls?: string;
  publicOptions?: string[];
}): CommunityChallengeSetting => {
  const options: Record<string, string> = {};
  if (params.tokens !== undefined) {
    options[TIPPING_V1_TOKENS_OPTION] = typeof params.tokens === "string" ? params.tokens : JSON.stringify(params.tokens);
  }
  if (params.feeRecipient !== undefined) options[TIPPING_V1_FEE_RECIPIENT_OPTION] = params.feeRecipient;
  if (params.rpcUrls !== undefined) options["rpcUrls"] = params.rpcUrls;

  return {
    name: "@bitsocial/tipping-challenge",
    options,
    publicOptions:
      params.publicOptions ??
      (params.feeRecipient !== undefined
        ? [TIPPING_V1_TOKENS_OPTION, TIPPING_V1_FEE_RECIPIENT_OPTION]
        : [TIPPING_V1_TOKENS_OPTION])
  } as CommunityChallengeSetting;
};

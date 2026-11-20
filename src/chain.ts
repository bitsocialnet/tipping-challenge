import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport
} from "viem";
import {
  arbitrum,
  avalanche,
  base,
  blast,
  bsc,
  celo,
  fantom,
  gnosis,
  linea,
  mainnet,
  optimism,
  polygon,
  scroll,
  zksync
} from "viem/chains";

// The chains viem ships a public RPC for. viem's http() transport has no default RPC unless the client
// is given a chain, so a chain ID outside this map has no default and must come with rpcUrls.
const builtInChains: readonly Chain[] = [
  mainnet,
  optimism,
  bsc,
  gnosis,
  polygon,
  fantom,
  zksync,
  base,
  arbitrum,
  celo,
  avalanche,
  linea,
  blast,
  scroll
];

const chainsById = new Map<number, Chain>(builtInChains.map((chain) => [chain.id, chain]));

export const knownChainIds: readonly number[] = [...chainsById.keys()].sort((a, b) => a - b);

export const getChainFromId = (chainId: number): Chain | undefined => chainsById.get(chainId);

const describeKnownChains = (): string => builtInChains.map((chain) => `${chain.id} (${chain.name})`).join(", ");

export const rpcUrlsRequiredMessage = (chainId: number): string =>
  `option rpcUrls is required for chain ID ${chainId}: it has no built-in RPC. ` +
  `Chain IDs with a built-in RPC are: ${describeKnownChains()}.`;

const splitUrls = (urls: string): string[] =>
  urls
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

const CHAIN_ID_KEY_REGEXP = /^[1-9]\d*$/;

// The rpcUrls option is either a JSON object mapping a chain ID (as a string key, since JSON keys are
// strings) to a comma-separated list of URLs, or a plain comma-separated list. The plain list names no
// chain, so it is only allowed when every token is on one chain ID.
export const parseRpcUrls = (rpcUrls: string | undefined): { all: string[]; byChainId: Map<number, string[]> } => {
  const byChainId = new Map<number, string[]>();
  const trimmed = (rpcUrls ?? "").trim();
  if (!trimmed) return { all: [], byChainId };

  if (!trimmed.startsWith("{")) return { all: splitUrls(trimmed), byChainId };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`option rpcUrls looks like a JSON object but is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("option rpcUrls must be a JSON object of chain ID to URLs, or a comma-separated list of URLs");
  }

  for (const [key, urls] of Object.entries(parsed)) {
    if (!CHAIN_ID_KEY_REGEXP.test(key) || !Number.isSafeInteger(Number(key))) {
      throw new Error(`option rpcUrls has the key "${key}", which is not a chain ID. Keys are chain IDs such as "1"`);
    }
    if (typeof urls !== "string") {
      throw new Error(`option rpcUrls["${key}"] must be a string of comma-separated URLs`);
    }
    byChainId.set(Number(key), splitUrls(urls));
  }
  return { all: [], byChainId };
};

export const getRpcUrlsForChain = (rpcUrls: string | undefined, chainId: number): string[] => {
  const { all, byChainId } = parseRpcUrls(rpcUrls);
  return byChainId.get(chainId) ?? all;
};

type TransportFactory = (args: { chainId: number; urls: string[] }) => Transport;

const defaultTransportFactory: TransportFactory = ({ urls }) =>
  urls.length === 0
    ? http()
    : urls.length === 1
      ? http(urls[0])
      : fallback(
          urls.map((url) => http(url)),
          { rank: true }
        );

let transportFactory: TransportFactory = defaultTransportFactory;

// Clients are cached per (chain ID, urls): fallback(..., { rank: true }) starts a background interval
// that is never torn down, so building a client per request would leak a timer per publish.
const clientCache = new Map<string, PublicClient>();

// Clients whose RPC has reported the chain ID they were built for. Only a confirmation is remembered: a
// failed or mismatched check is repeated on the next tip, so an owner who fixes the endpoint, or an
// endpoint that comes back, recovers without a restart.
const confirmedClients = new WeakSet<PublicClient>();

// Test seam. Not re-exported from index.ts, so it is not part of the package's public API.
export const _setTransportFactoryForTests = (factory: TransportFactory | undefined): void => {
  transportFactory = factory ?? defaultTransportFactory;
  clientCache.clear();
};

const getChainClient = (rpcUrls: string | undefined, chainId: number): PublicClient => {
  const urls = getRpcUrlsForChain(rpcUrls, chainId);
  const chain = getChainFromId(chainId);

  if (urls.length === 0 && !chain) {
    throw new Error(rpcUrlsRequiredMessage(chainId));
  }

  const cacheKey = `${chainId}\n${urls.join(",")}`;
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;

  const client = createPublicClient({ chain, transport: transportFactory({ chainId, urls }) });
  clientCache.set(cacheKey, client);
  return client;
};

export class ChainIdMismatchError extends Error {
  constructor(expected: number, reported: number) {
    super(
      `The RPC configured for chain ID ${expected} reports chain ID ${reported}. ` +
        `The community's rpcUrls point at the wrong chain, so the tip cannot be verified.`
    );
    this.name = "ChainIdMismatchError";
  }
}

// The only way to get a client for reading transactions. It returns one only after the RPC behind it has
// answered eth_chainId with the expected ID, so a transfer is never verified on another chain: a chain
// where the same token address or the same transaction hash means something else, or nothing.
export const getConfirmedChainClient = async (rpcUrls: string | undefined, chainId: number): Promise<PublicClient> => {
  const client = getChainClient(rpcUrls, chainId);
  if (confirmedClients.has(client)) return client;

  const reported = await client.getChainId();
  if (reported !== chainId) {
    throw new ChainIdMismatchError(chainId, reported);
  }
  confirmedClients.add(client);
  return client;
};

// keccak256("Transfer(address,address,uint256)"), shared by ERC-20 and ERC-721.
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface TokenTransfer {
  logIndex: number;
  token: Address;
  kind: "erc20" | "erc721";
  from: Address;
  to: Address;
  // The amount for erc20, the token ID for erc721.
  value: bigint;
}

export interface MinedTransaction {
  hash: string;
  succeeded: boolean;
  // The account that sent the transaction and signed its input.
  from: Address;
  to: Address | null;
  // Native coin sent by the transaction itself.
  value: bigint;
  // The transaction's calldata. The parent binding is read from its end.
  input: Hex;
  transfers: TokenTransfer[];
}

const topicToAddress = (topic: Hex): Address => getAddress(`0x${topic.slice(-40)}`);

const decodeTransfers = (
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex; logIndex: number | null }[]
): TokenTransfer[] => {
  const transfers: TokenTransfer[] = [];
  for (const log of logs) {
    const [topic0, fromTopic, toTopic, idTopic] = log.topics;
    if (topic0?.toLowerCase() !== TRANSFER_TOPIC || !fromTopic || !toTopic || log.logIndex === null) continue;

    // ERC-20 indexes two arguments and puts the amount in data. ERC-721 indexes all three, the token ID
    // included, and has no data. Any other shape is not a standard transfer and is ignored.
    if (log.topics.length === 3 && log.data.length === 66) {
      transfers.push({
        logIndex: log.logIndex,
        token: getAddress(log.address),
        kind: "erc20",
        from: topicToAddress(fromTopic),
        to: topicToAddress(toTopic),
        value: BigInt(log.data)
      });
    } else if (log.topics.length === 4 && idTopic) {
      transfers.push({
        logIndex: log.logIndex,
        token: getAddress(log.address),
        kind: "erc721",
        from: topicToAddress(fromTopic),
        to: topicToAddress(toTopic),
        value: BigInt(idTopic)
      });
    }
  }
  return transfers;
};

// Reads everything the challenge needs about one transaction. Returns undefined when the transaction is
// not mined yet. Any other RPC failure throws. `client` must come from getConfirmedChainClient.
export const readTransaction = async ({
  client,
  hash
}: {
  client: PublicClient;
  hash: string;
}): Promise<MinedTransaction | undefined> => {
  let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: hash as Hex });
  } catch (e) {
    if (e instanceof TransactionReceiptNotFoundError) return undefined;
    throw e;
  }

  // The receipt has no calldata, and the parent binding is read from it, so the transaction is always
  // fetched too.
  let transaction: Awaited<ReturnType<PublicClient["getTransaction"]>>;
  try {
    transaction = await client.getTransaction({ hash: hash as Hex });
  } catch (e) {
    if (e instanceof TransactionNotFoundError) return undefined;
    throw e;
  }

  return {
    hash,
    succeeded: receipt.status === "success",
    from: getAddress(receipt.from),
    to: receipt.to ? getAddress(receipt.to) : null,
    value: transaction.value,
    input: transaction.input,
    transfers: decodeTransfers(receipt.logs)
  };
};

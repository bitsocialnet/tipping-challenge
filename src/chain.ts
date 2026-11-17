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

// chainTicker is free-form in pkc-js, so this map is ours to own and will always be partial. viem's
// http() transport has no default RPC unless the client is given a chain, so a ticker outside this map
// has no default and must come with rpcUrls.
const chainsByTicker: Record<string, Chain> = {
  eth: mainnet,
  matic: polygon,
  pol: polygon,
  op: optimism,
  arb: arbitrum,
  base: base,
  avax: avalanche,
  bnb: bsc,
  bsc: bsc,
  gno: gnosis,
  xdai: gnosis,
  celo: celo,
  ftm: fantom,
  linea: linea,
  scroll: scroll,
  zksync: zksync,
  blast: blast
};

export const knownChainTickers = Object.keys(chainsByTicker);

// hasOwnProperty rather than a bare index, so a chainTicker of "constructor" or "toString" does not
// resolve to an inherited function and read as "this ticker has a built-in RPC".
export const getChainFromTicker = (chainTicker: string): Chain | undefined =>
  Object.prototype.hasOwnProperty.call(chainsByTicker, chainTicker) ? chainsByTicker[chainTicker] : undefined;

const splitUrls = (urls: string): string[] =>
  urls
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

// The rpcUrls option is either a comma-separated list of URLs, which applies to every chain in the token
// list (so it only makes sense with one chain), or a JSON object mapping a chainTicker to such a list.
export const parseRpcUrls = (rpcUrls: string | undefined): { all: string[]; byChain: Record<string, string[]> } => {
  const trimmed = (rpcUrls ?? "").trim();
  if (!trimmed) return { all: [], byChain: {} };

  if (!trimmed.startsWith("{")) return { all: splitUrls(trimmed), byChain: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`option rpcUrls looks like a JSON object but is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("option rpcUrls must be a comma-separated list of URLs or a JSON object of chainTicker to URLs");
  }

  const byChain: Record<string, string[]> = {};
  for (const [chainTicker, urls] of Object.entries(parsed)) {
    if (typeof urls !== "string") {
      throw new Error(`option rpcUrls["${chainTicker}"] must be a string of comma-separated URLs`);
    }
    byChain[chainTicker] = splitUrls(urls);
  }
  return { all: [], byChain };
};

export const getRpcUrlsForChain = (rpcUrls: string | undefined, chainTicker: string): string[] => {
  const { all, byChain } = parseRpcUrls(rpcUrls);
  return Object.prototype.hasOwnProperty.call(byChain, chainTicker) ? (byChain[chainTicker] ?? []) : all;
};

type TransportFactory = (args: { chainTicker: string; urls: string[] }) => Transport;

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

// Clients are cached per (chainTicker, urls): fallback(..., { rank: true }) starts a background interval
// that is never torn down, so building a client per request would leak a timer per publish.
const clientCache = new Map<string, PublicClient>();

// Test seams. Not re-exported from index.ts, so they are not part of the package's public API.
export const _setTransportFactoryForTests = (factory: TransportFactory | undefined): void => {
  transportFactory = factory ?? defaultTransportFactory;
  clientCache.clear();
};

export const getChainClient = (rpcUrls: string | undefined, chainTicker: string): PublicClient => {
  const urls = getRpcUrlsForChain(rpcUrls, chainTicker);
  const chain = getChainFromTicker(chainTicker);

  if (urls.length === 0 && !chain) {
    throw new Error(
      `option rpcUrls is required for chainTicker "${chainTicker}": it has no built-in RPC. ` +
        `Tickers with a built-in RPC are: ${knownChainTickers.join(", ")}.`
    );
  }

  const cacheKey = `${chainTicker}\n${urls.join(",")}`;
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;

  const client = createPublicClient({ chain, transport: transportFactory({ chainTicker, urls }) });
  clientCache.set(cacheKey, client);
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
  blockTimestamp: bigint;
  from: Address;
  to: Address | null;
  // Native coin sent by the transaction itself. Only read when asked for, since it costs a third request.
  value: bigint | undefined;
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
// not mined yet. Any other RPC failure throws.
export const readTransaction = async ({
  client,
  hash,
  withValue
}: {
  client: PublicClient;
  hash: string;
  withValue: boolean;
}): Promise<MinedTransaction | undefined> => {
  let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: hash as Hex });
  } catch (e) {
    if (e instanceof TransactionReceiptNotFoundError) return undefined;
    throw e;
  }

  const block = await client.getBlock({ blockNumber: receipt.blockNumber });

  let value: bigint | undefined;
  if (withValue) {
    try {
      value = (await client.getTransaction({ hash: hash as Hex })).value;
    } catch (e) {
      if (e instanceof TransactionNotFoundError) return undefined;
      throw e;
    }
  }

  return {
    hash,
    succeeded: receipt.status === "success",
    blockTimestamp: block.timestamp,
    from: getAddress(receipt.from),
    to: receipt.to ? getAddress(receipt.to) : null,
    value,
    transfers: decodeTransfers(receipt.logs)
  };
};

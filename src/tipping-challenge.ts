import { getAddress, type Address, type PublicClient } from "viem";
import type {
  ChallengeFileInput,
  ChallengeInput,
  ChallengeResultInput,
  CommunityChallengeSetting,
  GetChallengeArgsInput,
  LocalCommunity
} from "./types.js";
import {
  getKeyAddressFromPublicKey,
  getRequiredFee,
  hasParentBinding,
  isConfigAddress,
  parseTipClaimAnswer,
  parseTipTokens,
  TIPPING_V1_FEE_RECIPIENT_OPTION,
  TIPPING_V1_TOKENS_OPTION,
  tokensHaveFee,
  type TipClaim,
  type TipToken,
  type VerifiedTip
} from "./contract.js";
import {
  ChainIdMismatchError,
  getChainFromId,
  getConfirmedChainClient,
  getRpcUrlsForChain,
  parseRpcUrls,
  readTransaction,
  rpcUrlsRequiredMessage,
  type MinedTransaction,
  type TokenTransfer
} from "./chain.js";
import { verifyWalletProof, type AuthorWallet } from "./wallet-proof.js";

const description =
  "Verifies tips attached to replies. A reply that claims a tip must point at a real transfer from the author's wallet to the wallet of the author being replied to. Replies without a tip are not affected.";

const type: ChallengeInput["type"] = "text/plain";

const optionInputs: NonNullable<ChallengeFileInput["optionInputs"]> = [
  {
    option: TIPPING_V1_TOKENS_OPTION,
    label: "Tokens",
    default: "",
    description:
      "JSON array of the tokens accepted as tips. Each entry has chainId (the numeric chain ID, e.g. 1 for Ethereum mainnet), type (native, erc20 or erc721), address (not for native), and optionally minAmount and fee. Amounts are strings in the token's smallest unit. Must be listed in publicOptions so clients can offer the right tokens. The key names the tipping/v1 contract rather than this package.",
    placeholder:
      '[{"chainId":1,"type":"native"},{"chainId":1,"type":"erc20","address":"0x...","minAmount":"1000000","fee":{"percent":"2.5"}}]',
    required: true
  },
  {
    option: TIPPING_V1_FEE_RECIPIENT_OPTION,
    label: "Fee recipient",
    default: "",
    description:
      "The 0x address that receives the community fee. Required, and must be listed in publicOptions, when any token has a fee. Leave out to charge no fee.",
    placeholder: "0x..."
  },
  {
    // Not namespaced: the tipping/v1 namespace covers what a publishing client has to read, and no client
    // reads this. Only the community node talks to these endpoints.
    option: "rpcUrls",
    label: "RPC URLs",
    default: "",
    description:
      'JSON object mapping a chain ID to comma-separated JSON-RPC URLs, e.g. {"1":"https://a,https://b","8453":"https://c"}. A plain comma-separated list is also accepted when every token is on the same chain ID. Optional for a chain ID with a built-in RPC, required otherwise. Recommended even when optional: the built-in RPC is shared and rate-limited. Each endpoint must report the chain ID it is listed under.',
    placeholder: '{"1":"https://eth.llamarpc.com,https://rpc.ankr.com/eth"}'
  }
];

interface ParsedSettings {
  tokens: TipToken[];
  feeRecipient: Address | undefined;
  rpcUrls: string | undefined;
}

const parseFeeRecipient = (feeRecipient: string | undefined, tokens: readonly TipToken[]): Address | undefined => {
  if (feeRecipient === undefined || feeRecipient === "") {
    if (tokensHaveFee(tokens)) {
      throw new Error(
        `${TIPPING_V1_FEE_RECIPIENT_OPTION} is required because at least one token has a fee: without it there is nowhere to pay the fee`
      );
    }
    return undefined;
  }
  if (!isConfigAddress(feeRecipient)) {
    throw new Error(
      `${TIPPING_V1_FEE_RECIPIENT_OPTION} must be a 0x address, all lowercase or with a valid checksum, got "${feeRecipient}"`
    );
  }
  return getAddress(feeRecipient);
};

// The parse shared by validateChallengeSettings and getChallenge, so settings accepted at edit time
// cannot be read differently at challenge time.
const parseSettings = (challengeSettings: CommunityChallengeSetting | undefined): ParsedSettings => {
  const options = challengeSettings?.options ?? {};
  const tokens = parseTipTokens(options[TIPPING_V1_TOKENS_OPTION]);
  const feeRecipient = parseFeeRecipient(options[TIPPING_V1_FEE_RECIPIENT_OPTION], tokens);
  const rpcUrls = options["rpcUrls"];
  parseRpcUrls(rpcUrls);
  return { tokens, feeRecipient, rpcUrls };
};

// Sync and no network, per pkc-js docs/protocol/challenge-authoring.md: it runs on every community start.
const validateChallengeSettings = ({ challengeSettings }: { challengeSettings: CommunityChallengeSetting }): void => {
  const publicOptions = challengeSettings.publicOptions ?? [];

  // A client that cannot read the token list cannot offer a tip the community will accept, so
  // publication is required rather than the owner's call.
  if (!publicOptions.includes(TIPPING_V1_TOKENS_OPTION)) {
    throw new Error(
      `${TIPPING_V1_TOKENS_OPTION} must be listed in publicOptions: clients read it to know the community accepts tips and in which tokens`
    );
  }

  // RPC URLs routinely carry a provider API key in the path, the record is public and permanent, and no
  // client needs them.
  if (publicOptions.includes("rpcUrls")) {
    throw new Error(
      "rpcUrls cannot be listed in publicOptions: RPC URLs commonly embed a provider API key, and only the community node uses them"
    );
  }

  const { tokens, feeRecipient, rpcUrls } = parseSettings(challengeSettings);

  if (tokensHaveFee(tokens) && !publicOptions.includes(TIPPING_V1_FEE_RECIPIENT_OPTION)) {
    throw new Error(
      `${TIPPING_V1_FEE_RECIPIENT_OPTION} must be listed in publicOptions when a token has a fee: clients read it to know where to send the fee`
    );
  }
  if (feeRecipient && !tokensHaveFee(tokens)) {
    throw new Error(
      `${TIPPING_V1_FEE_RECIPIENT_OPTION} is set but no token has a fee. Add a fee to a token or remove the option`
    );
  }

  const { all, byChainId } = parseRpcUrls(rpcUrls);
  for (const url of [...all, ...[...byChainId.values()].flat()]) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`option rpcUrls contains an entry that is not a valid URL: "${url}"`);
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(`option rpcUrls entry "${url}" must use http: or https:, got "${parsedUrl.protocol}"`);
    }
  }

  const chainIds = [...new Set(tokens.map((token) => token.chainId))];
  if (all.length > 0 && chainIds.length > 1) {
    throw new Error(
      `option rpcUrls is a plain list of URLs but the tokens span ${chainIds.length} chain IDs (${chainIds.join(", ")}). ` +
        `Use a JSON object mapping each chain ID to its URLs`
    );
  }
  for (const chainId of byChainId.keys()) {
    if (!chainIds.includes(chainId)) {
      throw new Error(`option rpcUrls names chain ID ${chainId}, which no token uses`);
    }
  }
  for (const chainId of chainIds) {
    if (getRpcUrlsForChain(rpcUrls, chainId).length === 0 && !getChainFromId(chainId)) {
      throw new Error(rpcUrlsRequiredMessage(chainId));
    }
  }
};

const fail = (error: string): ChallengeResultInput => ({ success: false, error });

const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

// --- single use of a transaction, per community -----------------------------------------------------

const USED_TX_CACHE_NAME = "tipping_challenge_v1_used_tx";

// A claim that passed this challenge but whose publication never landed (another challenge rejected it,
// the author gave up) must not burn the transaction forever. After this long without the claiming
// publication showing up in the community's database, another publication may claim the transaction.
const RECLAIM_AFTER_SECONDS = 15 * 60;

interface UsedTxRecord {
  // signature.signature of the publication that claimed the transaction
  signature: string;
  claimedAt: number;
}

interface UsedTxStorage {
  getItem(key: string): Promise<unknown>;
  setItem(key: string, value: unknown): Promise<unknown>;
}

// Serializes the check-then-set below. Two replies claiming the same transaction at the same moment
// would otherwise both read "unused" before either wrote.
let claimQueue: Promise<unknown> = Promise.resolve();
const withClaimLock = <T>(run: () => Promise<T>): Promise<T> => {
  const result = claimQueue.then(run, run);
  claimQueue = result.catch(() => undefined);
  return result;
};

const isUsedTxRecord = (value: unknown): value is UsedTxRecord =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as UsedTxRecord).signature === "string" &&
  typeof (value as UsedTxRecord).claimedAt === "number";

// Binds every hash to the publication claiming it, or names the hash that another publication holds.
const claimTransactions = ({
  community,
  chainId,
  hashes,
  publicationSignature,
  nowSeconds
}: {
  community: LocalCommunity;
  chainId: number;
  hashes: string[];
  publicationSignature: string;
  nowSeconds: number;
}): Promise<{ conflict: string } | undefined> =>
  withClaimLock(async () => {
    const storage = (await community._pkc._createStorageLRU({
      cacheName: USED_TX_CACHE_NAME,
      maxItems: Number.MAX_SAFE_INTEGER
    })) as UsedTxStorage;

    // The storage is shared by every community on the node, so the key carries the community. publicKey
    // rather than address: the address can be a name, and a name can change.
    // The chain ID is part of the key: a hash on one chain says nothing about the same hash on another.
    const communityId = community.publicKey ?? community.address;
    const keyOf = (hash: string): string => `${communityId}\n${chainId}\n${hash}`;

    for (const hash of hashes) {
      const record = await storage.getItem(keyOf(hash));
      if (!isUsedTxRecord(record) || record.signature === publicationSignature) continue;

      const landed = community._dbHandler.queryCommentBySignatureEncoded(record.signature) !== undefined;
      if (landed || nowSeconds - record.claimedAt < RECLAIM_AFTER_SECONDS) {
        return { conflict: hash };
      }
    }

    const record: UsedTxRecord = { signature: publicationSignature, claimedAt: nowSeconds };
    for (const hash of hashes) {
      await storage.setItem(keyOf(hash), record);
    }
    return undefined;
  });

// --- finding the tip and the fee in a transaction ----------------------------------------------------

interface FoundTip {
  token: TipToken;
  // undefined for the native coin, which is not a log
  transfer: TokenTransfer | undefined;
  // amount for native and erc20, token ID for erc721
  value: bigint;
}

const includesAddress = (addresses: readonly string[], address: string | null | undefined): boolean =>
  addresses.some((candidate) => sameAddress(candidate, address));

// The tip is the first thing in the transaction that moves a whitelisted token from one of the tipper's
// proven wallets to one of the recipient's proven wallets: the native coin sent by the transaction itself
// if that is whitelisted, else the first matching Transfer event in log order. The claim does not name a
// token, so this order is the rule, and it is part of the tipping/v1 contract.
const findTip = ({
  tx,
  tokens,
  senders,
  receivers
}: {
  tx: MinedTransaction;
  tokens: readonly TipToken[];
  senders: readonly Address[];
  receivers: readonly Address[];
}): (FoundTip & { from: Address; to: Address }) | undefined => {
  const native = tokens.find((token) => token.type === "native");
  if (
    native &&
    tx.value > 0n &&
    tx.to !== null &&
    includesAddress(senders, tx.from) &&
    includesAddress(receivers, tx.to)
  ) {
    return { token: native, transfer: undefined, value: tx.value, from: tx.from, to: tx.to };
  }

  for (const transfer of tx.transfers) {
    if (!includesAddress(senders, transfer.from) || !includesAddress(receivers, transfer.to)) continue;
    const token = tokens.find((candidate) => candidate.type === transfer.kind && sameAddress(candidate.address, transfer.token));
    if (token) return { token, transfer, value: transfer.value, from: transfer.from, to: transfer.to };
  }

  return undefined;
};

interface ProvenWallets {
  addresses: Address[];
  // one line per entry that did not verify, for the error shown when nothing verified
  failures: string[];
}

// Every validly proven entry of author.wallets counts, whatever key it sits under. The key is a label
// the author chose (a ticker), and tipping/v1 does not use tickers: a proof shows control of an address,
// and that address is the same on every EVM chain. An entry that fails verification is ignored, since one
// stale entry must not stop an author with a good one.
const collectProvenWallets = async ({
  author,
  authorKeyAddress,
  nowSeconds
}: {
  author: unknown;
  authorKeyAddress: string;
  nowSeconds: number;
}): Promise<ProvenWallets> => {
  const wallets = (author as { wallets?: unknown } | undefined)?.wallets;
  const proven: ProvenWallets = { addresses: [], failures: [] };
  if (typeof wallets !== "object" || wallets === null || Array.isArray(wallets)) return proven;

  for (const [key, wallet] of Object.entries(wallets as Record<string, AuthorWallet>)) {
    const result = await verifyWalletProof({ wallet, authorKeyAddress, nowSeconds });
    if ("error" in result) {
      proven.failures.push(`"${key}": ${result.error}`);
    } else if (!includesAddress(proven.addresses, result.address)) {
      proven.addresses.push(result.address);
    }
  }
  return proven;
};

const describeNoWallets = (proven: ProvenWallets): string =>
  proven.failures.length > 0 ? `No entry verified (${proven.failures.join("; ")}).` : "There are no entries.";

const describeRpcError = (e: unknown): string => (e instanceof Error ? e.message.split("\n")[0] : String(e)) ?? "";

const getChallenge = async ({
  challengeSettings,
  challengeRequestMessage,
  challengeAnswer,
  community
}: GetChallengeArgsInput): Promise<ChallengeResultInput> => {
  // Only comments can carry a tip. Votes, edits and moderations pass untouched.
  const comment = challengeRequestMessage.comment;
  if (!comment) return { success: true };

  // The claim is this challenge's pre-answer: a JSON string the client put in the request's
  // challengeAnswers under this challenge's index. pkc-js hands it over as `challengeAnswer`. No answer
  // means no tip, and the reply passes untouched.
  if (challengeAnswer === undefined) return { success: true };

  // validateChallengeSettings rejects a bad config at edit time, so reaching this catch means a config
  // that predates the hook. Fail the tip loudly rather than accept it unverified.
  let settings: ParsedSettings;
  try {
    settings = parseSettings(challengeSettings);
  } catch (e) {
    return fail(`Invalid tipping challenge settings: ${(e as Error).message}`);
  }

  let claim: TipClaim;
  try {
    claim = parseTipClaimAnswer(challengeAnswer);
  } catch (e) {
    return fail(`Invalid tip: ${(e as Error).message}`);
  }

  if (!comment.parentCid) {
    return fail("A tip must be a reply to the comment being tipped. A post cannot carry a tip.");
  }

  const tokens = settings.tokens.filter((token) => token.chainId === claim.chainId);
  if (tokens.length === 0) {
    return fail(`This community does not accept tips on chain ID ${claim.chainId}.`);
  }

  const parent = community._dbHandler.queryComment(comment.parentCid);
  if (!parent) {
    return fail("The comment being tipped was not found in this community.");
  }

  let tipperKeyAddress: string;
  let recipientKeyAddress: string;
  try {
    tipperKeyAddress = getKeyAddressFromPublicKey(comment.signature.publicKey);
    recipientKeyAddress = getKeyAddressFromPublicKey(parent.signature.publicKey);
  } catch (e) {
    return fail(`Could not derive an author's key address: ${(e as Error).message}`);
  }

  if (tipperKeyAddress === recipientKeyAddress) {
    return fail("You cannot tip your own comment.");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);

  const tipperWallets = await collectProvenWallets({ author: comment.author, authorKeyAddress: tipperKeyAddress, nowSeconds });
  if (tipperWallets.addresses.length === 0) {
    return fail(`You have no valid author.wallets entry to tip from. ${describeNoWallets(tipperWallets)}`);
  }

  const recipientWallets = await collectProvenWallets({
    author: parent.author,
    authorKeyAddress: recipientKeyAddress,
    nowSeconds
  });
  if (recipientWallets.addresses.length === 0) {
    return fail(
      `The author being tipped has no valid author.wallets entry on that comment. ${describeNoWallets(recipientWallets)}`
    );
  }

  // A wallet the tipper has proven as their own is not somebody else's wallet, whoever else lists it.
  const receivers = recipientWallets.addresses.filter((address) => !includesAddress(tipperWallets.addresses, address));
  if (receivers.length === 0) {
    return fail("You cannot tip your own wallet.");
  }
  const senders = tipperWallets.addresses;

  // Nothing is read from an RPC until it has reported the chain ID the claim names.
  let client: PublicClient;
  try {
    client = await getConfirmedChainClient(settings.rpcUrls, claim.chainId);
  } catch (e) {
    if (e instanceof ChainIdMismatchError) return fail(e.message);
    return fail(`Could not confirm the RPC for chain ID ${claim.chainId}: ${describeRpcError(e)}`);
  }

  const parentCid = comment.parentCid;

  // Reads a transaction and applies the checks every claimed transaction must pass, tip or fee.
  const readClaimedTransaction = async (
    hash: string,
    label: string
  ): Promise<{ tx: MinedTransaction } | { error: string }> => {
    let tx: MinedTransaction | undefined;
    try {
      tx = await readTransaction({ client, hash });
    } catch (e) {
      return { error: `Could not read the ${label} transaction from the chain: ${describeRpcError(e)}` };
    }
    if (!tx) {
      return { error: `The ${label} transaction is not mined yet. Wait for it to confirm, then publish again.` };
    }
    if (!tx.succeeded) {
      return { error: `The ${label} transaction failed on chain.` };
    }
    // The sender signs the transaction's input, so only a transaction the tipper sent carries a parent
    // binding the tipper chose. A relayer or a bundler could append any suffix.
    if (!includesAddress(senders, tx.from)) {
      return {
        error: `The ${label} transaction was not sent by one of your proven wallets. A transaction submitted by a relayer, a paymaster or a bundler cannot back a tip.`
      };
    }
    if (!hasParentBinding(tx.input, parentCid)) {
      return {
        error: `The ${label} transaction does not end with the parent binding for the comment being tipped. It was made for another comment, or was not made as a tip.`
      };
    }
    return { tx };
  };

  const tipTxResult = await readClaimedTransaction(claim.txHash, "tip");
  if ("error" in tipTxResult) return fail(tipTxResult.error);
  const tipTx = tipTxResult.tx;

  const tip = findTip({ tx: tipTx, tokens, senders, receivers });
  if (!tip) {
    return fail(
      "The tip transaction does not transfer an accepted token from one of your proven wallets to a proven wallet of the author being tipped."
    );
  }

  if (tip.token.minAmount !== undefined && tip.value < BigInt(tip.token.minAmount)) {
    return fail(`The tip is below this community's minimum of ${tip.token.minAmount} for that token.`);
  }

  const verified: VerifiedTip = {
    chainId: claim.chainId,
    txHash: claim.txHash,
    type: tip.token.type,
    from: tip.from,
    to: tip.to
  };
  if (tip.transfer) verified.token = tip.transfer.token;
  if (tip.token.type === "erc721") verified.tokenId = tip.value.toString();
  else verified.amount = tip.value.toString();

  const usedHashes = [claim.txHash];

  // For erc721, tip.value is a token ID, not an amount. Its fee is always flat, so the value is unused.
  const requiredFee = getRequiredFee(tip.token, tip.token.type === "erc721" ? 0n : tip.value);
  if (requiredFee) {
    // parseSettings guarantees a fee recipient whenever a token has a fee.
    const feeRecipient = settings.feeRecipient as Address;
    const feeTxHash = claim.feeTxHash ?? claim.txHash;
    const sameTx = feeTxHash === claim.txHash;

    let feeTx = tipTx;
    if (!sameTx) {
      const feeTxResult = await readClaimedTransaction(feeTxHash, "fee");
      if ("error" in feeTxResult) return fail(feeTxResult.error);
      feeTx = feeTxResult.tx;
    }

    let paid: bigint | undefined;
    if (requiredFee.feeToken === undefined) {
      // A native fee is the value of a transaction sent straight to the fee recipient. Inside a batched
      // transaction the coin moves as an inner call that a standard RPC cannot show, and a native tip's
      // own transaction already spent its value on the recipient, so the fee needs its own transaction.
      if (sameTx) {
        return fail(
          "This tip owes the community a fee in the native coin, which must be a separate transaction. Send it to the fee recipient and put its hash in feeTxHash."
        );
      }
      if (includesAddress(senders, feeTx.from) && sameAddress(feeTx.to, feeRecipient)) {
        paid = feeTx.value;
      }
    } else {
      const feeToken = requiredFee.feeToken;
      // Not the tip's own event: when the fee recipient is also the author being tipped, one transfer
      // must not count twice.
      const transfer = feeTx.transfers.find(
        (candidate) =>
          candidate.kind === "erc20" &&
          sameAddress(candidate.token, feeToken) &&
          includesAddress(senders, candidate.from) &&
          sameAddress(candidate.to, feeRecipient) &&
          candidate.value >= requiredFee.amount &&
          !(sameTx && tip.transfer && candidate.logIndex === tip.transfer.logIndex)
      );
      paid = transfer?.value;
    }

    if (paid === undefined || paid < requiredFee.amount) {
      const feeTokenText = requiredFee.feeToken === undefined ? "the native coin" : `token ${requiredFee.feeToken}`;
      return fail(
        `This tip owes the community a fee of ${requiredFee.amount} in ${feeTokenText}, sent from one of your proven wallets to ${feeRecipient}. ` +
          (sameTx
            ? "No such transfer is in the tip transaction. Send it and put its hash in feeTxHash."
            : "The fee transaction does not contain it.")
      );
    }

    verified.fee = { txHash: feeTxHash, to: feeRecipient, amount: paid.toString() };
    if (requiredFee.feeToken !== undefined) verified.fee.token = getAddress(requiredFee.feeToken);
    if (!sameTx) usedHashes.push(feeTxHash);
  }

  const claimResult = await claimTransactions({
    community,
    chainId: claim.chainId,
    hashes: usedHashes,
    publicationSignature: comment.signature.signature,
    nowSeconds
  });
  if (claimResult) {
    return fail(
      `Transaction ${claimResult.conflict} has already been used for a tip in this community. A transaction can back one tip only.`
    );
  }

  return { success: true, commentUpdate: { tip: verified } };
};

function ChallengeFileFactory(_args: { challengeSettings: CommunityChallengeSetting }): ChallengeFileInput {
  // Deliberately cheap and non-throwing: the factory runs on load as well as on edit, so throwing here
  // would fail community startup rather than the offending edit.
  return { getChallenge, optionInputs, type, description, validateChallengeSettings };
}

export { description, optionInputs, getChallenge, validateChallengeSettings, RECLAIM_AFTER_SECONDS };
export default ChallengeFileFactory;

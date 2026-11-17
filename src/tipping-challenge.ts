import { getAddress, type Address } from "viem";
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
  isConfigAddress,
  parseTipClaim,
  parseTipTokens,
  TIPPING_V1_FEE_RECIPIENT_OPTION,
  TIPPING_V1_TOKENS_OPTION,
  tokensHaveFee,
  type TipClaim,
  type TipToken,
  type VerifiedTip
} from "./contract.js";
import {
  getChainClient,
  getChainFromTicker,
  getRpcUrlsForChain,
  knownChainTickers,
  parseRpcUrls,
  readTransaction,
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
      "JSON array of the tokens accepted as tips. Each entry has chainTicker, type (native, erc20 or erc721), address (not for native), and optionally minAmount and fee. Amounts are strings in the token's smallest unit. Must be listed in publicOptions so clients can offer the right tokens. The key names the tipping/v1 contract rather than this package.",
    placeholder:
      '[{"chainTicker":"eth","type":"native"},{"chainTicker":"eth","type":"erc20","address":"0x...","minAmount":"1000000","fee":{"percent":"2.5"}}]',
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
      'Comma-separated JSON-RPC URLs, or a JSON object mapping a chainTicker to such a list when the tokens span several chains, e.g. {"eth":"https://a,https://b","base":"https://c"}. Optional for a chainTicker with a built-in RPC, required otherwise. Recommended even when optional: the built-in RPC is shared and rate-limited.',
    placeholder: "https://eth.llamarpc.com,https://rpc.ankr.com/eth"
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

  const { all, byChain } = parseRpcUrls(rpcUrls);
  for (const url of [...all, ...Object.values(byChain).flat()]) {
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

  const chainTickers = [...new Set(tokens.map((token) => token.chainTicker))];
  if (all.length > 0 && chainTickers.length > 1) {
    throw new Error(
      `option rpcUrls is a plain list of URLs but the tokens span ${chainTickers.length} chains (${chainTickers.join(", ")}). ` +
        `Use a JSON object mapping each chainTicker to its URLs`
    );
  }
  for (const chainTicker of Object.keys(byChain)) {
    if (!chainTickers.includes(chainTicker)) {
      throw new Error(`option rpcUrls names chainTicker "${chainTicker}", which no token uses`);
    }
  }
  for (const chainTicker of chainTickers) {
    if (getRpcUrlsForChain(rpcUrls, chainTicker).length === 0 && !getChainFromTicker(chainTicker)) {
      throw new Error(
        `option rpcUrls is required for chainTicker "${chainTicker}": it has no built-in RPC. ` +
          `Tickers with a built-in RPC are: ${knownChainTickers.join(", ")}.`
      );
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
  chainTicker,
  hashes,
  publicationSignature,
  nowSeconds
}: {
  community: LocalCommunity;
  chainTicker: string;
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
    const communityId = community.publicKey ?? community.address;
    const keyOf = (hash: string): string => `${communityId}\n${chainTicker}\n${hash}`;

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

// The tip is the first thing in the transaction that moves a whitelisted token from the tipper's wallet
// to the recipient's wallet: the native coin sent by the transaction itself if that is whitelisted, else
// the first matching Transfer event in log order. The claim does not name a token, so this order is the
// rule, and it is part of the tipping/v1 contract.
const findTip = ({
  tx,
  tokens,
  from,
  to
}: {
  tx: MinedTransaction;
  tokens: readonly TipToken[];
  from: Address;
  to: Address;
}): FoundTip | undefined => {
  const native = tokens.find((token) => token.type === "native");
  if (native && tx.value !== undefined && tx.value > 0n && sameAddress(tx.from, from) && sameAddress(tx.to, to)) {
    return { token: native, transfer: undefined, value: tx.value };
  }

  for (const transfer of tx.transfers) {
    if (!sameAddress(transfer.from, from) || !sameAddress(transfer.to, to)) continue;
    const token = tokens.find((candidate) => candidate.type === transfer.kind && sameAddress(candidate.address, transfer.token));
    if (token) return { token, transfer, value: transfer.value };
  }

  return undefined;
};

const walletsOf = (author: unknown): Record<string, AuthorWallet> | undefined => {
  const wallets = (author as { wallets?: unknown } | undefined)?.wallets;
  return typeof wallets === "object" && wallets !== null ? (wallets as Record<string, AuthorWallet>) : undefined;
};

const describeRpcError = (e: unknown): string => (e instanceof Error ? e.message.split("\n")[0] : String(e)) ?? "";

const getChallenge = async ({
  challengeSettings,
  challengeRequestMessage,
  community
}: GetChallengeArgsInput): Promise<ChallengeResultInput> => {
  // Only comments can carry a tip. Votes, edits and moderations pass untouched.
  const comment = challengeRequestMessage.comment;
  if (!comment) return { success: true };

  // The claim is author-signed either way. `author.tip` is where clients put it today: pkc-js rejects an
  // unknown top-level key in createComment but signs unknown keys under `author`. The top level is also
  // read, since a community node accepts unknown top-level keys on the wire.
  const authorClaim = (comment.author as unknown as { tip?: unknown } | undefined)?.tip;
  const topLevelClaim = (comment as unknown as { tip?: unknown }).tip;
  const rawClaim = authorClaim ?? topLevelClaim;
  if (rawClaim === undefined) return { success: true };

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
    claim = parseTipClaim(rawClaim);
    if (authorClaim !== undefined && topLevelClaim !== undefined) {
      const other = parseTipClaim(topLevelClaim);
      if (other.chainTicker !== claim.chainTicker || other.txHash !== claim.txHash || other.feeTxHash !== claim.feeTxHash) {
        throw new Error("author.tip and the top-level tip are both present and differ. Publish the claim once");
      }
    }
  } catch (e) {
    return fail(`Invalid tip: ${(e as Error).message}`);
  }

  if (!comment.parentCid) {
    return fail("A tip must be a reply to the comment being tipped. A post cannot carry a tip.");
  }

  const tokens = settings.tokens.filter((token) => token.chainTicker === claim.chainTicker);
  if (tokens.length === 0) {
    return fail(`This community does not accept tips on chain "${claim.chainTicker}".`);
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

  const tipperWallet = await verifyWalletProof({
    wallet: walletsOf(comment.author)?.[claim.chainTicker],
    authorKeyAddress: tipperKeyAddress,
    nowSeconds
  });
  if ("error" in tipperWallet) {
    return fail(`Your author.wallets["${claim.chainTicker}"] entry is not valid: ${tipperWallet.error}.`);
  }

  const recipientWallet = await verifyWalletProof({
    wallet: walletsOf(parent.author)?.[claim.chainTicker],
    authorKeyAddress: recipientKeyAddress,
    nowSeconds
  });
  if ("error" in recipientWallet) {
    return fail(
      `The author being tipped has no valid author.wallets["${claim.chainTicker}"] entry on that comment: ${recipientWallet.error}.`
    );
  }

  if (sameAddress(tipperWallet.address, recipientWallet.address)) {
    return fail("You cannot tip your own wallet.");
  }

  const nativeAccepted = tokens.some((token) => token.type === "native");

  // Reads a transaction and applies the checks every claimed transaction must pass, tip or fee.
  const readClaimedTransaction = async (
    hash: string,
    label: string
  ): Promise<{ tx: MinedTransaction } | { error: string }> => {
    let tx: MinedTransaction | undefined;
    try {
      const client = getChainClient(settings.rpcUrls, claim.chainTicker);
      tx = await readTransaction({ client, hash, withValue: nativeAccepted });
    } catch (e) {
      return { error: `Could not read the ${label} transaction from the chain: ${describeRpcError(e)}` };
    }
    if (!tx) {
      return { error: `The ${label} transaction is not mined yet. Wait for it to confirm, then publish again.` };
    }
    if (!tx.succeeded) {
      return { error: `The ${label} transaction failed on chain.` };
    }
    if (tx.blockTimestamp < BigInt(parent.timestamp)) {
      return { error: `The ${label} transaction is older than the comment being tipped.` };
    }
    return { tx };
  };

  const tipTxResult = await readClaimedTransaction(claim.txHash, "tip");
  if ("error" in tipTxResult) return fail(tipTxResult.error);
  const tipTx = tipTxResult.tx;

  const tip = findTip({ tx: tipTx, tokens, from: tipperWallet.address, to: recipientWallet.address });
  if (!tip) {
    return fail(
      "The tip transaction does not transfer an accepted token from your wallet to the wallet of the author being tipped."
    );
  }

  if (tip.token.minAmount !== undefined && tip.value < BigInt(tip.token.minAmount)) {
    return fail(`The tip is below this community's minimum of ${tip.token.minAmount} for that token.`);
  }

  const verified: VerifiedTip = {
    chainTicker: claim.chainTicker,
    txHash: claim.txHash,
    type: tip.token.type,
    from: tipperWallet.address,
    to: recipientWallet.address
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
          "This tip owes the community a fee in the native coin, which must be a separate transaction. Send it to the fee recipient and put its hash in tip.feeTxHash."
        );
      }
      if (
        feeTx.value !== undefined &&
        sameAddress(feeTx.from, tipperWallet.address) &&
        sameAddress(feeTx.to, feeRecipient)
      ) {
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
          sameAddress(candidate.from, tipperWallet.address) &&
          sameAddress(candidate.to, feeRecipient) &&
          candidate.value >= requiredFee.amount &&
          !(sameTx && tip.transfer && candidate.logIndex === tip.transfer.logIndex)
      );
      paid = transfer?.value;
    }

    if (paid === undefined || paid < requiredFee.amount) {
      const feeTokenText = requiredFee.feeToken === undefined ? "the native coin" : `token ${requiredFee.feeToken}`;
      return fail(
        `This tip owes the community a fee of ${requiredFee.amount} in ${feeTokenText}, sent from your wallet to ${feeRecipient}. ` +
          (sameTx
            ? "No such transfer is in the tip transaction. Send it and put its hash in tip.feeTxHash."
            : "The fee transaction does not contain it.")
      );
    }

    verified.fee = { txHash: feeTxHash, to: feeRecipient, amount: paid.toString() };
    if (requiredFee.feeToken !== undefined) verified.fee.token = getAddress(requiredFee.feeToken);
    if (!sameTx) usedHashes.push(feeTxHash);
  }

  const claimResult = await claimTransactions({
    community,
    chainTicker: claim.chainTicker,
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

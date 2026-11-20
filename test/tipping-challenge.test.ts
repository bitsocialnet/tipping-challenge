import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { concat, encodeFunctionData, erc20Abi, getAddress, type Address, type Hex } from "viem";
import { getChallenge, RECLAIM_AFTER_SECONDS } from "../src/tipping-challenge.js";
import type { TipToken } from "../src/contract.js";
import type { ChallengeResultInput, GetChallengeArgsInput } from "../src/types.js";
import {
  addParentComment,
  buildSettings,
  erc20Transfer,
  erc721Transfer,
  FakeChain,
  makeAuthor,
  makeCommunity,
  makeRequest,
  newTxHash,
  PARENT_CID,
  withBinding,
  signWallet,
  uninstallFakeChain,
  type FakeCommunity,
  type FakeTx
} from "./helpers.js";

// Placeholder contracts, not real tokens.
const USDC: Address = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0001");
const DAI: Address = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0002");
const NFT: Address = "0x2222222222222222222222222222222222222222";
const UNLISTED: Address = "0x4444444444444444444444444444444444444444";
const FEE_RECIPIENT: Address = "0x1111111111111111111111111111111111111111";
// Example strings, not comments that exist.
const OTHER_PARENT_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

const tipper = makeAuthor(1);
const recipient = makeAuthor(2);
const stranger = makeAuthor(3);

const from = tipper.wallet.address;
const to = recipient.wallet.address;

const native: TipToken = { chainId: 1, type: "native" };
const usdc: TipToken = { chainId: 1, type: "erc20", address: USDC };
const nft: TipToken = { chainId: 1, type: "erc721", address: NFT };
const allTokens = [native, usdc, nft];

let chain: FakeChain;
let community: FakeCommunity;

beforeEach(async () => {
  chain = new FakeChain();
  chain.install();
  community = makeCommunity();
  await addParentComment(community, recipient);
});

afterAll(() => uninstallFakeChain());

const run = async (
  request: GetChallengeArgsInput["challengeRequestMessage"],
  settings = buildSettings({ tokens: allTokens }),
  target: FakeCommunity = community
): Promise<ChallengeResultInput> =>
  getChallenge({
    challengeSettings: settings,
    challengeRequestMessage: request,
    challengeIndex: 0,
    // What pkc-js passes: this challenge's own pre-answer.
    challengeAnswer: request.challengeAnswers?.["0"],
    community: target.asCommunity()
  });

const expectFailure = (result: ChallengeResultInput, message: RegExp): void => {
  expect(result).toEqual({ success: false, error: expect.stringMatching(message) });
};

const usdcTip = (amount = 5_000_000n): string =>
  chain.add(newTxHash(), { from, to: USDC, logs: [erc20Transfer(USDC, from, to, amount)] });

describe("publications without a tip", () => {
  it("passes a vote without touching the chain or the database", async () => {
    const result = await run({ vote: { vote: 1 } } as unknown as GetChallengeArgsInput["challengeRequestMessage"]);
    expect(result).toEqual({ success: true });
    expect(chain.requests).toEqual([]);
  });

  it("passes a comment with no tip claim untouched", async () => {
    expect(await run(await makeRequest(tipper))).toEqual({ success: true });
    expect(await run(await makeRequest(tipper, { parentCid: null, wallets: null }))).toEqual({ success: true });
    expect(chain.requests).toEqual([]);
  });

  it("passes a comment with no tip even when the settings are broken", async () => {
    expect(await run(await makeRequest(tipper), buildSettings({ tokens: "[" }))).toEqual({ success: true });
  });
});

describe("the claim", () => {
  it("rejects a tip when the settings are broken", async () => {
    const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip() } });
    expectFailure(await run(request, buildSettings({ tokens: "[" })), /Invalid tipping challenge settings/);
  });

  it("rejects a malformed claim", async () => {
    expectFailure(await run(await makeRequest(tipper, { tip: "0xabc" })), /Invalid tip: tip must be an object/);
    expectFailure(await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: "0x12" } })), /tip.txHash/);
  });

  it("rejects a claim carrying fields that imitate the verified result", async () => {
    const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip(), amount: "999", from, to } });
    expectFailure(await run(request), /unknown key/);
  });

  it("reads the claim only from its own index", async () => {
    const hash = usdcTip(3n);
    const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } });
    // Another challenge's pre-answer is at index 1. This challenge sits at index 0 and sees none.
    request.challengeAnswers = { "1": request.challengeAnswers?.["0"] ?? "" };
    expect(await run(request)).toEqual({ success: true });
  });

  it("rejects an answer that is not JSON", async () => {
    expectFailure(await run(await makeRequest(tipper, { rawAnswer: "0xabc" })), /must be JSON text/);
  });

  it("rejects a tip on a post", async () => {
    const request = await makeRequest(tipper, { parentCid: null, tip: { chainId: 1, txHash: usdcTip() } });
    expectFailure(await run(request), /must be a reply/);
  });

  it("rejects a chain ID the community does not accept", async () => {
    const request = await makeRequest(tipper, { tip: { chainId: 8453, txHash: usdcTip() } });
    expectFailure(await run(request), /does not accept tips on chain ID 8453/);
    expect(chain.requests).toEqual([]);
  });

  it("rejects a claim that names its chain by ticker", async () => {
    const request = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: usdcTip() } });
    expectFailure(await run(request), /Invalid tip: tip uses chainTicker/);
  });

  it("rejects a tip on a comment the community does not have", async () => {
    const request = await makeRequest(tipper, { parentCid: "QmUnknown", tip: { chainId: 1, txHash: usdcTip() } });
    expectFailure(await run(request), /was not found in this community/);
  });
});

describe("who is tipping whom", () => {
  it("rejects a tip on your own comment", async () => {
    const request = await makeRequest(recipient, { tip: { chainId: 1, txHash: usdcTip() } });
    expectFailure(await run(request), /cannot tip your own comment/);
  });

  it("rejects a tip to a wallet the tipper has proven as their own", async () => {
    // The tipper proves the same wallet the recipient uses: a different key, the same money.
    const sharedWallet = await recipient.wallet.signMessage({
      message: `{"domainSeparator":"bitsocial-author-wallet","authorPublicKey":"${tipper.keyAddress}","timestamp":1700000000}`
    });
    const request = await makeRequest(tipper, {
      tip: { chainId: 1, txHash: usdcTip() },
      wallets: {
        eth: await signWallet(tipper),
        other: { address: to, timestamp: 1_700_000_000, signature: { signature: sharedWallet, type: "eip191" } }
      }
    });
    expectFailure(await run(request), /cannot tip your own wallet/);
  });

  it("rejects a tipper with no wallets", async () => {
    const request = await makeRequest(tipper, { wallets: null, tip: { chainId: 1, txHash: usdcTip() } });
    expectFailure(await run(request), /You have no valid author.wallets entry to tip from. There are no entries/);
    expect(chain.requests).toEqual([]);
  });

  it("rejects a tipper whose only entry was copied from someone else, and says which entry failed", async () => {
    const request = await makeRequest(tipper, {
      wallets: { eth: await signWallet(stranger) },
      tip: { chainId: 1, txHash: usdcTip() }
    });
    expectFailure(await run(request), /You have no valid author.wallets entry.*No entry verified \("eth": wallet signature does not prove/);
  });

  it("rejects a tipper whose wallet was signed with the old separator", async () => {
    const message = `{"domainSeparator":"pkc-author-wallet","authorAddress":"${tipper.keyAddress}","timestamp":1700000000}`;
    const request = await makeRequest(tipper, {
      wallets: { eth: await signWallet(tipper, { message }) },
      tip: { chainId: 1, txHash: usdcTip() }
    });
    expectFailure(await run(request), /does not prove/);
  });

  it("rejects a recipient with no wallets", async () => {
    await addParentComment(community, recipient, { wallets: null });
    const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip() } });
    expectFailure(await run(request), /author being tipped has no valid author.wallets entry on that comment. There are no entries/);
  });

  it("rejects a recipient whose only entry is not theirs", async () => {
    await addParentComment(community, recipient, { wallets: { eth: await signWallet(stranger) } });
    const hash = chain.add(newTxHash(), {
      from,
      to: USDC,
      logs: [erc20Transfer(USDC, from, stranger.wallet.address, 5n)]
    });
    const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } });
    expectFailure(await run(request), /author being tipped has no valid.*"eth": wallet signature does not prove/);
  });
});

describe("which wallet entries count", () => {
  it("accepts wallets under any key, since the contract does not use tickers", async () => {
    await addParentComment(community, recipient, { walletKey: "base" });
    const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip(9n) }, walletKey: "anything at all" });
    expect(await run(request)).toMatchObject({ success: true, commentUpdate: { tip: { chainId: 1, from, to, amount: "9" } } });
  });

  it("ignores entries that fail verification when another entry is valid and matches", async () => {
    await addParentComment(community, recipient, {
      wallets: {
        aaa: await signWallet(stranger),
        eth: { address: "recipient.eth", timestamp: 1, signature: { signature: "0x00", type: "eip191" } },
        zzz: await signWallet(recipient)
      }
    });
    const request = await makeRequest(tipper, {
      tip: { chainId: 1, txHash: usdcTip(9n) },
      wallets: { broken: await signWallet(tipper, { type: "eip712" }), sol: await signWallet(tipper) }
    });
    expect(await run(request)).toMatchObject({ success: true, commentUpdate: { tip: { from, to, amount: "9" } } });
  });

  it("matches the sender and the receiver against any valid entry, not the first", async () => {
    const second = makeAuthor(40).wallet;
    const proveSecond = async (author: typeof tipper) => ({
      address: second.address,
      timestamp: 1_700_000_000,
      signature: {
        signature: await second.signMessage({
          message: `{"domainSeparator":"bitsocial-author-wallet","authorPublicKey":"${author.keyAddress}","timestamp":1700000000}`
        }),
        type: "eip191"
      }
    });

    // The tipper pays from their second wallet.
    const fromSecond = chain.add(newTxHash(), {
      from: second.address,
      to: USDC,
      logs: [erc20Transfer(USDC, second.address, to, 4n)]
    });
    const request = await makeRequest(tipper, {
      tip: { chainId: 1, txHash: fromSecond },
      wallets: { eth: await signWallet(tipper), matic: await proveSecond(tipper) }
    });
    expect(await run(request)).toMatchObject({ success: true, commentUpdate: { tip: { from: second.address, to } } });

    // The recipient is paid on their second wallet.
    await addParentComment(community, recipient, { wallets: { eth: await signWallet(recipient), matic: await proveSecond(recipient) } });
    const toSecond = chain.add(newTxHash(), {
      from,
      to: USDC,
      logs: [erc20Transfer(USDC, from, second.address, 4n)]
    });
    expect(await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: toSecond } }))).toMatchObject({
      success: true,
      commentUpdate: { tip: { from, to: second.address } }
    });
  });

  it("does not count a transfer from, or to, an address listed only in an entry that failed verification", async () => {
    const unproven = stranger.wallet.address;
    const fromUnproven = chain.add(newTxHash(), {
      from,
      to: USDC,
      logs: [erc20Transfer(USDC, unproven, to, 4n)]
    });
    const request = await makeRequest(tipper, {
      tip: { chainId: 1, txHash: fromUnproven },
      wallets: { eth: await signWallet(tipper), claimed: await signWallet(stranger) }
    });
    expectFailure(await run(request), /does not transfer an accepted token from one of your proven wallets/);

    await addParentComment(community, recipient, { wallets: { eth: await signWallet(recipient), claimed: await signWallet(stranger) } });
    const toUnproven = chain.add(newTxHash(), {
      from,
      to: USDC,
      logs: [erc20Transfer(USDC, from, unproven, 4n)]
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: toUnproven } })),
      /does not transfer an accepted token/
    );
  });

  it("accepts a fee paid from another of the tipper's valid entries, and not from an unproven address", async () => {
    const settings = buildSettings({ tokens: [{ ...usdc, fee: { percent: "10" } }], feeRecipient: FEE_RECIPIENT });
    const second = makeAuthor(41).wallet;
    const secondEntry = {
      address: second.address,
      timestamp: 1_700_000_000,
      signature: {
        signature: await second.signMessage({
          message: `{"domainSeparator":"bitsocial-author-wallet","authorPublicKey":"${tipper.keyAddress}","timestamp":1700000000}`
        }),
        type: "eip191"
      }
    };
    const feeFrom = (payer: Address): string =>
      chain.add(newTxHash(), { from: payer, to: USDC, logs: [erc20Transfer(USDC, payer, FEE_RECIPIENT, 100n)] });

    const paid = await makeRequest(tipper, {
      tip: { chainId: 1, txHash: usdcTip(1000n), feeTxHash: feeFrom(second.address) },
      wallets: { eth: await signWallet(tipper), second: secondEntry }
    });
    expect(await run(paid, settings)).toMatchObject({ success: true, commentUpdate: { tip: { fee: { amount: "100" } } } });

    const unpaid = await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip(1000n), feeTxHash: feeFrom(second.address) } });
    expectFailure(await run(unpaid, settings), /fee transaction was not sent by one of your proven wallets/);
  });
});

describe("the RPC's chain ID", () => {
  it("fails the tip when the RPC reports another chain ID, and reads no transaction from it", async () => {
    chain.reportChainId = 11155111;
    const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip() } });
    expectFailure(await run(request), /RPC configured for chain ID 1 reports chain ID 11155111/);
    expect(chain.requests).toEqual(["eth_chainId"]);
  });

  it("fails the tip when the chain ID cannot be read, and reads no transaction", async () => {
    chain.failChainId = new Error("connection refused");
    const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip() } });
    expectFailure(await run(request), /Could not confirm the RPC for chain ID 1/);
    expect(chain.requests).toEqual(["eth_chainId"]);
  });

  it("checks again after a failure, and stops asking once the chain ID is confirmed", async () => {
    chain.reportChainId = 5;
    expectFailure(await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip() } })), /reports chain ID 5/);

    chain.reportChainId = undefined;
    expect(await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip() } }))).toMatchObject({ success: true });
    expect(await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip() } }))).toMatchObject({ success: true });
    expect(chain.requests.filter((method) => method === "eth_chainId")).toHaveLength(2);
  });

  it("confirms the chain ID before the first transaction request", async () => {
    await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip() } }));
    expect(chain.requests[0]).toBe("eth_chainId");
    expect(chain.requests).toContain("eth_getTransactionReceipt");
  });

  it("uses the RPC listed under the claim's chain ID", async () => {
    const tokens: TipToken[] = [usdc, { chainId: 8453, type: "erc20", address: USDC }];
    const settings = buildSettings({
      tokens,
      rpcUrls: JSON.stringify({ "1": "https://one.example", "8453": "https://base.example" })
    });
    const result = await run(await makeRequest(tipper, { tip: { chainId: 8453, txHash: usdcTip(2n) } }), settings);
    expect(result).toMatchObject({ success: true, commentUpdate: { tip: { chainId: 8453, amount: "2" } } });
  });
});

describe("the transaction", () => {
  it("rejects a transaction that is not mined", async () => {
    const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: newTxHash() } });
    expectFailure(await run(request), /tip transaction is not mined yet/);
  });

  it("rejects a transaction that failed on chain", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: USDC,
      status: "reverted",
      logs: [erc20Transfer(USDC, from, to, 5n)]
    });
    expectFailure(await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } })), /failed on chain/);
  });

  it("reports an RPC failure as a rejection, not a crash", async () => {
    chain.failWith = new Error("rate limited");
    const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip() } });
    expectFailure(await run(request), /Could not read the tip transaction from the chain/);
  });

  it("rejects a chain ID with no RPC configured", async () => {
    const request = await makeRequest(tipper, { tip: { chainId: 999_999, txHash: usdcTip() } });
    const settings = buildSettings({ tokens: [{ chainId: 999_999, type: "native" }] });
    expectFailure(await run(request, settings), /rpcUrls is required for chain ID 999999/);
    expect(chain.requests).toEqual([]);
  });

  it("rejects a transfer of a token that is not whitelisted", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: UNLISTED,
      logs: [erc20Transfer(UNLISTED, from, to, 5n)]
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } })),
      /does not transfer an accepted token/
    );
  });

  it("rejects somebody else's transfer to the recipient", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: USDC,
      logs: [erc20Transfer(USDC, stranger.wallet.address, to, 5n)]
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } })),
      /does not transfer an accepted token/
    );
  });

  it("rejects the tipper's transfer to somebody other than the recipient", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: USDC,
      logs: [erc20Transfer(USDC, from, stranger.wallet.address, 5n)]
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } })),
      /does not transfer an accepted token/
    );
  });

  it("does not read an ERC-721 event on an ERC-20 entry, or the reverse", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: USDC,
      logs: [erc721Transfer(USDC, from, to, 5n), erc20Transfer(NFT, from, to, 5n)]
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } })),
      /does not transfer an accepted token/
    );
  });
});

describe("the parent binding", () => {
  // transfer(address,uint256) to the recipient: what an ERC-20 tip's calldata looks like before the suffix.
  const transferCall = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, 5n] });
  const logs = [erc20Transfer(USDC, from, to, 5n)];
  const claimWith = async (input: Hex, tx: Partial<FakeTx> = {}): Promise<ChallengeResultInput> => {
    const hash = chain.add(newTxHash(), { from, to: USDC, logs, ...tx, input });
    return run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } }));
  };
  const noBinding = /tip transaction does not end with the parent binding/;

  it("accepts a token transfer whose calldata is followed by the suffix", async () => {
    expect(await claimWith(withBinding(PARENT_CID, transferCall))).toMatchObject({
      success: true,
      commentUpdate: { tip: { type: "erc20", amount: "5" } }
    });
  });

  it("rejects each kind of tip when the suffix is missing", async () => {
    expectFailure(await claimWith(transferCall), noBinding);
    expectFailure(await claimWith("0x", { to: NFT, logs: [erc721Transfer(NFT, from, to, 7n)] }), noBinding);
    expectFailure(await claimWith("0x", { to, value: 10n, logs: [] }), noBinding);
  });

  it("rejects a suffix made for another comment", async () => {
    expectFailure(await claimWith(withBinding(OTHER_PARENT_CID, transferCall)), noBinding);
  });

  it("rejects bytes after the suffix", async () => {
    expectFailure(await claimWith(concat([withBinding(PARENT_CID, transferCall), "0x00"])), noBinding);
    // an ERC-8021 builder code appended by a wallet is one more suffix after ours
    expectFailure(
      await claimWith(concat([withBinding(PARENT_CID, transferCall), withBinding(OTHER_PARENT_CID)])),
      noBinding
    );
  });

  it("rejects a suffix that differs in one byte or is cut short", async () => {
    const suffix = withBinding();
    expectFailure(await claimWith(`0x${suffix.slice(4)}`), noBinding);
    expectFailure(await claimWith(suffix.replace("5820", "5821") as Hex), noBinding);
    expectFailure(await claimWith(suffix.replace("002e02", "002e00") as Hex), noBinding);
  });

  it("binds to the parentCid string as written, without regard to the case of the transaction's hex", async () => {
    expect(await claimWith(withBinding().toUpperCase().replace("0X", "0x") as Hex)).toMatchObject({ success: true });
  });
});

describe("who sends the transaction", () => {
  it("rejects a tip submitted by another account, even when the Transfer is from the tipper", async () => {
    const hash = chain.add(newTxHash(), {
      from: stranger.wallet.address,
      to: USDC,
      logs: [erc20Transfer(USDC, from, to, 5n)]
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } })),
      /tip transaction was not sent by one of your proven wallets/
    );
  });

  it("accepts a transfer out of one proven wallet sent by another", async () => {
    const second = makeAuthor(51).wallet;
    const secondEntry = {
      address: second.address,
      timestamp: 1_700_000_000,
      signature: {
        signature: await second.signMessage({
          message: `{"domainSeparator":"bitsocial-author-wallet","authorPublicKey":"${tipper.keyAddress}","timestamp":1700000000}`
        }),
        type: "eip191"
      }
    };
    const hash = chain.add(newTxHash(), { from: second.address, to: USDC, logs: [erc20Transfer(USDC, from, to, 5n)] });
    const request = await makeRequest(tipper, {
      tip: { chainId: 1, txHash: hash },
      wallets: { eth: await signWallet(tipper), second: secondEntry }
    });
    expect(await run(request)).toMatchObject({ success: true, commentUpdate: { tip: { from, to } } });
  });

  it("checks the sender before the binding", async () => {
    const hash = chain.add(newTxHash(), { from: stranger.wallet.address, to, value: 5n, input: "0x" });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } })),
      /was not sent by one of your proven wallets/
    );
  });
});

describe("accepted tips", () => {
  it("accepts an ERC-20 tip and writes the verified result", async () => {
    const hash = usdcTip(5_000_000n);
    const result = await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } }));
    expect(result).toEqual({
      success: true,
      commentUpdate: {
        tip: { contract: "tipping/v1", chainId: 1, txHash: hash, type: "erc20", token: USDC, from, to, amount: "5000000" }
      }
    });
  });

  it("accepts an ERC-20 tip sent through a batching account, where the transaction goes to the wallet itself", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: from,
      logs: [erc20Transfer(USDC, from, to, 7n)]
    });
    const result = await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } }));
    expect(result).toMatchObject({ success: true, commentUpdate: { tip: { type: "erc20", amount: "7" } } });
  });

  it("accepts an ERC-721 tip and writes the token ID", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: NFT,
      logs: [erc721Transfer(NFT, from, to, 4242n)]
    });
    const result = await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } }));
    expect(result).toEqual({
      success: true,
      commentUpdate: { tip: { contract: "tipping/v1", chainId: 1, txHash: hash, type: "erc721", token: NFT, from, to, tokenId: "4242" } }
    });
  });

  it("accepts a direct native send and writes no token", async () => {
    const hash = chain.add(newTxHash(), { from, to, value: 10n ** 16n });
    const result = await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } }));
    expect(result).toEqual({
      success: true,
      commentUpdate: { tip: { contract: "tipping/v1", chainId: 1, txHash: hash, type: "native", from, to, amount: "10000000000000000" } }
    });
  });

  it("rejects a native send from another wallet", async () => {
    const hash = chain.add(newTxHash(), { from: stranger.wallet.address, to, value: 5n });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } })),
      /tip transaction was not sent by one of your proven wallets/
    );
  });

  it("rejects a native send to another wallet, or of zero value", async () => {
    const toStranger = chain.add(newTxHash(), { from, to: stranger.wallet.address, value: 5n });
    const zero = chain.add(newTxHash(), { from, to, value: 0n });
    for (const hash of [toStranger, zero]) {
      expectFailure(
        await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } })),
        /does not transfer an accepted token/
      );
    }
  });

  it("does not accept a native send when the native coin is not whitelisted", async () => {
    const hash = chain.add(newTxHash(), { from, to, value: 5n });
    const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } });
    expectFailure(await run(request, buildSettings({ tokens: [usdc] })), /does not transfer an accepted token/);
  });

  it("takes the first matching transfer when a transaction holds several", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: from,
      logs: [erc20Transfer(UNLISTED, from, to, 1n), erc20Transfer(USDC, from, to, 3n), erc721Transfer(NFT, from, to, 9n)]
    });
    const result = await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } }));
    expect(result).toMatchObject({ success: true, commentUpdate: { tip: { type: "erc20", token: USDC, amount: "3" } } });
  });

  it("matches the whitelist address without regard to case", async () => {
    const settings = buildSettings({ tokens: [{ ...usdc, address: USDC.toLowerCase() }] });
    expect(USDC).not.toBe(USDC.toLowerCase());
    const result = await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip() } }), settings);
    expect(result).toMatchObject({ success: true });
  });
});

describe("minimum amount", () => {
  const settings = buildSettings({ tokens: [{ ...usdc, minAmount: "1000000" }, { ...native, minAmount: "100" }] });

  it("rejects a tip below the minimum", async () => {
    const result = await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip(999_999n) } }), settings);
    expectFailure(result, /below this community's minimum of 1000000/);

    const dust = chain.add(newTxHash(), { from, to, value: 99n });
    expectFailure(await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: dust } }), settings), /minimum of 100/);
  });

  it("accepts a tip exactly at the minimum", async () => {
    const result = await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip(1_000_000n) } }), settings);
    expect(result).toMatchObject({ success: true });
  });
});

describe("community fee", () => {
  const percentSettings = buildSettings({ tokens: [{ ...usdc, fee: { percent: "2.5" } }], feeRecipient: FEE_RECIPIENT });

  it("accepts a percentage fee batched into the tip's transaction", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: from,
      logs: [erc20Transfer(USDC, from, to, 1_000_000n), erc20Transfer(USDC, from, FEE_RECIPIENT, 25_000n)]
    });
    const result = await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } }), percentSettings);
    expect(result).toEqual({
      success: true,
      commentUpdate: {
        tip: {
          contract: "tipping/v1",
          chainId: 1,
          txHash: hash,
          type: "erc20",
          token: USDC,
          from,
          to,
          amount: "1000000",
          fee: { txHash: hash, to: FEE_RECIPIENT, amount: "25000", token: USDC }
        }
      }
    });
  });

  it("accepts a percentage fee in a separate transaction", async () => {
    const tipHash = usdcTip(1_000_000n);
    const feeHash = chain.add(newTxHash(), {
      from,
      to: USDC,
      logs: [erc20Transfer(USDC, from, FEE_RECIPIENT, 30_000n)]
    });
    const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: tipHash, feeTxHash: feeHash } });
    const result = await run(request, percentSettings);
    expect(result).toMatchObject({
      success: true,
      commentUpdate: { tip: { amount: "1000000", fee: { txHash: feeHash, amount: "30000", token: USDC } } }
    });
  });

  it("rejects a tip that paid no fee", async () => {
    const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip(1_000_000n) } });
    expectFailure(await run(request, percentSettings), /owes the community a fee of 25000.*No such transfer is in the tip transaction/);
  });

  it("rejects a fee that is one unit short", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: from,
      logs: [erc20Transfer(USDC, from, to, 1_000_000n), erc20Transfer(USDC, from, FEE_RECIPIENT, 24_999n)]
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } }), percentSettings),
      /owes the community a fee of 25000/
    );
  });

  it("rejects a fee paid by another wallet, to another address, or in another token", async () => {
    const tipHash = usdcTip(1_000_000n);
    const cases = [
      erc20Transfer(USDC, stranger.wallet.address, FEE_RECIPIENT, 25_000n),
      erc20Transfer(USDC, from, stranger.wallet.address, 25_000n),
      erc20Transfer(DAI, from, FEE_RECIPIENT, 25_000n)
    ];
    for (const log of cases) {
      const feeHash = chain.add(newTxHash(), { from, to: USDC, logs: [log] });
      const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: tipHash, feeTxHash: feeHash } });
      expectFailure(await run(request, percentSettings), /The fee transaction does not contain it/);
    }
  });

  it("applies the transaction checks to the fee transaction too", async () => {
    const tipHash = usdcTip(1_000_000n);
    const log = erc20Transfer(USDC, from, FEE_RECIPIENT, 25_000n);
    const relayed = chain.add(newTxHash(), { from: stranger.wallet.address, to: USDC, logs: [log] });
    const unbound = chain.add(newTxHash(), { from, to: USDC, input: "0x", logs: [log] });
    const otherParent = chain.add(newTxHash(), { from, to: USDC, input: withBinding(OTHER_PARENT_CID), logs: [log] });
    const reverted = chain.add(newTxHash(), { from, to: USDC, status: "reverted", logs: [log] });

    const claim = (feeTxHash: string) => makeRequest(tipper, { tip: { chainId: 1, txHash: tipHash, feeTxHash } });
    expectFailure(await run(await claim(relayed), percentSettings), /fee transaction was not sent by one of your proven wallets/);
    expectFailure(await run(await claim(unbound), percentSettings), /fee transaction does not end with the parent binding/);
    expectFailure(await run(await claim(otherParent), percentSettings), /fee transaction does not end with the parent binding/);
    expectFailure(await run(await claim(reverted), percentSettings), /fee transaction failed on chain/);
    expectFailure(await run(await claim(newTxHash()), percentSettings), /fee transaction is not mined yet/);
  });

  it("owes nothing when the percentage rounds down to zero", async () => {
    const result = await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip(39n) } }), percentSettings);
    expect(result).toMatchObject({ success: true });
    expect((result as unknown as { commentUpdate: { tip: { fee?: unknown } } }).commentUpdate.tip.fee).toBeUndefined();
  });

  it("does not count the tip's own transfer as the fee when the fee recipient is the author being tipped", async () => {
    const settings = buildSettings({ tokens: [{ ...usdc, fee: { percent: "50" } }], feeRecipient: to });
    const alone = chain.add(newTxHash(), {
      from,
      to: from,
      logs: [erc20Transfer(USDC, from, to, 1000n)]
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: alone } }), settings),
      /owes the community a fee of 500/
    );

    const both = chain.add(newTxHash(), {
      from,
      to: from,
      logs: [erc20Transfer(USDC, from, to, 1000n), erc20Transfer(USDC, from, to, 500n)]
    });
    expect(await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: both } }), settings)).toMatchObject({
      success: true,
      commentUpdate: { tip: { amount: "1000", fee: { amount: "500" } } }
    });
  });

  it("charges a flat ERC-20 fee in the tipped token", async () => {
    const settings = buildSettings({ tokens: [{ ...usdc, fee: { amount: "500" } }], feeRecipient: FEE_RECIPIENT });
    const paid = chain.add(newTxHash(), {
      from,
      to: from,
      logs: [erc20Transfer(USDC, from, to, 10n), erc20Transfer(USDC, from, FEE_RECIPIENT, 500n)]
    });
    expect(await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: paid } }), settings)).toMatchObject({
      success: true,
      commentUpdate: { tip: { amount: "10", fee: { amount: "500", token: USDC } } }
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: usdcTip(10n) } }), settings),
      /owes the community a fee of 500/
    );
  });

  it("charges an ERC-721 tip a flat fee in the named ERC-20", async () => {
    const settings = buildSettings({
      tokens: [{ ...nft, fee: { amount: "1000000", token: USDC } }],
      feeRecipient: FEE_RECIPIENT
    });
    const paid = chain.add(newTxHash(), {
      from,
      to: from,
      logs: [erc721Transfer(NFT, from, to, 7n), erc20Transfer(USDC, from, FEE_RECIPIENT, 1_000_000n)]
    });
    expect(await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: paid } }), settings)).toMatchObject({
      success: true,
      commentUpdate: { tip: { type: "erc721", tokenId: "7", fee: { amount: "1000000", token: USDC } } }
    });

    const unpaid = chain.add(newTxHash(), {
      from,
      to: NFT,
      logs: [erc721Transfer(NFT, from, to, 8n)]
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: unpaid } }), settings),
      /owes the community a fee of 1000000/
    );
  });

  describe("native coin", () => {
    const settings = buildSettings({ tokens: [{ ...native, fee: { percent: "2" } }], feeRecipient: FEE_RECIPIENT });
    const nativeTip = (): string => chain.add(newTxHash(), { from, to, value: 1000n });

    it("accepts a native fee as a separate direct transaction", async () => {
      const tipHash = nativeTip();
      const feeHash = chain.add(newTxHash(), { from, to: FEE_RECIPIENT, value: 20n });
      const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: tipHash, feeTxHash: feeHash } });
      expect(await run(request, settings)).toEqual({
        success: true,
        commentUpdate: {
          tip: {
            contract: "tipping/v1",
            chainId: 1,
            txHash: tipHash,
            type: "native",
            from,
            to,
            amount: "1000",
            fee: { txHash: feeHash, to: FEE_RECIPIENT, amount: "20" }
          }
        }
      });
    });

    it("rejects a native tip with no fee transaction, or with the tip's own hash as the fee", async () => {
      const tipHash = nativeTip();
      expectFailure(
        await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: tipHash } }), settings),
        /must be a separate transaction/
      );
      expectFailure(
        await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: tipHash, feeTxHash: tipHash } }), settings),
        /must be a separate transaction/
      );
    });

    it("rejects a native fee that is short, to another address, or from another wallet", async () => {
      const tipHash = nativeTip();
      const short = chain.add(newTxHash(), { from, to: FEE_RECIPIENT, value: 19n });
      const fromStranger = chain.add(newTxHash(), {
        from: stranger.wallet.address,
        to: FEE_RECIPIENT,
        value: 20n
      });
      const elsewhere = chain.add(newTxHash(), { from, to: stranger.wallet.address, value: 20n });
      for (const feeTxHash of [short, elsewhere]) {
        const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: tipHash, feeTxHash } });
        expectFailure(await run(request, settings), /owes the community a fee of 20 in the native coin/);
      }
      const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: tipHash, feeTxHash: fromStranger } });
      expectFailure(await run(request, settings), /fee transaction was not sent by one of your proven wallets/);
    });
  });
});

describe("a transaction backs one tip only", () => {
  const now = Date.UTC(2026, 0, 1) / 1000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now * 1000);
    return () => vi.useRealTimers();
  });

  it("rejects a second publication claiming a transaction whose first claim landed", async () => {
    const hash = usdcTip();
    const first = await makeRequest(tipper, { tip: { chainId: 1, txHash: hash }, signature: "first" });
    expect(await run(first)).toMatchObject({ success: true });
    community.landedSignatures.add("first");

    vi.setSystemTime((now + RECLAIM_AFTER_SECONDS * 10) * 1000);
    const second = await makeRequest(tipper, { tip: { chainId: 1, txHash: hash }, signature: "second" });
    expectFailure(await run(second), /has already been used for a tip in this community/);
  });

  it("lets the same publication be verified again", async () => {
    const hash = usdcTip();
    const request = await makeRequest(tipper, { tip: { chainId: 1, txHash: hash }, signature: "same" });
    expect(await run(request)).toMatchObject({ success: true });
    expect(await run(request)).toMatchObject({ success: true });
  });

  it("holds a transaction for a claim that has not landed yet, then releases it", async () => {
    const hash = usdcTip();
    const first = await makeRequest(tipper, { tip: { chainId: 1, txHash: hash }, signature: "abandoned" });
    expect(await run(first)).toMatchObject({ success: true });

    const second = await makeRequest(tipper, { tip: { chainId: 1, txHash: hash }, signature: "retry" });
    vi.setSystemTime((now + RECLAIM_AFTER_SECONDS - 1) * 1000);
    expectFailure(await run(second), /has already been used/);

    vi.setSystemTime((now + RECLAIM_AFTER_SECONDS) * 1000);
    expect(await run(second)).toMatchObject({ success: true });

    // and the transaction now belongs to the second publication
    community.landedSignatures.add("retry");
    vi.setSystemTime((now + RECLAIM_AFTER_SECONDS * 5) * 1000);
    expectFailure(await run(first), /has already been used/);
  });

  it("lets only one of two simultaneous claims through", async () => {
    const hash = usdcTip();
    const a = await makeRequest(tipper, { tip: { chainId: 1, txHash: hash }, signature: "a" });
    const b = await makeRequest(tipper, { tip: { chainId: 1, txHash: hash }, signature: "b" });
    const results = await Promise.all([run(a), run(b)]);
    expect(results.filter((result) => "success" in result && result.success === true)).toHaveLength(1);
  });

  it("does not let a fee transaction pay for two tips, or serve as another tip", async () => {
    const settings = buildSettings({ tokens: [{ ...usdc, fee: { percent: "2.5" } }], feeRecipient: FEE_RECIPIENT });
    const feeHash = chain.add(newTxHash(), {
      from,
      to: USDC,
      logs: [erc20Transfer(USDC, from, FEE_RECIPIENT, 25_000n)]
    });

    const first = await makeRequest(tipper, {
      tip: { chainId: 1, txHash: usdcTip(1_000_000n), feeTxHash: feeHash },
      signature: "fee-first"
    });
    expect(await run(first, settings)).toMatchObject({ success: true });
    community.landedSignatures.add("fee-first");

    const second = await makeRequest(tipper, {
      tip: { chainId: 1, txHash: usdcTip(1_000_000n), feeTxHash: feeHash },
      signature: "fee-second"
    });
    const result = await run(second, settings);
    expectFailure(result, /has already been used/);
    expect((result as { error: string }).error).toContain(feeHash);
  });

  it("does not burn a transaction when the claim is rejected", async () => {
    const settings = buildSettings({ tokens: [{ ...usdc, fee: { percent: "2.5" } }], feeRecipient: FEE_RECIPIENT });
    const tipHash = usdcTip(1_000_000n);
    const unpaid = await makeRequest(tipper, { tip: { chainId: 1, txHash: tipHash }, signature: "unpaid" });
    expectFailure(await run(unpaid, settings), /owes the community a fee/);

    const feeHash = chain.add(newTxHash(), {
      from,
      to: USDC,
      logs: [erc20Transfer(USDC, from, FEE_RECIPIENT, 25_000n)]
    });
    const paid = await makeRequest(tipper, { tip: { chainId: 1, txHash: tipHash, feeTxHash: feeHash }, signature: "paid" });
    expect(await run(paid, settings)).toMatchObject({ success: true });
  });

  it("does not confuse the same hash on two chain IDs", async () => {
    const tokens: TipToken[] = [usdc, { chainId: 8453, type: "erc20", address: USDC }];
    const settings = buildSettings({ tokens });
    const hash = usdcTip();

    const onMainnet = await makeRequest(tipper, { tip: { chainId: 1, txHash: hash }, signature: "mainnet" });
    expect(await run(onMainnet, settings)).toMatchObject({ success: true, commentUpdate: { tip: { chainId: 1 } } });
    community.landedSignatures.add("mainnet");

    const onBase = await makeRequest(tipper, { tip: { chainId: 8453, txHash: hash }, signature: "base" });
    expect(await run(onBase, settings)).toMatchObject({ success: true, commentUpdate: { tip: { chainId: 8453 } } });
    community.landedSignatures.add("base");

    vi.setSystemTime((now + RECLAIM_AFTER_SECONDS * 10) * 1000);
    const again = await makeRequest(tipper, { tip: { chainId: 8453, txHash: hash }, signature: "base-again" });
    expectFailure(await run(again, settings), /has already been used/);
  });

  it("does not let a transaction back a tip on another comment, in this community or in another one", async () => {
    const hash = usdcTip();
    expect(await run(await makeRequest(tipper, { tip: { chainId: 1, txHash: hash } }))).toMatchObject({ success: true });

    // A comment CID covers the community address, so a parent in another community has another CID.
    await addParentComment(community, recipient, { cid: OTHER_PARENT_CID });
    const other = makeCommunity("12D3KooWCommunityTwo", community.storage);
    await addParentComment(other, recipient, { cid: OTHER_PARENT_CID });

    for (const target of [community, other]) {
      const request = await makeRequest(tipper, { parentCid: OTHER_PARENT_CID, tip: { chainId: 1, txHash: hash } });
      expectFailure(
        await run(request, buildSettings({ tokens: allTokens }), target),
        /tip transaction does not end with the parent binding/
      );
    }
  });
});

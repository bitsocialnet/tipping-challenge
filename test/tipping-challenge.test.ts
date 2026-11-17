import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, type Address } from "viem";
import { getChallenge, RECLAIM_AFTER_SECONDS } from "../src/tipping-challenge.js";
import type { TipToken } from "../src/contract.js";
import type { ChallengeResultInput, GetChallengeArgsInput } from "../src/types.js";
import {
  addParentComment,
  AFTER_PARENT,
  buildSettings,
  erc20Transfer,
  erc721Transfer,
  FakeChain,
  makeAuthor,
  makeCommunity,
  makeRequest,
  newTxHash,
  PARENT_TIMESTAMP,
  signWallet,
  uninstallFakeChain,
  type FakeCommunity
} from "./helpers.js";

// Placeholder contracts, not real tokens.
const USDC: Address = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0001");
const DAI: Address = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0002");
const NFT: Address = "0x2222222222222222222222222222222222222222";
const UNLISTED: Address = "0x4444444444444444444444444444444444444444";
const FEE_RECIPIENT: Address = "0x1111111111111111111111111111111111111111";

const tipper = makeAuthor(1);
const recipient = makeAuthor(2);
const stranger = makeAuthor(3);

const from = tipper.wallet.address;
const to = recipient.wallet.address;

const native: TipToken = { chainTicker: "eth", type: "native" };
const usdc: TipToken = { chainTicker: "eth", type: "erc20", address: USDC };
const nft: TipToken = { chainTicker: "eth", type: "erc721", address: NFT };
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
    community: target.asCommunity()
  });

const expectFailure = (result: ChallengeResultInput, message: RegExp): void => {
  expect(result).toEqual({ success: false, error: expect.stringMatching(message) });
};

const usdcTip = (amount = 5_000_000n): string =>
  chain.add(newTxHash(), { from, to: USDC, blockTimestamp: AFTER_PARENT, logs: [erc20Transfer(USDC, from, to, amount)] });

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
    const request = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: usdcTip() } });
    expectFailure(await run(request, buildSettings({ tokens: "[" })), /Invalid tipping challenge settings/);
  });

  it("rejects a malformed claim", async () => {
    expectFailure(await run(await makeRequest(tipper, { tip: "0xabc" })), /Invalid tip: tip must be an object/);
    expectFailure(await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: "0x12" } })), /tip.txHash/);
  });

  it("rejects a claim carrying fields that imitate the verified result", async () => {
    const request = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: usdcTip(), amount: "999", from, to } });
    expectFailure(await run(request), /unknown key/);
  });

  it("reads the claim from the top level of the comment too", async () => {
    const hash = usdcTip(3n);
    const request = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash }, tipLocation: "topLevel" });
    expect(await run(request)).toMatchObject({ success: true, commentUpdate: { tip: { txHash: hash, amount: "3" } } });
  });

  it("accepts the same claim in both places, and rejects two that differ", async () => {
    const hash = usdcTip(3n);
    const same = await makeRequest(tipper, {
      tip: { chainTicker: "eth", txHash: hash },
      topLevelTip: { chainTicker: "eth", txHash: hash.toUpperCase().replace("0X", "0x") }
    });
    expect(await run(same)).toMatchObject({ success: true });

    const differ = await makeRequest(tipper, {
      tip: { chainTicker: "eth", txHash: usdcTip(3n) },
      topLevelTip: { chainTicker: "eth", txHash: usdcTip(4n) }
    });
    expectFailure(await run(differ), /both present and differ/);

    const malformedSecond = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: usdcTip(3n) }, topLevelTip: "x" });
    expectFailure(await run(malformedSecond), /Invalid tip/);
  });

  it("rejects a tip on a post", async () => {
    const request = await makeRequest(tipper, { parentCid: null, tip: { chainTicker: "eth", txHash: usdcTip() } });
    expectFailure(await run(request), /must be a reply/);
  });

  it("rejects a chain the community does not accept", async () => {
    const request = await makeRequest(tipper, { tip: { chainTicker: "base", txHash: usdcTip() }, chainTicker: "base" });
    expectFailure(await run(request), /does not accept tips on chain "base"/);
  });

  it("rejects a tip on a comment the community does not have", async () => {
    const request = await makeRequest(tipper, { parentCid: "QmUnknown", tip: { chainTicker: "eth", txHash: usdcTip() } });
    expectFailure(await run(request), /was not found in this community/);
  });
});

describe("who is tipping whom", () => {
  it("rejects a tip on your own comment", async () => {
    const request = await makeRequest(recipient, { tip: { chainTicker: "eth", txHash: usdcTip() } });
    expectFailure(await run(request), /cannot tip your own comment/);
  });

  it("rejects two authors sharing one wallet", async () => {
    // The tipper proves the same wallet the recipient uses: a different key, the same money.
    const sharedWallet = await recipient.wallet.signMessage({
      message: `{"domainSeparator":"bitsocial-author-wallet","authorPublicKey":"${tipper.keyAddress}","timestamp":1700000000}`
    });
    const request = await makeRequest(tipper, {
      tip: { chainTicker: "eth", txHash: usdcTip() },
      wallets: { eth: { address: to, timestamp: 1_700_000_000, signature: { signature: sharedWallet, type: "eip191" } } }
    });
    expectFailure(await run(request), /cannot tip your own wallet/);
  });

  it("rejects a tipper with no wallet on that chain", async () => {
    const request = await makeRequest(tipper, { wallets: null, tip: { chainTicker: "eth", txHash: usdcTip() } });
    expectFailure(await run(request), /Your author.wallets\["eth"\] entry is not valid: has no wallet/);
  });

  it("rejects a tipper who lists a wallet entry copied from someone else", async () => {
    const request = await makeRequest(tipper, {
      wallets: { eth: await signWallet(stranger) },
      tip: { chainTicker: "eth", txHash: usdcTip() }
    });
    expectFailure(await run(request), /Your author.wallets\["eth"\] entry is not valid: wallet signature does not prove/);
  });

  it("rejects a tipper whose wallet was signed with the old separator", async () => {
    const message = `{"domainSeparator":"pkc-author-wallet","authorAddress":"${tipper.keyAddress}","timestamp":1700000000}`;
    const request = await makeRequest(tipper, {
      wallets: { eth: await signWallet(tipper, { message }) },
      tip: { chainTicker: "eth", txHash: usdcTip() }
    });
    expectFailure(await run(request), /does not prove/);
  });

  it("rejects a recipient with no wallet on that chain", async () => {
    await addParentComment(community, recipient, { wallets: null });
    const request = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: usdcTip() } });
    expectFailure(await run(request), /author being tipped has no valid author.wallets\["eth"\] entry.*has no wallet/);
  });

  it("rejects a recipient whose wallet proof is not theirs", async () => {
    await addParentComment(community, recipient, { wallets: { eth: await signWallet(stranger) } });
    const hash = chain.add(newTxHash(), {
      from,
      to: USDC,
      blockTimestamp: AFTER_PARENT,
      logs: [erc20Transfer(USDC, from, stranger.wallet.address, 5n)]
    });
    const request = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash } });
    expectFailure(await run(request), /author being tipped has no valid.*does not prove/);
  });

  it("reads the wallet for the claimed chain, not another one", async () => {
    await addParentComment(community, recipient, { chainTicker: "base" });
    const request = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: usdcTip() } });
    expectFailure(await run(request), /author being tipped has no valid/);
  });
});

describe("the transaction", () => {
  it("rejects a transaction that is not mined", async () => {
    const request = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: newTxHash() } });
    expectFailure(await run(request), /tip transaction is not mined yet/);
  });

  it("rejects a transaction that failed on chain", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: USDC,
      status: "reverted",
      blockTimestamp: AFTER_PARENT,
      logs: [erc20Transfer(USDC, from, to, 5n)]
    });
    expectFailure(await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash } })), /failed on chain/);
  });

  it("rejects a transaction older than the comment being tipped, and accepts one from the same second", async () => {
    const old = chain.add(newTxHash(), {
      from,
      to: USDC,
      blockTimestamp: PARENT_TIMESTAMP - 1,
      logs: [erc20Transfer(USDC, from, to, 5n)]
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: old } })),
      /older than the comment being tipped/
    );

    const sameSecond = chain.add(newTxHash(), {
      from,
      to: USDC,
      blockTimestamp: PARENT_TIMESTAMP,
      logs: [erc20Transfer(USDC, from, to, 5n)]
    });
    const result = await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: sameSecond } }));
    expect(result).toMatchObject({ success: true });
  });

  it("reports an RPC failure as a rejection, not a crash", async () => {
    chain.failWith = new Error("rate limited");
    const request = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: usdcTip() } });
    expectFailure(await run(request), /Could not read the tip transaction from the chain/);
  });

  it("rejects a chain with no RPC configured", async () => {
    await addParentComment(community, recipient, { chainTicker: "mychain" });
    const request = await makeRequest(tipper, { tip: { chainTicker: "mychain", txHash: usdcTip() }, chainTicker: "mychain" });
    const settings = buildSettings({ tokens: [{ chainTicker: "mychain", type: "native" }] });
    expectFailure(await run(request, settings), /rpcUrls is required for chainTicker "mychain"/);
  });

  it("rejects a transfer of a token that is not whitelisted", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: UNLISTED,
      blockTimestamp: AFTER_PARENT,
      logs: [erc20Transfer(UNLISTED, from, to, 5n)]
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash } })),
      /does not transfer an accepted token/
    );
  });

  it("rejects somebody else's transfer to the recipient", async () => {
    const hash = chain.add(newTxHash(), {
      from: stranger.wallet.address,
      to: USDC,
      blockTimestamp: AFTER_PARENT,
      logs: [erc20Transfer(USDC, stranger.wallet.address, to, 5n)]
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash } })),
      /does not transfer an accepted token/
    );
  });

  it("rejects the tipper's transfer to somebody other than the recipient", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: USDC,
      blockTimestamp: AFTER_PARENT,
      logs: [erc20Transfer(USDC, from, stranger.wallet.address, 5n)]
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash } })),
      /does not transfer an accepted token/
    );
  });

  it("does not read an ERC-721 event on an ERC-20 entry, or the reverse", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: USDC,
      blockTimestamp: AFTER_PARENT,
      logs: [erc721Transfer(USDC, from, to, 5n), erc20Transfer(NFT, from, to, 5n)]
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash } })),
      /does not transfer an accepted token/
    );
  });
});

describe("accepted tips", () => {
  it("accepts an ERC-20 tip and writes the verified result", async () => {
    const hash = usdcTip(5_000_000n);
    const result = await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash } }));
    expect(result).toEqual({
      success: true,
      commentUpdate: {
        tip: { chainTicker: "eth", txHash: hash, type: "erc20", token: USDC, from, to, amount: "5000000" }
      }
    });
  });

  it("accepts an ERC-20 tip sent through a batching account, where the transaction goes to the wallet itself", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: from,
      blockTimestamp: AFTER_PARENT,
      logs: [erc20Transfer(USDC, from, to, 7n)]
    });
    const result = await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash } }));
    expect(result).toMatchObject({ success: true, commentUpdate: { tip: { type: "erc20", amount: "7" } } });
  });

  it("accepts an ERC-721 tip and writes the token ID", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: NFT,
      blockTimestamp: AFTER_PARENT,
      logs: [erc721Transfer(NFT, from, to, 4242n)]
    });
    const result = await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash } }));
    expect(result).toEqual({
      success: true,
      commentUpdate: { tip: { chainTicker: "eth", txHash: hash, type: "erc721", token: NFT, from, to, tokenId: "4242" } }
    });
  });

  it("accepts a direct native send and writes no token", async () => {
    const hash = chain.add(newTxHash(), { from, to, value: 10n ** 16n, blockTimestamp: AFTER_PARENT });
    const result = await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash } }));
    expect(result).toEqual({
      success: true,
      commentUpdate: { tip: { chainTicker: "eth", txHash: hash, type: "native", from, to, amount: "10000000000000000" } }
    });
  });

  it("rejects a native send from another wallet, to another wallet, or of zero value", async () => {
    const fromStranger = chain.add(newTxHash(), { from: stranger.wallet.address, to, value: 5n, blockTimestamp: AFTER_PARENT });
    const toStranger = chain.add(newTxHash(), { from, to: stranger.wallet.address, value: 5n, blockTimestamp: AFTER_PARENT });
    const zero = chain.add(newTxHash(), { from, to, value: 0n, blockTimestamp: AFTER_PARENT });
    for (const hash of [fromStranger, toStranger, zero]) {
      expectFailure(
        await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash } })),
        /does not transfer an accepted token/
      );
    }
  });

  it("does not accept a native send when the native coin is not whitelisted", async () => {
    const hash = chain.add(newTxHash(), { from, to, value: 5n, blockTimestamp: AFTER_PARENT });
    const request = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash } });
    expectFailure(await run(request, buildSettings({ tokens: [usdc] })), /does not transfer an accepted token/);
    // and it did not spend a request on the transaction's value
    expect(chain.requests).not.toContain("eth_getTransactionByHash");
  });

  it("takes the first matching transfer when a transaction holds several", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: from,
      blockTimestamp: AFTER_PARENT,
      logs: [erc20Transfer(UNLISTED, from, to, 1n), erc20Transfer(USDC, from, to, 3n), erc721Transfer(NFT, from, to, 9n)]
    });
    const result = await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash } }));
    expect(result).toMatchObject({ success: true, commentUpdate: { tip: { type: "erc20", token: USDC, amount: "3" } } });
  });

  it("matches the whitelist address without regard to case", async () => {
    const settings = buildSettings({ tokens: [{ ...usdc, address: USDC.toLowerCase() }] });
    expect(USDC).not.toBe(USDC.toLowerCase());
    const result = await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: usdcTip() } }), settings);
    expect(result).toMatchObject({ success: true });
  });
});

describe("minimum amount", () => {
  const settings = buildSettings({ tokens: [{ ...usdc, minAmount: "1000000" }, { ...native, minAmount: "100" }] });

  it("rejects a tip below the minimum", async () => {
    const result = await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: usdcTip(999_999n) } }), settings);
    expectFailure(result, /below this community's minimum of 1000000/);

    const dust = chain.add(newTxHash(), { from, to, value: 99n, blockTimestamp: AFTER_PARENT });
    expectFailure(await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: dust } }), settings), /minimum of 100/);
  });

  it("accepts a tip exactly at the minimum", async () => {
    const result = await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: usdcTip(1_000_000n) } }), settings);
    expect(result).toMatchObject({ success: true });
  });
});

describe("community fee", () => {
  const percentSettings = buildSettings({ tokens: [{ ...usdc, fee: { percent: "2.5" } }], feeRecipient: FEE_RECIPIENT });

  it("accepts a percentage fee batched into the tip's transaction", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: from,
      blockTimestamp: AFTER_PARENT,
      logs: [erc20Transfer(USDC, from, to, 1_000_000n), erc20Transfer(USDC, from, FEE_RECIPIENT, 25_000n)]
    });
    const result = await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash } }), percentSettings);
    expect(result).toEqual({
      success: true,
      commentUpdate: {
        tip: {
          chainTicker: "eth",
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
      blockTimestamp: AFTER_PARENT,
      logs: [erc20Transfer(USDC, from, FEE_RECIPIENT, 30_000n)]
    });
    const request = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: tipHash, feeTxHash: feeHash } });
    const result = await run(request, percentSettings);
    expect(result).toMatchObject({
      success: true,
      commentUpdate: { tip: { amount: "1000000", fee: { txHash: feeHash, amount: "30000", token: USDC } } }
    });
  });

  it("rejects a tip that paid no fee", async () => {
    const request = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: usdcTip(1_000_000n) } });
    expectFailure(await run(request, percentSettings), /owes the community a fee of 25000.*No such transfer is in the tip transaction/);
  });

  it("rejects a fee that is one unit short", async () => {
    const hash = chain.add(newTxHash(), {
      from,
      to: from,
      blockTimestamp: AFTER_PARENT,
      logs: [erc20Transfer(USDC, from, to, 1_000_000n), erc20Transfer(USDC, from, FEE_RECIPIENT, 24_999n)]
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash } }), percentSettings),
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
      const feeHash = chain.add(newTxHash(), { from, to: USDC, blockTimestamp: AFTER_PARENT, logs: [log] });
      const request = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: tipHash, feeTxHash: feeHash } });
      expectFailure(await run(request, percentSettings), /The fee transaction does not contain it/);
    }
  });

  it("applies the transaction checks to the fee transaction too", async () => {
    const tipHash = usdcTip(1_000_000n);
    const log = erc20Transfer(USDC, from, FEE_RECIPIENT, 25_000n);
    const old = chain.add(newTxHash(), { from, to: USDC, blockTimestamp: PARENT_TIMESTAMP - 1, logs: [log] });
    const reverted = chain.add(newTxHash(), { from, to: USDC, status: "reverted", blockTimestamp: AFTER_PARENT, logs: [log] });

    const claim = (feeTxHash: string) => makeRequest(tipper, { tip: { chainTicker: "eth", txHash: tipHash, feeTxHash } });
    expectFailure(await run(await claim(old), percentSettings), /fee transaction is older than the comment/);
    expectFailure(await run(await claim(reverted), percentSettings), /fee transaction failed on chain/);
    expectFailure(await run(await claim(newTxHash()), percentSettings), /fee transaction is not mined yet/);
  });

  it("owes nothing when the percentage rounds down to zero", async () => {
    const result = await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: usdcTip(39n) } }), percentSettings);
    expect(result).toMatchObject({ success: true });
    expect((result as unknown as { commentUpdate: { tip: { fee?: unknown } } }).commentUpdate.tip.fee).toBeUndefined();
  });

  it("does not count the tip's own transfer as the fee when the fee recipient is the author being tipped", async () => {
    const settings = buildSettings({ tokens: [{ ...usdc, fee: { percent: "50" } }], feeRecipient: to });
    const alone = chain.add(newTxHash(), {
      from,
      to: from,
      blockTimestamp: AFTER_PARENT,
      logs: [erc20Transfer(USDC, from, to, 1000n)]
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: alone } }), settings),
      /owes the community a fee of 500/
    );

    const both = chain.add(newTxHash(), {
      from,
      to: from,
      blockTimestamp: AFTER_PARENT,
      logs: [erc20Transfer(USDC, from, to, 1000n), erc20Transfer(USDC, from, to, 500n)]
    });
    expect(await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: both } }), settings)).toMatchObject({
      success: true,
      commentUpdate: { tip: { amount: "1000", fee: { amount: "500" } } }
    });
  });

  it("charges a flat ERC-20 fee in the tipped token", async () => {
    const settings = buildSettings({ tokens: [{ ...usdc, fee: { amount: "500" } }], feeRecipient: FEE_RECIPIENT });
    const paid = chain.add(newTxHash(), {
      from,
      to: from,
      blockTimestamp: AFTER_PARENT,
      logs: [erc20Transfer(USDC, from, to, 10n), erc20Transfer(USDC, from, FEE_RECIPIENT, 500n)]
    });
    expect(await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: paid } }), settings)).toMatchObject({
      success: true,
      commentUpdate: { tip: { amount: "10", fee: { amount: "500", token: USDC } } }
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: usdcTip(10n) } }), settings),
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
      blockTimestamp: AFTER_PARENT,
      logs: [erc721Transfer(NFT, from, to, 7n), erc20Transfer(USDC, from, FEE_RECIPIENT, 1_000_000n)]
    });
    expect(await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: paid } }), settings)).toMatchObject({
      success: true,
      commentUpdate: { tip: { type: "erc721", tokenId: "7", fee: { amount: "1000000", token: USDC } } }
    });

    const unpaid = chain.add(newTxHash(), {
      from,
      to: NFT,
      blockTimestamp: AFTER_PARENT,
      logs: [erc721Transfer(NFT, from, to, 8n)]
    });
    expectFailure(
      await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: unpaid } }), settings),
      /owes the community a fee of 1000000/
    );
  });

  describe("native coin", () => {
    const settings = buildSettings({ tokens: [{ ...native, fee: { percent: "2" } }], feeRecipient: FEE_RECIPIENT });
    const nativeTip = (): string => chain.add(newTxHash(), { from, to, value: 1000n, blockTimestamp: AFTER_PARENT });

    it("accepts a native fee as a separate direct transaction", async () => {
      const tipHash = nativeTip();
      const feeHash = chain.add(newTxHash(), { from, to: FEE_RECIPIENT, value: 20n, blockTimestamp: AFTER_PARENT });
      const request = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: tipHash, feeTxHash: feeHash } });
      expect(await run(request, settings)).toEqual({
        success: true,
        commentUpdate: {
          tip: {
            chainTicker: "eth",
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
        await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: tipHash } }), settings),
        /must be a separate transaction/
      );
      expectFailure(
        await run(await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: tipHash, feeTxHash: tipHash } }), settings),
        /must be a separate transaction/
      );
    });

    it("rejects a native fee that is short, from another wallet, or to another address", async () => {
      const tipHash = nativeTip();
      const short = chain.add(newTxHash(), { from, to: FEE_RECIPIENT, value: 19n, blockTimestamp: AFTER_PARENT });
      const fromStranger = chain.add(newTxHash(), {
        from: stranger.wallet.address,
        to: FEE_RECIPIENT,
        value: 20n,
        blockTimestamp: AFTER_PARENT
      });
      const elsewhere = chain.add(newTxHash(), { from, to: stranger.wallet.address, value: 20n, blockTimestamp: AFTER_PARENT });
      for (const feeTxHash of [short, fromStranger, elsewhere]) {
        const request = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: tipHash, feeTxHash } });
        expectFailure(await run(request, settings), /owes the community a fee of 20 in the native coin/);
      }
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
    const first = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash }, signature: "first" });
    expect(await run(first)).toMatchObject({ success: true });
    community.landedSignatures.add("first");

    vi.setSystemTime((now + RECLAIM_AFTER_SECONDS * 10) * 1000);
    const second = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash }, signature: "second" });
    expectFailure(await run(second), /has already been used for a tip in this community/);
  });

  it("lets the same publication be verified again", async () => {
    const hash = usdcTip();
    const request = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash }, signature: "same" });
    expect(await run(request)).toMatchObject({ success: true });
    expect(await run(request)).toMatchObject({ success: true });
  });

  it("holds a transaction for a claim that has not landed yet, then releases it", async () => {
    const hash = usdcTip();
    const first = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash }, signature: "abandoned" });
    expect(await run(first)).toMatchObject({ success: true });

    const second = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash }, signature: "retry" });
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
    const a = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash }, signature: "a" });
    const b = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash }, signature: "b" });
    const results = await Promise.all([run(a), run(b)]);
    expect(results.filter((result) => "success" in result && result.success === true)).toHaveLength(1);
  });

  it("does not let a fee transaction pay for two tips, or serve as another tip", async () => {
    const settings = buildSettings({ tokens: [{ ...usdc, fee: { percent: "2.5" } }], feeRecipient: FEE_RECIPIENT });
    const feeHash = chain.add(newTxHash(), {
      from,
      to: USDC,
      blockTimestamp: AFTER_PARENT,
      logs: [erc20Transfer(USDC, from, FEE_RECIPIENT, 25_000n)]
    });

    const first = await makeRequest(tipper, {
      tip: { chainTicker: "eth", txHash: usdcTip(1_000_000n), feeTxHash: feeHash },
      signature: "fee-first"
    });
    expect(await run(first, settings)).toMatchObject({ success: true });
    community.landedSignatures.add("fee-first");

    const second = await makeRequest(tipper, {
      tip: { chainTicker: "eth", txHash: usdcTip(1_000_000n), feeTxHash: feeHash },
      signature: "fee-second"
    });
    const result = await run(second, settings);
    expectFailure(result, /has already been used/);
    expect((result as { error: string }).error).toContain(feeHash);
  });

  it("does not burn a transaction when the claim is rejected", async () => {
    const settings = buildSettings({ tokens: [{ ...usdc, fee: { percent: "2.5" } }], feeRecipient: FEE_RECIPIENT });
    const tipHash = usdcTip(1_000_000n);
    const unpaid = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: tipHash }, signature: "unpaid" });
    expectFailure(await run(unpaid, settings), /owes the community a fee/);

    const feeHash = chain.add(newTxHash(), {
      from,
      to: USDC,
      blockTimestamp: AFTER_PARENT,
      logs: [erc20Transfer(USDC, from, FEE_RECIPIENT, 25_000n)]
    });
    const paid = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: tipHash, feeTxHash: feeHash }, signature: "paid" });
    expect(await run(paid, settings)).toMatchObject({ success: true });
  });

  it("the known gap: another community on the same node can accept the same transaction once", async () => {
    const hash = usdcTip();
    const sharedStorage = community.storage;
    const other = makeCommunity("12D3KooWCommunityTwo", sharedStorage);
    await addParentComment(other, recipient);

    const first = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash }, signature: "one" });
    const second = await makeRequest(tipper, { tip: { chainTicker: "eth", txHash: hash }, signature: "two" });
    expect(await run(first)).toMatchObject({ success: true });
    expect(await run(second, buildSettings({ tokens: allTokens }), other)).toMatchObject({ success: true });
  });
});

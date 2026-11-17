import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import {
  getKeyAddressFromPublicKey,
  getRequiredFee,
  getWalletMessageToSign,
  parseTipClaim,
  parseTipTokens,
  type TipToken
} from "../src/contract.js";
import { verifyWalletProof } from "../src/wallet-proof.js";
import { makeAuthor, signWallet, WALLET_TIMESTAMP } from "./helpers.js";

// Placeholder contracts, not real tokens.
const USDC = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0001");
const NFT = "0x2222222222222222222222222222222222222222";

const tokens = (list: unknown): string => JSON.stringify(list);

describe("getKeyAddressFromPublicKey", () => {
  // Expected values produced by pkc-js getPKCAddressFromPublicKey for the same keys.
  it.each([
    ["AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "12D3KooW9pNAk8aiBuGVQtWRdbkLmo5qVL3e2h5UxbN2Nz9ttwiw"],
    ["AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=", "12D3KooW9tJMax94Lrqw7Y5Qw36viGQAS2gTEPQ5Wg1vTk7xPfQs"],
    ["//////////////////////////////////////////8=", "12D3KooWT3gYEvLJyx1FyyHqrmvdy1tMjpgxmu9aSeKMEuafQtyC"]
  ])("derives the same key address as pkc-js for %s", (publicKey, expected) => {
    expect(getKeyAddressFromPublicKey(publicKey)).toBe(expected);
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => getKeyAddressFromPublicKey("AAAA")).toThrow(/32 bytes/);
  });
});

describe("getWalletMessageToSign", () => {
  it("is the exact agreed string", () => {
    expect(getWalletMessageToSign("12D3KooWabc", 1700000000)).toBe(
      '{"domainSeparator":"bitsocial-author-wallet","authorPublicKey":"12D3KooWabc","timestamp":1700000000}'
    );
  });
});

describe("parseTipTokens", () => {
  it("accepts the documented example", () => {
    const parsed = parseTipTokens(
      tokens([
        { chainTicker: "eth", type: "native", minAmount: "1000000000000000", fee: { percent: "2" } },
        { chainTicker: "eth", type: "erc20", address: USDC, minAmount: "1000000", fee: { percent: "2.5" } },
        { chainTicker: "eth", type: "erc20", address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0002", fee: { amount: "500000000000000000" } },
        { chainTicker: "eth", type: "erc721", address: NFT, fee: { amount: "1000000", token: USDC } },
        { chainTicker: "eth", type: "erc721", address: "0x3333333333333333333333333333333333333333" }
      ])
    );
    expect(parsed).toHaveLength(5);
    expect(parsed[3]).toEqual({ chainTicker: "eth", type: "erc721", address: NFT, fee: { amount: "1000000", token: USDC } });
  });

  it.each<[string, string | undefined, RegExp]>([
    ["missing option", undefined, /is required/],
    ["invalid JSON", "[", /not valid JSON/],
    ["not an array", "{}", /must be a JSON array/],
    ["empty list", "[]", /at least one token/],
    ["entry not an object", tokens(["eth"]), /\[0\] must be an object/],
    ["unknown key", tokens([{ chainTicker: "eth", type: "native", feee: {} }]), /unknown key "feee"/],
    ["missing chainTicker", tokens([{ type: "native" }]), /chainTicker must be a non-empty string/],
    ["unknown type", tokens([{ chainTicker: "eth", type: "erc1155", address: NFT }]), /type must be one of/],
    ["native with address", tokens([{ chainTicker: "eth", type: "native", address: USDC }]), /left out for the native coin/],
    ["erc20 without address", tokens([{ chainTicker: "eth", type: "erc20" }]), /0x address/],
    ["erc20 with a name as address", tokens([{ chainTicker: "eth", type: "erc20", address: "usdc.eth" }]), /0x address/],
    [
      "erc20 with a mistyped mixed-case address",
      tokens([{ chainTicker: "eth", type: "erc20", address: USDC.slice(0, -1) + (USDC.endsWith("1") ? "2" : "1") }]),
      /valid checksum/
    ],
    [
      "flat erc721 fee with a mistyped mixed-case token",
      tokens([{ chainTicker: "eth", type: "erc721", address: NFT, fee: { amount: "1", token: "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }]),
      /valid checksum/
    ],
    ["minAmount as number", tokens([{ chainTicker: "eth", type: "native", minAmount: 5 }]), /minAmount must be a string/],
    ["minAmount zero", tokens([{ chainTicker: "eth", type: "native", minAmount: "0" }]), /greater than 0/],
    ["minAmount decimal", tokens([{ chainTicker: "eth", type: "native", minAmount: "1.5" }]), /unsigned integer/],
    ["minAmount on erc721", tokens([{ chainTicker: "eth", type: "erc721", address: NFT, minAmount: "1" }]), /not possible for an erc721/],
    ["fee not an object", tokens([{ chainTicker: "eth", type: "native", fee: "2" }]), /fee must be an object/],
    ["fee with both kinds", tokens([{ chainTicker: "eth", type: "native", fee: { percent: "1", amount: "1" } }]), /exactly one of/],
    ["fee with neither kind", tokens([{ chainTicker: "eth", type: "native", fee: {} }]), /exactly one of/],
    ["fee with unknown key", tokens([{ chainTicker: "eth", type: "native", fee: { bps: "1" } }]), /unknown key "bps"/],
    ["percent zero", tokens([{ chainTicker: "eth", type: "native", fee: { percent: "0" } }]), /greater than 0/],
    ["percent above 100", tokens([{ chainTicker: "eth", type: "native", fee: { percent: "100.0001" } }]), /must not exceed 100/],
    ["percent with too many decimals", tokens([{ chainTicker: "eth", type: "native", fee: { percent: "1.00001" } }]), /at most 4 decimal places/],
    ["percent on erc721", tokens([{ chainTicker: "eth", type: "erc721", address: NFT, fee: { percent: "1" } }]), /cannot be split/],
    ["percent with token", tokens([{ chainTicker: "eth", type: "erc20", address: USDC, fee: { percent: "1", token: USDC } }]), /only for a flat erc721 fee/],
    ["flat erc721 fee without token", tokens([{ chainTicker: "eth", type: "erc721", address: NFT, fee: { amount: "1" } }]), /fee.token is required/],
    ["flat erc20 fee with token", tokens([{ chainTicker: "eth", type: "erc20", address: USDC, fee: { amount: "1", token: USDC } }]), /only for an erc721 token/],
    ["flat fee zero", tokens([{ chainTicker: "eth", type: "native", fee: { amount: "0" } }]), /greater than 0/],
    [
      "duplicate token, different casing",
      tokens([
        { chainTicker: "eth", type: "erc20", address: USDC },
        { chainTicker: "eth", type: "erc20", address: USDC.toLowerCase() }
      ]),
      /same token as entry 0/
    ],
    [
      "two native entries on one chain",
      tokens([
        { chainTicker: "eth", type: "native" },
        { chainTicker: "eth", type: "native", minAmount: "1" }
      ]),
      /same token as entry 0/
    ]
  ])("rejects %s", (_name, raw, message) => {
    expect(() => parseTipTokens(raw)).toThrow(message);
  });

  it("rejects more than the maximum number of entries", () => {
    const many = Array.from({ length: 65 }, (_, i) => ({
      chainTicker: "eth",
      type: "erc20",
      address: `0x${(i + 1).toString(16).padStart(40, "0")}`
    }));
    expect(() => parseTipTokens(tokens(many))).toThrow(/maximum is 64/);
  });

  it("allows the same contract on two chains", () => {
    expect(
      parseTipTokens(
        tokens([
          { chainTicker: "eth", type: "erc20", address: USDC },
          { chainTicker: "base", type: "erc20", address: USDC }
        ])
      )
    ).toHaveLength(2);
  });
});

describe("getRequiredFee", () => {
  const erc20 = (fee: TipToken["fee"]): TipToken => ({ chainTicker: "eth", type: "erc20", address: USDC, ...(fee ? { fee } : {}) });

  it("owes nothing without a fee", () => {
    expect(getRequiredFee(erc20(undefined), 1000n)).toBeUndefined();
  });

  it("computes a percentage in the tipped token", () => {
    expect(getRequiredFee(erc20({ percent: "2.5" }), 1_000_000n)).toEqual({ amount: 25_000n, feeToken: USDC });
  });

  it("rounds a percentage down", () => {
    expect(getRequiredFee(erc20({ percent: "2.5" }), 199n)).toEqual({ amount: 4n, feeToken: USDC });
  });

  it("owes nothing when the percentage rounds down to zero", () => {
    expect(getRequiredFee(erc20({ percent: "1" }), 99n)).toBeUndefined();
  });

  it("handles the smallest percentage and 100", () => {
    expect(getRequiredFee(erc20({ percent: "0.0001" }), 1_000_000n)).toEqual({ amount: 1n, feeToken: USDC });
    expect(getRequiredFee(erc20({ percent: "100" }), 7n)).toEqual({ amount: 7n, feeToken: USDC });
  });

  it("pays a native fee in the native coin", () => {
    expect(getRequiredFee({ chainTicker: "eth", type: "native", fee: { percent: "2" } }, 1000n)).toEqual({
      amount: 20n,
      feeToken: undefined
    });
  });

  it("charges a flat fee in the tipped token", () => {
    expect(getRequiredFee(erc20({ amount: "500" }), 1n)).toEqual({ amount: 500n, feeToken: USDC });
  });

  it("charges an erc721 flat fee in the named token", () => {
    expect(
      getRequiredFee({ chainTicker: "eth", type: "erc721", address: NFT, fee: { amount: "1000000", token: USDC } }, 0n)
    ).toEqual({ amount: 1_000_000n, feeToken: USDC });
  });
});

describe("parseTipClaim", () => {
  const hash = `0x${"ab".repeat(32)}`;

  it("accepts a claim and lowercases the hashes", () => {
    expect(parseTipClaim({ chainTicker: "eth", txHash: hash.toUpperCase().replace("0X", "0x"), feeTxHash: hash })).toEqual({
      chainTicker: "eth",
      txHash: hash,
      feeTxHash: hash
    });
  });

  it.each<[string, unknown, RegExp]>([
    ["a string", "0xabc", /must be an object/],
    ["an array", [], /must be an object/],
    ["a missing chainTicker", { txHash: hash }, /chainTicker/],
    ["a short hash", { chainTicker: "eth", txHash: "0xabc" }, /tip.txHash/],
    ["a bad fee hash", { chainTicker: "eth", txHash: hash, feeTxHash: "nope" }, /tip.feeTxHash/],
    ["fields that imitate the verified result", { chainTicker: "eth", txHash: hash, amount: "1000000" }, /unknown key "amount"/]
  ])("rejects %s", (_name, value, message) => {
    expect(() => parseTipClaim(value)).toThrow(message);
  });
});

describe("verifyWalletProof", () => {
  const author = makeAuthor(1);
  const other = makeAuthor(2);

  it("accepts a proof over the author's key address", async () => {
    const result = await verifyWalletProof({ wallet: await signWallet(author), authorKeyAddress: author.keyAddress });
    expect(result).toEqual({ address: author.wallet.address });
  });

  it("rejects a missing wallet", async () => {
    expect(await verifyWalletProof({ wallet: undefined, authorKeyAddress: author.keyAddress })).toEqual({
      error: "has no wallet for this chain"
    });
  });

  it("rejects a wallet entry copied from another author", async () => {
    const result = await verifyWalletProof({ wallet: await signWallet(other), authorKeyAddress: author.keyAddress });
    expect(result).toEqual({ error: expect.stringMatching(/does not prove/) });
  });

  it.each([
    ["the old pkc-author-wallet string", (key: string) => `{"domainSeparator":"pkc-author-wallet","authorAddress":"${key}","timestamp":${WALLET_TIMESTAMP}}`],
    ["the old plebbit-author-wallet string", (key: string) => `{"domainSeparator":"plebbit-author-wallet","authorAddress":"${key}","timestamp":${WALLET_TIMESTAMP}}`],
    ["the right separator with the old authorAddress field", (key: string) => `{"domainSeparator":"bitsocial-author-wallet","authorAddress":"${key}","timestamp":${WALLET_TIMESTAMP}}`],
    ["a name instead of the key", () => `{"domainSeparator":"bitsocial-author-wallet","authorPublicKey":"author.bso","timestamp":${WALLET_TIMESTAMP}}`]
  ])("rejects a proof signed over %s", async (_name, message) => {
    const wallet = await signWallet(author, { message: message(author.keyAddress) });
    expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress })).toEqual({
      error: expect.stringMatching(/does not prove/)
    });
  });

  it("rejects a signature type other than eip191", async () => {
    const wallet = await signWallet(author, { type: "eip712" });
    expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress })).toEqual({
      error: expect.stringMatching(/signature type must be "eip191"/)
    });
  });

  it("rejects a name in place of an address", async () => {
    const wallet = await signWallet(author, { address: "author.eth" });
    expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress })).toEqual({
      error: expect.stringMatching(/literal 0x address/)
    });
  });

  it("rejects a timestamp in the future, and accepts one at the present second", async () => {
    const wallet = await signWallet(author, { timestamp: 2_000 });
    expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress, nowSeconds: 1_999 })).toEqual({
      error: "wallet timestamp is in the future"
    });
    expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress, nowSeconds: 2_000 })).toEqual({
      address: author.wallet.address
    });
  });

  it("rejects a non-integer timestamp", async () => {
    const wallet = { ...(await signWallet(author)), timestamp: "1700000000" };
    expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress })).toEqual({
      error: "wallet timestamp must be an integer"
    });
  });

  it("rejects a malformed signature without throwing", async () => {
    const wallet = { ...(await signWallet(author)), signature: { signature: "0x1234", type: "eip191" } };
    expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress })).toEqual({
      error: expect.stringMatching(/does not prove/)
    });
  });
});

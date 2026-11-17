import { describe, expect, it } from "vitest";
import { getAddress, recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
        { chainId: 1, type: "native", minAmount: "1000000000000000", fee: { percent: "2" } },
        { chainId: 1, type: "erc20", address: USDC, minAmount: "1000000", fee: { percent: "2.5" } },
        { chainId: 1, type: "erc20", address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0002", fee: { amount: "500000000000000000" } },
        { chainId: 1, type: "erc721", address: NFT, fee: { amount: "1000000", token: USDC } },
        { chainId: 1, type: "erc721", address: "0x3333333333333333333333333333333333333333" }
      ])
    );
    expect(parsed).toHaveLength(5);
    expect(parsed[3]).toEqual({ chainId: 1, type: "erc721", address: NFT, fee: { amount: "1000000", token: USDC } });
  });

  it.each<[string, string | undefined, RegExp]>([
    ["missing option", undefined, /is required/],
    ["invalid JSON", "[", /not valid JSON/],
    ["not an array", "{}", /must be a JSON array/],
    ["empty list", "[]", /at least one token/],
    ["entry not an object", tokens(["eth"]), /\[0\] must be an object/],
    ["unknown key", tokens([{ chainId: 1, type: "native", feee: {} }]), /unknown key "feee"/],
    ["missing chainId", tokens([{ type: "native" }]), /chainId must be a positive integer/],
    ["chainTicker in place of chainId", tokens([{ chainTicker: "eth", type: "native" }]), /uses chainTicker.*numeric chainId only/],
    ["chainTicker next to chainId", tokens([{ chainId: 1, chainTicker: "eth", type: "native" }]), /uses chainTicker/],
    ["chainId as a string", tokens([{ chainId: "1", type: "native" }]), /chainId must be a positive integer.*got "1"/],
    ["chainId zero", tokens([{ chainId: 0, type: "native" }]), /chainId must be a positive integer/],
    ["chainId negative", tokens([{ chainId: -1, type: "native" }]), /chainId must be a positive integer/],
    ["chainId fractional", tokens([{ chainId: 1.5, type: "native" }]), /chainId must be a positive integer/],
    ["unknown type", tokens([{ chainId: 1, type: "erc1155", address: NFT }]), /type must be one of/],
    ["native with address", tokens([{ chainId: 1, type: "native", address: USDC }]), /left out for the native coin/],
    ["erc20 without address", tokens([{ chainId: 1, type: "erc20" }]), /0x address/],
    ["erc20 with a name as address", tokens([{ chainId: 1, type: "erc20", address: "usdc.eth" }]), /0x address/],
    [
      "erc20 with a mistyped mixed-case address",
      tokens([{ chainId: 1, type: "erc20", address: USDC.slice(0, -1) + (USDC.endsWith("1") ? "2" : "1") }]),
      /valid checksum/
    ],
    [
      "flat erc721 fee with a mistyped mixed-case token",
      tokens([{ chainId: 1, type: "erc721", address: NFT, fee: { amount: "1", token: "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } }]),
      /valid checksum/
    ],
    ["minAmount as number", tokens([{ chainId: 1, type: "native", minAmount: 5 }]), /minAmount must be a string/],
    ["minAmount zero", tokens([{ chainId: 1, type: "native", minAmount: "0" }]), /greater than 0/],
    ["minAmount decimal", tokens([{ chainId: 1, type: "native", minAmount: "1.5" }]), /unsigned integer/],
    ["minAmount on erc721", tokens([{ chainId: 1, type: "erc721", address: NFT, minAmount: "1" }]), /not possible for an erc721/],
    ["fee not an object", tokens([{ chainId: 1, type: "native", fee: "2" }]), /fee must be an object/],
    ["fee with both kinds", tokens([{ chainId: 1, type: "native", fee: { percent: "1", amount: "1" } }]), /exactly one of/],
    ["fee with neither kind", tokens([{ chainId: 1, type: "native", fee: {} }]), /exactly one of/],
    ["fee with unknown key", tokens([{ chainId: 1, type: "native", fee: { bps: "1" } }]), /unknown key "bps"/],
    ["percent zero", tokens([{ chainId: 1, type: "native", fee: { percent: "0" } }]), /greater than 0/],
    ["percent above 100", tokens([{ chainId: 1, type: "native", fee: { percent: "100.0001" } }]), /must not exceed 100/],
    ["percent with too many decimals", tokens([{ chainId: 1, type: "native", fee: { percent: "1.00001" } }]), /at most 4 decimal places/],
    ["percent on erc721", tokens([{ chainId: 1, type: "erc721", address: NFT, fee: { percent: "1" } }]), /cannot be split/],
    ["percent with token", tokens([{ chainId: 1, type: "erc20", address: USDC, fee: { percent: "1", token: USDC } }]), /only for a flat erc721 fee/],
    ["flat erc721 fee without token", tokens([{ chainId: 1, type: "erc721", address: NFT, fee: { amount: "1" } }]), /fee.token is required/],
    ["flat erc20 fee with token", tokens([{ chainId: 1, type: "erc20", address: USDC, fee: { amount: "1", token: USDC } }]), /only for an erc721 token/],
    ["flat fee zero", tokens([{ chainId: 1, type: "native", fee: { amount: "0" } }]), /greater than 0/],
    [
      "duplicate token, different casing",
      tokens([
        { chainId: 1, type: "erc20", address: USDC },
        { chainId: 1, type: "erc20", address: USDC.toLowerCase() }
      ]),
      /same token as entry 0/
    ],
    [
      "two native entries on one chain",
      tokens([
        { chainId: 1, type: "native" },
        { chainId: 1, type: "native", minAmount: "1" }
      ]),
      /same token as entry 0/
    ]
  ])("rejects %s", (_name, raw, message) => {
    expect(() => parseTipTokens(raw)).toThrow(message);
  });

  it("rejects more than the maximum number of entries", () => {
    const many = Array.from({ length: 65 }, (_, i) => ({
      chainId: 1,
      type: "erc20",
      address: `0x${(i + 1).toString(16).padStart(40, "0")}`
    }));
    expect(() => parseTipTokens(tokens(many))).toThrow(/maximum is 64/);
  });

  it("allows the same contract on two chain IDs", () => {
    expect(
      parseTipTokens(
        tokens([
          { chainId: 1, type: "erc20", address: USDC },
          { chainId: 8453, type: "erc20", address: USDC }
        ])
      )
    ).toHaveLength(2);
  });
});

describe("getRequiredFee", () => {
  const erc20 = (fee: TipToken["fee"]): TipToken => ({ chainId: 1, type: "erc20", address: USDC, ...(fee ? { fee } : {}) });

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
    expect(getRequiredFee({ chainId: 1, type: "native", fee: { percent: "2" } }, 1000n)).toEqual({
      amount: 20n,
      feeToken: undefined
    });
  });

  it("charges a flat fee in the tipped token", () => {
    expect(getRequiredFee(erc20({ amount: "500" }), 1n)).toEqual({ amount: 500n, feeToken: USDC });
  });

  it("charges an erc721 flat fee in the named token", () => {
    expect(
      getRequiredFee({ chainId: 1, type: "erc721", address: NFT, fee: { amount: "1000000", token: USDC } }, 0n)
    ).toEqual({ amount: 1_000_000n, feeToken: USDC });
  });
});

describe("parseTipClaim", () => {
  const hash = `0x${"ab".repeat(32)}`;

  it("accepts a claim and lowercases the hashes", () => {
    expect(parseTipClaim({ chainId: 1, txHash: hash.toUpperCase().replace("0X", "0x"), feeTxHash: hash })).toEqual({
      chainId: 1,
      txHash: hash,
      feeTxHash: hash
    });
  });

  it.each<[string, unknown, RegExp]>([
    ["a string", "0xabc", /must be an object/],
    ["an array", [], /must be an object/],
    ["a missing chainId", { txHash: hash }, /tip.chainId must be a positive integer/],
    ["a chainTicker in place of a chainId", { chainTicker: "eth", txHash: hash }, /uses chainTicker/],
    ["a chainId as a string", { chainId: "1", txHash: hash }, /tip.chainId must be a positive integer/],
    ["a chainId of zero", { chainId: 0, txHash: hash }, /tip.chainId must be a positive integer/],
    ["a short hash", { chainId: 1, txHash: "0xabc" }, /tip.txHash/],
    ["a bad fee hash", { chainId: 1, txHash: hash, feeTxHash: "nope" }, /tip.feeTxHash/],
    ["fields that imitate the verified result", { chainId: 1, txHash: hash, amount: "1000000" }, /unknown key "amount"/]
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

  it("accepts a timestamp up to 300 seconds ahead of the clock, and rejects one second more", async () => {
    const wallet = await signWallet(author, { timestamp: 2_000 });
    expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress, nowSeconds: 1_699 })).toEqual({
      error: "wallet timestamp is more than 300 seconds in the future"
    });
    expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress, nowSeconds: 1_700 })).toEqual({
      address: author.wallet.address
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

  it("rejects a signature that is not 65 bytes of hex", async () => {
    const good = (await signWallet(author)).signature.signature;
    for (const signature of ["0x1234", good.slice(0, -2), `${good}00`, good.slice(2), `0x${"zz".repeat(65)}`, 5]) {
      const wallet = { ...(await signWallet(author)), signature: { signature, type: "eip191" } };
      expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress })).toEqual({
        error: expect.stringMatching(/must be 65 bytes/)
      });
    }
  });
});

// The test vector of the "Author Wallet Proofs" BSIP draft.
describe("verifyWalletProof, BSIP test vector", () => {
  const SIGNATURE_PUBLIC_KEY = "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w";
  const KEY_ADDRESS = "12D3KooWK99VoVxNE7XzyBwXEzW7xhK7Gpv85r9F3V3fyKSUKPH5";
  const ADDRESS = "0x5050A4F4b3f9338C3472dcC01A87C76A144b3c9c";
  const TIMESTAMP = 1_790_000_000;
  const SIGNATURE =
    "0x689cdb0da488b458f4deb758ea77c3d205b6d17d690e9ffab497bc44eb9536a25fbc48ce7c3e6cab651efe176f94d856ebbe8fcad920dfece8cb5f0cb355d8ac1c";
  const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

  const entry = (overrides: { signature?: string; type?: string; address?: string } = {}) => ({
    address: overrides.address ?? ADDRESS,
    timestamp: TIMESTAMP,
    signature: { signature: overrides.signature ?? SIGNATURE, type: overrides.type ?? "eip191" }
  });

  const verify = (wallet: ReturnType<typeof entry>, options: { keyAddress?: string; nowSeconds?: number } = {}) =>
    verifyWalletProof({
      wallet,
      authorKeyAddress: options.keyAddress ?? KEY_ADDRESS,
      nowSeconds: options.nowSeconds ?? TIMESTAMP
    });

  it("derives the vector's key address from its signature.publicKey", () => {
    expect(getKeyAddressFromPublicKey(SIGNATURE_PUBLIC_KEY)).toBe(KEY_ADDRESS);
  });

  it("builds the vector's proof message", () => {
    expect(getWalletMessageToSign(KEY_ADDRESS, TIMESTAMP)).toBe(
      '{"domainSeparator":"bitsocial-author-wallet","authorPublicKey":"12D3KooWK99VoVxNE7XzyBwXEzW7xhK7Gpv85r9F3V3fyKSUKPH5","timestamp":1790000000}'
    );
  });

  it("is valid from the timestamp less the 300 second allowance onward", async () => {
    expect(await verify(entry(), { nowSeconds: 1_789_999_700 })).toEqual({ address: ADDRESS });
    expect(await verify(entry(), { nowSeconds: TIMESTAMP + 1_000_000 })).toEqual({ address: ADDRESS });
  });

  it("is not valid one second before that", async () => {
    expect(await verify(entry(), { nowSeconds: 1_789_999_699 })).toEqual({
      error: "wallet timestamp is more than 300 seconds in the future"
    });
  });

  it("is not valid in a publication signed by another key", async () => {
    expect(await verify(entry(), { keyAddress: makeAuthor(9).keyAddress })).toEqual({
      error: expect.stringMatching(/does not prove/)
    });
  });

  it("is not valid with another signature type or a name as the address", async () => {
    expect(await verify(entry({ type: "erc1271" }))).toEqual({ error: expect.stringMatching(/signature type must be "eip191"/) });
    expect(await verify(entry({ address: "example.eth" }))).toEqual({ error: expect.stringMatching(/literal 0x address/) });
  });

  it.each([
    ["0x00", "00"],
    ["0x01", "01"]
  ])("is not valid with %s as the last byte in place of 0x1c", async (_name, v) => {
    expect(await verify(entry({ signature: SIGNATURE.slice(0, -2) + v }))).toEqual({
      error: expect.stringMatching(/v of 27 or 28/)
    });
  });

  it("is not valid in its high-s form, although that form recovers the same address", async () => {
    const r = SIGNATURE.slice(2, 66);
    const s = BigInt(`0x${SIGNATURE.slice(66, 130)}`);
    const highS = (CURVE_ORDER - s).toString(16).padStart(64, "0");
    const twin = `0x${r}${highS}1b` as `0x${string}`;

    // The twin is a real signature of the same message by the same wallet. Only the encoding rule
    // rejects it, which is why the rule has to be checked before recovery.
    const recovered = await recoverMessageAddress({ message: getWalletMessageToSign(KEY_ADDRESS, TIMESTAMP), signature: twin });
    expect(recovered).toBe(ADDRESS);

    expect(await verify(entry({ signature: twin }))).toEqual({ error: "wallet signature must use the low form of s" });
  });

  it("is not valid against a message built with authorAddress or another separator", async () => {
    // Same wallet, same key, same timestamp: only the signed string differs.
    const wallet = privateKeyToAccount(`0x${"02".repeat(32)}`);
    expect(wallet.address).toBe(ADDRESS);
    for (const message of [
      `{"domainSeparator":"bitsocial-author-wallet","authorAddress":"${KEY_ADDRESS}","timestamp":${TIMESTAMP}}`,
      `{"domainSeparator":"pkc-author-wallet","authorPublicKey":"${KEY_ADDRESS}","timestamp":${TIMESTAMP}}`
    ]) {
      const signature = await wallet.signMessage({ message });
      expect(await verify(entry({ signature }))).toEqual({ error: expect.stringMatching(/does not prove/) });
    }
    // and signing the right string with that key reproduces the vector's signature exactly
    expect(await wallet.signMessage({ message: getWalletMessageToSign(KEY_ADDRESS, TIMESTAMP) })).toBe(SIGNATURE);
  });
});

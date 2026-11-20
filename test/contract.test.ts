import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  getKeyAddressFromPublicKey,
  getParentBindingSuffix,
  getRequiredFee,
  getWalletMessageToSign,
  hasParentBinding,
  PARENT_BINDING_SUFFIX_BYTES,
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
  it("is the exact BSIP-22 string, with the wallet address in lowercase", () => {
    expect(getWalletMessageToSign("12D3KooWabc", "0x5050A4F4b3f9338C3472dcC01A87C76A144b3c9c", 1700000000)).toBe(
      '{"domainSeparator":"bitsocial-author-wallet","authorPublicKey":"12D3KooWabc","walletAddress":"0x5050a4f4b3f9338c3472dcc01a87c76a144b3c9c","timestamp":1700000000}'
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
    ["a bad fee hash", { chainId: 1, txHash: hash, feeTxHash: "nope" }, /feeTxHash/],
    ["fields that imitate the verified result", { chainId: 1, txHash: hash, amount: "1000000" }, /unknown key "amount"/]
  ])("rejects %s", (_name, value, message) => {
    expect(() => parseTipClaim(value)).toThrow(message);
  });
});

describe("verifyWalletProof", () => {
  const author = makeAuthor(1);
  const other = makeAuthor(2);
  const valid = { outcome: "valid", address: author.wallet.address };
  const invalid = (error: string | RegExp) => ({
    outcome: "invalid",
    error: typeof error === "string" ? error : expect.stringMatching(error)
  });

  it("accepts a proof over the author's key address and the wallet's own address", async () => {
    const result = await verifyWalletProof({ wallet: await signWallet(author), authorKeyAddress: author.keyAddress });
    expect(result).toEqual(valid);
  });

  it("accepts the entry with its address in lowercase", async () => {
    const wallet = await signWallet(author, { address: author.wallet.address.toLowerCase() });
    expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress })).toEqual(valid);
  });

  it("rejects a missing wallet", async () => {
    expect(await verifyWalletProof({ wallet: undefined, authorKeyAddress: author.keyAddress })).toEqual(
      invalid("has no wallet for this chain")
    );
  });

  it("rejects a wallet entry copied from another author", async () => {
    const result = await verifyWalletProof({ wallet: await signWallet(other), authorKeyAddress: author.keyAddress });
    expect(result).toEqual(invalid(/does not prove/));
  });

  const lower = author.wallet.address.toLowerCase();
  it.each([
    ["the old pkc-author-wallet string", (key: string) => `{"domainSeparator":"pkc-author-wallet","authorAddress":"${key}","timestamp":${WALLET_TIMESTAMP}}`],
    ["the old plebbit-author-wallet string", (key: string) => `{"domainSeparator":"plebbit-author-wallet","authorAddress":"${key}","timestamp":${WALLET_TIMESTAMP}}`],
    ["the draft string that does not name the wallet address", (key: string) => `{"domainSeparator":"bitsocial-author-wallet","authorPublicKey":"${key}","timestamp":${WALLET_TIMESTAMP}}`],
    ["the wallet address in mixed case", (key: string) => `{"domainSeparator":"bitsocial-author-wallet","authorPublicKey":"${key}","walletAddress":"${author.wallet.address}","timestamp":${WALLET_TIMESTAMP}}`],
    ["the right separator with the old authorAddress field", (key: string) => `{"domainSeparator":"bitsocial-author-wallet","authorAddress":"${key}","walletAddress":"${lower}","timestamp":${WALLET_TIMESTAMP}}`],
    ["a name instead of the key", () => `{"domainSeparator":"bitsocial-author-wallet","authorPublicKey":"author.bso","walletAddress":"${lower}","timestamp":${WALLET_TIMESTAMP}}`]
  ])("rejects a proof signed over %s", async (_name, message) => {
    const wallet = await signWallet(author, { message: message(author.keyAddress) });
    expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress })).toEqual(invalid(/does not prove/));
  });

  it("reports a signature type other than eip191 as unknown, not invalid", async () => {
    const wallet = await signWallet(author, { type: "eip712" });
    expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress })).toEqual({
      outcome: "unknown",
      error: expect.stringMatching(/signature type "eip712" is unknown/)
    });
  });

  it("rejects a name in place of an address", async () => {
    const wallet = await signWallet(author, { address: "author.eth" });
    expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress })).toEqual(invalid(/literal 0x address/));
  });

  it("accepts a timestamp up to 300 seconds ahead of the clock, and rejects one second more", async () => {
    const wallet = await signWallet(author, { timestamp: 2_000 });
    expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress, nowSeconds: 1_699 })).toEqual(
      invalid("wallet timestamp is more than 300 seconds in the future")
    );
    expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress, nowSeconds: 1_700 })).toEqual(valid);
    expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress, nowSeconds: 2_000 })).toEqual(valid);
  });

  it("rejects a non-integer timestamp", async () => {
    const wallet = { ...(await signWallet(author)), timestamp: "1700000000" };
    expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress })).toEqual(
      invalid("wallet timestamp must be an integer")
    );
  });

  it("rejects an eip191 signature that is not 65 bytes of hex", async () => {
    const good = (await signWallet(author)).signature.signature;
    for (const signature of ["0x1234", good.slice(0, -2), `${good}00`, good.slice(2), `0x${"zz".repeat(65)}`]) {
      const wallet = { ...(await signWallet(author)), signature: { signature, type: "eip191" } };
      expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress })).toEqual(invalid(/must be 65 bytes/));
    }
  });

  it("rejects a signature that is not a string, whatever the type", async () => {
    for (const type of ["eip191", "erc1271"]) {
      const wallet = { ...(await signWallet(author)), signature: { signature: 5, type } };
      expect(await verifyWalletProof({ wallet, authorKeyAddress: author.keyAddress })).toEqual(
        invalid(/string signature and a string type/)
      );
    }
  });
});

// The test vectors of BSIP-22 (Author Wallet Proofs), copied unchanged from
// https://github.com/bitsocialnet/BSIPs/blob/b29e043674e4ce9d6dfb7ab11edff2a314f845e1/assets/bsip-22/wallet-proof-vectors.json
describe("verifyWalletProof, BSIP-22 test vectors", () => {
  interface VectorCase {
    name: string;
    entry: Record<string, unknown>;
    authorKey?: "other";
    verifierTime: number;
    outcome: "valid" | "invalid" | "unknown";
  }
  const vectors = JSON.parse(
    readFileSync(new URL("./fixtures/bsip-22-wallet-proof-vectors.json", import.meta.url), "utf8")
  ) as {
    authorKey: { publicKeyBase64Unpadded: string; address: string };
    otherKey: { publicKeyBase64Unpadded: string; address: string };
    walletPrivateKeyHex: string;
    walletAddress: string;
    timestamp: number;
    proofMessage: string;
    validSignature: string;
    cases: VectorCase[];
  };

  it("has every case of the BSIP", () => {
    expect(vectors.cases).toHaveLength(26);
  });

  it("derives the vectors' key addresses from their signature.publicKey", () => {
    expect(getKeyAddressFromPublicKey(vectors.authorKey.publicKeyBase64Unpadded)).toBe(vectors.authorKey.address);
    expect(getKeyAddressFromPublicKey(vectors.otherKey.publicKeyBase64Unpadded)).toBe(vectors.otherKey.address);
  });

  it("builds the vector's proof message from the mixed-case address", () => {
    expect(getWalletMessageToSign(vectors.authorKey.address, vectors.walletAddress, vectors.timestamp)).toBe(
      vectors.proofMessage
    );
  });

  it("reproduces the vector's signature when the vector's wallet signs that message", async () => {
    const wallet = privateKeyToAccount(`0x${vectors.walletPrivateKeyHex}`);
    expect(wallet.address).toBe(vectors.walletAddress);
    expect(await wallet.signMessage({ message: vectors.proofMessage })).toBe(vectors.validSignature);
  });

  it.each(vectors.cases.map((vectorCase) => [vectorCase.name, vectorCase] as const))("%s", async (_name, vectorCase) => {
    const result = await verifyWalletProof({
      wallet: vectorCase.entry,
      authorKeyAddress: vectorCase.authorKey === "other" ? vectors.otherKey.address : vectors.authorKey.address,
      nowSeconds: vectorCase.verifierTime
    });
    expect(result.outcome).toBe(vectorCase.outcome);
    if (result.outcome === "valid") expect(getAddress(result.address)).toBe(vectors.walletAddress);
  });
});

describe("the parent binding", () => {
  // The test vector in the README.
  const parentCid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
  const suffix =
    "0xa1616da16762736f2d74697058209e70d347eb27e5edfa2b03409b020ecdaba0997a7a4806a5c441694ea6bf9b5d002e0280218021802180218021802180218021";

  it("builds the suffix of the README's test vector", () => {
    expect(getParentBindingSuffix(parentCid)).toBe(suffix);
    expect((suffix.length - 2) / 2).toBe(PARENT_BINDING_SUFFIX_BYTES);
  });

  it("hashes the string as written", () => {
    expect(getParentBindingSuffix(parentCid.toLowerCase())).not.toBe(suffix);
    expect(getParentBindingSuffix(` ${parentCid}`)).not.toBe(suffix);
  });

  it("finds the suffix only at the very end of the input", () => {
    expect(hasParentBinding(suffix, parentCid)).toBe(true);
    expect(hasParentBinding(`0xa9059cbb${suffix.slice(2)}`, parentCid)).toBe(true);
    expect(hasParentBinding(`${suffix}00`, parentCid)).toBe(false);
    expect(hasParentBinding(`0x${suffix.slice(4)}`, parentCid)).toBe(false);
    expect(hasParentBinding("0x", parentCid)).toBe(false);
    expect(hasParentBinding(suffix, "QmbWqxBEKC3P8tqsKc98xmWNzrzDtRLMiMPL8wBuTGsMnR")).toBe(false);
  });
});

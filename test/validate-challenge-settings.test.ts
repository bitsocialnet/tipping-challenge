import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import tippingChallenge, { optionInputs, validateChallengeSettings } from "../src/tipping-challenge.js";
import { TIPPING_V1_FEE_RECIPIENT_OPTION, TIPPING_V1_TOKENS_OPTION, type TipToken } from "../src/contract.js";
import { buildSettings } from "./helpers.js";

// Placeholder contracts, not real tokens.
const USDC = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0001");
const FEE_RECIPIENT = "0x1111111111111111111111111111111111111111";

const native: TipToken = { chainTicker: "eth", type: "native" };
const usdcWithFee: TipToken = { chainTicker: "eth", type: "erc20", address: USDC, fee: { percent: "2.5" } };

const validate = (params: Parameters<typeof buildSettings>[0]) => () =>
  validateChallengeSettings({ challengeSettings: buildSettings(params) });

describe("factory", () => {
  it("returns the challenge file without throwing, even for settings that would not validate", () => {
    const file = tippingChallenge({ challengeSettings: buildSettings({ tokens: "not json" }) });
    expect(file.type).toBe("text/plain");
    expect(typeof file.getChallenge).toBe("function");
    expect(file.validateChallengeSettings).toBe(validateChallengeSettings);
    expect(file.optionInputs).toBe(optionInputs);
  });

  it("declares every option it reads, so core accepts them", () => {
    expect(optionInputs.map((input) => input.option)).toEqual([
      TIPPING_V1_TOKENS_OPTION,
      TIPPING_V1_FEE_RECIPIENT_OPTION,
      "rpcUrls"
    ]);
    expect(optionInputs[0]?.required).toBe(true);
  });
});

describe("validateChallengeSettings", () => {
  it("accepts a fee-free list", () => {
    expect(validate({ tokens: [native] })).not.toThrow();
  });

  it("accepts a list with a fee and a published fee recipient", () => {
    expect(validate({ tokens: [native, usdcWithFee], feeRecipient: FEE_RECIPIENT })).not.toThrow();
  });

  it("requires the token list to be published", () => {
    expect(validate({ tokens: [native], publicOptions: [] })).toThrow(/tipping\/v1\/tokens must be listed in publicOptions/);
  });

  it("refuses to publish rpcUrls", () => {
    expect(
      validate({ tokens: [native], rpcUrls: "https://rpc.example", publicOptions: [TIPPING_V1_TOKENS_OPTION, "rpcUrls"] })
    ).toThrow(/rpcUrls cannot be listed in publicOptions/);
  });

  it("rejects a malformed token list", () => {
    expect(validate({ tokens: "[" })).toThrow(/not valid JSON/);
    expect(validate({ tokens: "" })).toThrow(/not valid JSON/);
  });

  it("requires a fee recipient when a token has a fee", () => {
    expect(validate({ tokens: [usdcWithFee] })).toThrow(/tipping\/v1\/feeRecipient is required/);
  });

  it("requires the fee recipient to be published when a token has a fee", () => {
    expect(
      validate({ tokens: [usdcWithFee], feeRecipient: FEE_RECIPIENT, publicOptions: [TIPPING_V1_TOKENS_OPTION] })
    ).toThrow(/tipping\/v1\/feeRecipient must be listed in publicOptions/);
  });

  it("rejects a fee recipient that is not an address", () => {
    expect(validate({ tokens: [usdcWithFee], feeRecipient: "community.eth" })).toThrow(/must be a 0x address/);
  });

  it("rejects a mixed-case fee recipient whose checksum is wrong, and accepts it in lowercase", () => {
    const mistyped = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(validate({ tokens: [usdcWithFee], feeRecipient: mistyped })).toThrow(/valid checksum/);
    expect(validate({ tokens: [usdcWithFee], feeRecipient: mistyped.toLowerCase() })).not.toThrow();
  });

  it("rejects a fee recipient when no token has a fee", () => {
    expect(validate({ tokens: [native], feeRecipient: FEE_RECIPIENT })).toThrow(/no token has a fee/);
  });

  it("rejects an rpcUrls entry that is not an http URL", () => {
    expect(validate({ tokens: [native], rpcUrls: "not a url" })).toThrow(/not a valid URL/);
    expect(validate({ tokens: [native], rpcUrls: "ws://rpc.example" })).toThrow(/must use http: or https:/);
  });

  it("accepts a comma-separated rpcUrls list for one chain", () => {
    expect(validate({ tokens: [native], rpcUrls: "https://a.example, https://b.example" })).not.toThrow();
  });

  it("rejects a plain rpcUrls list when the tokens span several chains", () => {
    expect(
      validate({ tokens: [native, { chainTicker: "base", type: "native" }], rpcUrls: "https://a.example" })
    ).toThrow(/tokens span 2 chains/);
  });

  it("accepts rpcUrls as a JSON object per chain", () => {
    expect(
      validate({
        tokens: [native, { chainTicker: "base", type: "native" }],
        rpcUrls: JSON.stringify({ eth: "https://a.example,https://b.example", base: "https://c.example" })
      })
    ).not.toThrow();
  });

  it("rejects malformed rpcUrls JSON and a chain no token uses", () => {
    expect(validate({ tokens: [native], rpcUrls: "{" })).toThrow(/not valid JSON/);
    expect(validate({ tokens: [native], rpcUrls: JSON.stringify({ eth: ["https://a.example"] }) })).toThrow(/must be a string/);
    expect(validate({ tokens: [native], rpcUrls: JSON.stringify({ base: "https://c.example" }) })).toThrow(/which no token uses/);
  });

  it("requires rpcUrls for a chain with no built-in RPC", () => {
    const custom: TipToken = { chainTicker: "mychain", type: "native" };
    expect(validate({ tokens: [custom] })).toThrow(/rpcUrls is required for chainTicker "mychain"/);
    expect(validate({ tokens: [custom], rpcUrls: "https://rpc.mychain.example" })).not.toThrow();
  });

  it("does not treat an inherited property name as a known chain", () => {
    expect(validate({ tokens: [{ chainTicker: "constructor", type: "native" }] })).toThrow(/rpcUrls is required/);
  });
});

describe("pkc-js compatibility", () => {
  it("is a challenge file factory pkc-js accepts", async () => {
    const { validateChallengeFileFactory } = await import("@pkcprotocol/pkc-js/challenges");
    expect(() => validateChallengeFileFactory(tippingChallenge, { name: "@bitsocial/tipping-challenge" })).not.toThrow();
  });
});

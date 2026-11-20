import { describe, expect, it } from "vitest";
import { transportForUrl } from "../src/chain.js";

// Building a transport opens no connection: viem connects on the first request.
const transportType = (url: string): string => transportForUrl(url)({}).config.type;

describe("transportForUrl", () => {
  it("uses the WebSocket transport for ws: and wss: URLs", () => {
    expect(transportType("ws://rpc.example")).toBe("webSocket");
    expect(transportType("wss://rpc.example")).toBe("webSocket");
  });

  it("uses the HTTP transport for http: and https: URLs", () => {
    expect(transportType("http://rpc.example")).toBe("http");
    expect(transportType("https://rpc.example")).toBe("http");
  });

  it("reads the scheme the way validateChallengeSettings does", () => {
    expect(transportType("WSS://rpc.example")).toBe("webSocket");
    expect(transportType("w\nss://rpc.example")).toBe("webSocket");
  });
});

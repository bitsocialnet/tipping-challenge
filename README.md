# @bitsocial/tipping-challenge

A [pkc-js](https://github.com/pkcprotocol/pkc-js) challenge that lets a community show verified tips. It implements the [`tipping/v1` contract](#the-tippingv1-contract), which is what publishing clients code against.

> **Status: experimental.** This README is the spec, and `src/` follows it. The package is not published to npm. The contract will be proposed as a BSIP only after it has been used in production.

## What it does

An author tips another author by sending them a token directly, wallet to wallet, and then replying to the comment being tipped. The reply is published with the hash of the transaction as a challenge pre-answer. The community node looks the transaction up on chain and, if it really is a transfer from the replier's wallet to the wallet of the author being replied to, accepts the reply and writes the verified amount into that reply's comment update.

There is no tipping contract and no chain of its own. The payment is an ordinary ERC-20 transfer, ERC-721 transfer or native coin send.

Three things follow from that design:

- **The community cannot intercept a tip.** The money moves before the reply is published, straight to the recipient.
- **The community can hide a tip but cannot fake one.** The verified result includes the transaction hash, so any client can check it against the chain.
- **Replies without a tip are not affected.** The challenge never prompts anyone. It passes everything that carries no tip claim.

## The `tipping/v1` contract

A client has to recognise "this community accepts tips, in these tokens" from the published community record alone. The record does not say which challenge package produced it: `name` and `options` are stripped, and only `publicOptions` survives. So the signal is an option key that names a **contract** rather than a package:

| Public option | Required | Meaning |
|---|---|---|
| `tipping/v1/tokens` | yes | JSON array of the accepted tokens. Its presence is what identifies the contract |
| `tipping/v1/feeRecipient` | when any token has a fee | The address that receives the community fee |

This package is one implementation. Anything that publishes `tipping/v1/tokens` with the semantics below claims the contract.

`community.wallets` does not exist in the protocol today. If it is added, a later version of the contract may read the fee address from there instead of `tipping/v1/feeRecipient`.

### The token list

`tipping/v1/tokens` is a JSON array. Each entry:

| Field | Required | Meaning |
|---|---|---|
| `chainId` | yes | The numeric chain ID, as a JSON number: `1` for Ethereum mainnet, `8453` for Base. A positive integer, never a string |
| `type` | yes | `native`, `erc20` or `erc721` |
| `address` | for `erc20` and `erc721` | The token contract. Left out for `native` |
| `minAmount` | no | Smallest tip accepted. Not allowed for `erc721` |
| `fee` | no | The community fee for a tip in this token. Leave out to charge nothing |

`fee` is one of:

| Shape | Allowed for | Meaning |
|---|---|---|
| `{ "percent": "2.5" }` | `native`, `erc20` | A percentage of the tip, paid in the same token, on top of the tip. At most 4 decimal places, greater than 0, at most 100 |
| `{ "amount": "500" }` | `native`, `erc20` | A flat amount per tip, paid in the same token |
| `{ "amount": "1000000", "token": "0x…" }` | `erc721` | A flat amount per tip, paid in the named ERC-20. `token` is required here and not allowed elsewhere |

Chains are identified by chain ID only. There is no `chainTicker` anywhere in this contract: a ticker is a label that anyone can reuse for another network, while a chain ID is what a wallet and an RPC actually agree on. An entry that carries `chainTicker` is invalid.

Rules that apply to the whole list:

- Every amount is a **string holding an unsigned integer in the token's smallest unit** (wei for ETH, 6-decimal units for a 6-decimal token). There are no decimals, so there is no rounding.
- A token appears once. Two entries with the same `chainId` and contract (compared without regard to case), or two `native` entries on one chain ID, are rejected.
- Addresses are literal `0x` addresses, never names. A mixed-case address must carry a valid EIP-55 checksum; all lowercase is accepted.
- At most 64 entries. Unknown keys are rejected.

A percentage fee is rounded **down**: `fee = floor(amount × percent / 100)`. A client may pay more. When the result is 0, no fee is owed.

Example. The first ERC-20 is Bitsocial's $BSO on Ethereum mainnet. The other contract addresses are placeholders, not real tokens:

```json
[
  { "chainId": 1, "type": "native", "minAmount": "1000000000000000", "fee": { "percent": "2" } },
  { "chainId": 1, "type": "erc20", "address": "0xB50cea4c109dc223A10d44c14f521CaeD91DaB5A", "fee": { "percent": "2.5" } },
  { "chainId": 1, "type": "erc20", "address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0002", "fee": { "amount": "500000000000000000" } },
  { "chainId": 1, "type": "erc721", "address": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0001", "fee": { "amount": "1000000", "token": "0xB50cea4c109dc223A10d44c14f521CaeD91DaB5A" } },
  { "chainId": 1, "type": "erc721", "address": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0002" }
]
```

### The tip claim

A tip is a **reply** to the comment being tipped. The client sends the tip claim as a **challenge pre-answer**: an entry in the `challengeAnswers` of the publish request, keyed by the index of the tipping challenge, holding the claim as JSON text.

```js
challengeAnswers: {
  "2": JSON.stringify({ chainId: 1, txHash: "0x…", feeTxHash: "0x…" })
}
```

| Field | Required | Meaning |
|---|---|---|
| `chainId` | yes | The numeric chain ID the transaction is on, as a number |
| `txHash` | yes | The transaction that carries the tip |
| `feeTxHash` | no | The transaction that carries the fee, when it is not the same one. Left out when no fee is owed or when the fee is in the tip's own transaction |

**Which index.** `challengeAnswers` is a record keyed by the position of a challenge in `community.challenges`, as a decimal string (pkc-js 0.0.152 and later; earlier versions used a positional array and cannot carry this). Find the entry whose `publicOptions` carry `tipping/v1/tokens` and use its position. The claim is never sent under any other key: the challenge reads only its own index.

**What the challenge reads.** pkc-js hands the challenge the answer at its own index as `challengeAnswer`. No answer means no claim, and the reply passes untouched. The claim is not part of the signed comment, so it is not stored with the reply and not visible to other peers. Only the community node that receives the request sees it.

The claim carries only those three keys. Any other key is rejected, so a claim cannot carry fields that look like the verified result. An answer that is not JSON, or not an object, is rejected.

### What a valid tip is

For a reply that carries a claim, all of these must hold. Each is a separate rejection with its own message.

1. The publication is a reply, not a post. The recipient is the author of the parent comment.
2. The community accepts at least one token on `chainId`.
3. The parent comment exists in this community.
4. The tipper is not the recipient: the two signing keys differ.
5. The tipper has at least one valid entry in `author.wallets`. See [Which wallets count](#which-wallets-count).
6. The parent comment's author has at least one valid entry in `author.wallets` that the tipper has not also proven as their own.
7. The RPC the community uses for `chainId` reports that chain ID. See [The chain](#the-chain).
8. The transaction is mined and succeeded.
9. The transaction's block is not older than the parent comment's `timestamp`.
10. The transaction moves an accepted token from one of the tipper's wallets to one of the recipient's wallets. See [Finding the tip](#finding-the-tip).
11. The amount is at least the token's `minAmount`, if set.
12. The fee, if the token has one and it does not round down to 0, was paid. See [The fee](#the-fee).
13. Neither the tip transaction nor the fee transaction has backed another tip on that chain ID in this community.

### Which wallets count

`author.wallets` is keyed by a ticker the author chose, and this contract does not use tickers. So the key is ignored:

- **Every validly proven entry counts**, whatever key it sits under. A [wallet proof](#wallet-proofs) shows control of an address, and an address is the same on every EVM chain.
- **An entry that fails verification is ignored.** It does not cause a rejection, so one stale entry does not stop an author who also has a good one.
- **The transfer's sender** must equal the address of some valid entry of the tipper. **The transfer's receiver** must equal the address of some valid entry of the author being tipped.
- **A wallet the tipper has proven as their own is never a receiver**, even if the tipped author lists it too.
- The tip is rejected only when no valid entry matches.

### The chain

The same token address, and even the same transaction hash, can exist on two chains and mean different things. So the community node never verifies a transfer on an RPC it has not checked:

- Before reading anything, it asks the RPC configured for the claim's `chainId` for its chain ID (`eth_chainId`).
- If the answer differs, or the RPC cannot be asked, the tip is rejected with a message saying so. No transaction is read.
- A confirmation is remembered for the life of the process. A failure is not, so it is checked again on the next tip.

### Finding the tip

The claim does not name a token, so the rule for which transfer is the tip is part of the contract:

1. If the native coin is accepted on that chain ID, and the transaction itself was sent by one of the tipper's wallets to one of the recipient's wallets with a value above 0, the tip is that value.
2. Otherwise the tip is the first `Transfer` event in the transaction, in log order, that is emitted by a token contract accepted on that chain ID, goes from one of the tipper's wallets to one of the recipient's wallets, and has the shape of that entry's `type`.

`from` is the sender in the event, not the account that submitted the transaction. An ERC-20 or ERC-721 tip sent through a batching or smart account therefore verifies normally.

An ERC-20 `Transfer` has two indexed arguments and the amount in the data. An ERC-721 `Transfer` has three indexed arguments, the last being the token ID. An event of one shape on an entry of the other type is ignored.

Native coin is recognised only as a **direct send**. Coin moved by an inner call of a batched transaction emits no event and is invisible to a standard RPC, so it cannot be verified. Supporting it is future work.

### The fee

The fee is a second transfer, on the same chain ID, from any of the tipper's valid wallets to `tipping/v1/feeRecipient`, of at least the owed amount. It need not come from the wallet that sent the tip. It is paid on top of the tip: the tip is whatever reached the recipient.

| Fee is paid in | Where the challenge looks |
|---|---|
| An ERC-20 | A `Transfer` event of that token from one of the tipper's wallets to the fee recipient, in `feeTxHash` if given, else in `txHash`. It must be a different event from the tip itself |
| The native coin | `feeTxHash` must be given and must differ from `txHash`. That transaction must be sent by one of the tipper's wallets to the fee recipient with a value of at least the fee |

So an ERC-20 or ERC-721 tip can carry its fee in the same transaction when the wallet can batch, or in a separate one when it cannot. A native coin fee is always its own transaction.

The fee transaction must pass the same checks as the tip transaction: mined, succeeded, and not older than the parent comment.

Without a contract the fee is enforced by display only. The recipient keeps the tip either way; the community just does not show a tip that skipped the fee.

### The verified result

On success the challenge writes this into the reply's comment update:

```js
commentUpdate.tip = {
  chainId: 1,
  txHash: "0x…",
  type: "erc20",          // "native" | "erc20" | "erc721"
  token: "0x…",           // the token contract; absent for native
  from: "0x…",            // the tipper's wallet the transfer came from
  to: "0x…",              // the recipient's wallet it went to
  amount: "5000000",      // native and erc20: smallest unit, as a string
  tokenId: "4242",        // erc721 only, in place of amount
  fee: {                  // only when a fee was owed
    txHash: "0x…",
    to: "0x…",            // the fee recipient
    amount: "125000",     // what was actually paid
    token: "0x…"          // the fee token; absent for a native fee
  }
}
```

Addresses are written with their EIP-55 checksum. Hashes are lowercase.

It lives in the comment update, not in the comment, so a community that later stops showing tips can drop it. The reply itself, with its claim, is permanent.

### Wallet proofs

A tip is only meaningful if both wallets really belong to the two authors. pkc-js checks only the shape of `author.wallets`, so this challenge verifies each proof itself.

The rules follow the [Author Wallet Proofs BSIP draft](https://github.com/bitsocialnet/BSIPs/issues/26). An entry is `{ address, timestamp, signature: { signature, type } }`. It is valid when:

- `address` is a literal `0x` address (40 hex digits, any letter case), not a name.
- `signature.type` is `eip191`.
- `timestamp` is an integer and is not more than 300 seconds later than the verifier's clock. The allowance is fixed.
- `signature.signature` is 65 bytes, `r || s || v`, written as `0x` followed by 130 hex digits, where:
  - `v`, the last byte, is `0x1b` or `0x1c` (27 or 28). The `0`/`1` form is rejected. A client whose signer returns `0` or `1` adds 27 before storing the signature.
  - `s` is in the lower half of the curve order: `s <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0`. The high-`s` form of the same signature recovers the same address and is rejected anyway, so every proof has one accepted encoding.
- the address recovered from that signature, as an EIP-191 personal message over exactly this string, equals `address`:

```
{"domainSeparator":"bitsocial-author-wallet","authorPublicKey":"<key address>","timestamp":<timestamp>}
```

`authorPublicKey` is the **key address** of the author's signing key: the `12D3KooW…` form derived from `signature.publicKey`. It is never `author.address`, which is `author.name || keyAddress` and follows a name when the name is repointed. The field order is fixed and there is no whitespace.

Verification is stateless. There is no "newest timestamp wins" rule, and no RPC is needed. Signatures from contract accounts (ERC-1271) are not `eip191` proofs and do not verify.

The `v` and `s` rules are checked before recovery, because recovery libraries (viem included) accept the other forms. The BSIP draft's test vector is part of this package's tests.

Proofs signed with the older `pkc-author-wallet` or `plebbit-author-wallet` strings, or over `author.address`, do not verify. Authors re-sign.

The BSIP is still a draft, so these rules can change with it. It asks community nodes to verify wallet proofs on acceptance; once pkc-js does, the check here becomes a second line of defence.

## Future work

- **Let a verified tip skip the community's other challenges.** A community could treat a tip that passes this challenge as proof of effort and excuse that author from its other challenges (a captcha, a question) for that reply. pkc-js has no way for one challenge to excuse the others today, so this needs support there first. It must stay opt-in per community, since a tip proves a payment and not good behaviour.

## Known gaps

- **One transaction can be claimed once in each community.** A plain transfer names no comment, so the same payment can back a tip reply in community A and another in community B, as long as the recipient has a comment in both. Only a tipping contract that records the tipped comment would close this.
- **An old payment after the comment was posted.** The freshness rule only rejects transactions older than the tipped comment. A real, unrelated payment made to the same author after that comment was posted can be claimed as a tip on it, once.
- **The tipper no longer signs which reply a payment is for.** The claim travels in the publish request, not in the signed comment, so a community could attach a real payment to a different reply by the same tipper. It still cannot invent a payment: the verified result names the transaction, and the transfer must run between the two authors' proven wallets.
- **Comment timestamps are chosen by authors.** The freshness rule compares a block time with the parent comment's own `timestamp`.
- **Communities that hide authors.** The recipient's wallet proof is checked against the signing key stored with the parent comment. A community that replaces author identities (pseudonymity) may store a different key there, in which case tips are rejected. This combination has not been tested.
- **Excluded authors.** An author excused from this challenge by an `exclude` rule skips verification. No verified result is written for their reply, so a tip they paid does not show.

## For UI client developers

### 1. Find out whether the community accepts tips

```js
function getTippingConfig(community) {
  for (const challenge of community.challenges ?? []) {
    const raw = challenge.publicOptions?.["tipping/v1/tokens"];
    if (!raw) continue;
    try {
      const tokens = JSON.parse(raw);
      if (!Array.isArray(tokens)) continue;
      return { tokens, feeRecipient: challenge.publicOptions["tipping/v1/feeRecipient"] };
    } catch {
      // A list you cannot parse costs the tip button, never the community.
    }
  }
  return undefined;
}
```

Never look at which package produced the options. The record does not say, and you do not need it. If you bundle npm packages, `parseTipTokens` from this package validates the list exactly as the community node does.

Chains are named by `chainId` only. Offer a tip only when the comment's author has at least one valid `author.wallets` entry, and the user has one too.

### 2. Pick the recipient's wallet, and verify it before sending money

The community verifies the recipient's wallet proof, but it does so after the money has moved. Verify it yourself first, with the [wallet proof](#wallet-proofs) rules, so a user never pays an address the author does not control. `verifyWalletProof` and `getKeyAddressFromPublicKey` are exported from this package.

The keys of `author.wallets` do not select a chain, so every client must pick the same entry by the same rule:

1. Send to the tipped author's `eth` entry when it is valid.
2. Otherwise send to the first valid entry, taking the keys in ascending order.

If no entry is valid, do not offer a tip.

### 3. Send the payment

**Check your own RPC's chain ID first.** Before sending, confirm that the wallet or RPC you send through reports the `chainId` of the token entry (`eth_chainId`). A transfer sent on another chain cannot be verified, and the money is gone either way.

Send the token from a wallet the user has a valid `author.wallets` entry for, to the recipient wallet picked above. If the token has a fee, also send the fee, on the same chain ID, from any of the user's valid wallets to `tipping/v1/feeRecipient`.

- Compute a percentage fee and round **up** if you want to be safe. The community requires at least the rounded-down amount.
- If the wallet can batch (EIP-7702 or EIP-5792), put an ERC-20 fee in the same transaction as the tip. Otherwise send it separately and put its hash in `feeTxHash`.
- A native coin tip and a native coin fee are always two direct sends.

How the transaction is produced is outside this contract.

### 4. Wait, then publish

Wait until the transaction, and the fee transaction if any, are mined. An unmined transaction is rejected with a message asking the author to publish again.

Then publish the reply with the claim as a pre-answer, keyed by the tipping challenge's index:

```js
const challengeIndex = community.challenges.findIndex((c) => c.publicOptions?.["tipping/v1/tokens"]);

const reply = await pkc.createComment({
  communityAddress,
  parentCid: tippedComment.cid,
  postCid: tippedComment.postCid,
  content: "great post",
  challengeRequest: {
    challengeAnswers: { [String(challengeIndex)]: JSON.stringify({ chainId: 1, txHash, feeTxHash }) }
  }
});
```

If the publication is rejected for an unrelated reason, publish **the same signed publication** again, with the same pre-answer. A transaction is held for the publication that first claimed it, and released for another publication only after 15 minutes without the first one landing.

### 5. Display verified tips only

Show a tip only when both are true:

- the community publishes `tipping/v1/tokens`, and
- the reply's **comment update** carries `tip`, as written by the community.

Do not display from the author's claim. In a community that does not run this challenge, anyone can publish a reply with any `tip` field they like, and nothing has checked it.

The claim is not stored with the reply. The verified result sits at the top level of the comment update, so on a `Comment` instance it is `comment.tip`.

Before displaying a tip, verify the wallets it names: `tip.from` must be the address of a valid `author.wallets` entry of the reply's author, and `tip.to` the address of a valid entry of the tipped comment's author. That check needs no network.

A client is **not** required to fetch the transaction. The community node already read it from an RPC whose chain ID it confirmed. A client that wants to be independent of the community can re-check a tip against the chain with its `chainId` and `txHash`, but that is optional.

To show a total on a comment, sum the verified tips of its loaded replies, per `chainId` and token.

## Installation

Not yet published to npm. From a clone:

```bash
npm install
npm run build
```

Then register the built package with your node the way your pkc-js setup loads challenge packages.

## Configuration

Add the challenge to the community's `settings.challenges`. Option values are strings, so the token list is passed as a JSON string:

```js
{
  name: "@bitsocial/tipping-challenge",
  options: {
    "tipping/v1/tokens": JSON.stringify([
      { chainId: 1, type: "native", minAmount: "1000000000000000" },
      { chainId: 1, type: "erc20", address: "0xB50cea4c109dc223A10d44c14f521CaeD91DaB5A", fee: { percent: "2.5" } }
    ]),
    "tipping/v1/feeRecipient": "0x…",
    rpcUrls: JSON.stringify({ "1": "https://your-eth-node.example" })
  },
  publicOptions: ["tipping/v1/tokens", "tipping/v1/feeRecipient"]
}
```

| Option | Required | Public | Meaning |
|---|---|---|---|
| `tipping/v1/tokens` | yes | must be | The token list |
| `tipping/v1/feeRecipient` | when a token has a fee | must be, when set | Where fees are paid |
| `rpcUrls` | for chain IDs with no built-in RPC | must not be | JSON-RPC endpoints the node reads transactions from |

`rpcUrls` is a JSON object keyed by chain ID. JSON keys are strings, so the chain ID is written as a string key. Each value is a comma-separated list of URLs. A URL is `http:`, `https:`, `ws:` or `wss:`, and the schemes can be mixed in one list:

```json
{ "1": "https://a.example,wss://b.example", "8453": "https://c.example" }
```

A WebSocket connection that drops is reopened every 10 seconds until the endpoint answers again, so an outage does not need a node restart.

A plain comma-separated list of URLs is also accepted, but only when every token entry uses the same single chain ID.

Every endpoint must report the chain ID it is listed under. The node checks this before it verifies a tip and rejects the tip if the RPC is on another chain. With several URLs for one chain ID the node cannot tell which one answered, so list only endpoints for that chain.

Chain IDs with a built-in public RPC: 1 (Ethereum), 10 (OP Mainnet), 56 (BNB Smart Chain), 100 (Gnosis), 137 (Polygon), 250 (Fantom), 324 (ZKsync Era), 8453 (Base), 42161 (Arbitrum One), 42220 (Celo), 43114 (Avalanche), 59144 (Linea), 81457 (Blast), 534352 (Scroll). Those endpoints are shared and rate-limited, so setting your own is recommended.

Settings are checked when they are saved. The edit is rejected when:

- `tipping/v1/tokens` is not in `publicOptions`, or the list is malformed;
- a token has a fee and `tipping/v1/feeRecipient` is missing, is not an address, or is not in `publicOptions`;
- `tipping/v1/feeRecipient` is set but no token has a fee;
- `rpcUrls` is in `publicOptions` (RPC URLs often embed an API key), is malformed, has an entry that is not an `http:`, `https:`, `ws:` or `wss:` URL, has a key that is not a chain ID or that no token uses, is a plain list while the tokens span several chain IDs, or is missing for a chain ID with no built-in RPC.

### Moderation

A tip reply is an ordinary comment. Pending approval, removal and the mod log apply to it like any other. The `pendingApproval` flag on this challenge holds every comment the challenge applied to, not only tip replies.

### State

The challenge remembers which transactions have backed a tip, per community and chain ID, in the node's pkc-js storage (`tipping_challenge_v1_used_tx`). Deleting that storage lets old transactions be claimed again.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Tests run against a fake chain served through a real viem client. They use no network and no funds.

## License

GPL-3.0-or-later

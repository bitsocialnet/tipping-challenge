# AGENTS Notes

`README.md` is the `tipping/v1` spec. Code follows it: change the README and the code together.

Reference source files:

- `@pkcprotocol/pkc-js/src/challenges.ts` and `docs/protocol/challenge-authoring.md` for the challenge API.
- `src/contract.ts` holds everything a client and a community node must agree on. It has no pkc-js import.
- `src/index.ts` exports the challenge only: the factory as the default export, and its parts by name. Nothing from `src/contract.ts` or `src/wallet-proof.ts` is exported. UI clients copy the README's code snippets instead of importing from this package.

Workflow:

- Before every commit, run `npm run typecheck` and `npm test` and make sure both pass.
- When asked to commit and push, push a branch and open a pull request against `master` so it can be reviewed. Never push straight to the default branch. Do not put Claude session links in commits, PRs or issues.
- Keep the README's code snippets up to date with the code they restate: the wallet proof snippets with `src/wallet-proof.ts` and `getWalletMessageToSign`, the parent binding snippet with `getParentBindingSuffix`, the fee snippet with `getRequiredFee`. When one changes, change the other in the same commit.
- Tests must not use the network or real funds. The fake chain in `test/helpers.ts` serves a real viem client.
- Do not use real token addresses in tests or examples unless they are verified against the chain.
- This package is not published to npm (`"private": true`). Do not publish it without being asked.

# AGENTS Notes

`README.md` is the `tipping/v1` spec. Code follows it: change the README and the code together.

Reference source files:

- `@pkcprotocol/pkc-js/src/challenges.ts` and `docs/protocol/challenge-authoring.md` for the challenge API.
- `src/contract.ts` holds everything a client and a community node must agree on. It has no pkc-js import.

Workflow:

- Before every commit, run `npm run typecheck` and `npm test` and make sure both pass.
- Tests must not use the network or real funds. The fake chain in `test/helpers.ts` serves a real viem client.
- Do not use real token addresses in tests or examples unless they are verified against the chain.
- This package is not published to npm (`"private": true`). Do not publish it without being asked.

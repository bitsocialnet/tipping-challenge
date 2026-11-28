# Changelog

## [0.3.0](https://github.com/bitsocialnet/tipping-challenge/compare/v0.2.2...v0.3.0) (2026-11-28)

### ⚠ BREAKING CHANGES

* requires @pkcprotocol/pkc-js 0.0.165 or later. Older
versions pass no log, so getChallenge would throw.

### Features

* log rejections through the log pkc-js passes into each call ([60e44e7](https://github.com/bitsocialnet/tipping-challenge/commit/60e44e7d037235fc4632be7504ce687cf7ca6445)), closes [pkcprotocol/pkc-js#626](https://github.com/pkcprotocol/pkc-js/issues/626) [#19](https://github.com/bitsocialnet/tipping-challenge/issues/19)

### Bug Fixes

* log a fixed line for rejection reasons that quote untrusted text ([930c9ee](https://github.com/bitsocialnet/tipping-challenge/commit/930c9eee6818c939603555607023f92b86601560))

## [0.2.2](https://github.com/bitsocialnet/tipping-challenge/compare/v0.2.1...v0.2.2) (2026-11-26)

### Bug Fixes

* **deps:** upgrade @pkcprotocol/pkc-js 0.0.152 -> 0.0.163 ([#18](https://github.com/bitsocialnet/tipping-challenge/issues/18)) ([d83f616](https://github.com/bitsocialnet/tipping-challenge/commit/d83f61638f562d18fa91acf5ac792f63d571be14))

## [0.2.1](https://github.com/bitsocialnet/tipping-challenge/compare/v0.2.0...v0.2.1) (2026-11-23)

### Bug Fixes

* reject a comment that carries its own tip field ([bbc09e0](https://github.com/bitsocialnet/tipping-challenge/commit/bbc09e046aca59426f91d90a6a6fc0608b80c528))

## 0.2.0 (2026-11-20)

### ⚠ BREAKING CHANGES

* export only the challenge
* follow the BSIP-22 wallet proof string
* a transaction without the suffix, or sent by another
account, no longer verifies.
* spec the parent binding for tip transactions
* read the tip claim from the challenge pre-answer
* identify chains by numeric chain ID only

### refactor

* export only the challenge ([a9158fc](https://github.com/bitsocialnet/tipping-challenge/commit/a9158fc45b9224a58f9a6c2755ae9da9d2fa3893))

### docs

* spec the parent binding for tip transactions ([ec3c901](https://github.com/bitsocialnet/tipping-challenge/commit/ec3c9010ce21816cfbf4a9f59641201cb10d5d26))

### Features

* accept WebSocket URLs in rpcUrls ([0e3c5e6](https://github.com/bitsocialnet/tipping-challenge/commit/0e3c5e6be379d3d9d94db20740f124603d905b96))
* identify chains by numeric chain ID only ([ca26c8f](https://github.com/bitsocialnet/tipping-challenge/commit/ca26c8fab1d7f84d441da8c77382e8cb562a3373))
* read the tip claim from the challenge pre-answer ([4cd88ac](https://github.com/bitsocialnet/tipping-challenge/commit/4cd88ac35f4c4464778d98f150b807724814c710))
* require the parent binding and the tipper as sender on claimed transactions ([acede37](https://github.com/bitsocialnet/tipping-challenge/commit/acede3725d96e453449d3ebc9f9ae4bfb3ba23e1))
* verify tips attached to replies (tipping/v1) ([f7a34ec](https://github.com/bitsocialnet/tipping-challenge/commit/f7a34ec65b3a111235c2f080f9ddab039f2062e7))
* write the contract name and version into the verified tip ([11755bc](https://github.com/bitsocialnet/tipping-challenge/commit/11755bc1b8f562d5ee2ca7a84289c4f515dc10b2))

### Bug Fixes

* **ci:** skip Claude reviews on draft PRs [skip ci] [skip github-alerts] ([9c31aee](https://github.com/bitsocialnet/tipping-challenge/commit/9c31aee38852d32a5fac905de3dd81d41217c0be))
* **ci:** sync package-lock.json and run CI on npm 11 ([9e97faa](https://github.com/bitsocialnet/tipping-challenge/commit/9e97faae09fe90682a8401cf10f3825a6b027586))
* follow the BSIP-22 wallet proof string ([0ac5c56](https://github.com/bitsocialnet/tipping-challenge/commit/0ac5c5637993c607b2c638a6b9eb50413a308e96)), closes [#10](https://github.com/bitsocialnet/tipping-challenge/issues/10)
* keep WebSocket RPCs reconnecting and pick the transport by parsed scheme ([7a26036](https://github.com/bitsocialnet/tipping-challenge/commit/7a2603676556d8233b20ddff6eb8f046823409ef))
* **wallet-proof:** follow the Author Wallet Proofs BSIP draft ([abd308d](https://github.com/bitsocialnet/tipping-challenge/commit/abd308d88f3afc343e913a2c50e428ffbcc25ef7))

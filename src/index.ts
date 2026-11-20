// The package exports the challenge and nothing else. pkc-js reads the default export. UI clients do not
// import from this package: the README carries the snippets they need.
export { default as tippingChallenge } from "./tipping-challenge.js";
export { default } from "./tipping-challenge.js";
export { description, optionInputs, getChallenge, validateChallengeSettings } from "./tipping-challenge.js";

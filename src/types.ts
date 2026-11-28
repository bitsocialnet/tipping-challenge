export type {
  ChallengeFileInput,
  ChallengeInput,
  ChallengeResultInput,
  GetChallengeArgsInput,
  CommunityChallengeSetting
} from "@pkcprotocol/pkc-js/challenges";

import type { GetChallengeArgsInput } from "@pkcprotocol/pkc-js/challenges";

export type LocalCommunity = GetChallengeArgsInput["community"];
// The logger pkc-js passes into every call: a child of the community's logger, already tagged by pkc-js.
export type ChallengeLog = GetChallengeArgsInput["log"];
export type PKC = LocalCommunity["_pkc"];

type ChallengeRequestMessage = GetChallengeArgsInput["challengeRequestMessage"];
export type CommentFromChallengeRequest = NonNullable<ChallengeRequestMessage["comment"]>;

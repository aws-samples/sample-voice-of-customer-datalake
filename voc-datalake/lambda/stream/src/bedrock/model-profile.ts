/**
 * The e2e model profile for the stream Lambdas (owner decision, 5.58.00). MIRRORS
 * lambda/shared/model_profile.py and model_config.py's PROFILE_MODELS / PROFILE_FALLBACKS
 * (test_model_profile_lockstep.py reads this file).
 *
 * A caller in the Cognito group `e2e` (the production e2e test users) runs every model call
 * on Haiku 5.5, whatever the admin picked; the capacity fallback stays on Haiku. The profile
 * is derived ONLY from verified claims: `voc-chat-stream` reads the API Gateway Cognito
 * authorizer's `cognito:groups`, `voc-plan-step` the claims the conductor built after
 * re-reading the approver's groups in Cognito. Nothing in a request body can set it.
 */
import { parseGroups } from '../assistant/runtime/event.js';

const E2E_GROUP = 'e2e';
const E2E_PROFILE = 'e2e';
export type ModelProfile = typeof E2E_PROFILE;

const HAIKU55 = 'global.anthropic.claude-haiku-5-5';
const HAIKU45 = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

export const PROFILE_MODELS: Readonly<Record<ModelProfile, string>> = { e2e: HAIKU55 };
export const PROFILE_FALLBACKS: Readonly<Record<ModelProfile, readonly string[]>> = { e2e: [HAIKU55, HAIKU45] };

/** The profile of a caller with the verified `cognito:groups` claim `groups`, if any. */
export function profileForGroups(groups: string | undefined): ModelProfile | undefined {
  return parseGroups(groups).includes(E2E_GROUP) ? E2E_PROFILE : undefined;
}

/** `modelId`, or the profile's model when a profile applies. */
export function applyModelProfile(modelId: string, profile: ModelProfile | undefined): string {
  return profile === undefined ? modelId : PROFILE_MODELS[profile];
}

/** One structured line per run that resolved its model, so a log sweep can tell profiled runs apart. */
function logModelProfile(surface: string, modelId: string, profile: ModelProfile | undefined): void {
  if (profile === undefined) return;
  console.log(JSON.stringify({ level: 'INFO', message: 'model profile applied', surface, model_id: modelId, model_profile: profile }));
}

/** `modelId` after the profile of a caller with verified `cognito:groups` `groups` (logged when one applies). */
export function profiledModelId(modelId: string, groups: string | undefined, surface: string): string {
  const profile = profileForGroups(groups);
  const id = applyModelProfile(modelId, profile);
  logModelProfile(surface, id, profile);
  return id;
}

/**
 * The OpenAI GPT models of the web search surface (`web_reviews_search`, Administration → AI models, 7.42.00): a
 * Web Reviews target whose method is `bedrock_web_search` (docs/web-reviews.md → Methods) is read by one of them on
 * the Responses API of the `bedrock-mantle` endpoint, offered in us-west-2 on 2026-11-15. In the order of the
 * capacity fallback; the first is the surface's default.
 *
 * Deliberately NOT part of ALLOWED_MODEL_IDS (lib/utils/model-allowlist.ts): that list is the Claude text picker,
 * and nothing there may pick a GPT model, nor this surface a Claude one. In lockstep with
 * lambda/shared/model_config.py `WEB_SEARCH_MODELS` (the surface's allowlist, which the API and the ingestor
 * enforce): lib/stacks/ingestion-web-search.test.ts compares the two. The IAM grant is
 * `bedrock-mantle:CreateInference` on the account's default project (the ingestor, ingestion-roles.ts, and the
 * settings Lambda's Test, api-marketplace.ts); it does not name the models, because the value format of the
 * `bedrock-mantle:Model` condition key is not documented, so the allowlist is enforced in code.
 *
 * OpenAI models are sold through AWS Marketplace: each needs its agreement. The deploy accepts every one of them,
 * best effort, while an enabled plugin reads with them (BedrockModelAgreements, bedrock-access-stack.ts;
 * `aws bedrock list-foundation-model-agreement-offers --model-id <id>` lists an offer for each in us-west-2).
 */
import type * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

import type { PluginManifest } from '../plugin-loader';

export const WEB_SEARCH_MODELS = [
  'openai.gpt-5.6-luna', 'openai.gpt-5.6-terra', 'openai.gpt-5.6-sol', 'openai.gpt-5.5', 'openai.gpt-5.4',
] as const;

/** The Responses API on bedrock-mantle (a request names no project: the account's default one). */
export const MANTLE_INFERENCE_ACTION = 'bedrock-mantle:CreateInference';

/**
 * The settings Lambda's `WEB_SEARCH_MODELS_OFFERED` ('true' | 'false'): whether Administration → AI models offers
 * the web search surface and its Test (lambda/shared/model_config.py `WEB_SEARCH_OFFERED_ENV`).
 */
export const WEB_SEARCH_OFFERED_ENV = 'WEB_SEARCH_MODELS_OFFERED';

/** `bedrock-mantle:CreateInference` on `stack`'s account's default mantle project, and nothing else. */
export function mantleInferenceStatement(stack: cdk.Stack): iam.PolicyStatement {
  return new iam.PolicyStatement({
    actions: [MANTLE_INFERENCE_ACTION],
    resources: [stack.formatArn({ service: 'bedrock-mantle', resource: 'project', resourceName: 'default' })],
  });
}

/**
 * Whether an enabled plugin reads pages with these models (`infrastructure.ingestor.webSearch`, the web_reviews
 * plugin): only then does the deploy accept their agreements and the settings Lambda offer their surface.
 */
export function webSearchModelsInUse(enabledPlugins: readonly PluginManifest[]): boolean {
  return enabledPlugins.some((plugin) => plugin.infrastructure.ingestor?.webSearch === true);
}

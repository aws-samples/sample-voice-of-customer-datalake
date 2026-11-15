/**
 * The OpenAI GPT models a Web Reviews target may read its page with through Amazon Bedrock web search
 * (`method: bedrock_web_search`, docs/web-reviews.md → Methods): the Responses API on the `bedrock-mantle` endpoint,
 * offered in us-west-2 on 2026-11-15. The first is the default.
 *
 * In lockstep with lambda/shared/web_review_targets.py `WEB_SEARCH_MODELS` (which the API and the ingestor validate
 * a target against) and the manifest's `model` options (plugins/web_reviews/manifest.json):
 * lib/stacks/ingestion-web-search.test.ts compares the three. The IAM grant (ingestion-roles.ts) is
 * `bedrock-mantle:CreateInference` on the account's default project; it does not name the models, because the
 * value format of the `bedrock-mantle:Model` condition key is not documented, so the allowlist is enforced in code.
 *
 * OpenAI models are sold through AWS Marketplace: the account needs each model's subscription (an administrator
 * accepts the offer once, e.g. in the Amazon Bedrock console) before a target may use it.
 */
export const WEB_SEARCH_MODELS = [
  'openai.gpt-5.6-luna', 'openai.gpt-5.6-terra', 'openai.gpt-5.6-sol', 'openai.gpt-5.5', 'openai.gpt-5.4',
] as const;

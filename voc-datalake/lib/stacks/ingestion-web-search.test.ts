/**
 * A Web Reviews target read through Amazon Bedrock web search (`method: bedrock_web_search`, 7.41.00): the
 * web_reviews ingestor's grants (`infrastructure.ingestor.webSearch`) and the model allowlist's lockstep.
 *
 * - `bedrock-mantle:CreateInference` on the account's default mantle project only (the Responses API);
 * - `bedrock-websearch:InvokeSearch` / `InvokeFetch` on `*`, held to the deployment's region by `aws:RequestedRegion`
 *   (the Bedrock web search IAM guide's grant); never `bedrock-websearch:ExternalWebAccess`, so Fetch reads the cache;
 * - no other ingestor role holds any of them;
 * - lib/utils/web-search-models.ts and lambda/shared/model_config.py `WEB_SEARCH_MODELS` (the web search surface's
 *   allowlist, 7.42.00) name the same models, in the same order (the first is the surface's default), and the
 *   manifest asks for no model (Administration → AI models chooses it); the manifest's `method` options are the
 *   Python `METHODS`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { byCodeUnit } from '../utils/compare';
import { type NormalizedStatement, roleStatements } from '../test-support/iam-statements';
import { sourceStringConstant } from '../test-support/cross-language-invariants';
import { SYNTH_ACCOUNT, SYNTH_REGION } from '../test-support/synth-app';
import { ALLOWED_FOUNDATION_MODEL_IDS, ALLOWED_MODEL_IDS } from '../utils/model-allowlist';
import { MANTLE_INFERENCE_ACTION, WEB_SEARCH_MODELS, webSearchModelsInUse } from '../utils/web-search-models';
import { loadPlugins } from '../plugin-loader';
import { WEB_SEARCH_ACTIONS } from './ingestion-roles';

const ROOT = join(__dirname, '..', '..');
const TARGETS_PY = ['lambda', 'shared', 'web_review_targets.py'];
const MODEL_CONFIG_PY = ['lambda', 'shared', 'model_config.py'];

/** The `"id"` of every row of model_config.py's `WEB_SEARCH_MODELS = [ {…}, … ]`, in order. */
function pythonWebSearchModelIds(): string[] {
  const source = readFileSync(join(ROOT, ...MODEL_CONFIG_PY), 'utf8');
  const body = /^WEB_SEARCH_MODELS = \[([\s\S]*?)^\]/m.exec(source)?.[1];
  if (body === undefined) throw new Error(`could not read WEB_SEARCH_MODELS from ${MODEL_CONFIG_PY.join('/')}`);
  return [...body.matchAll(/"id": "([^"]+)"/g)].map((match) => match[1] ?? '');
}

/** The default of model_config.py's `SURFACE_DEFAULTS` for the web search surface (an alias of a string literal). */
function pythonWebSearchDefault(): string | undefined {
  const source = readFileSync(join(ROOT, ...MODEL_CONFIG_PY), 'utf8');
  const alias = /^ {4}"web_reviews_search": (_\w+),$/m.exec(source)?.[1];
  return alias === undefined ? undefined : new RegExp(`^${alias} = "([^"]+)"$`, 'm').exec(source)?.[1];
}

const ManifestSchema = z.object({
  config: z.array(z.object({ key: z.string(), options: z.array(z.object({ value: z.string() })).optional() })),
});
const manifestFields = () =>
  ManifestSchema.parse(JSON.parse(readFileSync(join(ROOT, 'plugins', 'web_reviews', 'manifest.json'), 'utf8'))).config;
const manifestOptions = (key: string): string[] =>
  (manifestFields().find((field) => field.key === key)?.options ?? []).map((option) => option.value);

const PolicySchema = z.object({
  Properties: z.object({ PolicyDocument: z.object({ Statement: z.array(z.record(z.string(), z.unknown())) }) }),
});
const PROJECT = JSON.stringify(`arn:aws:bedrock-mantle:${SYNTH_REGION}:${SYNTH_ACCOUNT}:project/default`);
const isWebSearch = (s: NormalizedStatement): boolean => s.actions.some((action) =>
  action.startsWith('bedrock-mantle:') || action.startsWith('bedrock-websearch:'));

describe('the web_reviews ingestor\'s Amazon Bedrock web search grants', () => {
  let template: Template;
  beforeAll(() => { template = synthIngestionTemplate(['web_reviews', 'webscraper', 'app_reviews_ios']); });

  const webReviews = () => roleStatements(template, 'IngestorRoleWebReviewsDefaultPolicy', { byIdPrefix: true })
    .filter(isWebSearch);

  it('may call the Responses API on the default mantle project only', () => {
    expect(webReviews().filter((s) => s.actions.includes(MANTLE_INFERENCE_ACTION)))
      .toStrictEqual([{ effect: 'Allow', actions: [MANTLE_INFERENCE_ACTION], resource: PROJECT }]);
  });

  it('may search and fetch from the cache in the deployment\'s region, never the external web', () => {
    const statements = Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.startsWith('IngestorRoleWebReviewsDefaultPolicy'))
      .flatMap(([, resource]) => PolicySchema.parse(resource).Properties.PolicyDocument.Statement)
      .filter((statement) => JSON.stringify(statement.Action).includes('bedrock-websearch:'));
    expect(statements).toStrictEqual([{
      Action: [...WEB_SEARCH_ACTIONS].sort(byCodeUnit), Effect: 'Allow', Resource: '*',
      Condition: { StringEquals: { 'aws:RequestedRegion': SYNTH_REGION } },
    }]);
    expect(JSON.stringify(template.toJSON())).not.toContain('ExternalWebAccess');
  });

  it('gives no other ingestor role any of them', () => {
    const others = ['IngestorRoleWebscraperDefaultPolicy', 'IngestorRoleAppReviewsIosDefaultPolicy']
      .flatMap((prefix) => roleStatements(template, prefix, { byIdPrefix: true }).filter(isWebSearch));
    expect(others).toStrictEqual([]);
  });
});

describe('the web search models and methods, in lockstep', () => {
  it('are the same models in the CDK and the surface\'s allowlist, the default first', () => {
    expect(pythonWebSearchModelIds()).toStrictEqual([...WEB_SEARCH_MODELS]);
    expect(pythonWebSearchDefault()).toBe(WEB_SEARCH_MODELS[0]);
  });

  it('are none of the Claude picker\'s models, which hold no GPT model (two separate allowlists)', () => {
    expect(ALLOWED_MODEL_IDS.filter((id) => id.includes('openai.'))).toStrictEqual([]);
    expect(ALLOWED_FOUNDATION_MODEL_IDS.filter((id) => WEB_SEARCH_MODELS.some((model) => model === id))).toStrictEqual([]);
  });

  it('are in use exactly while a plugin that reads with them is enabled: the web_reviews plugin', () => {
    const plugins = loadPlugins(join(ROOT, 'plugins'));
    expect(plugins.filter((plugin) => webSearchModelsInUse([plugin])).map((plugin) => plugin.id)).toStrictEqual(['web_reviews']);
    expect(webSearchModelsInUse([])).toBe(false);
  });

  it('are asked for on no page: the manifest has no model field (Administration → AI models chooses it)', () => {
    expect(manifestFields().map((field) => field.key)).not.toContain('model');
  });

  it('offer in the manifest exactly the methods the API accepts, the browser first (the default)', () => {
    const methods = [sourceStringConstant('METHOD_BROWSER', ...TARGETS_PY),
      sourceStringConstant('METHOD_BEDROCK_WEB_SEARCH', ...TARGETS_PY)];
    expect(manifestOptions('method')).toStrictEqual(methods);
    expect(methods).toStrictEqual(['browser', 'bedrock_web_search']);
  });
});

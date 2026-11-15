/**
 * A Web Reviews target read through Amazon Bedrock web search (`method: bedrock_web_search`, 7.41.00): the
 * web_reviews ingestor's grants (`infrastructure.ingestor.webSearch`) and the model allowlist's lockstep.
 *
 * - `bedrock-mantle:CreateInference` on the account's default mantle project only (the Responses API);
 * - `bedrock-websearch:InvokeSearch` / `InvokeFetch` on `*`, held to the deployment's region by `aws:RequestedRegion`
 *   (the Bedrock web search IAM guide's grant); never `bedrock-websearch:ExternalWebAccess`, so Fetch reads the cache;
 * - no other ingestor role holds any of them;
 * - lib/utils/web-search-models.ts, lambda/shared/web_review_targets.py `WEB_SEARCH_MODELS` and the manifest's
 *   `model` options name the same models, in the same order (the first is the default), and the manifest's `method`
 *   options are the Python `METHODS`.
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
import { WEB_SEARCH_MODELS } from '../utils/web-search-models';
import { MANTLE_INFERENCE_ACTION, WEB_SEARCH_ACTIONS } from './ingestion-roles';

const ROOT = join(__dirname, '..', '..');
const TARGETS_PY = ['lambda', 'shared', 'web_review_targets.py'];

/** The quoted strings of a Python tuple constant `NAME: Final = ( '…', … )`. */
function pythonTuple(name: string): string[] {
  const source = readFileSync(join(ROOT, ...TARGETS_PY), 'utf8');
  const body = new RegExp(`^${name}(?::\\s*Final)?\\s*=\\s*\\(([^)]*)\\)`, 'm').exec(source)?.[1];
  if (body === undefined) throw new Error(`could not read ${name} from ${TARGETS_PY.join('/')}`);
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

const ManifestSchema = z.object({
  config: z.array(z.object({ key: z.string(), options: z.array(z.object({ value: z.string() })).optional() })),
});
const manifestOptions = (key: string): string[] => {
  const manifest = ManifestSchema.parse(JSON.parse(readFileSync(join(ROOT, 'plugins', 'web_reviews', 'manifest.json'), 'utf8')));
  return (manifest.config.find((field) => field.key === key)?.options ?? []).map((option) => option.value);
};

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
  it('are the same models in the CDK, the Python validation and the manifest, the default first', () => {
    expect(pythonTuple('WEB_SEARCH_MODELS')).toStrictEqual([...WEB_SEARCH_MODELS]);
    expect(manifestOptions('model')).toStrictEqual([...WEB_SEARCH_MODELS]);
    expect(sourceStringConstant('DEFAULT_WEB_SEARCH_MODEL', ...TARGETS_PY)).toBe(WEB_SEARCH_MODELS[0]);
  });

  it('offer in the manifest exactly the methods the API accepts, the browser first (the default)', () => {
    const methods = [sourceStringConstant('METHOD_BROWSER', ...TARGETS_PY),
      sourceStringConstant('METHOD_BEDROCK_WEB_SEARCH', ...TARGETS_PY)];
    expect(manifestOptions('method')).toStrictEqual(methods);
    expect(methods).toStrictEqual(['browser', 'bedrock_web_search']);
  });
});

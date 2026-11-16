/**
 * The Settings API's grant for the Test button of Administration → AI models → "Review pages: Bedrock web search"
 * (7.42.00, api-marketplace.ts grantWebSearchModelProbe, lambda/shared/web_search_model_probe.py):
 * - with the web_reviews plugin enabled (it reads with those models: `infrastructure.ingestor.webSearch`): exactly
 *   `bedrock-mantle:CreateInference` on the account's default mantle project, alone in its statement, and nothing
 *   of Amazon Bedrock web search (`bedrock-websearch:*`, the Test sends no tool); the Lambda offers the surface
 *   (`WEB_SEARCH_MODELS_OFFERED=true`);
 * - with no plugin reading with them: no `bedrock-mantle:*` at all, and the surface is not offered (`false`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { apiTemplate, apiTemplateAllPlugins, policyStatementsOf, serviceEnvironment } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { MANTLE_INFERENCE_ACTION, WEB_SEARCH_OFFERED_ENV } from '../utils/web-search-models';

const MODEL_CONFIG_PY = join(__dirname, '..', '..', 'lambda', 'shared', 'model_config.py');
const ROLE = 'SettingsLambdaRoleDefaultPolicy';
/** The default mantle project of the fixture's account and region (the partition is the stack's pseudo parameter). */
const PROJECT = { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':bedrock-mantle:us-east-1:111111111111:project/default']] };
const isMantleOrWebSearch = (action: string): boolean =>
  action.startsWith('bedrock-mantle:') || action.startsWith('bedrock-websearch:');

beforeAll(() => {
  apiTemplate();
  apiTemplateAllPlugins();
}, SYNTH_TIMEOUT_MS * 2);

describe('Settings role: the web search surface\'s Test', () => {
  it('may call the Responses API on the default mantle project only, and nothing of web search', () => {
    const statements = policyStatementsOf(apiTemplateAllPlugins(), ROLE)
      .filter((s) => s.actions.some(isMantleOrWebSearch));
    expect(statements.map((s) => [s.actions, JSON.parse(s.resource), s.condition]))
      .toStrictEqual([[[MANTLE_INFERENCE_ACTION], PROJECT, undefined]]);
  });

  it('offers the surface on the settings Lambda', () => {
    expect(serviceEnvironment(apiTemplateAllPlugins(), 'voc-settings-api')[WEB_SEARCH_OFFERED_ENV]).toBe('true');
  });

  it('the control: without a plugin that reads with those models, no mantle grant and no surface', () => {
    expect(policyStatementsOf(apiTemplate(), ROLE).filter((s) => s.actions.some(isMantleOrWebSearch)))
      .toStrictEqual([]);
    expect(serviceEnvironment(apiTemplate(), 'voc-settings-api')[WEB_SEARCH_OFFERED_ENV]).toBe('false');
  });

  it('names the environment variable the Python resolver reads', () => {
    const python = /^WEB_SEARCH_OFFERED_ENV = "([^"]+)"$/m.exec(readFileSync(MODEL_CONFIG_PY, 'utf8'))?.[1];
    expect(python).toBe(WEB_SEARCH_OFFERED_ENV);
  });
});

/**
 * Feedback-board requests as evidence (lib/utils/feature-request-evidence-grant.ts,
 * docs/project-workspace.md → Feature requests): exactly the roles that read them get the table
 * name and `dynamodb:Query` on voc-feature-requests, nothing else on that table.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';

import { actionsWithPrefix, apiTemplateAllPlugins, policyStatementsOf, serviceEnvironment } from '../test-support/api-stack-template';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

const holder: { processing?: Template; api?: Template } = {};
const processing = (): Template => holder.processing ?? (holder.processing = synthProcessingTemplate());
const api = (): Template => holder.api ?? (holder.api = apiTemplateAllPlugins());

beforeAll(() => {
  processing();
  api();
}, SYNTH_TIMEOUT_MS);

/** The DynamoDB actions `roleFragment` holds on the feature-requests table (any of its ARNs). */
function featureRequestActions(template: Template, roleFragment: string): string[] {
  const statements = policyStatementsOf(template, roleFragment).filter((s) => /FeatureRequests/.test(s.resource));
  return [...new Set(actionsWithPrefix(statements, 'dynamodb:'))].sort();
}

describe('the evidence readers', () => {
  it.each([
    ['ProjectsLambdaRole', 'voc-projects-api'],
    ['PersonaGeneratorRole', 'voc-job-persona-generator'],
    ['DocumentGeneratorRole', 'voc-job-document-generator'],
  ])('%s queries the table and %s knows its name', (role, service) => {
    expect(featureRequestActions(api(), role)).toStrictEqual(['dynamodb:Query']);
    expect(JSON.stringify(serviceEnvironment(api(), service).FEATURE_REQUESTS_TABLE)).toMatch(/FeatureRequests/);
  });

  it('the research step queries the table and knows its name', () => {
    expect(featureRequestActions(processing(), 'ResearchLambdaRole')).toStrictEqual(['dynamodb:Query']);
    expect(JSON.stringify(serviceEnvironment(processing(), 'voc-research-step').FEATURE_REQUESTS_TABLE))
      .toMatch(/FeatureRequests/);
  });

  it('the generators that do not read board requests get no access', () => {
    expect(featureRequestActions(api(), 'DocumentMergerRole')).toStrictEqual([]);
    expect(featureRequestActions(api(), 'PersonaImporterRole')).toStrictEqual([]);
  });
});

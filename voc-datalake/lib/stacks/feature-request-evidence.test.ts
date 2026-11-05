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

let processing: Template;
let api: Template;

beforeAll(() => {
  // Both stacks' templates, synthesized once for the whole file.
  [processing, api] = [synthProcessingTemplate(), apiTemplateAllPlugins()];
}, SYNTH_TIMEOUT_MS);

/** The DynamoDB actions `roleFragment` holds on the feature-requests table (any of its ARNs). */
function featureRequestActions(template: Template, roleFragment: string): string[] {
  const statements = policyStatementsOf(template, roleFragment).filter((s) => /FeatureRequests/.test(s.resource));
  return [...new Set(actionsWithPrefix(statements, 'dynamodb:'))].sort((a, b) => a.localeCompare(b));
}

describe('the evidence readers', () => {
  it.each([
    ['PersonaGeneratorRole', 'voc-job-persona-generator'],
    ['DocumentGeneratorRole', 'voc-job-document-generator'],
  ])('%s queries the table and %s knows its name', (role, service) => {
    expect(featureRequestActions(api, role)).toStrictEqual(['dynamodb:Query']);
    expect(JSON.stringify(serviceEnvironment(api, service).FEATURE_REQUESTS_TABLE)).toMatch(/FeatureRequests/);
  });

  it('the research step queries the table and knows its name', () => {
    expect(featureRequestActions(processing, 'ResearchLambdaRole')).toStrictEqual(['dynamodb:Query']);
    expect(JSON.stringify(serviceEnvironment(processing, 'voc-research-step').FEATURE_REQUESTS_TABLE))
      .toMatch(/FeatureRequests/);
  });

  it('the roles that do not read board requests get no access', () => {
    // The Projects API only starts the jobs; its inline policy has no room (api-stack-mcp.test.ts).
    expect(featureRequestActions(api, 'ProjectsLambdaRole')).toStrictEqual([]);
    expect(serviceEnvironment(api, 'voc-projects-api').FEATURE_REQUESTS_TABLE).toBeUndefined();
    expect(featureRequestActions(api, 'DocumentMergerRole')).toStrictEqual([]);
    expect(featureRequestActions(api, 'PersonaImporterRole')).toStrictEqual([]);
  });
});

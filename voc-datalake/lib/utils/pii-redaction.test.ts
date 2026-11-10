/**
 * Every ingestion choke point can apply a source's PII policy before the raw
 * archive and the processing queue (docs/source-policies.md): it is told the
 * aggregates table (the source profile row), may GetItem on it, may call
 * Comprehend DetectPiiEntities, and has PII_COMPREHEND=1.
 *
 * A new ingestion Lambda that sends to the processing queue without these would
 * ship customer PII unredacted, so the set of choke points is derived from the
 * template (every function with PROCESSING_QUEUE_URL) rather than hand-listed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { apiTemplateAllPlugins, discoverPluginIds } from '../test-support/api-stack-template';
import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { roleStatements } from '../test-support/iam-statements';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { PII_REDACTION_ENV } from './pii-redaction';

const FunctionSchema = z.object({
  Properties: z.object({
    FunctionName: z.unknown().optional(),
    Role: z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.string()]) }),
    Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }).optional(),
  }),
});

interface ChokePoint { id: string; roleId: string; env: Record<string, unknown> }

/** Every function that sends to the processing queue. */
function chokePoints(template: Template): ChokePoint[] {
  return Object.entries(template.findResources('AWS::Lambda::Function')).flatMap(([id, resource]) => {
    const fn = FunctionSchema.safeParse(resource);
    const env = fn.data?.Properties.Environment?.Variables ?? {};
    if (!fn.success || !('PROCESSING_QUEUE_URL' in env)) return [];
    return [{ id, roleId: fn.data.Properties.Role['Fn::GetAtt'][0], env }];
  });
}

/** Known choke points that must be detected (a floor, so detection cannot silently find nothing). */
const EXPECTED_CHOKE_POINTS: Record<string, string[]> = {
  api: ['ManualImportApi', 'FeedbackFormApi', 'DataExplorerApi', 'GithubIssuesWebhook'],
  ingestion: ['IngestorWebscraper', 'IngestorGithubIssues'],
};

const templates: Record<string, Template> = {};
beforeAll(() => {
  templates.api = apiTemplateAllPlugins();
  templates.ingestion = synthIngestionTemplate(discoverPluginIds());
}, SYNTH_TIMEOUT_MS);

const points = (stack: string) => {
  const template = templates[stack];
  if (template === undefined) throw new Error(`no ${stack} template`);
  return { template, points: chokePoints(template) };
};

describe.each(['api', 'ingestion'])('PII policy wiring in the %s stack', (stack) => {
  it('finds the choke points (manual import, feedback form, data explorer, webhook / every ingestor)', () => {
    const ids = points(stack).points.map((p) => p.id).join(' ');
    expect((EXPECTED_CHOKE_POINTS[stack] ?? ['<unknown stack>']).filter((name) => !ids.includes(name))).toStrictEqual([]);
  });

  it('hands every choke point AGGREGATES_TABLE and PII_COMPREHEND=1', () => {
    const missing = points(stack).points
      .filter((p) => !('AGGREGATES_TABLE' in p.env) || p.env.PII_COMPREHEND !== PII_REDACTION_ENV.PII_COMPREHEND)
      .map((p) => p.id);
    expect(missing).toStrictEqual([]);
  });

  it('lets every choke point read the profile row and call DetectPiiEntities', () => {
    const { template, points: list } = points(stack);
    const missing = list.filter((p) => {
      const statements = roleStatements(template, p.roleId);
      const readsAggregates = statements.some((s) => s.resource.includes('Aggregates') && s.actions.some((a) => a === 'dynamodb:GetItem' || a === 'dynamodb:*'));
      const detectsPii = statements.some((s) => s.actions.includes('comprehend:DetectPiiEntities'));
      return !(readsAggregates && detectsPii);
    }).map((p) => p.id);
    expect(missing).toStrictEqual([]);
  });
});

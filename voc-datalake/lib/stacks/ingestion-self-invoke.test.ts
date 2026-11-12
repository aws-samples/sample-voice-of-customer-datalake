/**
 * The scheduled ingestors' self-invoke grant: the tick's per-workspace fan-out (plugins/_shared/base_ingestor.py
 * fan_out_tick) and the app-review continuation parts (plugins/_shared/app_reviews_parts.py) invoke the plugin's
 * OWN function, so each scheduled role may invoke exactly that function — never a sibling ingestor, never a
 * wildcard — and an unscheduled one may invoke no function.
 */
import type { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { capitalize } from '../plugin-loader';
import { flattenRefJoin } from '../test-support/cfn-join';
import { type NormalizedStatement, roleStatements } from '../test-support/iam-statements';
import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { SYNTH_ACCOUNT, SYNTH_REGION } from '../test-support/synth-app';

const FunctionSchema = z.object({ Properties: z.object({ FunctionName: z.unknown() }) });

const invokeStatements = (statements: NormalizedStatement[]) =>
  statements.filter((s) => s.actions.includes('lambda:InvokeFunction'));

describe('VocIngestionStack scheduled ingestors\' self-invoke grants', () => {
  let template: Template;
  beforeAll(() => {
    template = synthIngestionTemplate(['app_reviews_ios', 'app_reviews_android', 'webscraper']);
  });

  const functionName = (pluginId: string): string => {
    const [resource] = Object.entries(template.findResources('AWS::Lambda::Function'))
      .filter(([id]) => id.startsWith(`Ingestor${capitalize(pluginId)}`));
    return flattenRefJoin(FunctionSchema.parse(resource?.[1]).Properties.FunctionName);
  };
  const grantsOf = (pluginId: string) => invokeStatements(
    roleStatements(template, `IngestorRole${capitalize(pluginId)}DefaultPolicy`, { byIdPrefix: true }),
  );

  it.each(['app_reviews_ios', 'app_reviews_android', 'webscraper'])('lets %s invoke exactly its own function', (pluginId) => {
    const grants = grantsOf(pluginId);
    expect(grants.map((s) => s.actions)).toStrictEqual([['lambda:InvokeFunction']]);
    expect(grants.map((s) => flattenRefJoin(JSON.parse(s.resource)))).toStrictEqual([
      `arn:aws:lambda:${SYNTH_REGION}:${SYNTH_ACCOUNT}:function:${functionName(pluginId)}`,
    ]);
  });

  it('gives an unscheduled ingestor no invoke grant (s3_import: a role of its own for its job notices)', () => {
    const statements = invokeStatements(roleStatements(synthIngestionTemplate(['s3_import']),
      `IngestorRole${capitalize('s3_import')}DefaultPolicy`, { byIdPrefix: true }));
    expect(statements).toStrictEqual([]);
  });
});

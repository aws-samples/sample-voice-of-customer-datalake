/**
 * The app-review ingestors' self-invoke grant (plugins/_shared/app_reviews_parts.py).
 *
 * A many-app run continues in a new invocation of its own function once its time
 * budget is reached, so each app-review role may invoke exactly its OWN function —
 * never a sibling ingestor, never a wildcard — and no other ingestor role may
 * invoke any function.
 */
import type { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { capitalize } from '../plugin-loader';
import { type NormalizedStatement, roleStatements } from '../test-support/iam-statements';
import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { SYNTH_ACCOUNT, SYNTH_REGION } from '../test-support/synth-app';
import { SELF_CONTINUING_INGESTORS } from './ingestion-stack';

const FunctionSchema = z.object({ Properties: z.object({ FunctionName: z.unknown() }) });
const JoinSchema = z.object({
  'Fn::Join': z.tuple([z.literal(''), z.array(z.union([z.string(), z.object({ Ref: z.string() })]))]),
});

/** A synthesized string value, an `Fn::Join` of literals and `{Ref}`s written out as `${Ref}`. */
function flatten(value: unknown): string {
  if (typeof value === 'string') return value;
  return JoinSchema.parse(value)['Fn::Join'][1]
    .map((part) => (typeof part === 'string' ? part : `\${${part.Ref}}`))
    .join('');
}

const invokeStatements = (statements: NormalizedStatement[]) =>
  statements.filter((s) => s.actions.includes('lambda:InvokeFunction'));

describe('VocIngestionStack app-review self-invoke grants', () => {
  let template: Template;
  beforeAll(() => {
    template = synthIngestionTemplate(['app_reviews_ios', 'app_reviews_android', 'webscraper']);
  });

  const functionName = (pluginId: string): string => {
    const [resource] = Object.entries(template.findResources('AWS::Lambda::Function'))
      .filter(([id]) => id.startsWith(`Ingestor${capitalize(pluginId)}`));
    return flatten(FunctionSchema.parse(resource?.[1]).Properties.FunctionName);
  };
  const grantsOf = (pluginId: string) => invokeStatements(
    roleStatements(template, `IngestorRole${capitalize(pluginId)}DefaultPolicy`, { byIdPrefix: true }),
  );

  it.each(['app_reviews_ios', 'app_reviews_android'])('lets %s invoke exactly its own function', (pluginId) => {
    expect(SELF_CONTINUING_INGESTORS.has(pluginId)).toBe(true);
    const grants = grantsOf(pluginId);
    expect(grants.map((s) => s.actions)).toStrictEqual([['lambda:InvokeFunction']]);
    expect(grants.map((s) => flatten(JSON.parse(s.resource)))).toStrictEqual([
      `arn:aws:lambda:${SYNTH_REGION}:${SYNTH_ACCOUNT}:function:${functionName(pluginId)}`,
    ]);
  });

  it('gives an ingestor that does not continue itself no invoke grant', () => {
    expect(grantsOf('webscraper')).toStrictEqual([]);
  });
});

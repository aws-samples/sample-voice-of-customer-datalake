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

import * as path from 'path';

import { capitalize, loadPlugins } from '../plugin-loader';
import { byCodeUnit } from '../utils/compare';
import { flattenRefJoin } from '../test-support/cfn-join';
import { type NormalizedStatement, roleStatements } from '../test-support/iam-statements';
import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { SYNTH_ACCOUNT, SYNTH_REGION } from '../test-support/synth-app';

/** The plugins whose manifest declares `infrastructure.ingestor.selfInvoke` (tenet 5: no id list in the stack). */
const selfInvokingPlugins = (): string[] => loadPlugins(path.join(__dirname, '../../plugins'))
  .filter((plugin) => plugin.infrastructure.ingestor?.selfInvoke === true)
  .map((plugin) => plugin.id)
  .sort(byCodeUnit);

const FunctionSchema = z.object({ Properties: z.object({ FunctionName: z.unknown() }) });

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
    return flattenRefJoin(FunctionSchema.parse(resource?.[1]).Properties.FunctionName);
  };
  const grantsOf = (pluginId: string) => invokeStatements(
    roleStatements(template, `IngestorRole${capitalize(pluginId)}DefaultPolicy`, { byIdPrefix: true }),
  );

  it('reads the grant from the manifests: exactly the two app-review ingestors declare selfInvoke', () => {
    expect(selfInvokingPlugins()).toStrictEqual(['app_reviews_android', 'app_reviews_ios']);
  });

  it.each(['app_reviews_ios', 'app_reviews_android'])('lets %s invoke exactly its own function', (pluginId) => {
    const grants = grantsOf(pluginId);
    expect(grants.map((s) => s.actions)).toStrictEqual([['lambda:InvokeFunction']]);
    expect(grants.map((s) => flattenRefJoin(JSON.parse(s.resource)))).toStrictEqual([
      `arn:aws:lambda:${SYNTH_REGION}:${SYNTH_ACCOUNT}:function:${functionName(pluginId)}`,
    ]);
  });

  it('gives an ingestor that does not continue itself no invoke grant', () => {
    expect(grantsOf('webscraper')).toStrictEqual([]);
  });
});

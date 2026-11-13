/**
 * VocProcessingStack's push notices (docs/realtime.md): the Event API is VocCoreStack's (core-realtime.ts), so
 * each publisher (the agent conductor on `runs`, the job workers on `jobs`) gets the host as a stack reference and
 * its role carries exactly its namespace's managed publish policy, with no appsync or ssm statement of its own.
 * No other Lambda of this stack can publish.
 */
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FIXTURE_REALTIME_HTTP_DNS } from '../test-support/fixture-resources';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { byCodeUnit } from '../utils/compare';
import { REALTIME_HTTP_DNS_ENV, type RealtimeNamespace } from '../utils/realtime';
import { expectPublishesOnlyOn, realtimeNamespacesOfRole } from '../test-support/realtime-assertions';

const FunctionSchema = z.object({
  Properties: z.object({ FunctionName: z.unknown(), Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }) }),
});

/** Function base name → the logical id (prefix) of its role and the namespace it publishes on. */
const PUBLISHERS: Record<string, [string, RealtimeNamespace]> = {
  'voc-agent-conductor': ['AgentRuntimeAgentConductorRole', 'runs'],
  'voc-research-step': ['ResearchLambdaRole', 'jobs'],
  'voc-category-reprocess': ['CategoryReprocessRole', 'jobs'],
  'voc-retention': ['RetentionWorkerRetentionRole', 'jobs'],
  // A workspace export's end reaches its starter (lambda/jobs/workspace_export/handler.py).
  'voc-workspace-export': ['WorkspaceExportWorkerExportRole', 'jobs'],
  'voc-memory-extractor': ['MemoryWorkersMemoryExtractorRole', 'jobs'],
  'voc-briefing': ['BriefingWorkerBriefingRole', 'jobs'],
};

let template: Template;
beforeAll(() => { template = synthProcessingTemplate({ withIndexes: true }); });

function environmentsWith(key: string): { name: string; value: unknown }[] {
  return Object.values(template.findResources('AWS::Lambda::Function'))
    .map((resource) => FunctionSchema.safeParse(resource).data?.Properties)
    .filter((props) => props !== undefined && key in props.Environment.Variables)
    .map((props) => ({ name: JSON.stringify(props?.FunctionName), value: props?.Environment.Variables[key] }));
}

describe('VocProcessingStack\'s realtime publishers', () => {
  it('only the publishers are told the Event API host, as given by VocCoreStack', () => {
    const named = environmentsWith(REALTIME_HTTP_DNS_ENV);
    const expected = Object.keys(PUBLISHERS).sort(byCodeUnit);
    expect(named).toHaveLength(expected.length);
    expect(expected.filter((name) => !named.some((fn) => fn.name.includes(name)))).toStrictEqual([]);
    expect(new Set(named.map((fn) => JSON.stringify(fn.value)))).toStrictEqual(new Set([JSON.stringify(FIXTURE_REALTIME_HTTP_DNS)]));
  });

  it.each(Object.entries(PUBLISHERS))('%s publishes on exactly its namespace', (_name, [roleId, namespace]) => {
    expectPublishesOnlyOn(template, roleId, namespace, { byIdPrefix: true });
  });

  it('no other role of this stack carries a publish policy, and no statement here names appsync', () => {
    const publisherRoles = Object.values(PUBLISHERS).map(([roleId]) => roleId);
    const others = Object.keys(template.findResources('AWS::IAM::Role'))
      .filter((id) => !publisherRoles.some((roleId) => id.startsWith(roleId)))
      .filter((id) => realtimeNamespacesOfRole(template, id).length > 0);
    expect(others).toStrictEqual([]);
    expect(JSON.stringify(template.toJSON())).not.toContain('appsync:');
  });
});

/**
 * Async invocation failure destination (#253). Every Lambda the API stack
 * invokes with InvocationType='Event' must route a failed or expired invocation
 * to the durable failure queue — otherwise one that dies before it can record
 * its own failure (init error, OOM, the timeout kill, an aged-out throttle)
 * vanishes and leaves its job row `running` forever.
 *
 * The queue itself is VocCoreStack's (lib/stacks/dlq-alarms.test.ts pins it and
 * its alarm); this stack addresses it by its deterministic name.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';

import { API_ASYNC_FAILURES_QUEUE_BASE_NAME } from './dlq-alarms';
import { apiTemplate } from '../test-support/api-stack-template';
import { IamPolicySchema, isAttachedToRole, statementActions } from '../test-support/iam-statements';
import { itemAt } from '../test-support/guards';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

/** Construct ids of every async-invoked Lambda in the API stack. */
const ASYNC_INVOKED = [
  'PersonaGeneratorJob', 'DocumentGeneratorJob', 'DocumentMergerJob', 'PersonaImporterJob',
  'ManualImportProcessor',
];

/** How the Core queue's ARN appears in this template: `...:sqs:<region>:<account>:voc-api-async-failures-...`. */
const QUEUE_ARN_FRAGMENT = `:${API_ASYNC_FAILURES_QUEUE_BASE_NAME}-`;

const EventInvokeConfigSchema = z.object({
  Properties: z.object({
    FunctionName: z.object({ Ref: z.string() }),
    DestinationConfig: z.object({
      OnFailure: z.object({ Destination: z.unknown() }),
    }).optional(),
  }),
});
const FunctionRoleSchema = z.object({
  Properties: z.object({ Role: z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.string()]) }) }),
});

function onlyFunctionId(constructId: string): string {
  const ids = Object.keys(apiTemplate().findResources('AWS::Lambda::Function'))
    .filter((id) => new RegExp(`^${constructId}[0-9A-F]{8}$`).test(id));
  expect(ids, `exactly one AWS::Lambda::Function ${constructId}`).toHaveLength(1);
  return itemAt(ids, 0);
}

/** Every action `roleId`'s inline policies grant on a resource naming the failure queue. */
function actionsOnFailureQueue(roleId: string): string[] {
  const actions = Object.values(apiTemplate().findResources('AWS::IAM::Policy'))
    .map((resource) => IamPolicySchema.parse(resource).Properties)
    .filter((policy) => isAttachedToRole(policy, roleId))
    .flatMap((policy) => policy.PolicyDocument.Statement)
    .filter((s) => JSON.stringify(s.Resource).includes(QUEUE_ARN_FRAGMENT))
    .flatMap(statementActions);
  return [...new Set(actions)].sort(byCodeUnit);
}

describe('async invocation failure destination', () => {
  it('creates no queue of its own (the queue is VocCoreStack\'s)', () => {
    expect(Object.keys(apiTemplate().findResources('AWS::SQS::Queue'))
      .filter((logicalId) => logicalId.startsWith('AsyncInvokeFailures'))).toStrictEqual([]);
  });

  it.each(ASYNC_INVOKED)('routes a failed async invocation of %s to it', (constructId) => {
    const fnId = onlyFunctionId(constructId);
    const configs = Object.values(apiTemplate().findResources('AWS::Lambda::EventInvokeConfig'))
      .map((resource) => EventInvokeConfigSchema.parse(resource).Properties)
      .filter((c) => c.FunctionName.Ref === fnId);
    expect(configs, `${constructId} EventInvokeConfig`).toHaveLength(1);
    expect(JSON.stringify(itemAt(configs, 0).DestinationConfig?.OnFailure.Destination))
      .toContain(QUEUE_ARN_FRAGMENT);
  });

  it.each(ASYNC_INVOKED)('lets %s send to that queue — and only send', (constructId) => {
    const roleId = itemAt(FunctionRoleSchema.parse(apiTemplate().findResources('AWS::Lambda::Function')[onlyFunctionId(constructId)])
      .Properties.Role['Fn::GetAtt'], 0);
    expect(actionsOnFailureQueue(roleId), `${constructId} actions on the failure queue`)
      .toStrictEqual(['sqs:GetQueueAttributes', 'sqs:GetQueueUrl', 'sqs:SendMessage']);
  });
});

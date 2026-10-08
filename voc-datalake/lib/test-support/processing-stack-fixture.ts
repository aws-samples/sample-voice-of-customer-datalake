/**
 * Test support: VocProcessingStack synthesized against throwaway dependency
 * tables, queue, key and bucket — shared by the processing-stack suites.
 *
 * `withIndexes` gives every table a `gsi1` index. That is load-bearing for IAM
 * assertions about Query: `Table.grant()` adds `<table>/index/*` only when the
 * table has an index, so without one a table-only and an index-reaching grant
 * synthesize identically.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';

import { expect } from 'vitest';
import { z } from 'zod';

import { VocProcessingStack } from '../stacks/processing-stack-consolidated';
import { addGsi1 } from './api-stack-fixture';
import { fixtureBucket, fixtureQueue } from './fixture-resources';
import { itemAt, valueAt } from './guards';

export function synthProcessingTemplate(options: { withIndexes?: boolean } = {}): Template {
  // Skip asset bundling (Docker) — template assertions only need structure.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const env = { account: '111111111111', region: 'us-east-1' };
  const deps = new cdk.Stack(app, 'TestDeps', { env });

  const makeTable = (id: string, props: Partial<dynamodb.TableProps> = {}) => {
    const table = new dynamodb.Table(deps, id, {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      ...props,
    });
    if (options.withIndexes) addGsi1(table);
    return table;
  };

  const stack = new VocProcessingStack(app, 'TestProcessing', {
    env,
    feedbackTable: makeTable('Feedback', { stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES }),
    aggregatesTable: makeTable('Aggregates'),
    projectsTable: makeTable('Projects'),
    jobsTable: makeTable('Jobs'),
    idempotencyTable: makeTable('Idempotency'),
    memoryTable: makeTable('Memory'),
    agentsTable: makeTable('Agents'),
    conversationsTable: makeTable('Conversations'),
    processingQueue: fixtureQueue(deps, 'Queue'),
    kmsKey: new kms.Key(deps, 'Key'),
    rawDataBucket: fixtureBucket(deps, 'RawData'),
    config: {
      brandName: 'TestBrand',
      primaryLanguage: 'en',
      enabledSources: [],
    },
  });

  return Template.fromStack(stack);
}

const JoinedDefinitionSchema = z.object({ 'Fn::Join': z.tuple([z.unknown(), z.array(z.unknown())]) });

/**
 * The definition of the ONE state machine whose logical id starts with `logicalIdPrefix`, as
 * searchable JSON text: DefinitionString is an Fn::Join of string fragments and
 * Lambda ARN refs, and joining just the strings keeps exact `"key.$":"path"` pairs.
 */
export function stateMachineDefinition(template: Template, logicalIdPrefix: string): string {
  const machines = template.findResources('AWS::StepFunctions::StateMachine');
  const ids = Object.keys(machines).filter((id) => id.startsWith(logicalIdPrefix));
  expect(ids, `expected exactly one ${logicalIdPrefix}* state machine`).toHaveLength(1);
  const definition: unknown = valueAt(machines, itemAt(ids, 0)).Properties.DefinitionString;
  const joined = JoinedDefinitionSchema.safeParse(definition);
  if (joined.success) {
    return joined.data['Fn::Join'][1].filter((piece): piece is string => typeof piece === 'string').join('');
  }
  // A definition without refs synthesizes as a plain string.
  expect(typeof definition).toBe('string');
  return String(definition);
}


/**
 * Test support for the engineering runtime's suites (engineering-runtime.test.ts, engineering-agentcore.test.ts): a
 * stack with only the runtime's dependencies, under a context, and the template reads they share.
 */
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import type * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { z } from 'zod';

import { type EngineeringPeers, addEngineeringRuntime } from '../stacks/engineering-runtime';
import { fixtureBucket } from './fixture-resources';

export const ACCOUNT = 'arn:aws:lambda:us-east-1:111111111111';

/** The bus's and the broker's parts the runtime takes, as references, and the sources pinned on the bus. */
function fakePeers(stack: cdk.Stack, kmsKey: kms.IKey, pins: Map<string, string>): EngineeringPeers {
  return {
    // A queue on the stack's key, as voc-engineering-dlq is.
    deadLetterQueue: new sqs.Queue(stack, 'EngineeringDLQ', { encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: kmsKey }),
    bus: events.EventBus.fromEventBusArn(stack, 'Bus', 'arn:aws:events:us-east-1:111111111111:event-bus/voc-engineering'),
    addPublisher: (statementId: string, _role: iam.IRole, source: string) => {
      pins.set(statementId, source);
    },
    board: lambda.Function.fromFunctionArn(stack, 'Board', `${ACCOUNT}:function:voc-engineering-board`),
    boardUrl: 'https://abc123.lambda-url.us-east-1.on.aws/',
    broker: lambda.Function.fromFunctionArn(stack, 'Broker', `${ACCOUNT}:function:voc-engineering-broker`),
    brokerUrl: 'https://def456.lambda-url.us-east-1.on.aws/',
  };
}

export interface RuntimeStack { template: Template; added: boolean; pins: Map<string, string> }

/** A stack with only the runtime's dependencies, under `context`; `withPeers: false` leaves out the bus and broker. */
export function runtimeStack(context: Record<string, unknown>, withPeers = true): RuntimeStack {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], ...context } });
  const stack = new cdk.Stack(app, 'EngineeringTest', { env: { account: '111111111111', region: 'us-east-1' } });
  const kmsKey = new kms.Key(stack, 'Key');
  const pins = new Map<string, string>();
  const added = addEngineeringRuntime(stack, {
    uniqueName: (baseName) => baseName,
    layer: lambda.LayerVersion.fromLayerVersionArn(stack, 'Layer', 'arn:aws:lambda:us-east-1:111111111111:layer:deps:1'),
    kmsKey,
    engineeringTable: new dynamodb.Table(stack, 'Engineering', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    }),
    agentsTable: new dynamodb.Table(stack, 'Agents', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    }),
    rawDataBucket: fixtureBucket(stack, 'Raw'),
    workspaceBucket: fixtureBucket(stack, 'Workspace'),
    peers: withPeers ? fakePeers(stack, kmsKey, pins) : undefined,
  });
  return { template: Template.fromStack(stack), added, pins };
}

/** How many resources of `type` match `properties`. */
export function count(template: Template, type: string, properties?: Record<string, unknown>): number {
  return Object.keys(template.findResources(type, properties ? { Properties: properties } : undefined)).length;
}

export const EnvSchema = z.object({ Variables: z.record(z.string(), z.unknown()) });

/** A function's environment variables, by its name. */
export function functionEnv(template: Template, functionName: string): Record<string, unknown> {
  const [fn] = Object.values(template.findResources('AWS::Lambda::Function', {
    Properties: { FunctionName: functionName },
  }));
  return EnvSchema.parse(fn?.Properties?.Environment).Variables;
}

/** The supervisor function's environment variables. */
export function supervisorEnv(template: Template): Record<string, unknown> {
  return functionEnv(template, 'voc-engineering-runtime');
}

/** The inline policies attached to the role whose logical id contains `roleId`, as searchable text. */
export function policyText(template: Template, roleId: string): string {
  return JSON.stringify(template.findResources('AWS::IAM::Policy', {
    Properties: { Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp(roleId) }]) },
  }));
}

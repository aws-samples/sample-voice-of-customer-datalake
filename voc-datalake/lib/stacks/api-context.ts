/**
 * What VocApiStack's domain builders (api-*.ts) share: the stack they create
 * resources on, its props, and the stack's prefix-aware helpers.
 *
 * Every builder creates its resources DIRECTLY on `stack` (never inside a child
 * construct), so each resource keeps the logical id it always had —
 * lib/app-baseline.test.ts pins the synthesized templates byte for byte, and a
 * changed logical id is a CloudFormation REPLACEMENT.
 */
import type * as cdk from 'aws-cdk-lib';
import type * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as logs from 'aws-cdk-lib/aws-logs';
import type { VocApiStackProps } from './api-stack';

export interface ApiStackContext {
  stack: cdk.Stack;
  props: VocApiStackProps;
  /** CORS origin every API Lambda except the feedback-form widget's gets. */
  allowedOrigin: string;
  apiLayer: lambda.ILayerVersion;
  /** api/<file> + shared/ bundle (VocApiStack.createApiLambdaCode). */
  apiCode: (handlerFileName: string) => lambda.Code;
  /** A Lambda role with only the basic execution policy. */
  role: (id: string) => iam.Role;
  /** `/aws/lambda/<name>`, two weeks, destroyed with the stack. */
  logGroup: (id: string, name: string) => logs.LogGroup;
  uniqueName: (baseName: string) => string;
  uniqueNamePattern: (baseNameTemplate: string) => string;
  prefixed: (name: string) => string;
  prefixOnlyEnv: (entries: Record<string, string>) => Record<string, string>;
  deploymentPrefix: string | undefined;
  /** The persona-avatar image model ARN (model-allowlist.ts `imageModelArn()`). */
  avatarImageModelArn: string;
  /**
   * On-failure destination of every API-stack Lambda invoked with
   * InvocationType='Event' (#253): the manual-import processor and the four
   * project job Lambdas. VocCoreStack's queue, imported by name (dlq-alarms.ts).
   */
  asyncFailureDestination: lambda.IDestination;
}

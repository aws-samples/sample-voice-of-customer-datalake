/**
 * The engineering agents' connector broker (VocProcessingStack, only with `-c engineeringAgents=true`;
 * docs/autonomous-engineering.md, "Repository connectors").
 *
 *   agent session (assumed agent role) ──SigV4──▶ function URL (AWS_IAM) ──▶ voc-engineering-broker
 *
 * The only code that will hold a repository host's credential. It takes the caller's role, run and agent from the
 * request's assumed-role identity (lambda/engineering/connectors/identity.py), never from the body.
 *
 * What exists in this slice: the caller identity, the operations per role and the write rules. No repository
 * connection exists yet, so every permitted, well-formed operation answers 503 (an unknown caller or a role without
 * the operation 403, a bad body 400), and the role holds NO grant beyond writing its own log group (lib/utils/lambda-log-grants.ts): no table, bucket, parameter or key. The function URL has no
 * resource-based policy, so only identities of this account that an IAM policy grants `lambda:InvokeFunctionUrl`
 * on it can call it; no such policy exists until the agent roles land. Idle, it costs nothing (tenet 7).
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

import { createWorkerFunction, workerRole } from '../utils/worker-lambda';

/** The CDK context key that deploys the engineering agents (default off). */
const ENGINEERING_AGENTS_CONTEXT_KEY = 'engineeringAgents';

/**
 * The agent roles' IAM role names before the stack's naming (`[prefix-]voc-eng-{role}-<account>-<region>`), `{role}`
 * being an agent role of lambda/engineering/connectors/identity.py AGENT_ROLES.
 */
export const ENGINEERING_ROLE_NAME_TEMPLATE = 'voc-eng-{role}';

/** `lambda/engineering/connectors/handler.py`, path-style inside the worker bundle. */
const BROKER_HANDLER = 'engineering/connectors/handler.lambda_handler';

/** Whether `-c engineeringAgents=true` asked for the engineering agents (CLI context arrives as a string). */
export function engineeringAgentsEnabled(scope: Construct): boolean {
  const value: unknown = scope.node.tryGetContext(ENGINEERING_AGENTS_CONTEXT_KEY);
  return value === true || value === 'true';
}

export interface EngineeringBrokerProps {
  uniqueName: (baseName: string) => string;
  /** The agent roles' IAM role names, `{role}` standing for the role (identity.py ROLE_PLACEHOLDER). */
  roleNamePattern: string;
  layer: lambda.ILayerVersion;
}

export class EngineeringBroker extends Construct {
  constructor(scope: Construct, id: string, props: EngineeringBrokerProps) {
    super(scope, id);
    const functionName = props.uniqueName('voc-engineering-broker');
    const broker = createWorkerFunction(this, 'Function', {
      tree: 'engineering',
      functionName,
      handler: BROKER_HANDLER,
      role: workerRole(this, 'Role'),
      layer: props.layer,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { AGENT_ROLE_NAME_PATTERN: props.roleNamePattern },
      serviceName: 'voc-engineering-broker',
    });
    broker.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
  }
}

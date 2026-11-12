/**
 * The engineering agents' connector broker (VocProcessingStack, only with `-c engineeringAgents=true`;
 * docs/autonomous-engineering.md, "Repository connectors").
 *
 *   agent session (assumed agent role) ──SigV4──▶ function URL (AWS_IAM) ──▶ voc-engineering-broker
 *
 * The only code that will hold a repository host's credential. It takes the caller's role, run and agent from the
 * request's assumed-role identity (lambda/engineering/connectors/identity.py), never from the body.
 *
 * What exists: the caller identity, the operations per role, the write rules and the GitHub client
 * (lambda/engineering/connectors/github.py), which reads a connection's GitHub App credential from the SSM
 * SecureString `/[<prefix>-]voc/engineering/{connection_id}` (credentials.py). The run records and the board's GO
 * ledger are not built yet, so every permitted, well-formed operation still answers 503 (an unknown caller or a role
 * without the operation 403, a bad body 400). Beyond writing its own log group (lib/utils/lambda-log-grants.ts), the
 * role holds exactly `ssm:GetParameter` on the connections' parameters (no other parameter, no put or delete) and
 * `kms:Decrypt` on the stack's key only through SSM (`kms:ViaService`) and only for those parameters (the
 * `PARAMETER_ARN` encryption context): no table or bucket. The function URL has no
 * resource-based policy, so only identities of this account that an IAM policy grants `lambda:InvokeFunctionUrl`
 * on it can call it: the agent roles (engineering-runtime.ts). Idle, it costs nothing (tenet 7): standard
 * SSM parameters have no monthly charge.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

import { booleanContextFlag } from '../utils/context-flag';
import { SIGNING_LAYER_DIR, dependencyLayer } from '../utils/dependency-layers';
import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';
import { createWorkerFunction, workerRole } from '../utils/worker-lambda';

/** The CDK context key that deploys the engineering agents (default off). */
const ENGINEERING_AGENTS_CONTEXT_KEY = 'engineeringAgents';

/**
 * The agent roles' IAM role names before the stack's naming (`[prefix-]voc-eng-{role}-<account>-<region>`), `{role}`
 * being an agent role of lambda/engineering/connectors/identity.py AGENT_ROLES.
 */
export const ENGINEERING_ROLE_NAME_TEMPLATE = 'voc-eng-{role}';

/** The connections' credentials, one SecureString each under this path (lambda/engineering/connectors/credentials.py). */
const ENGINEERING_PARAMETER_PATH = 'voc/engineering/';

/**
 * `/voc/engineering/`, or `/<prefix>-voc/engineering/` on a prefixed deployment (the prefix on the `voc` segment, as
 * `DeploymentNaming.prefixed` places it; lib/utils/radar-exa-parameter.ts does the same): the broker's
 * `ENGINEERING_PARAMETER_PREFIX`.
 */
export function engineeringParameterPrefix(deploymentPrefix: string | undefined): string {
  return deploymentPrefix ? `/${deploymentPrefix}-${ENGINEERING_PARAMETER_PATH}` : `/${ENGINEERING_PARAMETER_PATH}`;
}

/** `lambda/engineering/connectors/handler.py`, path-style inside the worker bundle. */
const BROKER_HANDLER = 'engineering/connectors/handler.lambda_handler';

/**
 * Whether `-c engineeringAgents=true` asked for the engineering agents (CLI context arrives as a string), strictly
 * parsed: a typo fails the synth instead of deploying the opposite. The one parser of the flag (core, processing,
 * runtime).
 */
export function engineeringAgentsEnabled(scope: Construct): boolean {
  return booleanContextFlag(scope.node.tryGetContext(ENGINEERING_AGENTS_CONTEXT_KEY), ENGINEERING_AGENTS_CONTEXT_KEY,
    false, `Use -c ${ENGINEERING_AGENTS_CONTEXT_KEY}=true or false.`);
}

export interface EngineeringBrokerProps {
  uniqueName: (baseName: string) => string;
  /** The agent roles' IAM role names, `{role}` standing for the role (identity.py ROLE_PLACEHOLDER). */
  roleNamePattern: string;
  layer: lambda.ILayerVersion;
  /** The stack's customer-managed key, which encrypts the connections' SecureString parameters. */
  kmsKey: kms.IKey;
  deploymentPrefix: string | undefined;
}

export class EngineeringBroker extends Construct {
  /** The broker: the agent roles may call its function URL (engineering-runtime.ts). */
  public readonly function: lambda.IFunction;

  constructor(scope: Construct, id: string, props: EngineeringBrokerProps) {
    super(scope, id);
    const functionName = props.uniqueName('voc-engineering-broker');
    const stack = cdk.Stack.of(this);
    const parameterPrefix = engineeringParameterPrefix(props.deploymentPrefix);
    const role = workerRole(this, 'Role');
    const broker = createWorkerFunction(this, 'Function', {
      tree: 'engineering',
      functionName,
      handler: BROKER_HANDLER,
      role,
      layer: props.layer,
      // A push rebuilds every commit with the Git Data API (a tree and a commit per commit, a blob per binary file, then
      // the ref once), one request after another: 30 s was shorter than a large bundle's chain. Idle cost is nil either way.
      timeout: cdk.Duration.seconds(120),
      memorySize: 256,
      environment: { AGENT_ROLE_NAME_PATTERN: props.roleNamePattern, ENGINEERING_PARAMETER_PREFIX: parameterPrefix },
      serviceName: 'voc-engineering-broker',
    });
    // cryptography signs the GitHub App's JWT (RS256): the signing layer, for this one function of the stack.
    broker.addLayers(dependencyLayer(this, 'SigningDepsLayer', SIGNING_LAYER_DIR,
      'RS256 signing for the engineering broker (GitHub App JWT; ARM64/Graviton)'));
    const parameters = stack.formatArn({
      service: 'ssm', resource: 'parameter', resourceName: `${parameterPrefix.slice(1)}*`,
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'EngineeringConnectionCredentials', actions: ['ssm:GetParameter'], resources: [parameters],
    }));
    acknowledgeNag(role, [{
      id: 'AwsSolutions-IAM5',
      reason: 'One SecureString per repository connection, created by an administrator at run time, so the read '
        + 'is scoped to the connections\' path (/[<prefix>-]voc/engineering/*), read-only, and nothing else',
      findings: [resourceFinding(parameters)],
    }]);
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'EngineeringConnectionCredentialsKey',
      actions: ['kms:Decrypt'],
      resources: [props.kmsKey.keyArn],
      // Only through SSM, and only for the connections' parameters (SSM puts the parameter's ARN in the context).
      conditions: {
        StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` },
        StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': parameters },
      },
    }));
    broker.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    this.function = broker;
  }
}

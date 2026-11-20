/**
 * The engineering agents' part of VocProcessingStack (docs/autonomous-engineering.md): their connector broker
 * (engineering-broker.ts), their bus, inbox router, board API and report builder (engineering-bus.ts), and their
 * AgentCore runtime (engineering-runtime.ts). Only with `-c engineeringAgents=true`; without it nothing is made
 * (addEngineeringRuntime makes nothing either). Moved out of processing-stack-consolidated.ts in 7.35.00 so that stack
 * keeps to its line limit with both the workspace work and the engineering agents in it.
 */
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import { createEngineeringAppTokens } from './engineering-app-tokens';
import { createEngineeringIssuesConfig, issuesConfigDeployed } from './engineering-issues-config';
import { EngineeringBroker, engineeringAgentsEnabled } from './engineering-broker';
import { EngineeringBus } from './engineering-bus';
import { type EngineeringPeers, addEngineeringRuntime } from './engineering-runtime';

export interface ProcessingEngineeringProps {
  uniqueName: (baseName: string) => string;
  /** The agent roles' IAM role names (the stack's `uniqueNamePattern(ENGINEERING_ROLE_NAME_TEMPLATE)`). */
  roleNamePattern: string;
  layer: lambda.ILayerVersion;
  kmsKey: kms.IKey;
  deploymentPrefix: string | undefined;
  aggregatesTable: dynamodb.ITable;
  agentsTable: dynamodb.ITable;
  rawDataBucket: s3.IBucket;
  /** voc-engineering and voc-eng-workspace (VocCoreStack, made only with the flag). */
  engineeringTable?: dynamodb.ITable;
  engineeringWorkspaceBucket?: s3.IBucket;
  /** The deployment's plugins (pluginStatus): the GitHub Issues settings function exists only with github_issues. */
  enabledSources: readonly string[];
  /** The shared API-credentials secret (VocIngestionStack), for the GitHub Issues settings function. */
  apiSecretsArn?: string;
}

/**
 * The broker, the GitHub Apps' token function (7.45.00, engineering-app-tokens.ts: it shares the broker's signing layer)
 * and the bus (with the flag only), then the runtime, which the peers wire to them.
 */
export function addProcessingEngineering(scope: Construct, props: ProcessingEngineeringProps): void {
  const { uniqueName, layer, kmsKey, roleNamePattern } = props;
  let peers: EngineeringPeers | undefined;
  if (engineeringAgentsEnabled(scope)) {
    if (!props.engineeringTable) throw new Error('engineeringAgents needs VocCoreStack\'s voc-engineering table');
    if (!props.engineeringWorkspaceBucket) {
      throw new Error('engineeringAgents needs VocCoreStack\'s voc-eng-workspace bucket');
    }
    const broker = new EngineeringBroker(scope, 'EngineeringBroker', {
      uniqueName, layer, roleNamePattern, kmsKey, deploymentPrefix: props.deploymentPrefix,
      engineeringTable: props.engineeringTable, workspaceBucket: props.engineeringWorkspaceBucket,
      aggregatesTable: props.aggregatesTable, agentsTable: props.agentsTable,
    });
    createEngineeringAppTokens(scope, {
      uniqueName, layer, signingLayer: broker.signingLayer, kmsKey, deploymentPrefix: props.deploymentPrefix,
    });
    // The GitHub Issues source's settings for the connections (7.50.02, engineering-issues-config.ts), with that plugin.
    if (issuesConfigDeployed(scope, props.enabledSources)) {
      if (!props.apiSecretsArn) throw new Error('the GitHub Issues settings function needs VocIngestionStack\'s secretsArn');
      createEngineeringIssuesConfig(scope, { uniqueName, layer, secretsArn: props.apiSecretsArn });
    }
    const bus = new EngineeringBus(scope, 'EngineeringBus', {
      uniqueName, layer, roleNamePattern, kmsKey, engineeringTable: props.engineeringTable,
      workspaceBucket: props.engineeringWorkspaceBucket,
    });
    peers = {
      deadLetterQueue: bus.dlq, bus: bus.bus, board: bus.board, boardUrl: bus.boardUrl, broker: broker.function,
      brokerUrl: broker.url, connectionParameters: broker.connectionParameters,
      addPublisher: (statementId, role, source) => bus.addPublisher(statementId, role, source),
      admitRuntime: (role, functionName) => broker.admitRuntime(role, functionName),
      admitStart: (role, functionName) => broker.admitStart(role, functionName),
    };
  }
  // The runtime (one AgentCore session per agent; engineering-runtime.ts, engineering-agentcore.ts): its agent roles
  // call the board and the broker and publish on the bus; its supervisor rule's undelivered ticks go to the bus's
  // dead-letter queue.
  addEngineeringRuntime(scope, {
    uniqueName, layer, kmsKey, engineeringTable: props.engineeringTable, agentsTable: props.agentsTable,
    rawDataBucket: props.rawDataBucket, peers, workspaceBucket: props.engineeringWorkspaceBucket,
  });
}

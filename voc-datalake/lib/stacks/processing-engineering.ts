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
  engineeringTable: dynamodb.ITable | undefined;
  engineeringWorkspaceBucket: s3.IBucket | undefined;
}

/** The broker and the bus (with the flag only), then the runtime, which the peers wire to them. */
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
    const bus = new EngineeringBus(scope, 'EngineeringBus', {
      uniqueName, layer, roleNamePattern, kmsKey, engineeringTable: props.engineeringTable,
      workspaceBucket: props.engineeringWorkspaceBucket,
    });
    peers = {
      deadLetterQueue: bus.dlq, bus: bus.bus, board: bus.board, boardUrl: bus.boardUrl, broker: broker.function,
      brokerUrl: broker.url, connectionParameters: broker.connectionParameters,
      addPublisher: (statementId, role, source) => bus.addPublisher(statementId, role, source),
      admitRuntime: (role, functionName) => broker.admitRuntime(role, functionName),
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

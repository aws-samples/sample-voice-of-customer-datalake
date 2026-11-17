/**
 * The Agents API's voice on the engineering bus (7.51.02, only with `-c engineeringAgents=true`): a person's steering
 * of a run's orchestrator (`POST /agents/engineering/<run_id>/steer`) and their answer to an agent or the conductor
 * (`…/messages`) go out as `msg.steer` and `msg.answer` from the API's own source (lambda/engineering/monitor.py).
 *
 * - The role gets `events:PutEvents` on the engineering bus alone (VocProcessingStack's, by its name: this stack
 *   depends on that one and cannot reference it), held by conditions to the source `voc.engineering/api` and to those
 *   two detail types. Nothing else on the bus: a person's signals and Stop go through voc-engineering-start (its
 *   `signal_run` and `stop_run`, which record them on the run's `RUNLOG#` rows), and no `lambda:InvokeFunction` on
 *   voc-engineering-runtime is added, whose many actions IAM cannot tell apart.
 * - The bus's policy admits this role by its ARN with that source alone, as every publisher (engineering-bus.ts
 *   `admitTheAgentsApi`), so the role has a fixed name with the module on (`agentsApiRole`). The router admits that
 *   source for those two types alone and drops any event whose detail type is not its message's own
 *   (lambda/engineering/bus/senders.py, router.py).
 * - `ENGINEERING_BUS_NAME` names the bus to the Agents API (the overview's `steer_available`).
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

import type { ApiStackContext } from './api-context';
import {
  AGENTS_API_ROLE_BASE_NAME, ENGINEERING_API_DETAIL_TYPES, ENGINEERING_API_SOURCE, ENGINEERING_BUS_BASE_NAME,
} from './engineering-bus';
import { engineeringAgentsEnabled } from './engineering-broker';

/** The Agents API role's construct id (its logical id stays what it was before it had a fixed name). */
const AGENTS_ROLE_ID = 'AgentsLambdaRole';

/**
 * The Agents API's role: with the engineering agents on, named `[<prefix>-]voc-agents-api-<account>-<region>`, the
 * name the bus's policy admits; off, a generated name as every other API role (nothing changes without the module).
 */
export function agentsApiRole(ctx: ApiStackContext): iam.Role {
  if (!engineeringAgentsEnabled(ctx.stack)) return ctx.role(AGENTS_ROLE_ID);
  return new iam.Role(ctx.stack, AGENTS_ROLE_ID, {
    roleName: ctx.uniqueName(AGENTS_API_ROLE_BASE_NAME),
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  });
}

/**
 * The role's `events:PutEvents` on the engineering bus, held to the API's source and a person's steering and answer
 * (module doc); the env that names the bus. Called only with the module on (engineeringReads).
 */
export function grantEngineeringVoice(ctx: ApiStackContext, role: iam.Role): Record<string, string> {
  const busName = ctx.uniqueName(ENGINEERING_BUS_BASE_NAME);
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'SpeakOnTheEngineeringBus',
    actions: ['events:PutEvents'],
    resources: [cdk.Stack.of(role).formatArn({ service: 'events', resource: 'event-bus', resourceName: busName })],
    conditions: {
      StringEquals: { 'events:source': ENGINEERING_API_SOURCE, 'events:detail-type': [...ENGINEERING_API_DETAIL_TYPES] },
    },
  }));
  return { ENGINEERING_BUS_NAME: busName };
}

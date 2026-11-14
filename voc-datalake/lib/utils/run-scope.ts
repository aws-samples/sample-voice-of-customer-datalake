/**
 * The workspace of a project job's state machine run (voc-document-workflow, voc-research-workflow), for every
 * state's Lambda (docs/multi-workspace.md, the project plan, 3c; since 7.29.00).
 *
 * A run in a workspace starts with `workspace_id` in its input (lambda/shared/workspace_routing.py
 * `workspace_payload`); a run of the deployment has none, and its input stays exactly what it was. A JSONPath
 * parameter whose path the input lacks fails the state, so a Lambda payload cannot name `$.workspace_id` directly.
 * The run's first state, a Choice on `IsPresent`, sets `$.run_scope` instead: `{workspace_id}` in a workspace, `{}`
 * for the deployment. Every Lambda payload passes it on as `run_scope` (`RUN_SCOPE_PARAMETER`, beside its existing
 * paths), and lambda/shared/ws_repo.py `event_scope` reads it. voc-agent-run's ASL
 * (lambda/agents/state_machine.py) builds the same three states itself.
 */
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import type { Construct } from 'constructs';

/** lambda/shared/ws_repo.py RUN_SCOPE_FIELD. */
const RUN_SCOPE_FIELD = 'run_scope';
/** The payload entry every state's Lambda gets: the run's scope object. */
export const RUN_SCOPE_PARAMETER = { [`${RUN_SCOPE_FIELD}.$`]: `$.${RUN_SCOPE_FIELD}` } as const;

/**
 * `{prefix}RunScope`: a Choice that sets `$.run_scope` from the input (`{prefix}RunScopeWorkspace`, or
 * `{prefix}RunScopeDeployment` when the input names no workspace), then goes on to `first`. The machine starts here.
 */
export function withRunScope(scope: Construct, prefix: string, first: sfn.IChainable): sfn.Choice {
  const workspace = new sfn.Pass(scope, `${prefix}RunScopeWorkspace`, {
    parameters: { 'workspace_id.$': '$.workspace_id' },
    resultPath: `$.${RUN_SCOPE_FIELD}`,
  });
  const deployment = new sfn.Pass(scope, `${prefix}RunScopeDeployment`, {
    result: sfn.Result.fromObject({}),
    resultPath: `$.${RUN_SCOPE_FIELD}`,
  });
  workspace.next(first);
  deployment.next(first);
  return new sfn.Choice(scope, `${prefix}RunScope`)
    .when(sfn.Condition.isPresent('$.workspace_id'), workspace)
    .otherwise(deployment);
}

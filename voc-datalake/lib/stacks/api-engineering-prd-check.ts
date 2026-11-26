/**
 * The Agents API's check of a PRD's project (7.80.00, lambda/api/agents_handler.py `_require_deployment_prd`, through
 * lambda/shared/project_writes.py `deployment_project_live`): with
 * -c engineeringAgents=true, a feature agent's Run now and a run request name a PRD of one of the deployment's own
 * projects only. The role reads the deployment's project `META` (`PROJECT#{id}`) with one strongly consistent GetItem,
 * projected to whether it is being deleted: no workspace's partition (`WS#…`), no claim, no other attribute, no other
 * action on voc-projects.
 */
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';

/** The deployment's project partitions (lambda/shared/project_keys.py `project_pk` without a workspace). */
export const PRD_PROJECT_PARTITIONS = ['PROJECT#*'] as const;
/** What the check reads of a project's `META`: its key, its status and the deletion mark (shared/project_writes.py
 *  `deployment_project_live`'s `LIVE_PROJECTION`, `pk, sk, #status, #deleting`, with `PROJECT_DELETION_ATTRIBUTE`). */
export const PRD_PROJECT_ATTRIBUTES = ['deletion_started_at', 'pk', 'sk', 'status'] as const;

/** The grant, on the agents API's role; returns the environment that names the table to the check. */
export function grantPrdProjectCheck(role: iam.IRole, projectsTable: dynamodb.ITable): Record<string, string> {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'PrdProjectCheck', actions: ['dynamodb:GetItem'], resources: [projectsTable.tableArn],
    conditions: {
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [...PRD_PROJECT_PARTITIONS] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': [...PRD_PROJECT_ATTRIBUTES] },
      StringEqualsIfExists: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
      // (a request naming no key or no attributes never matches ForAllValues vacuously: the whole row is refused)
      Null: { 'dynamodb:LeadingKeys': 'false', 'dynamodb:Attributes': 'false' },
    },
  }));
  return { PROJECTS_TABLE: projectsTable.tableName };
}

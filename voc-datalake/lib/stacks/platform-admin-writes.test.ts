/**
 * The writes of what every workspace shares are a platform admin's, checked live (docs/multi-workspace.md,
 * "Per-workspace configuration"; lambda/shared/platform_admin_gate.py): `PUT /settings/appearance` on the settings
 * API and the alert writes on the logs API. Each Lambda reads the caller's groups and account in its user pool, so
 * each has `USER_POOL_ID` and Cognito's two reads, and no Cognito write.
 *
 * The settings API's resolved-problems routes act in the caller's workspace (lambda/shared/request_workspace.py), so it
 * also reads voc-workspaces' `WS#*` rows and writes a platform admin's entry audit row in `AUDIT#WS#*` only
 * (lib/utils/workspace-resolution-grants.ts: the stack's one managed policy for it, not the role's own), and nothing
 * else there.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';

import { actionsWithPrefix, apiTemplateAllPlugins, policyStatementsOf, serviceEnvironment } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { IamPolicySchema, statementActions } from '../test-support/iam-statements';
import { WORKSPACE_AUDIT_PARTITION, WORKSPACE_RESOLUTION_POLICY_ID } from '../utils/workspace-resolution-grants';

const holder: { api?: Template } = {};
const api = (): Template => holder.api ?? (holder.api = apiTemplateAllPlugins());

beforeAll(() => {
  api();
}, SYNTH_TIMEOUT_MS);

const LIVE_CHECK = ['cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser'];
const sorted = (actions: string[]): string[] => [...actions].sort((a, b) => a.localeCompare(b));

describe.each([
  ['voc-settings-api', 'SettingsLambdaRole'],
  ['voc-logs-api', 'LogsLambdaRole'],
])('%s runs the live platform-admin check', (service, role) => {
  it('names its user pool', () => {
    expect(serviceEnvironment(api(), service).USER_POOL_ID).toBeDefined();
  });

  it("may read the caller's groups and account in Cognito, and change nothing there", () => {
    expect(sorted(actionsWithPrefix(policyStatementsOf(api(), role), 'cognito-idp:'))).toStrictEqual(LIVE_CHECK);
  });
});

describe('voc-settings-api resolves the workspace of a request', () => {
  /** The stack's workspace-resolution policies (one expected), by logical id. */
  const resolutionEntries = () => Object.entries(api().findResources('AWS::IAM::ManagedPolicy'))
    .filter(([id]) => id.startsWith(WORKSPACE_RESOLUTION_POLICY_ID));
  const resolution = () => resolutionEntries().map(([, resource]) => IamPolicySchema.parse(resource).Properties);
  /** The managed policies the settings role attaches (`ManagedPolicyArns`), serialized. */
  const settingsRoleAttaches = (): string => JSON.stringify(Object.entries(api().findResources('AWS::IAM::Role'))
    .find(([id]) => id.startsWith('SettingsLambdaRole'))?.[1]);

  it('names the workspaces table', () => {
    // The same table token the users API's environment carries (lib/stacks/api-engagement-lambdas.ts).
    const table = serviceEnvironment(api(), 'voc-users-api').WORKSPACES_TABLE;
    expect(table).toBeDefined();
    expect(serviceEnvironment(api(), 'voc-settings-api').WORKSPACES_TABLE).toStrictEqual(table);
  });

  it('holds the one workspace-resolution policy, attached to its role', () => {
    const ids = resolutionEntries().map(([id]) => id);
    expect(ids).toHaveLength(1);
    expect(settingsRoleAttaches()).toContain(JSON.stringify({ Ref: ids[0] }));
  });

  it('reads the membership and workspace rows and only appends an entry audit row there', () => {
    const allows = resolution().flatMap((policy) => policy.PolicyDocument.Statement)
      .filter((statement) => (statement.Effect ?? 'Allow') === 'Allow')
      .map((statement) => ({ actions: statementActions(statement), condition: statement.Condition }));
    expect(allows).toStrictEqual([
      { actions: ['dynamodb:GetItem'],
        condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*', WORKSPACE_AUDIT_PARTITION] } } },
      { actions: ['dynamodb:PutItem'],
        condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [WORKSPACE_AUDIT_PARTITION] } } },
    ]);
  });

  it('writes nothing in voc-workspaces from its own policy', () => {
    const own = policyStatementsOf(api(), 'SettingsLambdaRole')
      .filter((s) => s.resource.includes('Workspaces') && s.actions.some((a) => a.startsWith('dynamodb:')));
    expect(own).toStrictEqual([]);
  });
});

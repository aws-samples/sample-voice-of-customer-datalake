/**
 * The writes of what every workspace shares are a platform admin's, checked live (docs/multi-workspace.md,
 * "Per-workspace configuration"; lambda/shared/platform_admin_gate.py): `PUT /settings/appearance` on the settings
 * API and the alert writes on the logs API. Each Lambda reads the caller's groups and account in its user pool, so
 * each has `USER_POOL_ID` and Cognito's two reads, and no Cognito write.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';

import { actionsWithPrefix, apiTemplateAllPlugins, policyStatementsOf, serviceEnvironment } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

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

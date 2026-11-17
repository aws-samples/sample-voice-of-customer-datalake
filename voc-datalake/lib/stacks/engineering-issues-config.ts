/**
 * voc-engineering-issues-config (VocProcessingStack, with `-c engineeringAgents=true` AND the github_issues plugin
 * deployed with its schedule; 7.50.02, docs/github-issues.md "Configured by your GitHub connection"): the one function
 * that reads and writes the deployment's GitHub Issues source's settings for the repository connections
 * (lambda/engineering/connectors/issues_config.py), so the Agents API holds no grant on the shared API-credentials
 * secret or the source's schedule rule. It takes `follow`, `unfollow` and `status` and refuses every other request
 * before anything is read; it writes only `github_issues_repos`, `github_issues_repos_managed` and
 * `github_issues_github_app_id`, and answers no secret.
 *
 * Its own role holds exactly `secretsmanager:GetSecretValue` and `secretsmanager:PutSecretValue` on that one secret's
 * ARN (encrypted with Secrets Manager's own key: no KMS grant) and `events:DescribeRule` and `events:EnableRule` on the
 * github_issues schedule rule alone (never DisableRule): no function URL, no resource policy, no table, no bucket. The
 * Agents API's role invokes it by name (VocApiStack: api-engineering-issues-sync.ts). Pay per use: no fixed cost.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as path from 'path';
import type { Construct } from 'constructs';

import { getEnabledPlugins, getPluginsWithIngestor, loadPlugins } from '../plugin-loader';
import { ENGINEERING_ISSUES_CONFIG_FUNCTION_BASE_NAME } from '../utils/function-names';
import { workerRole } from '../utils/worker-lambda';
import { GITHUB_APP_SIGN_IN_PLUGIN, connectorFunction } from './engineering-app-tokens';
import type { ConnectorFunctionSpec } from './engineering-app-tokens';
import { engineeringAgentsEnabled } from './engineering-broker';

/** The Agents API's env var it finds the function by (lambda/shared/engineering_agents.py ISSUES_CONFIG_FUNCTION_ENV). */
export const ISSUES_CONFIG_FUNCTION_ENV = 'ENGINEERING_ISSUES_CONFIG_FUNCTION';

/** The function's name in `uniqueName`'s naming (the same in both stacks). */
export function issuesConfigFunctionName(uniqueName: (baseName: string) => string): string {
  return uniqueName(ENGINEERING_ISSUES_CONFIG_FUNCTION_BASE_NAME);
}

/** The github_issues ingestor's schedule rule (VocIngestionStack's name for it). */
export function issuesScheduleRuleName(uniqueName: (baseName: string) => string): string {
  return uniqueName(`voc-ingest-${GITHUB_APP_SIGN_IN_PLUGIN}-schedule`);
}

/** Whether the function exists here: the engineering agents, and the github_issues plugin deployed with a schedule. */
export function issuesConfigDeployed(scope: Construct, enabledSources: readonly string[]): boolean {
  if (!engineeringAgentsEnabled(scope)) return false;
  const plugins = getEnabledPlugins(loadPlugins(path.join(__dirname, '../../plugins')), [...enabledSources]);
  return getPluginsWithIngestor(plugins).some((plugin) => plugin.id === GITHUB_APP_SIGN_IN_PLUGIN
    && Boolean(plugin.infrastructure.ingestor?.schedule));
}

interface IssuesConfigProps {
  /** The owning stack's prefix-aware `uniqueName()`. */
  uniqueName: (baseName: string) => string;
  layer: lambda.ILayerVersion;
  /** The shared API-credentials secret (VocIngestionStack's `secretsArn`). */
  secretsArn: string;
}

/** The function's own role: the one secret read and written, the one rule described and turned on; nothing else. */
function issuesConfigRole(scope: Construct, props: IssuesConfigProps, rule: string): iam.Role {
  const role = workerRole(scope, 'EngineeringIssuesConfigRole');
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'IssuesSourceSettings', actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue'],
    resources: [props.secretsArn],
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'IssuesSourceSchedule', actions: ['events:DescribeRule', 'events:EnableRule'],
    resources: [cdk.Stack.of(scope).formatArn({ service: 'events', resource: 'rule', resourceName: rule })],
  }));
  return role;
}

export function createEngineeringIssuesConfig(scope: Construct, props: IssuesConfigProps): lambda.Function {
  const rule = issuesScheduleRuleName(props.uniqueName);
  const spec: ConnectorFunctionSpec = {
    functionName: issuesConfigFunctionName(props.uniqueName), role: issuesConfigRole(scope, props, rule), layer: props.layer,
    // Under the Agents API's wait: a few Secrets Manager calls and one EventBridge call per request.
    timeout: cdk.Duration.seconds(15),
    environment: { ISSUES_SETTINGS_ARN: props.secretsArn, ISSUES_SCHEDULE_RULE: rule },
  };
  return connectorFunction(scope, 'EngineeringIssuesConfig', 'issues_config', 'voc-engineering-issues-config', spec);
}

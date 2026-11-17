/**
 * The Agents API's side of the GitHub Issues source's follow of the connections (7.50.02, lambda/engineering/connectors/
 * issues_sync.py; docs/github-issues.md "Configured by your GitHub connection"): with `-c engineeringAgents=true` and
 * the github_issues plugin deployed with its schedule only, `lambda:InvokeFunction` on voc-engineering-issues-config by
 * name (VocProcessingStack, engineering-issues-config.ts), whose own role alone reads and writes the source's settings in
 * the shared API-credentials secret and turns its schedule on. This role gains no grant on the secret or the rule. The
 * `voc-agent` label is the token function's (`ensure_label`), which this role already invokes. Returns the function's
 * name for the Agents API's environment: none where it is not deployed (the follow then answers `deployed: false`).
 */
import * as cdk from 'aws-cdk-lib';
import type * as iam from 'aws-cdk-lib/aws-iam';

import { grantInvokeByName } from '../utils/worker-lambda';
import type { ApiStackContext } from './api-context';
import { ISSUES_CONFIG_FUNCTION_ENV, issuesConfigDeployed, issuesConfigFunctionName } from './engineering-issues-config';

export function grantIssuesSourceFollow(ctx: ApiStackContext, role: iam.Role): Record<string, string> {
  if (!issuesConfigDeployed(ctx.stack, ctx.props.enabledSources)) return {};
  const name = issuesConfigFunctionName(ctx.uniqueName);
  grantInvokeByName(cdk.Stack.of(role), role, [name], 'EngineeringIssuesConfig');
  return { [ISSUES_CONFIG_FUNCTION_ENV]: name };
}

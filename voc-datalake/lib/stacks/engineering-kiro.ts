/**
 * The Kiro harness's deployment settings (7.53.00; docs/autonomous-engineering.md "The Kiro harness (7.53.00)",
 * docs/deployment.md `engineeringHarness`): which roles run as Kiro CLI over ACP, and their API key.
 *
 * - `-c engineeringHarness`: `native` (the default: every agent on its skill's own adapter, the Bedrock Converse
 *   loop), `kiro` (every launchable role), or `kiro:<role>,<role>` (only those). The runtime gets it as
 *   ENGINEERING_HARNESS (lambda/engineering/runtime/harness_switch.py reads the same three shapes) and readiness too.
 * - The key: ONE SecureString an operator stores, `/[<prefix>-]voc/engineering/_kiro/api-key` (under the connections'
 *   path, as the GitHub Apps' keys are), never written by any stack or function. Only the agent roles that run on Kiro
 *   may read it: `ssm:GetParameter` on exactly that parameter, and `kms:Decrypt` of the stack's key only through SSM
 *   and only for that parameter (SSM puts the parameter's ARN in the encryption context). The harness reads it with
 *   the agent's own role session and hands it to kiro-cli's environment only (lambda/engineering/runtime/harness/kiro.py).
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import type { Construct } from 'constructs';

/** `-c engineeringHarness`. */
const HARNESS_CONTEXT = 'engineeringHarness';
const NATIVE = 'native';
const KIRO = 'kiro';
/** The key's parameter under the connections' path (`engineeringParameterPrefix`). */
const KIRO_KEY_PARAMETER = '_kiro/api-key';
/** The roles a deployment may run on Kiro: every launchable one (the coach is Learn's, never launched). */
function kiroLaunchable(roles: readonly string[]): string[] {
  return roles.filter((role) => role !== 'coach');
}

function sortedRoles(roles: readonly string[]): string[] {
  const sorted = [...roles];
  sorted.sort((a, b) => a.localeCompare(b, 'en'));
  return sorted;
}

/** The switch as the runtime reads it, and the roles it runs on Kiro (sorted); anything off its shape fails the synth. */
export function engineeringHarness(scope: Construct, roles: readonly string[]): { value: string; kiroRoles: string[] } {
  const raw: unknown = scope.node.tryGetContext(HARNESS_CONTEXT);
  const text = raw === undefined || raw === null || raw === '' ? NATIVE : String(raw).trim();
  const launchable = kiroLaunchable(roles);
  const usage = `Use -c ${HARNESS_CONTEXT}=native, kiro, or kiro:<role>,<role> (roles: ${launchable.join(', ')}).`;
  if (text === NATIVE) return { value: NATIVE, kiroRoles: [] };
  if (text === KIRO) return { value: KIRO, kiroRoles: sortedRoles(launchable) };
  const named = text.startsWith(`${KIRO}:`)
    ? [...new Set(text.slice(KIRO.length + 1).split(',').map((role) => role.trim()).filter(Boolean))] : [];
  if (named.length === 0 || !named.every((role) => launchable.includes(role))) {
    throw new Error(`${HARNESS_CONTEXT} is not a harness setting. ${usage}`);
  }
  const sorted = sortedRoles(named);
  return { value: `${KIRO}:${sorted.join(',')}`, kiroRoles: sorted };
}

/** The key's parameter name (`parameterPrefix` is `/[<prefix>-]voc/engineering/`). */
export function kiroKeyParameterName(parameterPrefix: string): string {
  return `${parameterPrefix}${KIRO_KEY_PARAMETER}`;
}

/** The key's parameter ARN in `stack`'s account and region. */
function kiroKeyParameterArn(stack: cdk.Stack, parameterPrefix: string): string {
  return stack.formatArn({
    service: 'ssm', resource: 'parameter', arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    resourceName: kiroKeyParameterName(parameterPrefix).slice(1),
  });
}

/** An agent role that runs on Kiro: the key read (exactly its parameter) and decrypted through SSM for it alone. */
function grantKiroKey(role: iam.Role, kmsKey: kms.IKey, parameterArn: string): void {
  role.addToPolicy(new iam.PolicyStatement({ sid: 'KiroApiKey', actions: ['ssm:GetParameter'], resources: [parameterArn] }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: 'KiroApiKeyDecrypt',
    actions: ['kms:Decrypt'],
    resources: [kmsKey.keyArn],
    conditions: {
      StringEquals: {
        'kms:ViaService': `ssm.${cdk.Stack.of(role).region}.amazonaws.com`,
        'kms:EncryptionContext:PARAMETER_ARN': parameterArn,
      },
    },
  }));
}

/**
 * The runtime's side (engineering-runtime.ts): each agent role on Kiro granted the key (`grantKiroKey`), and the
 * environment the runtime and the start function take: ENGINEERING_HARNESS (lambda/engineering/runtime/harness_switch.py)
 * and, with a role on Kiro, ENGINEERING_KIRO_KEY_PARAMETER. `parameterPrefix` is the connections' path.
 */
export function wireKiroHarness(
  scope: Construct, agentRoles: ReadonlyMap<string, iam.Role>, kmsKey: kms.IKey, parameterPrefix: string,
): Record<string, string> {
  const harness = engineeringHarness(scope, [...agentRoles.keys()]);
  if (harness.kiroRoles.length === 0) return { ENGINEERING_HARNESS: harness.value };
  const parameterArn = kiroKeyParameterArn(cdk.Stack.of(scope), parameterPrefix);
  for (const role of harness.kiroRoles) {
    const agentRole = agentRoles.get(role);
    if (agentRole) grantKiroKey(agentRole, kmsKey, parameterArn);
  }
  return { ENGINEERING_HARNESS: harness.value, ENGINEERING_KIRO_KEY_PARAMETER: kiroKeyParameterName(parameterPrefix) };
}

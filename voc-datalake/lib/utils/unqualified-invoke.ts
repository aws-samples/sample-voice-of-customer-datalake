/**
 * Drops the version/alias wildcard (`<function arn>:*`) CDK's `grantInvoke` adds next to a function's own ARN,
 * when nothing can invoke that function qualified (cdk-nag `AwsSolutions-IAM5`).
 *
 * CDK grants both forms because a Step Functions task or a caller MAY invoke a version or an alias
 * (https://github.com/aws/aws-cdk/pull/21233). IAM matches the ARN of the Invoke request's FunctionName and
 * Qualifier (https://repost.aws/knowledge-center/granular-access-lambda), so an unqualified invoke needs only the
 * function ARN. The wildcard is dropped only when ALL of these hold, so no caller can lose a permission it uses:
 *
 *   - the statement grants Lambda actions only (`lambda:InvokeFunction`, …);
 *   - it also names the function's own ARN (the wildcard is CDK's companion entry, never the only grant);
 *   - the ARN is a reference to a function of this app (a CfnFunction's `Arn`);
 *   - that function has no version and no alias anywhere in the app (SnapStart's `live` alias keeps it).
 */
import { Reference, Tokenization } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { IConstruct } from 'constructs';

const QUALIFIER_WILDCARD = ':*';

/** Per app root: the functions some version or alias points at (computed once). */
const qualifiedFunctionsByRoot = new WeakMap<IConstruct, ReadonlySet<lambda.CfnFunction>>();

/** The CfnFunction a token string references, or undefined. */
function referencedFunction(value: unknown): lambda.CfnFunction | undefined {
  if (typeof value !== 'string') return undefined;
  const fragments = Tokenization.reverseString(value);
  const token = fragments.firstToken;
  if (fragments.length !== 1 || token === undefined || !Reference.isReference(token)) return undefined;
  return token.target instanceof lambda.CfnFunction ? token.target : undefined;
}

function qualifiedFunctions(root: IConstruct): ReadonlySet<lambda.CfnFunction> {
  const cached = qualifiedFunctionsByRoot.get(root);
  if (cached !== undefined) return cached;
  const functions = new Set<lambda.CfnFunction>();
  for (const construct of root.node.findAll()) {
    const name = construct instanceof lambda.CfnVersion || construct instanceof lambda.CfnAlias
      ? construct.functionName : undefined;
    const target = referencedFunction(name);
    if (target !== undefined) functions.add(target);
  }
  qualifiedFunctionsByRoot.set(root, functions);
  return functions;
}

/** `resources` without the `<function arn>:*` entries no caller can need (see the module comment). */
export function withoutUnusedQualifierWildcards(
  resources: readonly unknown[], actions: readonly string[], root: IConstruct,
): unknown[] {
  if (actions.length === 0 || !actions.every((action) => action.startsWith('lambda:'))) return [...resources];
  const named = new Set(resources.filter((entry): entry is string => typeof entry === 'string'));
  return resources.filter((entry) => {
    if (typeof entry !== 'string' || !entry.endsWith(QUALIFIER_WILDCARD)) return true;
    const base = entry.slice(0, -QUALIFIER_WILDCARD.length);
    const fn = referencedFunction(base);
    return !(named.has(base) && fn !== undefined && !qualifiedFunctions(root).has(fn));
  });
}

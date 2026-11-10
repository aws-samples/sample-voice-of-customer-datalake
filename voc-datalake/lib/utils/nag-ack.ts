/**
 * cdk-nag 3 acknowledgements: one typed helper over CDK's `Validations.of(scope).acknowledge()`.
 *
 * cdk-nag 3 is a policy-validation plugin. A rule is acknowledged per FINDING (`AwsSolutions-IAM5[<finding>]`),
 * exactly: there is no prefix, no regex and no "every finding of this rule" form. An acknowledgement on a
 * construct covers that construct and everything below it (cdk-nag walks a resource's ancestors).
 *
 * A finding is written either as the literal id cdk-nag prints (`Action::kms:ReEncrypt*`, `Resource::*`) or,
 * for a resource ARN, as the SAME expression the grant uses ({@link resourceFinding}). The second form is
 * rendered when it is acknowledged, the way cdk-nag will report it from the acknowledging stack: a resource
 * of the same stack as `<LogicalId.Arn>`, a resource of another stack as its export name
 * (`<stack>:ExportsOutput…`, through {@link Stack.exportValue}, which names the export exactly like the
 * automatic cross-stack reference), and the pseudo parameters as `<AWS::Region>`. So no finding id hardcodes
 * a logical-id hash, an account, a region or a deployment prefix.
 */
import { Reference, Stack, StringConcat, Token, Tokenization, Validations } from 'aws-cdk-lib';
import type { IResolvable } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

/** A resource ARN expression, rendered as cdk-nag's `Resource::…` finding for it (see the module header). */
export interface NagResource {
  readonly resource: string;
}

/** One finding of a rule: the literal finding id, or a resource ARN expression. */
export type NagFinding = string | NagResource;

export interface NagAck {
  /** The rule, e.g. `AwsSolutions-IAM5`. */
  readonly id: string;
  /** Why the finding is accepted. At least {@link MIN_REASON_LENGTH} characters (cdk-nag 2's own floor). */
  readonly reason: string;
  /**
   * The findings acknowledged, each one explicitly. Absent for a rule that reports no finding id (a plain
   * non-compliance such as `AwsSolutions-SQS3`): the rule itself is acknowledged then.
   */
  readonly findings?: readonly NagFinding[];
}

export const MIN_REASON_LENGTH = 10;

/** The finding cdk-nag reports for a grant on `arn`. */
export function resourceFinding(arn: string): NagResource {
  return { resource: arn };
}

/** Acknowledge `acks` on `scope` and every construct below it. */
export function acknowledgeNag(scope: IConstruct, acks: readonly NagAck[]): void {
  const validations = Validations.of(scope);
  for (const ack of acks) {
    if (ack.reason.trim().length < MIN_REASON_LENGTH) {
      throw new Error(`${scope.node.path}: ${ack.id} needs a reason of at least ${MIN_REASON_LENGTH} characters`);
    }
    if (ack.findings === undefined) {
      validations.acknowledge({ id: ack.id, reason: ack.reason });
      continue;
    }
    if (ack.findings.length === 0) throw new Error(`${scope.node.path}: ${ack.id} lists no finding`);
    for (const finding of ack.findings) {
      validations.acknowledge({ id: `${ack.id}[${renderNagFinding(scope, finding)}]`, reason: ack.reason });
    }
  }
}

/**
 * Acknowledge `acks` on `construct`'s own CloudFormation resource only (its `defaultChild`, else itself), not
 * on the constructs below it: a method, a user pool or a queue without its children.
 */
export function acknowledgeNagOnResource(construct: IConstruct, acks: readonly NagAck[]): void {
  acknowledgeNag(construct.node.defaultChild ?? construct, acks);
}

/** One acknowledgement recorded on a construct (CDK stores the id as `Annotation::<id>`). */
export interface NagAcknowledgement {
  readonly id: string;
  readonly reason: string;
}

/** The acknowledgements recorded directly on `construct`. */
export function acknowledgementsOn(construct: IConstruct): NagAcknowledgement[] {
  return construct.node.metadata
    .filter((entry) => entry.type === Validations.ACKNOWLEDGED_RULES_METADATA_KEY)
    .flatMap((entry) => (isRecord(entry.data) ? Object.entries(entry.data) : []))
    .map(([key, reason]) => ({ id: key.replace(/^annotation::/i, ''), reason: String(reason) }));
}

/**
 * The acknowledgement of `id` nearest to `construct` (`construct` itself, then its ancestors), or undefined.
 * cdk-nag skips a finding when any of them acknowledges it.
 */
export function acknowledgementCovering(construct: IConstruct, id: string): NagAcknowledgement | undefined {
  for (const scope of [...construct.node.scopes].reverse()) {
    const found = acknowledgementsOn(scope).find((ack) => ack.id === id);
    if (found) return found;
  }
  return undefined;
}

/** Whether `id` is acknowledged on `construct` or an ancestor: the test cdk-nag applies to a finding. */
export function isNagAcknowledged(construct: IConstruct, id: string): boolean {
  return acknowledgementCovering(construct, id) !== undefined;
}

/** The finding id cdk-nag reports for `finding`, seen from `scope`'s stack. */
export function renderNagFinding(scope: IConstruct, finding: NagFinding): string {
  if (typeof finding === 'string') return finding;
  const stack = Stack.of(scope);
  const imported: unknown = Tokenization.reverseString(finding.resource)
    .mapTokens({ mapToken: (token) => importIfForeign(stack, token) })
    .join(new StringConcat());
  return `Resource::${flattenCfnReference(stack.resolve(imported))}`;
}

/** A reference to another stack's resource becomes that stack's export, imported (what synthesis does). */
function importIfForeign(stack: Stack, token: IResolvable): unknown {
  if (!Reference.isReference(token)) return token;
  const producer = Stack.of(token.target);
  return producer === stack ? token : producer.exportValue(Token.asString(token));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The one value of a one-key intrinsic `{ [name]: value }`, else undefined. */
function intrinsic(node: Record<string, unknown>, name: string): unknown {
  return name in node ? node[name] : undefined;
}

/**
 * cdk-nag's `flattenCfnReference` (lib/utils/flatten-cfn-reference.ts in cdk-nag 3.0.2, not exported):
 * `${X}` → `<X>`, Fn::Join joined, Fn::GetAtt → `<Res.Attr>`, Ref → `<Name>`, Fn::ImportValue → its name.
 * lib/nag-suppressions.test.ts proves every rendered acknowledgement matches a finding cdk-nag reports.
 */
function flattenCfnReference(node: unknown): string {
  if (node === undefined) return '';
  if (typeof node === 'string') return node.replace(/\$\{/g, '<').replace(/\}/g, '>');
  if (!isRecord(node)) return JSON.stringify(node);
  const join = intrinsic(node, 'Fn::Join');
  if (Array.isArray(join) && typeof join[0] === 'string' && Array.isArray(join[1])) {
    return join[1].map(flattenCfnReference).join(join[0]);
  }
  const sub = intrinsic(node, 'Fn::Sub');
  if (sub !== undefined) return flattenCfnReference(sub);
  const getAtt = intrinsic(node, 'Fn::GetAtt');
  if (Array.isArray(getAtt)) return `<${flattenCfnReference(getAtt[0])}.${flattenCfnReference(getAtt[1])}>`;
  const imported = intrinsic(node, 'Fn::ImportValue');
  if (imported !== undefined) return flattenCfnReference(imported);
  const ref = intrinsic(node, 'Ref');
  if (ref !== undefined) return `<${flattenCfnReference(ref)}>`;
  return JSON.stringify(node);
}

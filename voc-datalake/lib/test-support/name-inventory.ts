/**
 * Test support: every name in a synthesized template that the deployment
 * prefix is supposed to reach.
 *
 * This is the surface `-c deploymentPrefix=<p>` has to cover completely, and
 * the surface it must leave untouched when unset. Extracting it as data lets
 * one guard state both halves, and — when the byte-identity hash moves — makes
 * the failure legible: a name-level diff instead of "the sha changed".
 */

/** A physical-name-bearing property, per CloudFormation resource type. */
const NAME_PROPERTIES = [
  'Alias',
  'BucketName',
  'DomainPrefix',
  'FunctionName',
  'IdentityPoolName',
  'LogGroupName',
  'Name',
  'QueueName',
  'RestApiName',
  'StateMachineName',
  'TableName',
  'UserPoolName',
  'UserPoolClientName',
] as const;

export interface NameInventory {
  /** `Type ResourceProperty = name`, sorted. Physical names. */
  physicalNames: string[];
  /** CloudFormation `Outputs[*].Export.Name`, sorted. */
  exportNames: string[];
  /** Every literal string in an IAM policy `Resource` that names a VoC resource. */
  policyResources: string[];
  /** Lambda environment entries whose value looks like a VoC resource name. */
  environmentNames: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Render a template value that may be an `Fn::Join` of literals and tokens
 * (which is how CDK emits `${base}-${Aws.ACCOUNT_ID}-${Aws.REGION}`) into a
 * comparable string. Tokens become `<AWS::AccountId>` / `<AWS::Region>` so the
 * literal part — the part naming carries — is what gets compared.
 */
export function renderName(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  const join = value['Fn::Join'];
  if (Array.isArray(join) && join.length === 2 && typeof join[0] === 'string' && Array.isArray(join[1])) {
    const parts = join[1].map((part) => renderName(part));
    if (parts.some((part) => part === undefined)) return undefined;
    return parts.join(join[0]);
  }
  const ref = value['Ref'];
  if (typeof ref === 'string') return `<${ref}>`;
  const getAtt = value['Fn::GetAtt'];
  if (Array.isArray(getAtt) && getAtt.every((part) => typeof part === 'string')) {
    return `<${getAtt.join('.')}>`;
  }
  return undefined;
}

/** Collect every `Resource` string reachable from a policy document. */
function collectPolicyResources(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectPolicyResources(item, into);
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'Resource') {
      const values = Array.isArray(value) ? value : [value];
      for (const entry of values) {
        const rendered = renderName(entry);
        if (rendered && rendered.includes('voc')) into.add(rendered);
      }
    }
    collectPolicyResources(value, into);
  }
}

export function nameInventory(template: Record<string, unknown>): NameInventory {
  const physicalNames = new Set<string>();
  const exportNames = new Set<string>();
  const policyResources = new Set<string>();
  const environmentNames = new Set<string>();

  const resources = isRecord(template.Resources) ? template.Resources : {};
  for (const resource of Object.values(resources)) {
    if (!isRecord(resource)) continue;
    const type = typeof resource.Type === 'string' ? resource.Type : '?';
    const props = isRecord(resource.Properties) ? resource.Properties : {};

    for (const property of NAME_PROPERTIES) {
      const rendered = renderName(props[property]);
      if (rendered && rendered.includes('voc')) physicalNames.add(`${type} ${property} = ${rendered}`);
    }

    // Cognito nests the hosted-UI domain prefix, and DynamoDB/Lambda nest
    // nothing — but the environment block is where resolved names reach
    // runtime code, which is exactly where a missed prefix goes unnoticed.
    const environment = isRecord(props.Environment) ? props.Environment : undefined;
    const variables = environment && isRecord(environment.Variables) ? environment.Variables : {};
    for (const [key, value] of Object.entries(variables)) {
      const rendered = renderName(value);
      if (rendered && rendered.includes('voc')) environmentNames.add(`${key} = ${rendered}`);
    }

    collectPolicyResources(props.PolicyDocument, policyResources);
    collectPolicyResources(props.Policies, policyResources);
  }

  const outputs = isRecord(template.Outputs) ? template.Outputs : {};
  for (const output of Object.values(outputs)) {
    if (!isRecord(output)) continue;
    const exported = isRecord(output.Export) ? renderName(output.Export.Name) : undefined;
    if (exported) exportNames.add(exported);
  }

  const sorted = (values: Set<string>): string[] => [...values].sort();
  return {
    physicalNames: sorted(physicalNames),
    exportNames: sorted(exportNames),
    policyResources: sorted(policyResources),
    environmentNames: sorted(environmentNames),
  };
}

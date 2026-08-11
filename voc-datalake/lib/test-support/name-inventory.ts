/**
 * Test support: every name in a synthesized template that the deployment
 * prefix is supposed to reach.
 *
 * This is the surface `-c deploymentPrefix=<p>` has to cover completely, and
 * the surface it must leave untouched when unset. Extracting it as data lets
 * one guard state both halves, and — when the byte-identity hash moves — makes
 * the failure legible: a name-level diff instead of "the sha changed".
 */

/**
 * A physical-name-bearing property, spelled AS CLOUDFORMATION EMITS IT.
 *
 * The CFN property name and the CDK L2 construct property name differ for four
 * of the resources here — `AliasName`/`alias`, `ClientName`/`userPoolClientName`,
 * `Domain`/`domainPrefix`, `Name`/`restApiName` — and this list is matched
 * against a synthesized template, so an L2 spelling produces an entry that can
 * never match and silently leaves that name uninventoried. It did: `Alias`,
 * `DomainPrefix`, `RestApiName` and `UserPoolClientName` were listed while the
 * KMS alias, the Cognito hosted-UI domain (the name `uniqueDnsName()` exists
 * for), the user-pool client name and the API usage plan went uncovered by both
 * the readable half of the byte-identity guard and the exhaustive prefix
 * mapping.
 *
 * `unlistedNameProperties` below is what keeps the list honest from here on: a
 * resource whose name property is missing fails a test instead of going
 * unexamined.
 */
const NAME_PROPERTIES = [
  'AliasName', // AWS::KMS::Alias
  'BucketName', // AWS::S3::Bucket
  'ClientName', // AWS::Cognito::UserPoolClient
  'Domain', // AWS::Cognito::UserPoolDomain — the hosted-UI prefix
  'FunctionName', // AWS::Lambda::Function
  'IdentityPoolName', // AWS::Cognito::IdentityPool
  'LogGroupName', // AWS::Logs::LogGroup
  'Name', // AWS::Events::Rule, AWS::ApiGateway::RestApi, AWS::SecretsManager::Secret, …
  'QueueName', // AWS::SQS::Queue
  'StateMachineName', // AWS::StepFunctions::StateMachine
  'TableName', // AWS::DynamoDB::Table
  'UsagePlanName', // AWS::ApiGateway::UsagePlan
  'UserPoolName', // AWS::Cognito::UserPool
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

/**
 * Resource properties that render to a VoC name but are NOT in
 * {@link NAME_PROPERTIES} — i.e. names the inventory is silently missing.
 *
 * The guard on the guard. {@link nameInventory} is only as exhaustive as its
 * list of property names, and a list that is wrong in the "too narrow"
 * direction fails OPEN: the missing name simply never appears, so the
 * byte-identity comparison and the exhaustive prefix mapping both pass while
 * saying nothing about it. Four names were in that state.
 *
 * Only TOP-LEVEL properties are considered, because that is where
 * CloudFormation puts a physical name — always. Nested VoC strings are ARNs in
 * policy documents, Lambda environment values and inline handler source, and
 * the first two have their own inventories above.
 */
export function unlistedNameProperties(template: Record<string, unknown>): string[] {
  const listed: readonly string[] = NAME_PROPERTIES;
  const unlisted = new Set<string>();
  const resources = isRecord(template.Resources) ? template.Resources : {};
  for (const resource of Object.values(resources)) {
    if (!isRecord(resource)) continue;
    const type = typeof resource.Type === 'string' ? resource.Type : '?';
    const props = isRecord(resource.Properties) ? resource.Properties : {};
    for (const [property, value] of Object.entries(props)) {
      if (listed.includes(property)) continue;
      const rendered = renderName(value);
      if (rendered && rendered.includes('voc')) unlisted.add(`${type} ${property} = ${rendered}`);
    }
  }
  return [...unlisted].sort();
}

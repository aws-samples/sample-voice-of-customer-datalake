/**
 * The reviewed list of IAM actions this app may grant on `Resource: "*"`.
 *
 * Why a list. An identity-policy statement on `"*"` is either unavoidable (the action has no resource type in
 * the AWS Service Authorization Reference, so `"*"` is the only resource it can be granted on) or a shortcut
 * that should have named an ARN. The template cannot tell the two apart, so a person decides once per action
 * and writes the reason here. Two gates read this list:
 *
 *   - lib/app-template-gates.test.ts: every `Allow` on `"*"` in every stack of the synthesized app uses only
 *     actions listed here (testing the condition keys an entry's `requiredConditionKeys` names), and every entry is still
 *     used by some statement, so a stale entry cannot linger as pre-approval for a future grant;
 *   - `suppressReviewedResourceStar` (nag-suppressions.ts): cdk-nag's AwsSolutions-IAM5 `Resource::*`
 *     finding is suppressed on a policy only when every `"*"` action in it is listed here, so a new
 *     unlisted `"*"` grant surfaces as a cdk-nag error instead of riding a stack-wide suppression.
 *
 * What it cannot prove: that a reason is true. Each was checked against the Service Authorization Reference
 * (https://docs.aws.amazon.com/service-authorization/latest/reference/reference_policies_actions-resources-contextkeys.html)
 * when it was written; an action that gains a resource type later stays allowed here until someone notices.
 * Resource-based policies (KMS key policies, where `"*"` means "this key") are out of scope.
 */

export interface ResourceStarGrant {
  /** Why `"*"` is the only resource this action can be granted on here. */
  readonly reason: string;
  /**
   * Condition keys every `"*"` statement with this action must test (under any operator). A bare
   * "has a Condition" check would accept one that narrows nothing, so the key that does the narrowing is named.
   */
  readonly requiredConditionKeys?: readonly string[];
}

const NO_RESOURCE_TYPE = 'has no resource type in the Service Authorization Reference, so it can only be granted on "*"';

const COMPREHEND_DETECT = `Comprehend real-time detection without a custom endpoint ${NO_RESOURCE_TYPE}; stateless text analysis (processor, category reprocess, source PII policy)`;
const SFN_LOG_DELIVERY = 'CloudWatch Logs vended log delivery: the Step Functions logging role CDK generates for a state machine with `logs` set; the Step Functions developer guide (cw-logs.html) documents these actions on "*" because log delivery APIs have no resource type';
const SFN_TRACING = `X-Ray tracing for a state machine with \`tracingEnabled\` (CDK-generated); the action ${NO_RESOURCE_TYPE}`;
const MODEL_AGREEMENT = `Bedrock model access provider (account-level agreement API); the action ${NO_RESOURCE_TYPE}`;

export const RESOURCE_STAR_ACTIONS: Readonly<Record<string, ResourceStarGrant>> = {
  'comprehend:DetectDominantLanguage': { reason: COMPREHEND_DETECT },
  'comprehend:DetectKeyPhrases': { reason: COMPREHEND_DETECT },
  'comprehend:DetectPiiEntities': { reason: COMPREHEND_DETECT },
  'comprehend:DetectSentiment': { reason: COMPREHEND_DETECT },
  'translate:TranslateText': {
    reason: 'TranslateText can be scoped only to custom terminology or parallel data, which the app does not use; a plain translation is authorized on "*"',
  },
  'dynamodb:ListStreams': {
    reason: `Granted by CDK's DynamoEventSource (aggregator stream trigger); ListStreams ${NO_RESOURCE_TYPE}. The stream reads themselves are scoped to the table's stream ARN`,
  },
  'logs:CreateLogDelivery': { reason: SFN_LOG_DELIVERY },
  'logs:DeleteLogDelivery': { reason: SFN_LOG_DELIVERY },
  'logs:DescribeLogGroups': { reason: SFN_LOG_DELIVERY },
  'logs:DescribeResourcePolicies': { reason: SFN_LOG_DELIVERY },
  'logs:GetLogDelivery': { reason: SFN_LOG_DELIVERY },
  'logs:ListLogDeliveries': { reason: SFN_LOG_DELIVERY },
  'logs:PutResourcePolicy': { reason: SFN_LOG_DELIVERY },
  'logs:UpdateLogDelivery': { reason: SFN_LOG_DELIVERY },
  'xray:GetSamplingRules': { reason: SFN_TRACING },
  'xray:GetSamplingTargets': { reason: SFN_TRACING },
  'xray:PutTelemetryRecords': { reason: SFN_TRACING },
  'xray:PutTraceSegments': { reason: SFN_TRACING },
  'logs:GetQueryResults': { reason: `System -> Logs diagnostics polls a Logs Insights query by id; the action ${NO_RESOURCE_TYPE} (StartQuery is scoped to named log groups)` },
  'logs:StopQuery': { reason: `System -> Logs diagnostics stops its own Logs Insights query by id; the action ${NO_RESOURCE_TYPE}` },
  'cloudwatch:GetMetricData': { reason: `Failure-queue ages for System -> Logs; the action ${NO_RESOURCE_TYPE}` },
  'kms:Decrypt': {
    reason: 'Failure-queue peek decrypts through SQS only: the queue keys live in two stacks and no key ARN crosses a stack, so the grant is "*" narrowed by kms:ViaService and the SQS encryption context',
    requiredConditionKeys: ['kms:ViaService'],
  },
  'cloudfront:CreateInvalidation': {
    reason: 'CDK-managed: the aws-s3-deployment BucketDeployment singleton handler grants it on "*" (the action supports a distribution ARN, but the construct does not scope it); invalidates the frontend after an upload',
  },
  'cloudfront:GetInvalidation': {
    reason: 'CDK-managed: the aws-s3-deployment BucketDeployment singleton handler polls the invalidation it created; same grant as CreateInvalidation',
  },
  'bedrock-agentcore:ConnectBrowserAutomationStream': {
    reason: `AgentCore managed browser (web reviews, design capture); the action ${NO_RESOURCE_TYPE}. Start/StopBrowserSession are scoped to aws.browser.v1`,
  },
  'servicequotas:ListServiceQuotas': { reason: `Read-only Bedrock quota listing for the Settings model test and capacity views; the action ${NO_RESOURCE_TYPE}` },
  'aws-marketplace:ViewSubscriptions': { reason: `Bedrock model EULA check; the action ${NO_RESOURCE_TYPE}` },
  'aws-marketplace:Subscribe': {
    reason: `Bedrock model EULA acceptance; the action ${NO_RESOURCE_TYPE}. API-stack grants add an aws-marketplace:ProductId condition (lib/stacks/api-marketplace.ts)`,
  },
  'bedrock:GetFoundationModelAvailability': { reason: MODEL_AGREEMENT },
  'bedrock:ListFoundationModelAgreementOffers': { reason: MODEL_AGREEMENT },
  'bedrock:CreateFoundationModelAgreement': { reason: MODEL_AGREEMENT },
  'bedrock:PutUseCaseForModelAccess': { reason: MODEL_AGREEMENT },
};

/** The condition keys an IAM `Condition` block tests: `{ StringEquals: { 'kms:ViaService': … } }` → `['kms:ViaService']`. */
function conditionKeys(condition: unknown): string[] {
  if (typeof condition !== 'object' || condition === null) return [];
  return Object.values(condition).flatMap((byKey: unknown) =>
    typeof byKey === 'object' && byKey !== null ? Object.keys(byKey) : []);
}

/** Whether `action` may be granted on `"*"` by a statement whose `Condition` block is `condition`. */
export function isReviewedResourceStarAction(action: string, condition: unknown): boolean {
  // Own keys only: a plain-object lookup would also find inherited names such as `constructor`.
  if (!Object.prototype.hasOwnProperty.call(RESOURCE_STAR_ACTIONS, action)) return false;
  const grant = RESOURCE_STAR_ACTIONS[action];
  if (grant === undefined) return false;
  const tested = new Set(conditionKeys(condition));
  return (grant.requiredConditionKeys ?? []).every((key) => tested.has(key));
}

/**
 * The assistant stream's delegation, prototype IAM boundaries, the document
 * workflow, the Bedrock generation budget against job timeouts, and the
 * verification fixture provider. Split out of api-stack.test.ts; shared
 * template readers live in lib/test-support/api-stack-template.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { z } from 'zod';

import { lambdaBasicExecutionRoleSuppressions } from '../utils/nag-suppressions';
import { BEDROCK_FAILURE_RECORDING_RESERVE_SECONDS, pythonIntConstant } from '../test-support/cross-language-invariants';
import { IamPolicySchema, isAttachedToRole, statementActions } from '../test-support/iam-statements';
import type { IamStatement } from '../test-support/iam-statements';
import {
  RefSchema, apiTemplate, apiTemplatePrefixed, buildApiStack, synthApiTemplate,
} from '../test-support/api-stack-template';
import { itemAt, recordAt } from '../test-support/guards';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

// Synthesize the shared default template once, outside any single case's 5s
// budget: the first case to call apiTemplate() would otherwise pay for it.
beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

/** A Lambda's `Environment` block and its `Role: { Fn::GetAtt: [id, attr] }`. */
const FunctionEnvironmentSchema = z.object({ Variables: z.record(z.string(), z.unknown()) });
const FunctionRoleSchema = z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.string()]) });

describe('ChatStream (AI assistant) delegation', () => {
  // The assistant is read-only server-side: its server tools read through the
  // seven canonical domain APIs (internal invoke with forwarded claims; memory
  // and agents joined for recall and the memory/agents read tools), and
  // every write is a client tool the SPA executes after user approval. These
  // cases pin that boundary in the role, not just in the stream code.
  const FunctionSchema = z.object({
    Properties: z.object({
      Environment: FunctionEnvironmentSchema,
      Role: FunctionRoleSchema,
    }),
  });
  /** Env var → logical-id prefix of the domain Lambda it must name. */
  const DELEGATES = {
    PROJECTS_FUNCTION: 'ProjectsApi',
    METRICS_FUNCTION: 'MetricsApi',
    FEEDBACK_FORMS_FUNCTION: 'FeedbackFormApi',
    SETTINGS_FUNCTION: 'SettingsApi',
    SCRAPERS_FUNCTION: 'ScrapersApi',
    MEMORY_FUNCTION: 'MemoryApi',
    AGENTS_FUNCTION: 'AgentsApi',
  } as const;

  type ParsedFunction = { logicalId: string; properties: z.infer<typeof FunctionSchema>['Properties'] };

  function functions(): ParsedFunction[] {
    return Object.entries(apiTemplate().findResources('AWS::Lambda::Function'))
      .flatMap(([logicalId, resource]) => {
        const parsed = FunctionSchema.safeParse(resource);
        return parsed.success ? [{ logicalId, properties: parsed.data.Properties }] : [];
      });
  }

  function byLogicalPrefix(all: ParsedFunction[], prefix: string): ParsedFunction {
    const found = all.filter(({ logicalId }) => new RegExp(`^${prefix}[0-9A-F]{8}$`).test(logicalId));
    expect(found, `exactly one ${prefix} Lambda`).toHaveLength(1);
    return itemAt(found, 0);
  }

  function chatStatements(chat: ParsedFunction) {
    const chatRoleId = chat.properties.Role['Fn::GetAtt'][0];
    return Object.values(apiTemplate().findResources('AWS::IAM::Policy')).flatMap((resource) => {
      const parsed = IamPolicySchema.safeParse(resource);
      if (!parsed.success) return [];
      return isAttachedToRole(parsed.data.Properties, chatRoleId) ? parsed.data.Properties.PolicyDocument.Statement : [];
    });
  }

  const actionsOf = statementActions;

  it('defaults the assistant to Sonnet 5.5', () => {
    const chat = byLogicalPrefix(functions(), 'ChatStreamApi');
    expect(chat.properties.Environment.Variables.BEDROCK_MODEL_ID)
      .toBe('global.anthropic.claude-sonnet-5-5');
  });

  it('names each delegate Lambda in its env var and drops PROJECTS_TABLE', () => {
    const all = functions();
    const chat = byLogicalPrefix(all, 'ChatStreamApi');
    const variables = chat.properties.Environment.Variables;
    for (const [envName, prefix] of Object.entries(DELEGATES)) {
      expect(variables[envName], envName).toStrictEqual({ Ref: byLogicalPrefix(all, prefix).logicalId });
    }
    expect(variables).not.toHaveProperty('PROJECTS_TABLE');
  });

  it('may invoke exactly the seven delegate domain APIs, by unqualified ARN in one statement', () => {
    const all = functions();
    const chat = byLogicalPrefix(all, 'ChatStreamApi');
    const invokeStatements = chatStatements(chat)
      .filter((statement) => actionsOf(statement).includes('lambda:InvokeFunction'));
    expect(invokeStatements).toHaveLength(1);
    const invoke = itemAt(invokeStatements, 0);
    expect(actionsOf(invoke)).toStrictEqual(['lambda:InvokeFunction']);
    const expected = Object.values(DELEGATES).map((prefix) => ({ 'Fn::GetAtt': [byLogicalPrefix(all, prefix).logicalId, 'Arn'] }));
    expect(invoke.Resource).toStrictEqual(expected);
    expect(JSON.stringify(invoke.Resource)).not.toContain(':*');
  });

  it('carries no IAM5 suppression for delegate invoke wildcards', () => {
    const metadata = JSON.stringify(Object.values(apiTemplate().toJSON().Resources ?? {})
      .map((resource: unknown) => (typeof resource === 'object' && resource !== null ? Reflect.get(resource, 'Metadata') : undefined)));
    expect(metadata).not.toMatch(/ProjectsApi\|MetricsApi\|FeedbackFormApi/);
  });

  /** The ChatStream statements carrying a DynamoDB write action. */
  function chatWriteStatements(): IamStatement[] {
    const chat = byLogicalPrefix(functions(), 'ChatStreamApi');
    return chatStatements(chat).filter((statement) => actionsOf(statement).some((action) =>
      /^dynamodb:(PutItem|UpdateItem|DeleteItem|BatchWriteItem)$/.test(action)));
  }

  it('has no projects-table access', () => {
    const chat = byLogicalPrefix(functions(), 'ChatStreamApi');
    // The tables live in another stack, so grants reference them by
    // Fn::ImportValue; the export name carries the table's logical id.
    const dynamoStatements = chatStatements(chat).filter((statement) =>
      actionsOf(statement).some((action) => action.startsWith('dynamodb:')));
    expect(dynamoStatements.filter((statement) => /[Pp]rojects/.test(JSON.stringify(statement.Resource)))).toStrictEqual([]);
  });

  it('writes DynamoDB only through one Get/PutItem statement on the conversations table itself', () => {
    // Server-side session persistence (lambda/stream/src/assistant/session/):
    // exactly one statement, exactly these two actions, exactly the conversations
    // table (no index, no wildcard). The partition is enforced in the stream code.
    const writes = chatWriteStatements();
    expect(writes).toHaveLength(1);
    const write = itemAt(writes, 0);
    expect([...actionsOf(write)].sort(byCodeUnit)).toStrictEqual(['dynamodb:GetItem', 'dynamodb:PutItem']);
    const resources: unknown[] = Array.isArray(write.Resource) ? write.Resource : [write.Resource];
    expect(resources.map((resource) => JSON.stringify(resource))).toStrictEqual([
      expect.stringMatching(/^\{"Fn::ImportValue":"[^"*]*Conversations[^"*]*Arn[^"*]*"\}$/),
    ]);
  });

  it('names the conversations table for the session writes', () => {
    const chat = byLogicalPrefix(functions(), 'ChatStreamApi');
    expect(JSON.stringify(chat.properties.Environment.Variables.CONVERSATIONS_TABLE)).toMatch(/Conversations/);
  });

  it('keeps the ChatStream role policy well under the inline IAM quota', () => {
    const chat = byLogicalPrefix(functions(), 'ChatStreamApi');
    const chars = JSON.stringify({ Statement: chatStatements(chat) }).length;
    expect(chars).toBeGreaterThan(0);
    expect(chars).toBeLessThan(10_240 * 0.7);
  });
});


describe('prototype object IAM boundaries', () => {
  function statementsForRole(roleName: string): IamStatement[] {
    const policies = apiTemplate().findResources('AWS::IAM::Policy');
    const policy = Object.entries(policies).find(([logicalId]) => logicalId.includes(roleName));
    expect(policy, `no IAM policy found for ${roleName}`).toBeDefined();
    return IamPolicySchema.parse(policy?.[1]).Properties.PolicyDocument.Statement;
  }

  it('denies Data Explorer prototype writes without denying reads or other prefixes', () => {
    const denies = statementsForRole('DataExplorerLambdaRole')
      .filter((statement) => statement.Effect === 'Deny');

    expect(denies).toHaveLength(1);
    const deny = itemAt(denies, 0);
    expect([...statementActions(deny)].sort(byCodeUnit)).toStrictEqual(['s3:DeleteObject', 's3:PutObject']);
    const resources: unknown[] = Array.isArray(deny.Resource) ? deny.Resource : [deny.Resource];
    expect(resources).toHaveLength(1);
    expect(JSON.stringify(resources.at(0))).toContain('prototypes/*');
  });

  it('lets the projects Lambda copy prototype HTML (document duplication), never s3:*', () => {
    const prototypeStatements = statementsForRole('ProjectsLambdaRole')
      .filter((statement) => JSON.stringify(statement.Resource).includes('prototypes/*'));

    const actions = new Set(prototypeStatements.flatMap(statementActions));
    expect(actions).toContain('s3:GetObject*');
    expect(actions).toContain('s3:PutObject');
    expect(actions).not.toContain('s3:*');
  });

  it('lets the projects Lambda sweep a deleted project\'s objects: list + delete on its three prefixes', () => {
    const statements = statementsForRole('ProjectsLambdaRole');
    const deletesUnder = (pattern: string) => statements.some((statement) =>
      statementActions(statement).includes('s3:DeleteObject*') && JSON.stringify(statement.Resource).includes(pattern));

    expect(['prototypes/*', 'projects/*/product_docs/*', 'avatars/*'].filter((pattern) => !deletesUnder(pattern)))
      .toStrictEqual([]);
    expect(statements.some((statement) => statementActions(statement).includes('s3:List*'))).toBe(true);
  });

  it('keeps the document generator read-write grant scoped to prototype objects', () => {
    const prototypeStatements = statementsForRole('DocumentGeneratorRole')
      .filter((statement) => JSON.stringify(statement.Resource).includes('prototypes/*'));

    expect(prototypeStatements.length).toBeGreaterThan(0);
    const actions = new Set(prototypeStatements.flatMap(statementActions));
    const needed = ['s3:GetObject*', 's3:PutObject', 's3:DeleteObject*'];
    expect(needed.filter((action) => !actions.has(action)), 'missing prototype actions').toStrictEqual([]);
    expect(actions).not.toContain('s3:*');
  });
});


function stateMachineDefinitionText(value: unknown): string {
  if (typeof value === 'string') return value;
  const joined = z.object({
    'Fn::Join': z.array(z.unknown()),
  }).safeParse(value);
  if (!joined.success) return '';
  const pieces = joined.data['Fn::Join'][1];
  if (!Array.isArray(pieces)) return '';
  return pieces
    .filter((piece): piece is string => typeof piece === 'string')
    .join('');
}

function documentWorkflowDefinition(template: Template): string {
  const resourceSchema = z.object({
    Properties: z.object({
      DefinitionString: z.unknown(),
    }),
  });
  const machines = template.findResources('AWS::StepFunctions::StateMachine');
  for (const resource of Object.values(machines)) {
    const parsed = resourceSchema.safeParse(resource);
    if (!parsed.success) continue;
    const definition = stateMachineDefinitionText(
      parsed.data.Properties.DefinitionString,
    );
    if (definition.includes('DocGather')) return definition;
  }
  throw new Error('Document workflow state machine was not synthesized');
}

describe('document workflow replay routing', () => {
  const state: { definition: string } = { definition: '' };
  beforeAll(() => {
    state.definition = documentWorkflowDefinition(synthApiTemplate());
  });

  it('selects the replay marker from the gather Lambda result', () => {
    expect(state.definition).toContain(
      '"replayed.$":"$.Payload.replayed"',
    );
  });

  it('completes committed replays and runs fresh allocations', () => {
    expect(state.definition).toContain('"DocumentAlreadyGenerated"');
    expect(state.definition).toContain(
      '"Variable":"$.gathered.replayed","BooleanEquals":true,"Next":"DocComplete"',
    );
    expect(state.definition).toContain('"Default":"DocStep0"');
  });
});

describe('the Bedrock generation budget fits the job Lambdas', () => {
  // The bug this pins was arithmetic split across two files: shared/aws.py built
  // the ONE cached Bedrock client with read_timeout=300 and max_attempts=3, and
  // the job functions below are configured for 15 minutes. 3 x 300 = 900, so a
  // generation needing more than five minutes could not succeed at all — two
  // abandoned attempts, each re-paying for a full generation, then killed
  // mid-third. Measured live on a prototype build, where the application log read
  // "Attempt 1/5" for the whole 900 s because botocore retried BELOW
  // shared/converse.py's own loop.
  //
  // Neither file could catch it alone, which is the reason this test exists here:
  // the Python side pins the values and their product (lambda/shared/test/
  // test_aws.py), and this side pins the product against the timeouts actually
  // synthesized. Same shape as the delegation-timeout suite above.
  //
  // Matched on LOGICAL ID, not FunctionName: uniqueName() builds names from the
  // Aws.ACCOUNT_ID/Aws.REGION pseudo-parameters, so FunctionName synthesizes to
  // an Fn::Join rather than a comparable string.
  const JOB_CONSTRUCT_IDS = [
    'PersonaGeneratorJob',
    'DocumentGeneratorJob',
    'DocumentMergerJob',
    'PersonaImporterJob',
  ];

  // The two that run a FULL-LENGTH generation, and the pair the read budget is
  // sized against: `build_prototype` asks for 32000 tokens on this generator, and
  // persona generation is the other 15-minute caller. `voc-research-step` in
  // ProcessingStack is the third, pinned at the same 900 s by its own suite.
  const LONG_GENERATION_JOB_IDS = ['DocumentGeneratorJob', 'PersonaGeneratorJob'];

  const JobFunctionSchema = z.object({ Timeout: z.number() });

  /** Each named function's logical id and timeout, validated rather than assumed. */
  const jobFunctions = (constructIds: string[] = JOB_CONSTRUCT_IDS) => {
    const functions = Object.entries(apiTemplate().findResources('AWS::Lambda::Function'));
    return constructIds.map((constructId) => {
      const matches = functions.filter(([logicalId]) => logicalId.startsWith(constructId));
      // Count FIRST: a renamed construct must read as "not found", not as a
      // vacuous pass over an empty list.
      expect(matches, `expected exactly one ${constructId}`).toHaveLength(1);
      const [logicalId, resource] = itemAt(matches, 0);
      return {
        constructId,
        logicalId,
        timeout: JobFunctionSchema.parse(resource.Properties).Timeout,
      };
    });
  };

  /** read_timeout x max_attempts, read from the Python that configures the client. */
  const bedrockMaxAttempts = () =>
    pythonIntConstant('BEDROCK_MAX_ATTEMPTS', 'lambda', 'shared', 'aws.py');
  const bedrockBudgetSeconds = () =>
    pythonIntConstant('BEDROCK_READ_TIMEOUT_SECONDS', 'lambda', 'shared', 'aws.py') *
    bedrockMaxAttempts();

  it('fires before the long-generation jobs are killed, with time to record the failure', () => {
    const budget = bedrockBudgetSeconds();

    for (const fn of jobFunctions(LONG_GENERATION_JOB_IDS)) {
      // Strictly less than, not "fits": a budget that merely EQUALS the ceiling
      // is the original bug exactly. The invocation has to outlive its own read
      // timeout far enough for shared/jobs.py to write the job `failed`, or a slow
      // generation is a silent kill and a job row stuck on `running` forever.
      expect(budget, `${fn.constructId} runs ${fn.timeout}s; the Bedrock read budget is ${budget}s`)
        .toBeLessThan(fn.timeout - BEDROCK_FAILURE_RECORDING_RESERVE_SECONDS);
    }
  });

  it('classifies every job Lambda as one the read timeout binds inside, or one it does not', () => {
    // ONE cached client serves the 30 s API handlers, the 5-10 minute
    // importer/merger jobs and the 15-minute generators, so "the budget is below
    // every caller's timeout" is not achievable: a per-caller read timeout needs a
    // keyed client cache plus the caller's remaining time plumbed through
    // converse(), which nothing passes today.
    //
    // Rather than leave that asymmetry as prose, it is enumerated. A job Lambda is
    // in exactly one band, and a new one — or a timeout change that moves an
    // existing one across the line — fails here and has to be classified in review
    // instead of quietly inheriting whichever behaviour it happens to get.
    //
    // Band 2 is not a regression introduced by the budget: at the previous 300 x 3
    // the merger's first read timeout did not surface either, because botocore had
    // already started attempt 2 when the function was killed. What band 2 costs is
    // the DIAGNOSIS — the row stays `running` rather than going `failed` — and that
    // is the separately documented job-timeout defect, whose fix (a remaining-time
    // guard) covers OOM and every other kill too, so a read-timeout-shaped fix here
    // would only be a partial one.
    const budget = bedrockBudgetSeconds();
    const bands: Record<'bindsInside' | 'killedAtItsOwnCeiling', string[]> = {
      bindsInside: [],
      killedAtItsOwnCeiling: [],
    };

    for (const fn of jobFunctions()) {
      const band = budget < fn.timeout - BEDROCK_FAILURE_RECORDING_RESERVE_SECONDS
        ? 'bindsInside'
        : 'killedAtItsOwnCeiling';
      bands[band].push(fn.constructId);
    }

    expect(bands).toStrictEqual({
      // 15-minute generations: the read timeout fires first and the job records `failed`.
      bindsInside: ['PersonaGeneratorJob', 'DocumentGeneratorJob'],
      // 10- and 5-minute jobs: their own timeout is reached first. Safe because the
      // budget is ONE attempt, so nothing is spent on a retry that cannot help.
      killedAtItsOwnCeiling: ['DocumentMergerJob', 'PersonaImporterJob'],
    });
  });

  it('never multiplies inside a caller too short for the read timeout to bind', () => {
    // The property that makes one shared budget safe for band 2 above: a single
    // attempt, so no caller is ever handed a MULTIPLE of the read timeout. This is
    // the assertion that fails if someone restores botocore's retries.
    expect(bedrockMaxAttempts(), 'shared/aws.py must make exactly one Bedrock attempt: more than '
      + 'one makes the budget a MULTIPLE of the read timeout, which is how 300 x 3 came to equal '
      + 'the 900s job ceiling').toBe(1);
  });

  it('does not retry the whole generation behind the caller', () => {
    // These four are invoked with InvocationType='Event', and AWS re-drives a
    // failed async invocation twice more by default — the second multiplier that
    // turned one 15-minute kill into ~45 minutes of Opus generations. A missing
    // EventInvokeConfig is indistinguishable from the default at a glance, which
    // is why the resource is asserted to EXIST rather than just to be zero.
    const configs = Object.values(apiTemplate().findResources('AWS::Lambda::EventInvokeConfig'))
      .map((resource) => z.object({
        Properties: z.object({
          FunctionName: RefSchema,
          // Absent on a config that only adds a failure destination and keeps
          // AWS's default retries (the manual-import processor, #253).
          MaximumRetryAttempts: z.number().optional(),
        }),
      }).parse(resource).Properties);

    for (const fn of jobFunctions()) {
      const config = configs.find((c) => c.FunctionName.Ref === fn.logicalId);
      expect(config, `${fn.constructId} has no EventInvokeConfig, so AWS retries it twice`)
        .toBeDefined();
      expect(config?.MaximumRetryAttempts, `${fn.constructId} async retries`).toBe(0);
    }
  });
});


const HandlerSchema = z.object({ Properties: z.object({ Handler: z.string().optional() }).optional() });

/** The provider writes to the live data tables, so a normal install must not have one. */
function fixtureProviderEntry(template: Template): [string, unknown] | undefined {
  return Object.entries(template.findResources('AWS::Lambda::Function')).find(([, resource]) =>
    HandlerSchema.safeParse(resource).data?.Properties?.Handler
      === 'verification_fixture_provider.lambda_handler');
}

/** Every trace the provider leaves in a template: the function, its stack
 *  output, and any other resource carrying its name (role, policy, log group). */
function fixtureProviderTrace(template: Template): { fn: boolean; output: boolean; named: boolean } {
  const outputs = recordAt(template.toJSON(), 'Outputs') ?? {};
  return {
    fn: fixtureProviderEntry(template) !== undefined,
    output: outputs.VerificationFixtureProviderArn !== undefined,
    named: JSON.stringify(template.toJSON()).includes('voc-fixture-provider'),
  };
}

const NO_FIXTURE_PROVIDER = { fn: false, output: false, named: false };

/**
 * Both conditions are load-bearing, so both single-condition shapes are tested.
 * A prefixed PRODUCTION slot is the case that makes topology alone unsafe, and
 * the flag alone must not smuggle the provider into a default deployment.
 */
describe('the fixture provider is absent unless a prefixed deployment opts in', () => {
  it.each([
    ['neither a prefix nor the flag', () => apiTemplate()],
    ['a prefix but no flag', () => synthApiTemplate({}, [], 'b')],
    ['the flag but no prefix', () => synthApiTemplate({ enableVerificationFixtureProvider: true })],
  ])('creates nothing given %s', (_label, synth) => {
    expect(fixtureProviderTrace(synth())).toStrictEqual(NO_FIXTURE_PROVIDER);
  });

  // One synth per case, like the shapes above: five synths in one test body put a
  // single case past the 5s default once the machine is busy (seen on a full run).
  it.each<unknown>(['TRUE', '1', 'yes', 'on', false])(
    'rejects the truthy-looking spelling %s, which is not an accepted one',
    (value) => {
      // Same three checks as the shapes above: a partial leak (role or log
      // group created while the function is skipped) must fail here too.
      const template = synthApiTemplate({ enableVerificationFixtureProvider: value }, [], 'b');
      expect(fixtureProviderTrace(template)).toStrictEqual(NO_FIXTURE_PROVIDER);
    },
  );
});

describe('the optional invoker ARN narrows invoke to one principal', () => {
  const enabled = { enableVerificationFixtureProvider: true };

  // The template carries ~105 API Gateway permissions; only the provider's matter.
  const invokerPermissions = (template: Template) =>
    Object.entries(template.findResources('AWS::Lambda::Permission'))
      .filter(([logicalId]) => logicalId.includes('VerificationFixtureInvoker'));

  it('attaches no resource policy when no ARN is supplied', () => {
    expect(invokerPermissions(apiTemplatePrefixed())).toStrictEqual([]);
  });

  it('attaches a permission for exactly the supplied role', () => {
    const arn = 'arn:aws:iam::111122223333:role/my-verification-role';
    const permissions = invokerPermissions(synthApiTemplate(
      { ...enabled, verificationFixtureInvokerArn: arn }, [], 'b',
    ));
    expect(permissions).toHaveLength(1);
    const props = z.object({ Properties: z.record(z.string(), z.unknown()) }).parse(itemAt(permissions, 0)[1]).Properties;
    expect(props).toMatchObject({ Action: 'lambda:InvokeFunction', Principal: arn });
  });

  it.each([
    ['not an arn', 'my-verification-role'],
    ['a non-IAM arn', 'arn:aws:lambda:us-east-1:111122223333:function:x'],
    ['a wildcard account', 'arn:aws:iam::*:role/x'],
    // IAM rejects these at deploy time, so synth must reject them first.
    ['a wildcard path', 'arn:aws:iam::111122223333:role/*'],
    ['a wildcard inside the path', 'arn:aws:iam::111122223333:role/team-*'],
    // `?` is an IAM wildcard too, and just as invalid in a principal.
    ['a single-character wildcard', 'arn:aws:iam::111122223333:role/te?m'],
    ['trailing junk after the arn', 'arn:aws:iam::111122223333:role/x extra'],
    ['an empty role name', 'arn:aws:iam::111122223333:role/'],
    ['a non-string', 42],
  ])('fails at synth given %s rather than deploying a useless policy', (_label, value) => {
    expect(() => synthApiTemplate(
      { ...enabled, verificationFixtureInvokerArn: value }, [], 'b',
    )).toThrow(/verificationFixtureInvokerArn/);
  });
});

/**
 * Gating the provider behind prefix+flag moved its IAM out of the shape that
 * `npm run cdk:nag` synthesizes (the default app, no prefix), so nothing in CI
 * would have reported a wildcard on it. This runs cdk-nag over the shape that
 * DOES contain it, which is the only place those findings can appear.
 */
it('leaves no unsuppressed cdk-nag finding on the fixture provider', () => {
  const stack = buildApiStack(
    { enableVerificationFixtureProvider: true }, [], 'b', [new AwsSolutionsChecks()],
  );
  // Mirror ONLY the suppression bin/voc-datalake.ts applies for the shared
  // createLambdaRole helper's AWSLambdaBasicExecutionRole. Deliberately not the
  // rest of that file's list: every other rule — IAM5 wildcards above all —
  // must still be able to fail this case.
  NagSuppressions.addStackSuppressions(stack, lambdaBasicExecutionRoleSuppressions, true);
  const annotations = Annotations.fromStack(stack);
  const provider = [...annotations.findError('*', Match.anyValue()),
    ...annotations.findWarning('*', Match.anyValue())]
    .filter((annotation) => annotation.id.includes('VerificationFixtureProvider'))
    .map((annotation) => `${annotation.id} ${JSON.stringify(annotation.entry.data)}`);
  expect(provider, `unsuppressed findings:\n${provider.join('\n')}`).toStrictEqual([]);
});

/** The provider function's properties, parsed rather than asserted. */
const FixtureProviderSchema = z.object({
  Properties: z.object({
    Runtime: z.string(),
    MemorySize: z.number(),
    Timeout: z.number(),
    Architectures: z.array(z.string()),
    Environment: FunctionEnvironmentSchema,
    Role: FunctionRoleSchema,
  }),
});

interface FixtureProvider {
  logicalId: string;
  props: z.infer<typeof FixtureProviderSchema>['Properties'];
}

/** The one fixture provider of `template`, failing loudly when it is absent. */
function fixtureProvider(template: Template): FixtureProvider {
  const entry = fixtureProviderEntry(template);
  if (entry === undefined) throw new Error('expected the fixture provider in a prefixed, opted-in template');
  const [logicalId, resource] = entry;
  return { logicalId, props: FixtureProviderSchema.parse(resource).Properties };
}

/**
 * An attached policy whose statements keep EVERY key — `Condition` included,
 * which the KMS case reads. `IamPolicySchema` strips unknown keys.
 */
const ProviderPolicySchema = z.object({
  Properties: z.object({
    Roles: z.array(z.unknown()).optional(),
    PolicyDocument: z.object({
      Statement: z.array(z.object({
        Effect: z.string().optional(),
        Action: z.union([z.string(), z.array(z.string())]),
        Resource: z.unknown(),
      }).loose()),
    }),
  }),
});

/** Every statement of every IAM policy attached to the provider's role, unstripped. */
function providerStatements(template: Template, provider: FixtureProvider): IamStatement[] {
  const roleRef = provider.props.Role['Fn::GetAtt'][0];
  return Object.values(template.findResources('AWS::IAM::Policy')).flatMap((resource) => {
    const parsed = ProviderPolicySchema.safeParse(resource);
    return parsed.success && isAttachedToRole(parsed.data.Properties, roleRef)
      ? parsed.data.Properties.PolicyDocument.Statement
      : [];
  });
}

/** Sorted, de-duplicated actions across `statements`. */
const actionSet = (statements: IamStatement[]): string[] =>
  [...new Set(statements.flatMap(statementActions))].sort(byCodeUnit);

describe('the private fixture provider', () => {
  let template: Template;
  let provider: FixtureProvider;
  let statements: IamStatement[];
  beforeAll(() => {
    template = apiTemplatePrefixed();
    provider = fixtureProvider(template);
    statements = providerStatements(template, provider);
  });

  /** The provider's grants on the two data tables. */
  const tableStatements = (): IamStatement[] => statements.filter((statement) =>
    JSON.stringify(statement.Resource).includes('Projects')
    || JSON.stringify(statement.Resource).includes('Aggregates'));

  it('has the exact runtime shape', () => {
    const { Runtime, MemorySize, Timeout, Architectures } = provider.props;
    expect({ Runtime, MemorySize, Timeout, Architectures }).toStrictEqual({
      Runtime: 'python3.14', MemorySize: 256, Timeout: 30, Architectures: ['arm64'],
    });
  });

  it('carries exactly its four environment variables, naming both tables', () => {
    const variables = provider.props.Environment.Variables;
    expect(Object.keys(variables).sort(byCodeUnit)).toStrictEqual([
      'AGGREGATES_TABLE', 'LOG_LEVEL', 'POWERTOOLS_SERVICE_NAME', 'PROJECTS_TABLE',
    ]);
    expect(variables).toMatchObject({ POWERTOOLS_SERVICE_NAME: 'voc-fixture-provider', LOG_LEVEL: 'INFO' });
    expect(JSON.stringify(variables.PROJECTS_TABLE)).toMatch(/Projects/);
    expect(JSON.stringify(variables.AGGREGATES_TABLE)).toMatch(/Aggregates/);
  });

  it('may only get, put and delete items on the two tables', () => {
    const actions = actionSet(tableStatements());
    expect(actions).toStrictEqual(['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:PutItem']);
    expect(actions.filter((action) => /Query|Scan|UpdateItem/.test(action))).toStrictEqual([]);
  });

  it('scopes every table grant to the two table ARNs, never `<table>/index/*`', () => {
    // Asserting only the actions (as this case first did) would pass while the
    // resource set was wide.
    const scopes = tableStatements().map((statement) => {
      const resources: unknown[] = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
      return { resourceCount: resources.length, namesAnIndex: JSON.stringify(resources).includes('index/') };
    });
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes).toStrictEqual(scopes.map(() => ({ resourceCount: 2, namesAnIndex: false })));
  });

  it('uses KMS only through DynamoDB, for these two tables', () => {
    const kms = statements.filter((statement) =>
      statementActions(statement).some((action) => action.startsWith('kms:')));
    expect(actionSet(kms)).toStrictEqual([
      'kms:Decrypt',
      'kms:DescribeKey',
      'kms:Encrypt',
      'kms:GenerateDataKey',
      'kms:GenerateDataKeyWithoutPlaintext',
      'kms:ReEncryptFrom',
      'kms:ReEncryptTo',
    ]);
    const kmsPolicy = JSON.stringify(kms);
    const required = [
      'kms:ViaService', 'kms:CallerAccount', 'kms:EncryptionContext:aws:dynamodb:tableName', 'Projects', 'Aggregates',
    ];
    expect(required.filter((fragment) => !kmsPolicy.includes(fragment)), 'missing from the KMS grant')
      .toStrictEqual([]);
  });

  it('exports its ARN and exposes no public endpoint', () => {
    expect(recordAt(template.toJSON(), 'Outputs', 'VerificationFixtureProviderArn')?.Value).toStrictEqual({
      'Fn::GetAtt': [provider.logicalId, 'Arn'],
    });
    expect(Object.keys(template.findResources('AWS::Lambda::Url'))).toHaveLength(0);
    expect(JSON.stringify(template.findResources('AWS::ApiGateway::Method'))).not.toContain(provider.logicalId);
  });
});

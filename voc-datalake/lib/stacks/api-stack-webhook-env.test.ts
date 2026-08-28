/**
 * The environment a webhook Lambda is deployed with, against what
 * `plugins/_shared/base_webhook.py` actually reads.
 *
 * `createWebhookLambda` set `PLUGIN_ID` while `base_webhook.py` read
 * `SOURCE_PLATFORM`, so on a deployed webhook the plugin identity was `''`. Under
 * the old fail-open secret filter that empty identity matched nothing and the
 * whole shared secret came back; since issue #251 it is a hard
 * `ConfigurationError` at construction, so EVERY delivery would have died — on a
 * message blaming the identity rather than the missing variable, which is the
 * wrong thing to hand a deployer at 3am.
 *
 * IN ITS OWN FILE, and this is the point of the whole file: no manifest declares
 * `infrastructure.webhook` and no plugin has a `webhook/` directory, so
 * `api-stack.test.ts`'s fixtures — which read the real manifests — synthesize no
 * webhook Lambda at all and CANNOT see this. Rather than wait for the first
 * webhook plugin to discover it in production, the loader is mocked here to
 * declare one. Mocking `loadPlugins` is why this cannot live in
 * `api-stack.test.ts`: `vi.mock` is module-scoped and hoisted, and every other
 * case in that file depends on the real manifests.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { z } from 'zod';

const WEBHOOK_PLUGIN_ID = 'webhook_fixture';

const ACCOUNT = '111111111111';
const REGION = 'us-east-1';
/** The SHARED API-credentials secret — the one `base_webhook.py` reads. Named here
 *  because the IAM case below has to tell it apart from the CDN signing secret,
 *  which the same stack also grants reads of. */
const SHARED_SECRET_ARN = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:voc`;
const CDN_SIGNING_SECRET_ARN = `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:cdn-signing`;

/** A manifest declaring a webhook, which nothing on disk does. Otherwise shaped
 *  exactly like a real one, so it travels the same `createWebhookLambda` path. */
const webhookPlugin = {
  id: WEBHOOK_PLUGIN_ID,
  name: 'Webhook Fixture',
  icon: '🔔',
  infrastructure: {
    webhook: { enabled: true, path: '/webhooks/fixture', methods: ['POST'] as const },
  },
  config: [],
  secrets: { api_key: '' },
};

// Only `loadPlugins` is replaced; every other export (aggregateSecretsByPlugin,
// getEnabledPlugins, getPluginsWithWebhook, capitalize, ManifestSchema) stays
// real, so the stack still exercises the genuine filtering and naming logic.
vi.mock('../plugin-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plugin-loader')>();
  return { ...actual, loadPlugins: () => [webhookPlugin] };
});

// Imported AFTER the mock declaration for readability only — `vi.mock` is
// hoisted above both.
import { VocApiStack } from './api-stack';

function synthWithWebhookPlugin(): Template {
  const app = new cdk.App({
    context: { 'aws:cdk:bundling-stacks': [], skipFrontendBuildCheck: true },
  });
  const env = { account: ACCOUNT, region: REGION };
  const deps = new cdk.Stack(app, 'TestDeps', { env });

  const table = (id: string) => new dynamodb.Table(deps, id, {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  });
  const userPool = new cognito.UserPool(deps, 'UserPool');
  const websiteBucket = new s3.Bucket(deps, 'Website');

  const stack = new VocApiStack(app, 'TestApiStack', {
    env,
    feedbackTable: table('Feedback'),
    aggregatesTable: table('Aggregates'),
    projectsTable: table('Projects'),
    jobsTable: table('Jobs'),
    conversationsTable: table('Conversations'),
    kmsKey: new kms.Key(deps, 'Key'),
    rawDataBucket: new s3.Bucket(deps, 'RawData'),
    avatarsCdnUrl: 'https://cdn.example.invalid/avatars',
    prototypesCdnUrl: 'https://cdn.example.invalid/prototypes',
    cdnSigningSecretArn: CDN_SIGNING_SECRET_ARN,
    cdnSigningKeyPairId: 'KEXAMPLE0000',
    websiteBucket,
    frontendDistribution: new cloudfront.Distribution(deps, 'Dist', {
      defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket) },
    }),
    frontendDomainName: 'app.example.invalid',
    userPool,
    userPoolClient: userPool.addClient('Client'),
    identityPool: new cognito.CfnIdentityPool(deps, 'IdentityPool', { allowUnauthenticatedIdentities: false }),
    authenticatedRole: new iam.Role(deps, 'AuthRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') }),
    processingQueueUrl: `https://sqs.${env.region}.amazonaws.com/${env.account}/processing`,
    processingQueueArn: `arn:aws:sqs:${env.region}:${env.account}:processing`,
    secretsArn: SHARED_SECRET_ARN,
    s3ImportBucket: new s3.Bucket(deps, 'S3Import'),
    researchStateMachine: new sfn.StateMachine(deps, 'Research', {
      definitionBody: sfn.DefinitionBody.fromChainable(new sfn.Pass(deps, 'Noop')),
    }),
    brandName: 'TestBrand',
    // The fixture plugin has to be ENABLED for a webhook Lambda to be created:
    // api-stack.ts filters `getEnabledPlugins` before `getPluginsWithWebhook`.
    enabledSources: [WEBHOOK_PLUGIN_ID],
  });

  return Template.fromStack(stack);
}

let cached: Template | undefined;
const template = () => (cached ??= synthWithWebhookPlugin());

const EnvSchema = z.object({
  Properties: z.object({ Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }) }),
});

/** The fixture plugin's webhook function, found by its Powertools service name
 *  (the same way api-stack.test.ts locates the integrations function). */
function webhookFunction(): unknown {
  const functions = Object.values(template().findResources('AWS::Lambda::Function'));
  const fn = functions.find(
    (f) => EnvSchema.safeParse(f).success
      && EnvSchema.parse(f).Properties.Environment.Variables.POWERTOOLS_SERVICE_NAME
        === `voc-webhook-${WEBHOOK_PLUGIN_ID}`,
  );
  expect(fn, `no webhook Lambda synthesized for ${WEBHOOK_PLUGIN_ID}`).toBeDefined();
  return fn;
}

function webhookEnv(): Record<string, unknown> {
  return EnvSchema.parse(webhookFunction()).Properties.Environment.Variables;
}

/** A function's `Role` is a `Fn::GetAtt` on the role's logical id — element 0. */
const RoleRefSchema = z.object({
  Properties: z.object({
    Role: z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.literal('Arn')]) }),
  }),
});

/** Statements of the inline policies attached to *roleLogicalId*, and nothing
 *  else's. Scoping to the role is the whole point: five other roles in this stack
 *  grant `secretsmanager:GetSecretValue`, so a template-wide scan for that action
 *  passes with the webhook's own grant deleted. */
const PolicySchema = z.object({
  Properties: z.object({
    Roles: z.array(z.object({ Ref: z.string() }).or(z.unknown())),
    PolicyDocument: z.object({
      Statement: z.array(z.object({
        Action: z.union([z.string(), z.array(z.string())]).optional(),
        Resource: z.unknown().optional(),
      }).passthrough()),
    }),
  }),
});

function statementsFor(roleLogicalId: string): { Action?: string | string[]; Resource?: unknown }[] {
  return Object.values(template().findResources('AWS::IAM::Policy'))
    .filter((p) => {
      const parsed = PolicySchema.safeParse(p);
      if (!parsed.success) return false;
      return parsed.data.Properties.Roles.some(
        (r) => typeof r === 'object' && r !== null && (r as { Ref?: string }).Ref === roleLogicalId,
      );
    })
    .flatMap((p) => PolicySchema.parse(p).Properties.PolicyDocument.Statement);
}

const actionsOf = (statement: { Action?: string | string[] }): string[] => {
  const action = statement.Action;
  if (typeof action === 'string') return [action];
  return action ?? [];
};

describe('webhook Lambda environment', () => {
  it('synthesizes a webhook Lambda at all, so the assertions below are not vacuous', () => {
    // The mock is the only reason a webhook function exists in this template. If
    // it stopped taking effect — an import path change, a rename of `loadPlugins`
    // — every case here would pass over nothing. `webhookEnv()` throwing is what
    // makes that loud.
    expect(webhookEnv().POWERTOOLS_SERVICE_NAME).toBe(`voc-webhook-${WEBHOOK_PLUGIN_ID}`);
  });

  it('carries SOURCE_PLATFORM, which is the name base_webhook.py reads', () => {
    // `plugins/_shared/base_webhook.py` resolves the plugin identity from
    // SOURCE_PLATFORM and hands it to `filter_plugin_secrets`, which since issue
    // #251 raises on an empty one. `createIngestorLambda` sets both names; this
    // one used to set only PLUGIN_ID.
    expect(webhookEnv().SOURCE_PLATFORM).toBe(WEBHOOK_PLUGIN_ID);
  });

  it('keeps PLUGIN_ID too, so nothing reading the older name breaks', () => {
    expect(webhookEnv().PLUGIN_ID).toBe(WEBHOOK_PLUGIN_ID);
  });

  it('agrees with the variable base_webhook.py actually reads', () => {
    // The independent oracle, and the half that keeps this honest in the other
    // direction: the two assertions above would still pass if the Python side were
    // changed to read a third name. Read out of the Python source rather than
    // re-stated, which is this repo's convention for a contract two languages
    // share (see the MCP_TOKEN_PK and TRANSPORT_HEADERS tests in
    // api-stack.test.ts).
    const source = readFileSync(
      join(__dirname, '..', '..', 'plugins', '_shared', 'base_webhook.py'),
      'utf-8',
    );
    const name = source.match(/^SOURCE_PLATFORM = os\.environ\.get\("([A-Z_]+)"/m)?.[1];

    expect(name, 'could not read the identity env var from base_webhook.py').toBeDefined();
    expect(Object.keys(webhookEnv())).toContain(name);
  });

  it("grants the webhook's OWN role read access to the shared secret", () => {
    // Failing closed makes the secret read load-bearing: without the grant, every
    // delivery raises at construction rather than degrading. Asserted here because
    // this is the only fixture in the suite that synthesizes the role at all.
    //
    // Scoped to the webhook function's own role, and to the shared secret's ARN
    // specifically. A template-wide `some(... includes('GetSecretValue'))` was
    // vacuous: the integrations, scrapers, projects and chat-stream roles in this
    // same stack all grant that action, so deleting the webhook role's grant left
    // the assertion green. The CDN signing secret is excluded for the same reason —
    // a grant on THAT ARN does not let base_webhook.py read its credentials.
    const roleLogicalId = RoleRefSchema.parse(webhookFunction())
      .Properties.Role['Fn::GetAtt'][0];

    const grants = statementsFor(roleLogicalId).filter(
      (s) => actionsOf(s).includes('secretsmanager:GetSecretValue')
        && JSON.stringify(s.Resource) === JSON.stringify(SHARED_SECRET_ARN),
    );

    expect(
      grants.length,
      `the webhook role ${roleLogicalId} may not read ${SHARED_SECRET_ARN}, so every `
      + 'delivery would raise ConfigurationError at construction',
    ).toBeGreaterThan(0);
  });

  it('the control: the webhook role is found and does carry other statements', () => {
    // Non-vacuity for the case above, in the direction that actually threatens it:
    // if `statementsFor` matched nothing — a logical-id shape change, a move from
    // AWS::IAM::Policy to an inline role policy — the filter would return empty and
    // the case above would fail with a message blaming the grant. This says which
    // of the two broke.
    //
    // Written to NOT fail under the mutation it controls for: it asserts the role
    // has statements and does not mention GetSecretValue, so deleting the secret
    // grant leaves this green.
    const roleLogicalId = RoleRefSchema.parse(webhookFunction())
      .Properties.Role['Fn::GetAtt'][0];
    const statements = statementsFor(roleLogicalId);

    expect(statements.length, `no IAM policy resolves to role ${roleLogicalId}`)
      .toBeGreaterThan(0);
    // sqs:SendMessage is granted to the same role on the line above the secret one,
    // so its presence proves the lookup reaches the right policy document.
    expect(statements.flatMap(actionsOf)).toContain('sqs:SendMessage');
  });
});

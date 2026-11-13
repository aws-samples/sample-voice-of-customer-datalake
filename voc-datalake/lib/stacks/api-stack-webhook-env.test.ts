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

import { beforeAll, describe, it, expect, vi } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';
import { apiStackDependencyProps, pkSkTable, sharedSecretArn } from '../test-support/api-stack-fixture';
import { applyAppAspects } from '../utils/app-aspects';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

const WEBHOOK_PLUGIN_ID = 'webhook_fixture';

const ENV = { account: '111111111111', region: 'us-east-1' };
/** The SHARED API-credentials secret — the one `base_webhook.py` reads. Named here
 *  because the IAM case below has to tell it apart from the CDN signing secret
 *  (`cdnSigningSecretArn` in the fixture), which the same stack also grants reads of. */
const SHARED_SECRET_ARN = sharedSecretArn(ENV);

/** A manifest declaring a webhook, which nothing on disk does. Otherwise shaped
 *  exactly like a real one, so it travels the same `createWebhookLambda` path. */
const webhookPlugin = {
  id: WEBHOOK_PLUGIN_ID,
  name: 'Webhook Fixture',
  icon: 'Plugin',
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
  const deps = new cdk.Stack(app, 'TestDeps', { env: ENV });

  const table = (id: string) => pkSkTable(deps, id);

  const dependencies = apiStackDependencyProps(deps, ENV, table);
  const stack = new VocApiStack(app, 'TestApiStack', {
    env: ENV,
    ...dependencies,
    brandName: 'TestBrand',
    // The fixture plugin has to be ENABLED for a webhook Lambda to be created:
    // api-stack.ts filters `getEnabledPlugins` before `getPluginsWithWebhook`.
    enabledSources: [WEBHOOK_PLUGIN_ID],
  });
  applyAppAspects(app, { auditRowTables: dependencies }); // the rewrites bin/voc-datalake.ts applies

  return Template.fromStack(stack);
}

let cached: Template | undefined;
const template = () => (cached ??= synthWithWebhookPlugin());

// Synthesize once, under the synth timeout, rather than inside the first 5 s case.
beforeAll(() => {
  template();
}, SYNTH_TIMEOUT_MS);

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

/** A REST method's authorization and its integration's URI (an intrinsic; compared as rendered). */
const MethodSchema = z.object({
  Properties: z.object({ AuthorizationType: z.string(), Integration: z.object({ Uri: z.unknown() }) }),
});

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
      }).loose()),
    }),
  }),
});

/** One `Roles` entry of an inline policy, when it is a plain `Ref`. */
const RoleNameRefSchema = z.object({ Ref: z.string() });

function statementsFor(roleLogicalId: string): { Action?: string | string[]; Resource?: unknown; Condition?: unknown }[] {
  return Object.values(template().findResources('AWS::IAM::Policy'))
    .filter((p) => {
      const parsed = PolicySchema.safeParse(p);
      if (!parsed.success) return false;
      return parsed.data.Properties.Roles.some(
        (r) => RoleNameRefSchema.safeParse(r).data?.Ref === roleLogicalId,
      );
    })
    .flatMap((p) => PolicySchema.parse(p).Properties.PolicyDocument.Statement);
}

const actionsOf = (statement: { Action?: string | string[] }): string[] => {
  const action = statement.Action;
  if (typeof action === 'string') return [action];
  return action ?? [];
};

/** A statement's resources, normalized to an array. CloudFormation renders a
 *  single-resource grant as a bare string and a multi-resource one as an array, and
 *  the case below asks about the PERMISSION rather than the rendering — see the
 *  comment there for why containment, not equality. */
const resourcesOf = (statement: { Resource?: unknown }): unknown[] => (
  Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource]
);

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
    // #251 raises on an empty one. This function used to get only PLUGIN_ID.
    expect(webhookEnv().SOURCE_PLATFORM).toBe(WEBHOOK_PLUGIN_ID);
  });

  it('carries PLUGIN_VERSION for its raw archives (unversioned when the manifest has none)', () => {
    expect(webhookEnv().PLUGIN_VERSION).toBe('unversioned');
  });

  it('carries no variable its code never reads (PLUGIN_ID, FEEDBACK_TABLE)', () => {
    expect(Object.keys(webhookEnv()).filter((key) => ['PLUGIN_ID', 'FEEDBACK_TABLE'].includes(key))).toStrictEqual([]);
  });

  it('agrees with the variable base_webhook.py actually reads', () => {
    // The independent oracle, and the half that keeps this honest in the other
    // direction: the two assertions above would still pass if the Python side were
    // changed to read a third name. Read out of the Python source rather than
    // re-stated, which is this repo's convention for a contract two languages
    // share (see the MCP transport-header tests in api-stack-mcp.test.ts).
    const source = readFileSync(
      join(__dirname, '..', '..', 'plugins', '_shared', 'base_webhook.py'),
      'utf-8',
    );
    const name = /^SOURCE_PLATFORM = os\.environ\.get\("([A-Z_]+)"/m.exec(source)?.[1];

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
    //
    // CONTAINMENT, not equality, and deliberately so: equality on the rendered
    // `Resource` pins the CloudFormation output rather than the permission, so a
    // grant that is equally correct but rendered as a one-element array — an added
    // resource, or a move to `secret.grantRead()` — would report a MISSING grant
    // that is in fact present, which is the costliest failure direction here.
    // Containment keeps the CDN discrimination: a statement scoped only to
    // the CDN signing secret still does not match. Do not tighten this back.
    const roleLogicalId = RoleRefSchema.parse(webhookFunction())
      .Properties.Role['Fn::GetAtt'][0];

    const grants = statementsFor(roleLogicalId).filter(
      (s) => actionsOf(s).includes('secretsmanager:GetSecretValue')
        && resourcesOf(s).includes(SHARED_SECRET_ARN),
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

  it('names the raw-archive bucket, which _shared/raw_archive.py writes through the webhook', () => {
    expect(webhookEnv().RAW_DATA_BUCKET, 'webhook raw payloads would never reach the lake').toBeTruthy();
  });

  it("lets the webhook put raw objects only under its OWN source's prefix", () => {
    const roleLogicalId = RoleRefSchema.parse(webhookFunction())
      .Properties.Role['Fn::GetAtt'][0];
    const puts = statementsFor(roleLogicalId).filter((s) => actionsOf(s).some((a) => a.startsWith('s3:PutObject')));

    expect(puts.length, 'the webhook role cannot archive its raw payload').toBeGreaterThan(0);
    const rendered = JSON.stringify(puts.flatMap(resourcesOf));
    expect(rendered).toContain(`/raw/${WEBHOOK_PLUGIN_ID}/*`);
    // No bucket-wide or sibling-prefix put: every resource names this plugin's prefix.
    for (const resource of puts.flatMap(resourcesOf)) {
      expect(JSON.stringify(resource)).toContain(`/raw/${WEBHOOK_PLUGIN_ID}/*`);
    }
  });

  it('bundles lambda/shared, which base_webhook.py imports (`shared.aws`, `shared.logging`)', () => {
    // The asset is skipped in tests (`aws:cdk:bundling-stacks: []`), so the bundle
    // command is read from the stack source: it must stage from the project root
    // and copy all three trees, exactly as an ingestor bundle does.
    const source = readFileSync(join(__dirname, 'api-stack.ts'), 'utf-8');
    const body = source.slice(source.indexOf('private createWebhookLambda('));
    expect(body).toContain("cp -r /asset-input/lambda/shared /asset-output/");
    expect(body).toContain('cp -r /asset-input/plugins/_shared /asset-output/');
    expect(body).toContain("pythonLambdaAsset('.'");
  });
});

describe('webhook stage throttle', () => {
  it('gives the enabled webhook route an explicit rate/burst pair', () => {
    const stage = Object.values(template().findResources('AWS::ApiGateway::Stage'))[0];
    const settings = JSON.stringify(stage);
    expect(settings).toContain(
      `{"DataTraceEnabled":false,"HttpMethod":"POST","ResourcePath":"/~1webhooks~1${WEBHOOK_PLUGIN_ID}",`
      + '"ThrottlingBurstLimit":20,"ThrottlingRateLimit":10}',
    );
  });

  it("gives the workspaces' endpoint of that plugin its own rate/burst pair", () => {
    const settings = JSON.stringify(Object.values(template().findResources('AWS::ApiGateway::Stage'))[0]);
    expect(settings).toContain(
      `{"DataTraceEnabled":false,"HttpMethod":"POST","ResourcePath":"/~1webhooks~1${WEBHOOK_PLUGIN_ID}~1{ws}",`
      + '"ThrottlingBurstLimit":20,"ThrottlingRateLimit":10}',
    );
  });
});

// A workspace's own endpoint, /webhooks/{plugin}/{ws} (docs/multi-workspace.md, "Public and non-user entry points";
// plugins/_shared/base_webhook.py): public like the deployment's, the workspace read from voc-workspaces' META, the
// webhook secret from that workspace's own secret, the archive under its own prefix.
describe("a workspace's webhook endpoint", () => {
  const roleStatements = () => statementsFor(RoleRefSchema.parse(webhookFunction()).Properties.Role['Fn::GetAtt'][0]);

  it('wires POST /webhooks/{plugin}/{ws} to the same function, with no authorizer', () => {
    const postOn = (pathPart: string) => {
      const ids = Object.keys(template().findResources('AWS::ApiGateway::Resource', { Properties: { PathPart: pathPart } }));
      expect(ids).toHaveLength(1);
      const methods = Object.values(template().findResources('AWS::ApiGateway::Method', {
        Properties: { HttpMethod: 'POST', ResourceId: { Ref: ids[0] } },
      }));
      expect(methods).toHaveLength(1);
      return MethodSchema.parse(methods[0]).Properties;
    };
    const workspace = postOn('{ws}');
    const deployment = postOn(WEBHOOK_PLUGIN_ID);
    expect(workspace.AuthorizationType).toBe('NONE');
    // The same function behind both routes: one integration URI.
    expect(JSON.stringify(workspace.Integration.Uri)).toBe(JSON.stringify(deployment.Integration.Uri));
  });

  it('reads only the routing attributes of WS#* rows and the key of PLUGIN#* rows of voc-workspaces, and writes none', () => {
    // IAM, not only the code, keeps a MEMBER# row's email and name out of the webhook's reach; a read naming no
    // attributes is refused (Null), and of a PLUGIN# row (the workspace enabled the plugin, 7.14.00) only its pk.
    const onWorkspaces = roleStatements().filter((s) => JSON.stringify(s.Resource).includes('Workspaces'));
    const attributeRead = (partition: string, attributes: string[]) => ({ actions: ['dynamodb:GetItem'], condition: {
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [partition] },
      'ForAllValues:StringEquals': { 'dynamodb:Attributes': attributes },
      StringEqualsIfExists: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
      Null: { 'dynamodb:Attributes': 'false' },
    } })
    expect(onWorkspaces.map((s) => ({ actions: actionsOf(s), condition: s.Condition })))
      .toStrictEqual([attributeRead('WS#*', ['pk', 'sk', 'status']), attributeRead('PLUGIN#*', ['pk'])]);
  });

  it('grants exactly the attributes the routing read projects', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'lambda', 'shared', 'workspace_routing.py'), 'utf-8');
    const declared = /^META_ROUTING_ATTRIBUTES: Final = \(([^)]*)\)/m.exec(source)?.[1] ?? '';
    expect([...declared.matchAll(/'(\w+)'/g)].map((match) => match[1]))
      .toStrictEqual(['pk', 'sk', 'status']);
  });

  it("reads its webhook plugins' credentials parameters of one workspace id, and no other parameter or secret", () => {
    // Decision 19: `voc/ws/{one workspace id}/credentials/{plugin}` of the webhook plugins only, read only.
    const onParameters = roleStatements().filter((s) => actionsOf(s).some((a) => a.startsWith('ssm:')));
    const rendered = onParameters.flatMap(resourcesOf).map((resource) => JSON.stringify(resource));
    const own = `:parameter/voc/ws/ws_${'?'.repeat(26)}/credentials/${WEBHOOK_PLUGIN_ID}"`;
    expect({
      actions: onParameters.map(actionsOf),
      resources: rendered.map((resource) => resource.includes(own) && !resource.includes('*')),
      otherOnVocWs: roleStatements().filter((s) => JSON.stringify(s.Resource).includes('voc/ws'))
        .flatMap(actionsOf).filter((a) => !a.startsWith('ssm:') && !a.startsWith('s3:')),
      otherSecrets: roleStatements().flatMap(actionsOf)
        .filter((a) => a.startsWith('secretsmanager:') && a !== 'secretsmanager:GetSecretValue'),
    }).toStrictEqual({ actions: [['ssm:GetParameter']], resources: [true], otherOnVocWs: [], otherSecrets: [] });
  });

  it('decrypts with the deployment key through SSM for those parameters only', () => {
    const throughSsm = roleStatements()
      .filter((s) => JSON.stringify(s.Condition ?? {}).includes('kms:EncryptionContext:PARAMETER_ARN'));
    const condition = JSON.stringify(throughSsm[0]?.Condition);
    expect({
      actions: throughSsm.map(actionsOf),
      forTheNames: condition.includes(`/credentials/${WEBHOOK_PLUGIN_ID}`),
      throughSsm: condition.includes('"kms:ViaService":"ssm.'),
    }).toStrictEqual({ actions: [['kms:Decrypt']], forTheNames: true, throughSsm: true });
  });

  it("puts raw objects under one workspace's prefix of its own source only", () => {
    const workspaceGrants = roleStatements().filter((s) => actionsOf(s).some((a) => a.startsWith('s3:PutObject')))
      .flatMap(resourcesOf).map((resource) => JSON.stringify(resource)).filter((rendered) => rendered.includes('/ws/'));
    expect(workspaceGrants.length).toBeGreaterThan(0);
    // Every one: exactly one workspace id segment (IAM's `*` would also match `/`), then this plugin's raw prefix.
    for (const rendered of workspaceGrants) {
      expect(rendered).toContain(`/ws/ws_${'?'.repeat(26)}/raw/${WEBHOOK_PLUGIN_ID}/*`);
    }
  });

  it('is handed the workspaces table and the parameter prefix', () => {
    expect(webhookEnv()).toHaveProperty('WORKSPACE_PARAMETER_PREFIX', '/voc/ws');
    expect(webhookEnv()).not.toHaveProperty('WORKSPACE_SECRET_PREFIX');
    expect(Object.keys(webhookEnv())).toContain('WORKSPACES_TABLE');
  });
});

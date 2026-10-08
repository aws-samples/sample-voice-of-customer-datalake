/**
 * The integrations secret defaults, the MCP surface (the retired per-project
 * server's absence, throttling, transport headers), projects Cognito access,
 * role-policy size and the delegation/time budgets. Split out of api-stack.test.ts; shared template
 * readers live in lib/test-support/api-stack-template.ts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, beforeAll } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { ManifestSchema } from '../plugin-loader';
import { pythonIntConstant } from '../test-support/cross-language-invariants';
import {
  apiMethods, apiTemplate, discoverPluginIds, methodThrottles, policyStatementsOf, serviceEnvironment, readRepoFile, synthApiTemplate,
} from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';
import { itemAt } from '../test-support/guards';

// Synthesize the shared default template once, outside any single case's 5s
// budget: the first case to call apiTemplate() would otherwise pay for it.
beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

const GatewayResponseSchema = z.object({
  Properties: z.object({
    ResponseType: z.string(),
    ResponseParameters: z.record(z.string(), z.string()).optional(),
  }),
});

/** Every gateway response of the default template: its type and header parameters. */
function gatewayResponses(): z.infer<typeof GatewayResponseSchema>['Properties'][] {
  return Object.values(apiTemplate().findResources('AWS::ApiGateway::GatewayResponse'))
    .map((r) => GatewayResponseSchema.parse(r).Properties);
}

/** A gateway header value (`'a, b'`, single-quoted as API Gateway stores it) as a
 *  lowercase set. */
function headerSet(raw: string): Set<string> {
  return new Set(unquoted(raw).split(',').map((h) => h.trim().toLowerCase()));
}

/** `"<header> missing from the <type> response"` for each of `declared` (lowercase)
 *  absent from the `param` list of a response that publishes one. */
function headersMissingFrom(
  responses: ReturnType<typeof gatewayResponses>,
  param: string,
  declared: string[],
): string[] {
  return responses.flatMap((props) => {
    const raw = props.ResponseParameters?.[param];
    if (!raw) return [];
    const published = headerSet(raw);
    return declared.filter((h) => !published.has(h)).map((h) => `${h} missing from the ${props.ResponseType} response`);
  });
}

/** `raw` without one leading and one trailing single quote, each where present. */
function unquoted(raw: string): string {
  const start = raw.startsWith("'") ? 1 : 0;
  const end = raw.length > start && raw.endsWith("'") ? raw.length - 1 : raw.length;
  return raw.slice(start, end);
}

describe('the integrations Lambda is handed its plugin secret defaults', () => {
  // PLUGIN_SECRET_DEFAULTS is how the handler learns two things it cannot read
  // at runtime: which sources exist, and what value each key was SEEDED with.
  // The second one is load-bearing. Every key exists from the moment the stack
  // deploys and several defaults are non-empty, so without this the handler's
  // only available test is "does the key hold something", which reports a
  // source as connected before anybody configured it.
  //
  // If this variable goes missing the handler degrades quietly — it reports no
  // sources at all, and no Python test can see the cause, because the cause is
  // in the CDK. Hence the guard lives here.
  function integrationsEnv(template: Template = apiTemplate()): Record<string, unknown> {
    return serviceEnvironment(template, 'voc-integrations-api');
  }

  it('sets PLUGIN_SECRET_DEFAULTS to a plugin-keyed map of declared defaults', () => {
    const raw = integrationsEnv().PLUGIN_SECRET_DEFAULTS;
    expect(typeof raw).toBe('string');

    const parsed = z.record(z.string(), z.record(z.string(), z.string()))
      .parse(JSON.parse(z.string().parse(raw)));

    // Every real plugin on disk must be present. Read from the manifests rather
    // than listed here, so adding a plugin extends the guard for free.
    const pluginsDir = join(__dirname, '../../plugins');
    const onDisk = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .filter((e) => existsSync(join(pluginsDir, e.name, 'manifest.json')))
      .map((e) => e.name)
      .sort(byCodeUnit);

    expect(Object.keys(parsed).sort(byCodeUnit)).toStrictEqual(onDisk);

    // And the values must be the manifests' own declared defaults, since that is
    // the baseline the handler compares stored values against.
    for (const id of onDisk) {
      const manifest = ManifestSchema.parse(
        JSON.parse(readFileSync(join(pluginsDir, id, 'manifest.json'), 'utf-8')),
      );
      expect(parsed[id]).toStrictEqual(manifest.secrets ?? {});
    }
  });

  it('carries a non-empty default, so the comparison it enables is not vacuous', () => {
    // The whole point is distinguishing seeded from entered. If every seeded
    // default were the empty string, a plain truthiness check would have been
    // correct and this variable pointless — so assert the premise holds.
    const parsed = z.record(z.string(), z.record(z.string(), z.string()))
      .parse(JSON.parse(z.string().parse(integrationsEnv().PLUGIN_SECRET_DEFAULTS)));
    const nonEmpty = Object.values(parsed).flatMap((keys) => Object.values(keys)).filter(Boolean);
    expect(nonEmpty.length).toBeGreaterThan(0);
  });

  it('leaves the function env well under the 4 KB Lambda limit, worst case', () => {
    // Lambda caps the TOTAL environment at 4096 bytes across all variables, and
    // this one grows with every plugin added. Blowing the budget fails at deploy,
    // not at synth, so measure it here.
    //
    // Measured on the LARGEST env this stack can produce, not the default synth:
    // every plugin on disk enabled, AND a deploymentPrefix set, which is what adds
    // the two INGESTOR_/INGEST_SCHEDULE_ name patterns via prefixOnlyEnv() and
    // lengthens the values. The default no-prefix synth omits those entirely, so a
    // budget measured there would pass while a real prefixed deployment failed.
    for (const [label, variables] of [
      ['default', integrationsEnv()],
      ['all plugins + deploymentPrefix', integrationsEnv(
        synthApiTemplate({ deploymentPrefix: 'x' }, discoverPluginIds()),
      )],
    ] as const) {
      const total = Object.entries(variables)
        .reduce((sum, [k, v]) => sum + Buffer.byteLength(`${k}=${String(v)}`), 0);
      expect(total, `${label} env is ${total} bytes`).toBeLessThan(4096);
    }
  });
});


describe('the retired per-project MCP server is gone (3.00.00)', () => {
  // POST /mcp, /mcp/{proxy+}, voc-mcp-api (mcp_handler.py) and its MCPTOKEN-scoped
  // role were removed. What stays: the /mcp resource as the parent of
  // /mcp/global, and the bearer-token shape authorizer that guards it.
  const FunctionSchema = z.object({ Properties: z.looseObject({ Handler: z.string().optional() }) });

  it('synthesizes no per-project MCP function, role or log group', () => {
    const logicalIds = Object.keys(apiTemplate().toJSON().Resources ?? {});
    expect(logicalIds.filter((id) => /^McpApi[0-9A-F]{8}$|^McpLambdaRole|^McpApiLogs/.test(id))).toStrictEqual([]);
    const handlers = Object.values(apiTemplate().findResources('AWS::Lambda::Function'))
      .map((fn) => FunctionSchema.parse(fn).Properties.Handler);
    expect(handlers).not.toContain('mcp_handler.lambda_handler');
    expect(handlers, 'the global MCP handler must still be deployed').toContain('mcp_global_handler.lambda_handler');
  });

  it('wires no method on /mcp itself and nothing under it but /mcp/global', () => {
    const mcpPaths = apiMethods(apiTemplate())
      .filter((m) => m.path === '/mcp' || m.path.startsWith('/mcp/'))
      .filter((m) => m.httpMethod !== 'OPTIONS');
    expect(mcpPaths.map((m) => `${m.httpMethod} ${m.path}`)).toStrictEqual(['POST /mcp/global']);
    expect(apiMethods(apiTemplate()).filter((m) => m.path.startsWith('/mcp/{proxy+}'))).toStrictEqual([]);
  });

  it('grants no role access to the retired MCPTOKEN partition', () => {
    const policies = JSON.stringify(apiTemplate().findResources('AWS::IAM::Policy'));
    expect(policies).not.toContain('"MCPTOKEN"');
    expect(policies, 'the global token partition must still be granted').toContain('"MCPGTOKEN"');
  });

  it('keeps the bearer-token shape authorizer for /mcp/global', () => {
    expect(Object.keys(apiTemplate().findResources('AWS::ApiGateway::Authorizer', {
      Properties: { Name: 'voc-mcp-token-authorizer' },
    }))).toHaveLength(1);
  });
});

describe('projects Lambda Cognito access (per-project sharing)', () => {
  // The member picker and invite/ownership resolution look users up with
  // ListUsers. That is the ONLY Cognito call the projects function makes:
  // creating, disabling, regrouping or deleting users stays with UsersApi, so an
  // Admin* action here would turn every project "manage" route into a user-admin
  // surface. Asserted as an exact set for the same reason as the MCP grants.
  const serviceEnv = (serviceName: string) => serviceEnvironment(apiTemplate(), serviceName);
  const projectsStatements = () => policyStatementsOf(apiTemplate(), 'ProjectsLambdaRole');

  it('holds exactly cognito-idp:ListUsers, and nothing broader', () => {
    const cognitoActions = projectsStatements()
      .flatMap((s) => s.actions)
      .filter((a) => a.toLowerCase().startsWith('cognito-idp:'));
    expect(cognitoActions).toStrictEqual(['cognito-idp:ListUsers']);
    expect(cognitoActions.filter((a) => a.startsWith('cognito-idp:Admin'))).toStrictEqual([]);
  });

  it('scopes ListUsers to the stack user pool, not a wildcard', () => {
    const statements = projectsStatements().filter((s) => s.actions.includes('cognito-idp:ListUsers'));
    expect(statements.length).toBe(1);
    const { resource } = itemAt(statements, 0);
    expect(resource).toContain('UserPool');
    expect(resource).not.toContain('"*"');
  });

  it('is handed USER_POOL_ID for the same pool the users Lambda administers', () => {
    const projectsPoolId = serviceEnv('voc-projects-api').USER_POOL_ID;
    expect(projectsPoolId, 'USER_POOL_ID missing on the projects Lambda').toBeDefined();
    expect(projectsPoolId).toStrictEqual(serviceEnv('voc-users-api').USER_POOL_ID);
  });
});

describe('lambda role policies stay under the IAM size limit', () => {
  // The repo's whole domain-split Lambda architecture exists because of this
  // limit, yet nothing measured it. The failure mode is a deploy-time rejection
  // with no synth warning — exactly the class of fault this suite converts into
  // a test.
  //
  // ⚠️ THE NUMBERS, because the repo's docs round them to "20 KB" and that is
  // above the real ceiling, so a guard set there could never fire:
  //   • an INLINE policy on a role (what AWS::IAM::Policy creates, and what
  //     every grant* call in this stack produces) — 10,240 characters;
  //   • a MANAGED policy (AWS::IAM::ManagedPolicy) — 6,144 characters.
  // IAM does not count whitespace toward either, so the measurement below
  // strips it, which is also what makes the count comparable to the quota
  // rather than to `JSON.stringify`'s output.
  //   https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html
  //
  // All three shapes are measured — AWS::IAM::Policy, AWS::IAM::ManagedPolicy,
  // and inline `Policies` on AWS::IAM::Role — because measuring only the first
  // would let a role exceed its quota with this test green.
  //
  // Still an APPROXIMATION, stated so nobody reads it as exact: the template
  // carries `{"Fn::GetAtt": …}` and `{"Fn::ImportValue": …}` where the deployed
  // policy carries resolved ARNs, so per-statement counts differ in both
  // directions. It tracks the thing that actually grows — statement count — so
  // it works as a trend alarm even though it is not byte-for-byte the number IAM
  // checks. Largest policy today is ~2 KB against a 10,240 ceiling.
  const INLINE_LIMIT = 10_240;
  const MANAGED_LIMIT = 6_144;
  // Fire at 70% so there is room to land a feature and then split a domain,
  // rather than discovering the ceiling in the middle of a deploy.
  const WARN_FRACTION = 0.7;

  const DocumentSchema = z.object({ Properties: z.object({ PolicyDocument: z.unknown() }) });
  const RoleSchema = z.object({
    Properties: z.object({
      Policies: z.array(z.object({ PolicyName: z.unknown(), PolicyDocument: z.unknown() })).optional(),
    }),
  });

  // `JSON.stringify` emits no structural whitespace, so a `replace(/\s/g,'')`
  // here could only ever strip whitespace INSIDE string values — Sids, condition
  // values, ARNs with spaces — which IAM does count. Measuring the serialized
  // length directly is both simpler and closer to the quota.
  const size = (document: unknown) => JSON.stringify(document).length;

  function policies(): { id: string; kind: string; chars: number; limit: number }[] {
    const template = apiTemplate();
    const measured: { id: string; kind: string; chars: number; limit: number }[] = [];

    for (const [id, resource] of Object.entries(template.findResources('AWS::IAM::Policy'))) {
      measured.push({
        id, kind: 'inline', limit: INLINE_LIMIT,
        chars: size(DocumentSchema.parse(resource).Properties.PolicyDocument),
      });
    }
    for (const [id, resource] of Object.entries(template.findResources('AWS::IAM::ManagedPolicy'))) {
      measured.push({
        id, kind: 'managed', limit: MANAGED_LIMIT,
        chars: size(DocumentSchema.parse(resource).Properties.PolicyDocument),
      });
    }
    // Inline policies declared ON the role rather than as a separate resource.
    // None today, which is exactly why they need measuring: the first one added
    // would otherwise arrive unmeasured.
    for (const [id, resource] of Object.entries(template.findResources('AWS::IAM::Role'))) {
      for (const policy of RoleSchema.parse(resource).Properties.Policies ?? []) {
        measured.push({
          id: `${id}/${JSON.stringify(policy.PolicyName)}`, kind: 'inline-on-role',
          limit: INLINE_LIMIT, chars: size(policy.PolicyDocument),
        });
      }
    }
    return measured;
  }

  // Measured once: each call walks the whole synthesized template.
  let measured: ReturnType<typeof policies>;
  beforeAll(() => { measured = policies(); });

  it('measures every policy shape the stack can produce', () => {
    // Vacuity guard, and it names the shapes so a future one is a deliberate add.
    expect(measured.length).toBeGreaterThan(0);
    expect(new Set(measured.map((p) => p.kind)).has('inline'),
      'no AWS::IAM::Policy measured — has the filter drifted?').toBe(true);
  });

  it('keeps every policy under its IAM quota', () => {
    expect(measured.filter((p) => p.chars >= p.limit),
      'policies at or over their IAM character quota').toStrictEqual([]);
  });

  it('keeps every policy under 70% of its quota', () => {
    // If this fails, the answer is a new domain Lambda, not a bigger threshold.
    // Raising the fraction here is how the ceiling gets hit for real.
    expect(measured.filter((p) => p.chars >= p.limit * WARN_FRACTION),
      'policies past 70% of their IAM quota — split the domain instead').toStrictEqual([]);
  });
});

describe('the delegation timeout budget', () => {
  // The adapter gives up on a domain call before its OWN Lambda timeout, so a
  // slow route produces a -32603 rather than a Lambda timeout with no JSON-RPC
  // envelope at all. That ordering is the invariant worth pinning, and nothing
  // else notices if it inverts.
  const readTimeout = () => {
    const source = readRepoFile('lambda', 'shared', 'mcp_delegate.py');
    const seconds = /_DELEGATE_READ_TIMEOUT_SECONDS:\s*Final\s*=\s*(\d+)/.exec(source)?.[1];
    expect(seconds, 'could not read _DELEGATE_READ_TIMEOUT_SECONDS').toBeDefined();
    return Number(seconds);
  };

  const FunctionSchema = z.object({
    Properties: z.object({ Handler: z.string().optional(), Timeout: z.number().optional() }),
  });
  const functionByHandler = (handler: string) =>
    Object.values(apiTemplate().findResources('AWS::Lambda::Function'))
      .map((fn) => FunctionSchema.parse(fn).Properties)
      .find((p) => p.Handler === handler);

  it('gives the adapter time to answer after it stops waiting', () => {
    const adapter = functionByHandler('mcp_global_handler.lambda_handler');
    expect(adapter, 'no Lambda with the mcp_global_handler entry point').toBeDefined();
    expect(readTimeout()).toBeLessThan(adapter?.Timeout ?? 0);
  });

  it('does not require the callees to finish sooner than the adapter waits', () => {
    // Deliberately NOT asserted the other way round, which a review suggested.
    // The metrics and projects functions serve the browser too, where 30 s is the
    // right budget, and API Gateway caps the OUTER request at 29 s regardless —
    // so a delegated call that ran longer than the adapter's patience was never
    // going to be delivered. The callee may still be running when the adapter
    // gives up; that is inherent to a timeout, and it is why retries are off.
    // This test records the relationship so the asymmetry reads as chosen.
    for (const handler of ['metrics_handler.lambda_handler', 'projects_handler.lambda_handler']) {
      const fn = functionByHandler(handler);
      expect(fn, `${handler} is not in the template`).toBeDefined();
      expect(fn?.Timeout, `${handler} timeout`).toBeGreaterThanOrEqual(readTimeout());
    }
  });
});

describe('the per-day walk time budget fits the metrics timeout', () => {
  // Per-day `gsi1-by-date` walks (`/feedback/search` and the item-scan routes)
  // issue ONE DynamoDB query per day partition, because the index is partitioned
  // BY DAY (`gsi1pk = DATE#YYYY-MM-DD`). With windows up to 9999 days and
  // `days=0` meaning all time, the DAY COUNT can no longer bound a request, so the
  // walk is bounded by WALL-CLOCK TIME instead (lambda/shared/time_budget.py):
  // it stops at `WALK_TIME_BUDGET_SECONDS` and answers `is_partial: true,
  // partial_reason: 'time_budget', scanned_through: 'YYYY-MM-DD'`.
  //
  // That budget is coupled to two ceilings, pinned here so config drift fails at
  // synth rather than as 502s on an all-time search:
  //   • the metrics Lambda's own timeout — the walk plus the work after it
  //     (filtering, serialisation, the one query straddling the deadline) must
  //     finish before the function is killed;
  //   • API Gateway's 29 s REST integration cap, which no Lambda timeout can
  //     rescue a request from.
  //
  // 🔑 The Lambda timeout is deliberately NOT asserted against the API Gateway
  // ceiling: `MetricsApi` serves the browser across every `/metrics/*` and
  // `/feedback/*` route, where 30 s is the right budget (see the delegation suite
  // above for the same asymmetry). The BUDGET is what must sit under both.
  const TIME_BUDGET_FILE = ['lambda', 'shared', 'time_budget.py'] as const;
  const timeBudgetFileExists = existsSync(join(__dirname, '..', '..', ...TIME_BUDGET_FILE));
  // Post-walk work + one in-flight query. Below this, a walk that uses its whole
  // budget could still be cut off by the gateway or the Lambda.
  const MIN_MARGIN_SECONDS = 5;
  // API Gateway hard-caps a REST integration at 29 s — the AWS quota, stated
  // here independently of the Python mirror so the two are checked against
  // each other rather than one trusted.
  const API_GATEWAY_INTEGRATION_CEILING_SECONDS = 29;

  /** States, rather than silently skips, that the budget case could not run. */
  const warnWhenTimeBudgetAbsent = (): void => {
    if (timeBudgetFileExists) return;
    console.warn(
      `SKIPPED: ${TIME_BUDGET_FILE.join('/')} is absent, so the walk time budget is not `
      + 'pinned against the metrics Lambda timeout. It defines WALK_TIME_BUDGET_SECONDS.',
    );
  };

  const metricsTimeout = () => {
    const fn = Object.values(apiTemplate().findResources('AWS::Lambda::Function'))
      .map((f) => z.object({
        Properties: z.object({ Handler: z.string().optional(), Timeout: z.number().optional() }),
      }).parse(f).Properties)
      .find((p) => p.Handler === 'metrics_handler.lambda_handler');
    expect(fn, 'no Lambda with the metrics_handler entry point').toBeDefined();
    return fn?.Timeout ?? 0;
  };

  it.skipIf(!timeBudgetFileExists)(
    'leaves the metrics function and the gateway a margin past the walk budget',
    () => {
      const budget = pythonIntConstant('WALK_TIME_BUDGET_SECONDS', ...TIME_BUDGET_FILE);
      const gatewayMirror = pythonIntConstant('API_GATEWAY_INTEGRATION_TIMEOUT_SECONDS', ...TIME_BUDGET_FILE);

      expect(budget, 'a zero budget would make every walk partial').toBeGreaterThan(0);
      expect(gatewayMirror, 'time_budget.py restates the API Gateway cap wrongly')
        .toBe(API_GATEWAY_INTEGRATION_CEILING_SECONDS);
      expect(budget + MIN_MARGIN_SECONDS, `a ${budget}s walk leaves under ${MIN_MARGIN_SECONDS}s before API Gateway stops waiting`)
        .toBeLessThanOrEqual(API_GATEWAY_INTEGRATION_CEILING_SECONDS);
      expect(budget + MIN_MARGIN_SECONDS, `a ${budget}s walk leaves under ${MIN_MARGIN_SECONDS}s before the metrics Lambda times out`)
        .toBeLessThanOrEqual(metricsTimeout());
    },
  );

  it('says why the budget check did not run, rather than passing silently', () => {
    // Integration guard for the parallel change set: until
    // lambda/shared/time_budget.py lands, the case above is skipped. Once it
    // exists this is a no-op; if it is ever deleted again, this states it.
    warnWhenTimeBudgetAbsent();
    expect(metricsTimeout()).toBeGreaterThan(0);
  });
});

describe('mcp endpoint throttling', () => {
  // The former McpUsagePlan never bound: a usage plan's throttle applies per
  // API KEY and no MCP client sends one (SEC-10's fourth sub-claim, open since
  // #260). The working mechanism is stage method settings, keyed by path —
  // and a mistyped key throttles nothing silently, hence the lockstep test.
  it('carries no throttle key for the retired per-project routes', () => {
    const retired = ['/mcp/POST', '/mcp/{proxy+}/POST', '/mcp/{proxy+}/GET'];
    expect(methodThrottles(apiTemplate(), retired)).toStrictEqual(
      Object.fromEntries(retired.map((key) => [key, undefined])),
    );
    expect(methodThrottles(apiTemplate(), ['/mcp/global/POST'])).toStrictEqual({
      '/mcp/global/POST': { rate: 20, burst: 40 },
    });
  });
  it('has no usage plan anywhere in the stack', () => {
    // A usage plan that "throttles" a keyless endpoint is worse than absent:
    // it reads as protection and provides none. If one ever returns, it has to
    // be argued past this test.
    expect(Object.keys(apiTemplate().findResources('AWS::ApiGateway::UsagePlan'))).toStrictEqual([]);
  });
});


describe('mcp transport headers reach a browser', () => {
  // `mcp_global_handler.py` allows three transport headers (and validates
  // `MCP-Protocol-Version`), and a browser's preflight on this API is answered by
  // API Gateway's generated OPTIONS mock —
  // not by the handler. So the handler allowing them in its own CORS response is
  // not enough: omitted from the gateway's list, a browser-based client that sends
  // `MCP-Protocol-Version` is blocked by its own preflight before the Lambda ever
  // sees the request, and the server ends up enforcing a rule against a header no
  // browser can deliver.
  //
  // Read out of the PYTHON source rather than re-listed here, which is this repo's
  // convention for a contract two languages have to agree on: a header added to the
  // handler and not to the gateway fails here instead of at a browser.
  const pythonTransportHeaders = (): string[] => {
    const source = readRepoFile('lambda', 'api', 'mcp_global_handler.py');
    const declaration = source.split('\n').map((line) => line.trim())
      .find((line) => line.startsWith("'Access-Control-Allow-Headers':"));
    const value = /^'Access-Control-Allow-Headers':\s*'([^']+)',/.exec(declaration ?? '')?.[1];
    expect(value, 'could not read Access-Control-Allow-Headers from mcp_global_handler.py').toBeDefined();
    // The MCP transport headers only: Content-Type / Authorization are the API's own.
    return (value ?? '').split(',').map((h) => h.trim()).filter((h) => /^mcp-/i.test(h));
  };

  /** The allow-list the generated OPTIONS mock actually publishes. */
  const preflightAllowHeaders = (): string[] => {
    const methods = Object.values(apiTemplate().findResources('AWS::ApiGateway::Method'));
    const MethodSchema = z.object({
      Properties: z.object({
        HttpMethod: z.string(),
        Integration: z.object({
          IntegrationResponses: z.array(z.object({
            ResponseParameters: z.record(z.string(), z.string()).optional(),
          })).optional(),
        }).optional(),
      }),
    });
    for (const method of methods) {
      const props = MethodSchema.parse(method).Properties;
      if (props.HttpMethod !== 'OPTIONS') continue;
      for (const response of props.Integration?.IntegrationResponses ?? []) {
        const raw = response.ResponseParameters?.[
          'method.response.header.Access-Control-Allow-Headers'
        ];
        if (raw) return unquoted(raw).split(',');
      }
    }
    throw new Error('no generated OPTIONS method published an Allow-Headers list');
  };

  it('allows every header the handler validates through the preflight', () => {
    const allowed = new Set(preflightAllowHeaders().map((h) => h.trim().toLowerCase()));
    const declared = pythonTransportHeaders();

    // Positive control: a regex that silently matched nothing would make the
    // subset assertion below vacuously true.
    expect(declared.length).toBeGreaterThanOrEqual(3);
    for (const header of declared) {
      // Case-insensitively, because CORS header matching is — the handler reads
      // the lowercase form API Gateway delivers, the gateway publishes the wire
      // spelling, and both must name the same header.
      expect(allowed, `${header} is validated by the handler but blocked by the preflight`)
        .toContain(header.toLowerCase());
    }
  });

  it('allows them on the gateway error responses too', () => {
    // A 4XX/5XX from the gateway itself carries its own CORS headers, and a
    // browser that cannot read the error sees a network failure instead of the
    // 401 or 400 the server actually sent.
    const declared = pythonTransportHeaders().map((h) => h.toLowerCase());
    const parsed = gatewayResponses();
    expect(parsed.length, 'no gateway responses in the template').toBeGreaterThan(0);

    // Responses without an allow list are not this case's subject; every one
    // that has one must carry every declared header.
    expect(headersMissingFrom(parsed, 'gatewayresponse.header.Access-Control-Allow-Headers', declared))
      .toStrictEqual([]);
  });

  // `mcp_global_handler.py` sends `Vary: Authorization` on every response, because its
  // answers depend on the credential and the caches in front of this endpoint read
  // headers rather than the JSON-RPC body's `cacheScope`. `Vary` is not
  // CORS-safelisted, so a browser receives it and hides it from the page unless the
  // endpoint says otherwise — the same failure `WWW-Authenticate` already documents.
  //
  // Read out of the Python source for the same reason as the allow-list above: the
  // handler's own responses carry ITS expose list and gateway-GENERATED ones (the
  // authorizer's 401) carry the template's, so a header exposed by one and not the
  // other is readable on some of this endpoint's answers and not others.
  //
  // ⚠️ This parse reads a single-quoted STRING LITERAL, so it breaks (loudly) if the
  // value is ever rewritten as an expression.
  const pythonExposeHeaders = (): string[] => {
    const source = readRepoFile('lambda', 'api', 'mcp_global_handler.py');
    // Line-wise, so the pattern needs no leading-whitespace run under the `m` flag.
    const declaration = source.split('\n').map((line) => line.trim())
      .find((line) => line.startsWith("'Access-Control-Expose-Headers':"));
    const value = /^'Access-Control-Expose-Headers':\s*'([^']+)',/.exec(declaration ?? '')?.[1];
    expect(value, "could not read Access-Control-Expose-Headers from mcp_global_handler.py")
      .toBeDefined();
    return (value ?? '').split(',').map((h) => h.trim());
  };

  it('exposes every response header the handler expects a browser to read', () => {
    const declared = pythonExposeHeaders();
    // Positive control: a regex that matched nothing would make the loop vacuous.
    // Both of the non-safelisted headers the handler adds are named, so a parse that
    // recovered only part of the list fails here rather than checking less.
    expect(declared.map((h) => h.toLowerCase())).toContain('vary');
    expect(declared.map((h) => h.toLowerCase())).toContain('allow');

    const parsed = gatewayResponses();
    const expose = 'gatewayresponse.header.Access-Control-Expose-Headers';
    expect(parsed.filter((props) => props.ResponseParameters?.[expose]).length,
      'no gateway response publishes an expose list').toBeGreaterThan(0);
    expect(headersMissingFrom(parsed, expose, declared.map((h) => h.toLowerCase())))
      .toStrictEqual([]);
  });

  it('tells a cache the authorizer 401 varies by credential', () => {
    // The 401 is the most credential-dependent answer this API gives, and the
    // authorizer produces it — so the `Vary` the handler sends never reaches it.
    // Without this, an intermediary could cache that refusal against the endpoint
    // alone and serve it to a request carrying a perfectly good credential.
    const unauthorized = gatewayResponses()
      .filter((props) => props.ResponseType === 'UNAUTHORIZED');

    expect(unauthorized.length, 'no UNAUTHORIZED gateway response in the template')
      .toBe(1);
    const vary = itemAt(unauthorized, 0).ResponseParameters?.['gatewayresponse.header.Vary'];
    expect(vary, 'the UNAUTHORIZED response sends no Vary').toBeDefined();
    expect((vary ?? '').toLowerCase()).toContain('authorization');
  });
});

describe('unauthorized gateway response', () => {
  // The ONLY place a REST API can emit a true WWW-Authenticate on a 401:
  // Lambda-proxy responses have the header unconditionally remapped to
  // x-amzn-remapped-www-authenticate (verified live). Removing this response
  // or either header would be silent — the handler-side header keeps flowing,
  // remapped — so the delivery path for the RFC 6750 challenge is pinned here.
  it('carries the Bearer challenge and exposes it to browsers', () => {
    const unauthorized = gatewayResponses()
      .find((p) => p.ResponseType === 'UNAUTHORIZED');
    expect(unauthorized, 'no UNAUTHORIZED gateway response in the template').toBeDefined();
    const params = unauthorized?.ResponseParameters ?? {};
    expect(params['gatewayresponse.header.WWW-Authenticate']).toBe('\'Bearer error="invalid_token"\'');
    // The challenge must be READABLE, which is the property this line is about —
    // asserted as membership rather than as the whole list, because the list also
    // carries `Content-Type` and `Vary` and pinning it exactly made this test fail
    // when an unrelated header was exposed. 'mcp transport headers reach a browser'
    // owns the completeness of the list; this owns the challenge being in it.
    const exposed = headerSet(params['gatewayresponse.header.Access-Control-Expose-Headers'] ?? '');
    expect([...exposed]).toContain('www-authenticate');
  });
});

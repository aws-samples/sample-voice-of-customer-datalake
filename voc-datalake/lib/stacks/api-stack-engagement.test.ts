/**
 * VocApiStack's engagement API (5.33.00): the `voc-engagement-api` Lambda, its IAM, its routes and
 * their two authorizers, the public unsubscribe route's throttle, the feedback-form Lambda's
 * participant attribution grant, and the runtime config.json flags — with and without
 * `-c emailFrom` (which, since 5.45.00, only decides how the always-present board pool emails).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import {
  apiMethods, apiTemplate, buildApiStack, methodThrottles, nonOptions, policyStatementsOf, serviceEnvironment,
} from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

const EMAIL_FROM = 'noreply@voc.example.com';

let cachedEmailStack: ReturnType<typeof buildApiStack> | undefined;
let cachedEmail: Template | undefined;
const emailStack = () => (cachedEmailStack ??= buildApiStack({ emailFrom: EMAIL_FROM }));
const withEmail = () => (cachedEmail ??= Template.fromStack(emailStack()));

// Synthesize both shapes once, up front, under the synth timeout (not inside a 5 s case).
beforeAll(() => {
  apiTemplate();
  withEmail();
}, SYNTH_TIMEOUT_MS * 2);

const SERVICE = 'voc-engagement-api';

/** How a fixture table's ARN reaches this stack: a cross-stack export named after its construct id. */
const exportOf = (tableId: string) => `ExportsOutputFnGetAtt${tableId}`;

const FunctionSchema = z.object({
  Properties: z.object({
    Handler: z.string(), Runtime: z.string(), Architectures: z.array(z.string()),
    MemorySize: z.number(), Timeout: z.number(), FunctionName: z.unknown(),
  }),
});

function engagementFunction(template: Template) {
  const fns = Object.entries(template.findResources('AWS::Lambda::Function'))
    .filter(([id]) => /^EngagementApi[0-9A-F]{8}$/.test(id));
  expect(fns).toHaveLength(1);
  const [id, resource] = fns[0] ?? ['', {}];
  return { id, ...FunctionSchema.parse(resource).Properties };
}

/** Logical id of the one resource of `type` whose id starts with `prefix`. */
function idStartingWith(template: Template, type: string, prefix: string): string {
  const ids = Object.keys(template.findResources(type)).filter((id) => id.startsWith(prefix));
  expect(ids, `${type} ${prefix}`).toHaveLength(1);
  return ids[0] ?? '';
}

describe('voc-engagement-api Lambda', () => {
  it('runs engagement_handler (Python 3.14, ARM64, 512 MB, 60 s)', () => {
    const fn = engagementFunction(apiTemplate());
    expect([fn.Handler, fn.Runtime, fn.Architectures, fn.MemorySize, fn.Timeout])
      .toStrictEqual(['engagement_handler.lambda_handler', 'python3.14', ['arm64'], 512, 60]);
  });

  it('carries exactly the contract environment', () => {
    expect(Object.keys(serviceEnvironment(apiTemplate(), SERVICE)).sort(byCodeUnit)).toStrictEqual([
      'AGGREGATES_TABLE', 'ALLOWED_ORIGIN', 'APP_CLIENT_IDS', 'APP_USER_POOL_ID', 'BOARD_USER_POOL_ID', 'EMAIL_FROM',
      'ENGAGEMENT_FUNCTION', 'FEATURE_REQUESTS_TABLE', 'FRONTEND_URL', 'LOG_LEVEL', 'PARTICIPANTS_TABLE',
      'POWERTOOLS_SERVICE_NAME', 'PROJECTS_TABLE',
    ]);
  });

  it('has email off but still names the board pool without -c emailFrom (the pool is always deployed)', () => {
    const env = serviceEnvironment(apiTemplate(), SERVICE);
    expect([env.EMAIL_FROM, env.FRONTEND_URL]).toStrictEqual(['', 'https://app.example.invalid']);
    expect(JSON.stringify(env.BOARD_USER_POOL_ID)).toContain('BoardUserPool');
  });

  it('names its sender and the board pool with -c emailFrom', () => {
    const env = serviceEnvironment(withEmail(), SERVICE);
    expect(env.EMAIL_FROM).toBe(EMAIL_FROM);
    expect(JSON.stringify(env.BOARD_USER_POOL_ID)).toContain('BoardUserPool');
  });

  it('names itself for the send continuation, and never retries an async invoke', () => {
    const template = apiTemplate();
    const fn = engagementFunction(template);
    expect(serviceEnvironment(template, SERVICE).ENGAGEMENT_FUNCTION).toStrictEqual(fn.FunctionName);
    const configs = Object.values(template.findResources('AWS::Lambda::EventInvokeConfig'))
      .map((c) => z.object({ Properties: z.object({ FunctionName: z.object({ Ref: z.string() }), MaximumRetryAttempts: z.number().optional() }) }).parse(c).Properties)
      .filter((c) => c.FunctionName.Ref === fn.id);
    expect(configs.map((c) => c.MaximumRetryAttempts)).toStrictEqual([0]);
  });
});

describe('voc-engagement-api IAM', () => {
  const statements = (template: Template) => policyStatementsOf(template, 'EngagementLambdaRole');
  const onTable = (template: Template, tableId: string) => statements(template)
    .filter((s) => s.resource.includes(exportOf(tableId))).flatMap((s) => s.actions).sort(byCodeUnit);

  it('reads and writes its own two tables (index included)', () => {
    for (const table of ['Participants', 'FeatureRequests']) {
      expect(onTable(apiTemplate(), table), table).toStrictEqual([
        'dynamodb:BatchGetItem', 'dynamodb:BatchWriteItem', 'dynamodb:ConditionCheckItem', 'dynamodb:DeleteItem',
        'dynamodb:DescribeTable', 'dynamodb:GetItem', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator',
        'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:UpdateItem',
      ]);
    }
  });

  it('only reads projects, and only GetItems the aggregates table itself', () => {
    expect(onTable(apiTemplate(), 'Projects')).not.toContain('dynamodb:PutItem');
    const aggregates = statements(apiTemplate()).filter((s) => s.resource.includes(exportOf('Aggregates')));
    expect(aggregates.map((s) => [s.actions, s.resource.includes('/index/')])).toStrictEqual([[['dynamodb:GetItem'], false]]);
  });

  it('invokes exactly itself, by name', () => {
    const invoke = statements(apiTemplate()).filter((s) => s.actions.includes('lambda:InvokeFunction'));
    expect(invoke).toHaveLength(1);
    expect(invoke[0]?.resource).toMatch(/function:voc-engagement-api-/);
  });

  it('cannot send email without -c emailFrom', () => {
    expect(statements(apiTemplate()).flatMap((s) => s.actions).filter((a) => a.startsWith('ses:'))).toStrictEqual([]);
  });

  it('sends only from the configured address, on its SES identities, with -c emailFrom', () => {
    const ses = statements(withEmail()).filter((s) => s.actions.some((a) => a.startsWith('ses:')));
    expect(ses.map((s) => s.actions)).toStrictEqual([['ses:SendEmail']]);
    const identities = z.array(z.unknown()).parse(JSON.parse(ses[0]?.resource ?? '[]')).map((arn) => JSON.stringify(arn));
    expect(identities).toHaveLength(2);
    expect(identities.map((arn) => /:ses:us-east-1:111111111111:identity\/([^"]+)"/.exec(arn)?.[1]))
      .toStrictEqual(['voc.example.com', EMAIL_FROM]);
    expect(ses[0]?.condition).toStrictEqual({ StringEquals: { 'ses:FromAddress': EMAIL_FROM } });
  });
});

describe('engagement routes', () => {
  const AuthorizerSchema = z.object({ AuthorizerId: z.object({ Ref: z.string() }).optional() });
  /** route -> authorizer logical id ('' = none). apiMethods() walks the same findResources() map in
   *  the same (insertion) order, so index i is the same method in both lists. */
  const authorizers = (template: Template): Map<string, string> => {
    const routes = apiMethods(template);
    const raw = Object.values(template.findResources('AWS::ApiGateway::Method'))
      .map((m) => AuthorizerSchema.parse(z.object({ Properties: z.unknown() }).parse(m).Properties).AuthorizerId?.Ref ?? '');
    return new Map(routes.map((route, i) => [route.route, raw[i] ?? '']));
  };
  const appAuthorizer = (t: Template) => idStartingWith(t, 'AWS::ApiGateway::Authorizer', 'VocCognitoAuthorizer');

  const BOARD_ROUTES = ['ANY /feature-requests/{proxy+}', 'GET /feature-requests', 'POST /feature-requests'];

  it('serves /participants through a Cognito proxy only (nothing on the bare collection)', () => {
    const routes = nonOptions(apiTemplate()).map((m) => m.route).filter((r) => r.includes('/participants'));
    expect(routes).toStrictEqual(['ANY /participants/{proxy+}']);
    expect(authorizers(apiTemplate()).get('ANY /participants/{proxy+}')).toBe(appAuthorizer(apiTemplate()));
  });

  it('serves the board routes and the public unsubscribe from voc-engagement-api', () => {
    const fn = engagementFunction(apiTemplate()).id;
    const served = nonOptions(apiTemplate()).filter((m) => m.integrationFunctionId === fn).map((m) => m.route).sort(byCodeUnit);
    expect(served).toStrictEqual(['ANY /participants/{proxy+}', ...BOARD_ROUTES, 'POST /unsubscribe'].sort(byCodeUnit));
  });

  /** The board-authorizer routes: the board (engagement Lambda) and the review links (projects Lambda). */
  const BOARD_AUTHORIZER_ROUTES = [...BOARD_ROUTES, 'ANY /review/{proxy+}'].sort(byCodeUnit);

  it.each([
    ['without -c emailFrom (the default)', apiTemplate],
    ['with -c emailFrom', withEmail],
  ])('%s, puts the board and review routes on the two-pool board authorizer, every other route on the app one', (_shape, template) => {
    const t = template();
    const board = idStartingWith(t, 'AWS::ApiGateway::Authorizer', 'VocBoardAuthorizer');
    const app = appAuthorizer(t);
    const byRoute = authorizers(t);
    const isOptions = (route: string) => route.startsWith('OPTIONS ');
    const boardRoutes = [...byRoute].filter(([, id]) => id === board).map(([route]) => route).sort(byCodeUnit);
    const others = [...byRoute].filter(([route, id]) => !isOptions(route) && id !== '' && id !== board && id !== app);
    expect(boardRoutes).toStrictEqual(BOARD_AUTHORIZER_ROUTES);
    // /mcp/global's own token authorizer is the one other authorizer (CUSTOM_AUTHORIZER_ROUTE_PREFIXES).
    expect(others.filter(([route]) => !route.includes('/mcp')).map(([route]) => route)).toStrictEqual([]);
    const ProvidersSchema = z.object({ Properties: z.object({ ProviderARNs: z.array(z.unknown()) }) });
    const providers = ProvidersSchema.parse(t.findResources('AWS::ApiGateway::Authorizer')[board]).Properties.ProviderARNs;
    expect(JSON.stringify(providers)).toMatch(/GetAttUserPool[0-9A-F]{8}Arn.*GetAttBoardUserPool[0-9A-F]{8}Arn/);
  });

  it('serves the review routes from the projects Lambda, never the engagement one', () => {
    const review = nonOptions(apiTemplate()).filter((m) => m.route.includes('/review'));
    expect(review.map((m) => m.route)).toStrictEqual(['ANY /review/{proxy+}']);
    expect(review[0]?.integrationFunctionId).toMatch(/^ProjectsApi/);
  });

  it('throttles every review-link method at 10 rps / 20', () => {
    // Per HTTP method: API Gateway refuses a `*` method key for one path (the 5.45.00 deploy failed on it).
    const keys = ['/review/{proxy+}/GET', '/review/{proxy+}/POST']
    expect(methodThrottles(apiTemplate(), keys)).toStrictEqual(Object.fromEntries(keys.map((key) => [key, { rate: 10, burst: 20 }])));
  });

  it('throttles the public unsubscribe at 5 rps / 10', () => {
    expect(methodThrottles(apiTemplate(), ['/unsubscribe/POST'])).toStrictEqual({ '/unsubscribe/POST': { rate: 5, burst: 10 } });
  });
});

describe('feedback-form Lambda participant attribution', () => {
  it('knows the participants table', () => {
    expect(JSON.stringify(serviceEnvironment(apiTemplate(), 'voc-feedback-form-api').PARTICIPANTS_TABLE)).toContain('Participants');
  });

  it('may only GetItem / UpdateItem the participants table itself', () => {
    const onParticipants = policyStatementsOf(apiTemplate(), 'FeedbackFormLambdaRole')
      .filter((s) => s.resource.includes(exportOf('Participants')));
    expect(onParticipants.map((s) => [s.actions, s.resource.includes('/index/')]))
      .toStrictEqual([[['dynamodb:GetItem', 'dynamodb:UpdateItem'], false]]);
  });
});

describe('runtime config.json', () => {
  const BoardSchema = z.object({ userPoolId: z.unknown(), clientId: z.unknown(), signIn: z.string() });
  const ConfigSchema = z.object({ features: z.record(z.string(), z.unknown()), board: BoardSchema });

  it('has features.email false and the board pool with the code sign-in without -c emailFrom', () => {
    const config = buildApiStack();
    const resolved = ConfigSchema.parse(config.resolve(config.runtimeConfig));
    expect([resolved.features.email, resolved.board.signIn]).toStrictEqual([false, 'code']);
    expect(JSON.stringify(resolved.board)).toMatch(/BoardUserPool.*BoardUserPoolBoardClient/);
  });

  it('has features.email true and the board pool with the EMAIL_OTP sign-in with -c emailFrom', () => {
    const stack = emailStack();
    const resolved = ConfigSchema.parse(stack.resolve(stack.runtimeConfig));
    expect([resolved.features.email, resolved.board.signIn]).toStrictEqual([true, 'email_otp']);
    expect(JSON.stringify(resolved.board)).toMatch(/BoardUserPool.*BoardUserPoolBoardClient/);
  });
}, SYNTH_TIMEOUT_MS);

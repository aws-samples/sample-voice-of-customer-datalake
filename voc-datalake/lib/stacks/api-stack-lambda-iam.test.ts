/**
 * Per-Lambda IAM and environment wiring on the VoC REST API: metrics, feedback
 * edit, category access and reprocess, the data explorer, ballots and the two
 * public origin sets. Split out of api-stack.test.ts; the template builder and
 * readers are shared through lib/test-support/api-stack-template.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { IamPolicySchema, managedPolicies, statementActions } from '../test-support/iam-statements';
import type { IamStatement } from '../test-support/iam-statements';
import { ALLOWED_FOUNDATION_MODEL_IDS, ALLOWED_MODEL_IDS, IMAGE_MODEL_MARKETPLACE_PRODUCT_ID, imageModelArn } from '../utils/model-allowlist';
import { allowedActions as allowedActionsOf, roleStatements as readRoleStatements } from '../test-support/iam-statements';
import {
  LambdaEnvSchema, apiMethods, apiTemplate, apiTemplateDev, apiTemplatePrefixed, functionIdForHandler, nonOptions, resolveMethod,
  methodThrottles, policyStatementsOf, serviceEnvironment, unwiredMethodKeys,
  actionsWithPrefix, RefSchema,
} from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';
import { itemAt } from '../test-support/guards';

// Synthesize the shared default template once, outside any single case's 5s
// budget: the first case to call apiTemplate() would otherwise pay for it.
beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

describe('metrics Lambda IAM grants', () => {
  // The /metrics/* and /feedback/entities handlers read a whole date window with
  // a base-table Query on the aggregates table (see _query_metric_window). Every
  // Python test for those endpoints mocks `aggregates_table`, so a narrowed grant
  // would surface only as an AccessDenied 500 in a deployed environment. This
  // pins the action that makes those reads possible.
  // Resource matching is keyed on the logical-ID substring 'Aggregates' appearing
  // in the serialized Ref/GetAtt/ImportValue, since a cross-stack table ARN has no
  // stable literal to compare against. Renaming the table construct away from
  // 'Aggregates' will fail this test rather than silently pass it — the safe
  // direction, but worth knowing before you chase the failure into IAM.
  it('grants dynamodb:Query on the aggregates table itself, not only its indexes', () => {
    const aggregatesQueryStatements = policyStatementsOf(apiTemplate(), 'MetricsLambdaRole')
      .filter((s) => s.actions.includes('dynamodb:Query') && s.resource.includes('Aggregates'));
    expect(aggregatesQueryStatements.length).toBeGreaterThan(0);

    // The bare table ARN must be present, not just the `/index/*` child: a
    // grant covering only indexes would satisfy a laxer check while every
    // windowed read still failed.
    const resources = aggregatesQueryStatements.map((s) => s.resource).join('\n');
    expect(resources).toContain('Aggregates');
    const hasBareTableArn = aggregatesQueryStatements.some((s) => {
      const resource: unknown = JSON.parse(s.resource);
      const list: unknown[] = Array.isArray(resource) ? resource : [resource];
      return list.some((r) => JSON.stringify(r).includes('Aggregates') && !JSON.stringify(r).includes('index/*'));
    });
    expect(hasBareTableArn, 'aggregates Query granted on indexes only').toBe(true);
  });
});


// ── Keep-everything + categories change set ──────────────────────────────────
// Statement readers live in lib/test-support/iam-statements.ts (shared with the
// processing-stack suite); policies here are found by their role-derived id prefix.
const roleStatements = (template: Template, roleId: string) =>
  readRoleStatements(template, roleId, { byIdPrefix: true });
const allowedActions = (template: Template, roleId: string, prefix: string, resourceFragment: string) =>
  allowedActionsOf(roleStatements(template, roleId), prefix, resourceFragment);

function lambdaEnv(template: Template, handler: string): Record<string, unknown> {
  const fn = Object.values(template.findResources('AWS::Lambda::Function'))
    .map((f) => LambdaEnvSchema.parse(f).Properties)
    .find((p) => p.Handler === handler);
  expect(fn, `no Lambda with Handler ${handler}`).toBeDefined();
  return fn?.Environment?.Variables ?? {};
}

describe('feedback edit Lambda (PUT /feedback/{id}/category, PUT /feedback/{id}/dimensions)', () => {
  const ROLE = 'FeedbackEditLambdaRole';

  it.each(['PUT /feedback/{id}/category', 'PUT /feedback/{id}/dimensions'])(
    'wires %s behind Cognito to its own Lambda, not the read-only metrics one',
    (route) => {
      const method = apiMethods(apiTemplate()).find((m) => m.route === route);
      expect(method, `${route} is not wired`).toBeDefined();
      expect(method?.authorizationType).toBe('COGNITO_USER_POOLS');
      expect(method?.hasAuthorizerId).toBe(true);
      expect(method?.integrationFunctionId).toBe(functionIdForHandler(apiTemplate(), 'feedback_edit_handler.py'));
    },
  );

  it('holds exactly GetItem/Query/UpdateItem on feedback — never Put, Delete or Scan', () => {
    // Customer data is never deleted, and a correction is an in-place update of
    // the existing item. Query reaches the gsi4-by-feedback-id index (the grant
    // carries `<table>/index/*`), GetItem the base item.
    expect(allowedActions(apiTemplate(), ROLE, 'dynamodb:', 'Feedback'))
      .toStrictEqual(['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem']);
    const feedbackResources = roleStatements(apiTemplate(), ROLE)
      .filter((s) => s.resource.includes('Feedback')).map((s) => s.resource).join(' ');
    expect(feedbackResources, 'Query must reach the feedback-by-id GSI').toContain('/index/*');
  });

  it('only reads aggregates (category config + CATEGORY_ACCESS rows)', () => {
    expect(allowedActions(apiTemplate(), ROLE, 'dynamodb:', 'Aggregates'))
      .toStrictEqual(['dynamodb:GetItem', 'dynamodb:Query']);
  });

  it('cannot reach projects, conversations, S3 or the processing queue', () => {
    const offenders = roleStatements(apiTemplate(), ROLE).filter((s) =>
      ['Projects', 'Conversations', 'Jobs'].some((t) => s.resource.includes(t))
      || s.actions.some((a) => a.startsWith('s3:') || a.startsWith('sqs:') || a.startsWith('bedrock:')));
    expect(offenders).toStrictEqual([]);
  });

  it('is handed both table names', () => {
    expect(Object.keys(lambdaEnv(apiTemplate(), 'feedback_edit_handler.lambda_handler')))
      .toStrictEqual(expect.arrayContaining(['FEEDBACK_TABLE', 'AGGREGATES_TABLE']));
  });
});

describe('category access wiring', () => {
  it('serves GET /feedback/access from the metrics Lambda behind Cognito', () => {
    const method = apiMethods(apiTemplate()).find((m) => m.route === 'GET /feedback/access');
    expect(method, 'GET /feedback/access is not wired').toBeDefined();
    expect(method?.authorizationType).toBe('COGNITO_USER_POOLS');
    expect(method?.integrationFunctionId).toBe(functionIdForHandler(apiTemplate(), 'metrics_handler.py'));
  });

  it('lets the metrics Lambda read the CATEGORY_ACCESS rows in aggregates', () => {
    expect(allowedActions(apiTemplate(), 'MetricsLambdaRole', 'dynamodb:', 'Aggregates'))
      .toStrictEqual(expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:Query']));
  });

  it('gives the users Lambda exactly GetItem/PutItem/BatchGetItem on aggregates, and its name', () => {
    // GET/PUT /users/{username}/category-access read and write ONE row per user;
    // GET /users batch-reads every listed user's USERFLAGS row (shared/user_flags.py).
    expect(allowedActions(apiTemplate(), 'UsersLambdaRole', 'dynamodb:', 'Aggregates'))
      .toStrictEqual(['dynamodb:BatchGetItem', 'dynamodb:GetItem', 'dynamodb:PutItem']);
    expect(allowedActions(apiTemplate(), 'UsersLambdaRole', 'dynamodb:', 'Feedback')).toStrictEqual([]);
    expect(lambdaEnv(apiTemplate(), 'users_handler.lambda_handler')).toHaveProperty('AGGREGATES_TABLE');
  });

  it('lets the users Lambda list group memberships per group for GET /users (E2E F10)', () => {
    // users_handler._groups_by_username: ListGroups + ListUsersInGroup instead of
    // one AdminListGroupsForUser per user. Without them GET /users is a 500.
    const cognitoActions = roleStatements(apiTemplate(), 'UsersLambdaRole').flatMap((s) => s.actions);
    expect(cognitoActions).toStrictEqual(expect.arrayContaining(['cognito-idp:ListGroups', 'cognito-idp:ListUsersInGroup']));
  });

  it('keeps cognito-idp:AdminGetUser on the users Lambda (username → sub)', () => {
    const cognitoActions = roleStatements(apiTemplate(), 'UsersLambdaRole').flatMap((s) => s.actions);
    expect(cognitoActions).toContain('cognito-idp:AdminGetUser');
  });
});

describe('category reprocess is started by the settings Lambda', () => {
  const WORKER = 'voc-category-reprocess';

  it('names the worker in CATEGORY_REPROCESS_FUNCTION', () => {
    const env = lambdaEnv(apiTemplate(), 'settings_handler.lambda_handler');
    expect(JSON.stringify(env.CATEGORY_REPROCESS_FUNCTION)).toContain(WORKER);
  });

  /** The settings role's ONE lambda:InvokeFunction statement's resource. */
  function settingsInvokeResource(): string {
    const invokes = roleStatements(apiTemplate(), 'SettingsLambdaRole')
      .filter((s) => s.actions.includes('lambda:InvokeFunction'));
    expect(invokes, 'expected exactly one lambda:InvokeFunction statement').toHaveLength(1);
    return itemAt(invokes, 0).resource;
  }

  it('may invoke exactly that worker, the retention worker and itself', () => {
    // Itself: a design-reference refresh re-invokes the settings Lambda async.
    // The retention worker: POST /settings/erasure starts an erasure job.
    const resource = settingsInvokeResource();
    expect(resource).toContain(`:function:${WORKER}-`);
    expect(resource).toContain(':function:voc-retention-');
    expect(resource).toContain(':function:voc-settings-api-');
    expect(resource.match(/:function:/g)).toHaveLength(3);
  });

  it('names the retention worker in RETENTION_FUNCTION (prefix-aware, like the processing stack)', () => {
    expect(JSON.stringify(lambdaEnv(apiTemplate(), 'settings_handler.lambda_handler').RETENTION_FUNCTION))
      .toContain('voc-retention-');
    expect(JSON.stringify(lambdaEnv(apiTemplatePrefixed(), 'settings_handler.lambda_handler').RETENTION_FUNCTION))
      .toContain('b-voc-retention-');
  });

  it('invokes by deterministic unqualified ARNs', () => {
    expect(settingsInvokeResource(), 'no version/alias wildcard').not.toContain('*');
  });

  it('prefixes the worker name in a prefixed deployment, matching the processing stack', () => {
    const env = lambdaEnv(apiTemplatePrefixed(), 'settings_handler.lambda_handler');
    expect(JSON.stringify(env.CATEGORY_REPROCESS_FUNCTION)).toContain(`b-${WORKER}-`);
  });
});

describe('the settings Lambda can test models and read their quotas', () => {
  const ROLE = 'SettingsLambdaRole';

  it('may invoke every allowlisted model (POST /settings/model/test calls Converse on it)', () => {
    const invoke = roleStatements(apiTemplate(), ROLE).filter((s) => s.actions.includes('bedrock:InvokeModel'));
    expect(invoke).toHaveLength(1);
    const resource = itemAt(invoke, 0).resource;
    for (const modelId of ALLOWED_MODEL_IDS) expect(resource).toContain(`inference-profile/${modelId}`);
  });

  it('holds servicequotas:ListServiceQuotas and no other Service Quotas action', () => {
    const quotaStatements = roleStatements(apiTemplate(), ROLE)
      .filter((s) => s.actions.some((action) => action.startsWith('servicequotas:')));
    expect(quotaStatements).toHaveLength(1);
    const statement = itemAt(quotaStatements, 0);
    expect(statement.actions).toStrictEqual(['servicequotas:ListServiceQuotas']);
    expect(JSON.parse(statement.resource)).toBe('*');
  });

  it('documents the read-only wildcard with a scoped cdk-nag suppression', () => {
    const roles = apiTemplate().findResources('AWS::IAM::Role');
    const settingsRole = Object.entries(roles).find(([logicalId]) => logicalId.startsWith(ROLE));
    expect(settingsRole, `no ${ROLE}`).toBeDefined();
    expect(JSON.stringify(settingsRole?.[1])).toContain('servicequotas:ListServiceQuotas supports no resource-level permission');
  });
});

describe('the data explorer never deletes customer data', () => {
  const ROLE = 'DataExplorerLambdaRole';

  it.each(['DELETE /data-explorer/s3', 'DELETE /data-explorer/feedback'])('does not wire %s', (route) => {
    const methods = apiMethods(apiTemplate());
    const parts = route.split(' ');
    expect(resolveMethod(methods, itemAt(parts, 0), itemAt(parts, 1)), `${route} reaches a Lambda`).toBeUndefined();
  });

  it('has no catch-all under /data-explorer that could serve a DELETE', () => {
    const anyOrProxy = apiMethods(apiTemplate())
      .filter((m) => m.path.startsWith('/data-explorer'))
      .filter((m) => m.httpMethod === 'ANY' || m.path.includes('+}') || m.httpMethod === 'DELETE');
    expect(anyOrProxy.map((m) => m.route)).toStrictEqual([]);
  });

  it('wires every remaining route behind Cognito', () => {
    const routes = nonOptions(apiTemplate())
      .filter((m) => m.path.startsWith('/data-explorer'))
      .map((m) => `${m.route} [${m.authorizationType}]`)
      .sort(byCodeUnit);
    expect(routes).toStrictEqual([
      'GET /data-explorer/buckets [COGNITO_USER_POOLS]',
      'GET /data-explorer/s3 [COGNITO_USER_POOLS]',
      'GET /data-explorer/s3/preview [COGNITO_USER_POOLS]',
      'GET /data-explorer/stats [COGNITO_USER_POOLS]',
      'PUT /data-explorer/feedback [COGNITO_USER_POOLS]',
      'PUT /data-explorer/s3 [COGNITO_USER_POOLS]',
    ]);
  });

  it('holds no s3:DeleteObject* and no dynamodb:DeleteItem', () => {
    const allowed = roleStatements(apiTemplate(), ROLE)
      .filter((s) => s.effect === 'Allow')
      .flatMap((s) => s.actions);
    expect(allowed.filter((a) => a.startsWith('s3:Delete') || a === 'dynamodb:DeleteItem'
      || a === 'dynamodb:BatchWriteItem')).toStrictEqual([]);
  });

  it('edits feedback in place only: read actions plus UpdateItem', () => {
    const writes = allowedActions(apiTemplate(), ROLE, 'dynamodb:', 'Feedback')
      .filter((a) => !['dynamodb:BatchGetItem', 'dynamodb:ConditionCheckItem', 'dynamodb:DescribeTable',
        'dynamodb:GetItem', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:Query',
        'dynamodb:Scan'].includes(a));
    expect(writes).toStrictEqual(['dynamodb:UpdateItem']);
  });

  it('reads (never writes) the aggregates table, for the categories config a category edit is validated against', () => {
    expect(allowedActions(apiTemplate(), ROLE, 'dynamodb:', 'Aggregates')).toStrictEqual(['dynamodb:GetItem']);
    expect(lambdaEnv(apiTemplate(), 'data_explorer_handler.lambda_handler').AGGREGATES_TABLE).toBeDefined();
  });
});


describe('ballots Lambda IAM grants', () => {
  // A ballot is a DECISION record, not customer voice: it is never written to the
  // feedback table and never enqueued for processing, so it gains no sentiment, no
  // persona and no place in any customer metric. That split was made at the write
  // path on purpose, and a comment cannot enforce it — the grants can. The ballots
  // role holds the aggregates table and nothing else, so the unwanted write is
  // impossible rather than merely absent from today's handler.
  const ballotsStatements = () => roleStatements(apiTemplate(), 'BallotsLambdaRole');

  it('can write the aggregates table, which holds sessions and ballots', () => {
    const writes = ballotsStatements().filter(
      (s) => s.actions.includes('dynamodb:UpdateItem') && s.resource.includes('Aggregates'),
    );

    expect(writes.length).toBeGreaterThan(0);
  });

  it('holds only the three item actions the handler calls, and no listing or deletion', () => {
    // `grantReadWriteData` would have handed over Query, Scan, DeleteItem,
    // BatchGetItem and BatchWriteItem across the whole aggregates table — which
    // also holds every feedback-form configuration and every signed-in reviewer's
    // ballot — on the ONE function in this stack that two unauthenticated routes
    // reach. The handler reads one item at a time, creates a session and upserts;
    // it never lists, never deletes, never writes in bulk.
    //
    // Asserted as an exact SET rather than as an absence list, so an action nobody
    // considered cannot arrive unremarked: a new grant fails this test and has to
    // be argued for.
    expect(actionsWithPrefix(ballotsStatements(), 'dynamodb:')).toStrictEqual([
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
    ]);
  });

  it('may only GetItem the projects table, to gate a session on project access', () => {
    const onProjects = ballotsStatements().filter((s) => s.resource.includes('Projects'));
    // Guard the logical-id filter so a construct rename cannot make this vacuous.
    expect(onProjects.length, 'no ballots statement names the Projects table').toBeGreaterThan(0);
    const actions = new Set(onProjects.flatMap((s) => s.actions));

    expect([...actions]).toStrictEqual(['dynamodb:GetItem']);
  });

  it('cannot reach the feedback table or the processing queue', () => {
    // The resource-name matching is the same logical-ID substring approach the
    // metrics grant test above uses, and carries the same caveat: renaming the
    // Feedback table construct fails this test rather than silently passing it.
    const offenders = ballotsStatements().filter(
      (s) => s.resource.includes('Feedback') || s.actions.some((a) => a.startsWith('sqs:')),
    );

    expect(
      offenders,
      'the ballots Lambda has been granted access to customer feedback or to the '
      + 'processing queue. A ballot is an internal decision record: enriching it '
      + 'would assign a colleague\'s vote a customer persona.',
    ).toStrictEqual([]);
  });
});


describe('the public ballot routes', () => {
  /** The two routes a phone reaches with no credentials, as
   *  `deployOptions.methodOptions` keys them: `{resource path}/{METHOD}`. */
  const PUBLIC_BALLOT_METHOD_KEYS = [
    '/voting-sessions/{session_id}/config/GET',
    '/voting-sessions/{session_id}/submit/POST',
  ];

  it('throttles both of them below the stage default', () => {
    // The stage default is 100/200 for `/*/*`. These two answer an anonymous
    // caller a DynamoDB read — and `submit` a conditional write — against a
    // bounded room, so they get their own tighter pair. (The widget's `submit`
    // shares it; the two widget reads deliberately do not — see
    // `the public feedback-form routes` below.)
    expect(methodThrottles(apiTemplate(), PUBLIC_BALLOT_METHOD_KEYS)).toStrictEqual(
      Object.fromEntries(PUBLIC_BALLOT_METHOD_KEYS.map((key) => [key, { rate: 20, burst: 40 }])),
    );
  });

  it('spells those throttle keys the same way the wired routes are spelled', () => {
    // A methodOptions key is a STRING matched against a resource path at deploy
    // time. A typo in it throttles nothing, breaks nothing and reports nothing —
    // the setting is simply never applied — so the two spellings are compared
    // against each other here rather than each being trusted on its own.
    expect(unwiredMethodKeys(apiTemplate(), PUBLIC_BALLOT_METHOD_KEYS)).toStrictEqual([]);
  });

  it('answers CORS preflight on both, which a cross-origin JSON POST requires', () => {
    // `submitBallot` sends Content-Type: application/json to a different host from
    // the SPA, which makes it a non-simple request: the browser sends OPTIONS
    // first and never sends the POST if that fails. The RestApi's
    // `defaultCorsPreflightOptions` generates these, so this asserts the
    // inheritance actually reached the two resources added for this feature —
    // nothing in `addResource` guarantees it, and the failure mode is a room whose
    // ballots never leave the phone.
    const preflight = new Set(
      apiMethods(apiTemplate()).filter((m) => m.httpMethod === 'OPTIONS').map((m) => m.path),
    );

    expect([...PUBLIC_BALLOT_METHOD_KEYS].map((key) => key.replace(/\/[A-Z]+$/, ''))
      .filter((path) => !preflight.has(path))).toStrictEqual([]);
  });

  it('serves the ballots Lambda the site origin, not a wildcard', () => {
    // ALLOWED_ORIGIN is per-FUNCTION, and the three facilitator routes share this
    // function with the two public ones, so a '*' for the benefit of the ballot
    // page would also publish a facilitator's session responses to any origin.
    // It needs no wildcard: the ballot page is a route of this SPA, so a phone
    // opening it sends the same Origin every other page does.
    expect(serviceEnvironment(apiTemplate(), 'voc-ballots-api').ALLOWED_ORIGIN)
      .toBe('https://app.example.invalid');
  });
});


/** ALLOWED_ORIGIN for one API Lambda, by its POWERTOOLS_SERVICE_NAME.
 *
 *  Returns `undefined` when the function exists but names no such variable,
 *  which is a distinct failure from "no such function" and the two assertions
 *  below distinguish them. */
function allowedOriginOf(template: Template, serviceName: string): unknown {
  return serviceEnvironment(template, serviceName).ALLOWED_ORIGIN;
}


describe('the two public sets get OPPOSITE origins, on purpose', () => {
  // Both functions serve unauthenticated routes and they answer the CORS question
  // differently — the forms Lambda takes '*', the ballots Lambda takes the site
  // origin. That difference is a DECISION, not an oversight, so it is pinned from
  // both sides: changing either value alone fails here, and whoever changes one
  // has to say why the other stayed.
  //
  // Forms: the widget (lambda/api/static/feedback-widget.js) is embedded on
  // CUSTOMER sites, so the Origin is a domain this stack cannot enumerate and no
  // single value would work.
  //
  // Ballots: the ballot page is a route of THIS SPA served from its own
  // CloudFront domain, so a phone opening it sends the same Origin every other
  // page does — and '*' there would also loosen the three facilitator routes that
  // share that function.
  it('gives the feedback-form Lambda the deliberate wildcard', () => {
    expect(allowedOriginOf(apiTemplate(), 'voc-feedback-form-api')).toBe('*');
  });

  it('gives the ballots Lambda the site origin', () => {
    // `https://app.example.invalid` is this fixture's `frontendDomainName`
    // interpolated by `allowedOrigin`, i.e. the RESOLVED form of a value a real
    // deploy carries as an Fn::Join over the CloudFront domain. The assertion
    // pins the derivation, not a literal any deployment ever sees.
    expect(allowedOriginOf(apiTemplate(), 'voc-ballots-api')).toBe('https://app.example.invalid');
  });

  it('states the wildcard in the STACK, not in the handler default', () => {
    // feedback_form_handler.py falls back to '*' when the variable is absent, so
    // the effective value was already '*' before this was set — from a Python
    // default, where no reader of the CDK could see it. Asserting the variable is
    // PRESENT is therefore the whole point of this case: a value equal to the
    // handler's fallback is indistinguishable from an omission unless presence is
    // checked on its own.
    expect(allowedOriginOf(apiTemplate(), 'voc-feedback-form-api')).toBeDefined();
  });

  it('keeps the two values distinct, so neither can be "fixed" into the other', () => {
    // TRUE OF THE DEFAULT (PRODUCTION) SHAPE ONLY, and that is not a weakness of
    // the test but a fact about the stack worth stating here: the ballots value
    // comes from `allowedOrigin`, which is `isDev ? '*' : https://<frontend>`, so
    // under `-c environment=dev` it also becomes '*' and the two coincide. The
    // forms value is hardcoded and moves for neither context (see its comment in
    // api-stack.ts). Asserting distinctness under `environment=dev` would
    // therefore be asserting something false.
    const template = apiTemplate();
    const forms = allowedOriginOf(template, 'voc-feedback-form-api');
    const ballots = allowedOriginOf(template, 'voc-ballots-api');

    expect(forms).not.toBe(ballots);
  });

  it('leaves the forms wildcard unmoved by environment=dev, unlike every other Lambda', () => {
    // The divergence the case above describes, asserted rather than only noted.
    // This is the one API Lambda no deployment-time control can tighten: the dev
    // switch that loosens every OTHER API Lambda (each takes
    // `ALLOWED_ORIGIN: allowedOrigin`) reaches everything BUT this value, which is
    // already at its loosest and stays there in both contexts. No count is stated
    // here on purpose — a number drifts as Lambdas are added, and one of those
    // others is not even a CORS consumer (the MCP Lambda uses ALLOWED_ORIGIN as
    // its DNS-rebinding allowlist, see its comment in api-stack.ts).
    const dev = apiTemplateDev();

    expect(allowedOriginOf(dev, 'voc-feedback-form-api')).toBe('*');

    // A FOIL, not a requirement of this change: it shows the switch does move a
    // sibling on the same fixture, which is what makes the line above meaningful.
    // This PR does not own dev-mode CORS, so a future decision to stop loosening
    // `allowedOrigin` to '*' in dev should just update this line — it is not the
    // asymmetry the describe block exists to protect.
    expect(allowedOriginOf(dev, 'voc-ballots-api')).toBe('*');
  });
});

describe('document generator: prototype pin forms (§6.2)', () => {
  // Each built prototype gets ONE prototype_pin feedback form, written by a
  // conditional put. The generator otherwise only READS aggregates (model picker,
  // company context), so its only write there is PutItem — it can create a form,
  // never change or delete one (feedback forms share that table).
  it('writes aggregates with PutItem only', () => {
    const actions = allowedActions(apiTemplate(), 'DocumentGeneratorRole', 'dynamodb:', 'Aggregates');

    expect(actions).toContain('dynamodb:PutItem');
    expect(actions.filter((a) => /(Update|Delete|BatchWrite)/.test(a))).toStrictEqual([]);
  });

  it('gives the publicly reachable feedback-form Lambda no projects-table access', () => {
    // Pins are stored in aggregates precisely so the public submit's Lambda needs
    // no new grant; moderating them happens behind the projects API.
    const onProjects = roleStatements(apiTemplate(), 'FeedbackFormLambdaRole')
      .filter((s) => s.resource.includes('Projects'));

    expect(onProjects).toStrictEqual([]);
  });
});

describe('Marketplace image model access (issue #274)', () => {
  // The avatar model is a Marketplace listing: the first InvokeModel in an account
  // subscribes AS THE CALLER, so a role holding only bedrock:InvokeModel is denied
  // in a fresh account. Every role that can reach the model must hold both.
  const MARKETPLACE_ACTIONS = ['aws-marketplace:Subscribe', 'aws-marketplace:ViewSubscriptions'];

  /** Statements of every IAM policy (inline and customer-managed), grouped by the role(s) it is attached to. */
  function statementsByRole(template: Template): Map<string, IamStatement[]> {
    const byRole = new Map<string, IamStatement[]>();
    const inline = Object.values(template.findResources('AWS::IAM::Policy'))
      .map((resource) => IamPolicySchema.parse(resource).Properties);
    for (const policy of [...inline, ...managedPolicies(template)]) {
      for (const role of policy.Roles ?? []) {
        const roleId = RefSchema.parse(role).Ref;
        byRole.set(roleId, [...(byRole.get(roleId) ?? []), ...policy.PolicyDocument.Statement]);
      }
    }
    return byRole;
  }

  const allowStatements = (statements: IamStatement[]) => statements.filter((s) => (s.Effect ?? 'Allow') === 'Allow');
  const invokesImageModel = (statements: IamStatement[], imageArn: string) => allowStatements(statements)
    .some((s) => statementActions(s).includes('bedrock:InvokeModel') && JSON.stringify(s.Resource).includes(imageArn));
  /** A role's logical id without CDK's 8-hex hash suffix. */
  const roleStem = (roleId: string) => roleId.replace(/[0-9A-F]{8}$/, '');

  it('grants ViewSubscriptions + Subscribe to every role that may invoke the image model', () => {
    const imageArn = imageModelArn();
    const invokers = [...statementsByRole(apiTemplate())]
      .filter(([, statements]) => invokesImageModel(statements, imageArn));

    // Count first: a renamed grant must not turn this into a vacuous pass.
    expect(invokers.map(([roleId]) => roleStem(roleId)).sort(byCodeUnit)).toStrictEqual([
      'PersonaGeneratorRole', 'PersonaImporterRole', 'ProjectsLambdaRole',
    ]);
    for (const [roleId, statements] of invokers) {
      const marketplace = statements
        .filter((s) => (s.Effect ?? 'Allow') === 'Allow')
        .flatMap(statementActions)
        .filter((a) => a.startsWith('aws-marketplace:'));
      expect([...new Set(marketplace)].sort(byCodeUnit), roleId).toStrictEqual(MARKETPLACE_ACTIONS);
    }
  });

  it('grants Marketplace actions to EXACTLY the roles that may invoke the image model (least privilege)', () => {
    // Scrapers and ChatStream invoke text models only, so they must not hold the
    // grant: holders are compared to the image-model invokers, not a superset.
    const imageArn = imageModelArn();
    const byRole = [...statementsByRole(apiTemplate())];
    const stems = (rows: typeof byRole) => rows.map(([roleId]) => roleStem(roleId)).sort(byCodeUnit);
    const holders = byRole.filter(([, statements]) => allowStatements(statements)
      .flatMap(statementActions).some((a) => a.startsWith('aws-marketplace:')));
    const invokers = byRole.filter(([, statements]) => invokesImageModel(statements, imageArn));

    expect(stems(holders)).toStrictEqual(['PersonaGeneratorRole', 'PersonaImporterRole', 'ProjectsLambdaRole']);
    expect(stems(holders)).toStrictEqual(stems(invokers));
  });

  it('scopes every Subscribe grant to the image model Marketplace product (decision 4)', () => {
    // Subscribe is the only Marketplace action that honours aws-marketplace:ProductId
    // (Bedrock model-access guide); unconditioned it lets a role subscribe the
    // account to ANY Marketplace listing. ViewSubscriptions has no condition key
    // and stays on `*`.
    const ConditionedStatementSchema = z.object({
      Action: z.union([z.string(), z.array(z.string())]),
      Effect: z.string().optional(),
      Condition: z.unknown().optional(),
    });
    const PolicySchema = z.object({
      Properties: z.object({ PolicyDocument: z.object({ Statement: z.array(ConditionedStatementSchema) }) }),
    });
    type ConditionedStatement = z.infer<typeof ConditionedStatementSchema>;
    const actionsOf = (s: ConditionedStatement): string[] => (Array.isArray(s.Action) ? s.Action : [s.Action]);
    const marketplaceStatements = Object.values(apiTemplate().findResources('AWS::IAM::Policy'))
      .flatMap((resource) => PolicySchema.parse(resource).Properties.PolicyDocument.Statement)
      .filter((s) => actionsOf(s).some((a) => a.startsWith('aws-marketplace:')));
    const subscribe = marketplaceStatements
      .filter((s) => actionsOf(s).includes('aws-marketplace:Subscribe'));

    // One per grantMarketplaceSubscription call site — not a vacuous pass.
    expect(subscribe.length).toBeGreaterThanOrEqual(3);
    for (const statement of subscribe) {
      expect(actionsOf(statement)).toStrictEqual(['aws-marketplace:Subscribe']);
      expect(statement.Condition).toStrictEqual({
        'ForAnyValue:StringEquals': { 'aws-marketplace:ProductId': [IMAGE_MODEL_MARKETPLACE_PRODUCT_ID] },
      });
    }
    const viewOnly = marketplaceStatements.filter((s) => s.Condition === undefined);
    for (const statement of viewOnly) {
      expect(actionsOf(statement)).toStrictEqual(['aws-marketplace:ViewSubscriptions']);
    }
  });
});

describe('Projects Bedrock grant (customer-managed policy, 3.07.00)', () => {
  // Moved out of the role's default inline policy for the 10,240-char inline
  // quota. Pinned so a move back, or a policy that drops a model, is noticed.
  const projectsRoleId = () => {
    const ids = Object.keys(apiTemplate().findResources('AWS::IAM::Role')).filter((id) => id.startsWith('ProjectsLambdaRole'));
    expect(ids).toHaveLength(1);
    return itemAt(ids, 0);
  };
  const bedrockResources = (policies: z.infer<typeof IamPolicySchema>['Properties'][]) => policies
    .flatMap((policy) => policy.PolicyDocument.Statement)
    .filter((statement) => statementActions(statement).includes('bedrock:InvokeModel'))
    .map((statement) => JSON.stringify(statement.Resource))
    .join(' ');

  it('grants every allowlisted model and the avatar model from one managed policy on the role', () => {
    const roleId = projectsRoleId();
    const attached = managedPolicies(apiTemplate())
      .filter((policy) => (policy.Roles ?? []).some((role) => JSON.stringify(role).includes(roleId)));
    expect(attached).toHaveLength(1);
    const granted = bedrockResources(attached);
    expect(ALLOWED_FOUNDATION_MODEL_IDS.filter((id) => !granted.includes(`foundation-model/${id}`))).toStrictEqual([]);
    expect(granted).toContain(imageModelArn());
  });

  it('keeps Bedrock out of the default inline policy', () => {
    const inline = Object.entries(apiTemplate().findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.startsWith('ProjectsLambdaRoleDefaultPolicy'))
      .map(([, resource]) => IamPolicySchema.parse(resource).Properties);
    expect(inline).toHaveLength(1);
    expect(bedrockResources(inline)).toBe('');
  });
});

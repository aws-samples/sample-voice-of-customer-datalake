/**
 * VocApiStack's REST API: the stage (throttles, logging), CORS on generated
 * errors, and the Cognito authorizer. Resources are created on the stack
 * itself — see api-context.ts.
 */
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import type { PluginManifest } from '../plugin-loader';
import { apiGatewayRequestValidationSuppressions } from '../utils/nag-suppressions';
import type { ApiStackContext } from './api-context';
import { GLOBAL_MCP_METHOD_THROTTLE } from './global-mcp';

/**
 * The MCP transport headers a browser-based client may send.
 *
 * `mcp_global_handler.py` allows them (`Access-Control-Allow-Headers` in its
 * `_response`) and validates `MCP-Protocol-Version`, and a browser's preflight on this API is answered by API Gateway's generated
 * OPTIONS mock rather than by the Lambda — so the handler allowing them in its own
 * CORS response was not enough. Omitted here, a browser-based client that sends
 * `MCP-Protocol-Version` was blocked by its own preflight before the handler ever
 * saw the request: a rule the server enforces against a header no browser could
 * deliver.
 *
 * Spelled the way the spec spells them (`Mcp-Method`, not `MCP-Method`). CORS
 * header matching is case-insensitive, so this is about agreeing with the spec
 * rather than about function.
 *
 * Kept in lockstep with the handler by 'mcp transport headers' in
 * api-stack-mcp.test.ts, which reads the handler's Allow-Headers out of its source.
 */
const MCP_TRANSPORT_HEADERS = ['MCP-Protocol-Version', 'Mcp-Method', 'Mcp-Name'];

/**
 * Every header this API accepts on a cross-origin request, declared ONCE.
 *
 * The list was previously written out four times — the preflight options plus
 * three gateway responses — which is how a header comes to be allowed on the
 * preflight and refused on the error path, or vice versa. The string form below is
 * derived from this array rather than typed again.
 */
const CORS_ALLOW_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Requested-With',
  'X-Amz-Date',
  'X-Amz-Security-Token',
  ...MCP_TRANSPORT_HEADERS,
];

/**
 * The same list in the single-quoted form an API Gateway response header takes.
 * Derived, so the four places that state it cannot disagree.
 */
const CORS_ALLOW_HEADERS_VALUE = `'${CORS_ALLOW_HEADERS.join(',')}'`;

/**
 * Response headers a browser-based client is allowed to READ.
 *
 * None of these is CORS-safelisted, so without this list a browser receives them
 * and hides them from the page — the failure `WWW-Authenticate` already documents.
 * `Vary` joins it because `mcp_global_handler.py` sends `Vary: Authorization` on every
 * response (its answers depend on the credential), and a header stating that fact
 * which the client cannot read states it to nobody.
 *
 * `Allow` is the same failure on the header that says what to RETRY WITH: the handler
 * attaches it to every 405 — and a browser-based client would receive the refusal
 * with that instruction stripped out.
 *
 * `Content-Type` stays because the frontend reads it. `Retry-After` is the per-token
 * rate limit's answer to "when may I try again" on a 429 — hidden, a browser-based
 * client could only guess, and guessing early is how a loop stays limited.
 *
 * Kept in lockstep with `mcp_global_handler`'s `Access-Control-Expose-Headers`
 * by 'mcp transport headers reach a browser' in api-stack-mcp.test.ts: the handler's own
 * responses carry its list and gateway-GENERATED ones carry this, so a header
 * exposed by one and not the other is readable on some answers and not others.
 */
const CORS_EXPOSE_HEADERS = ['Content-Type', 'WWW-Authenticate', 'Vary', 'Allow', 'Retry-After'];

/** The same list in the single-quoted form an API Gateway response header takes. */
const CORS_EXPOSE_HEADERS_VALUE = `'${CORS_EXPOSE_HEADERS.join(',')}'`;

/**
 * The CORS headers every gateway-GENERATED error carries (issue #267 item 10).
 *
 * The same origin the API Lambdas answer with (`allowedOrigin`: the frontend
 * domain, or '*' only under `-c environment=dev`) — these used to hardcode '*',
 * so an error from the gateway was readable cross-origin when the Lambdas' own
 * answers were not. No `Allow-Credentials` is sent: the frontend authenticates
 * with a bearer header, not cookies.
 *
 * Gateway responses are API-WIDE, so the public widget routes (which the Lambda
 * answers with '*') get this origin too on a gateway error such as a 429: the
 * widget on a customer site then sees a network error instead of an unreadable
 * error body, which its `.catch` already renders as a load/submit failure.
 *
 * `Vary: Origin` whenever the value is a single origin, so a shared cache never
 * serves one origin's answer to another; `vary` adds response-specific names.
 */
function gatewayErrorCorsHeaders(allowedOrigin: string, vary: string[] = []): Record<string, string> {
  const varyNames = allowedOrigin === '*' ? vary : ['Origin', ...vary];
  return {
    'Access-Control-Allow-Origin': `'${allowedOrigin}'`,
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS_VALUE,
    'Access-Control-Allow-Methods': "'GET,POST,PUT,DELETE,OPTIONS'",
    ...(varyNames.length > 0 ? { Vary: `'${varyNames.join(', ')}'` } : {}),
  };
}

export interface ApiGateway {
  api: apigateway.RestApi;
  /** Cognito options every signed-in route uses. */
  authMethodOptions: apigateway.MethodOptions;
  /** The one-shot `skipFeedbackFormItemRoutes` upgrade flag (see api-routes.ts). */
  skipFeedbackFormItemRoutes: boolean;
}

export function createApiGateway(ctx: ApiStackContext, webhookPlugins: PluginManifest[]): ApiGateway {
  const { stack, allowedOrigin } = ctx;
  const { userPool } = ctx.props;

  // One-shot flag for upgrading an environment that still has the old
  // /feedback-forms/{proxy+}. Read HERE, above the RestApi, because it decides
  // two things that are declared far apart: whether the `{form_id}` item
  // resources are created at all (see /feedback-forms/* below, which is where
  // the flag is explained in full) and whether this stage carries method
  // settings for the three public routes under them.
  // Read ONCE into a const — the value is compared twice, not fetched twice.
  // `true` and `'true'` are the accepted spellings ('TRUE', '1', 'yes' are
  // "off"); "off" means "deploy the routes", so a typo fails loudly on the
  // first upgrade deploy rather than skipping the step silently.
  const skipFeedbackFormItemRoutesContext: unknown = stack.node.tryGetContext('skipFeedbackFormItemRoutes');
  const skipFeedbackFormItemRoutes =
    skipFeedbackFormItemRoutesContext === true || skipFeedbackFormItemRoutesContext === 'true';

  /** 20 rps / burst 40 — the pair for an unauthenticated method whose
   *  LEGITIMATE demand is bounded and whose per-request cost is not. Both
   *  ballot methods (a room is capped at MAX_BALLOT_CAP ballots, one per
   *  attendee) and the widget's `submit` (see its own comment below).
   *
   *  Named once so those entries cannot drift apart by a typo in a number, and
   *  ANNOTATED so a typo in a property NAME is a compile error too: without the
   *  annotation the object literal is not fresh at its use sites, excess-property
   *  checking never fires, and a `throttlingBurstLmit` would deploy a rate limit
   *  with the burst left at the account default.
   *
   *  Deliberately NOT shared with the /mcp entries, which carry the same two
   *  numbers by coincidence and for a different reason (a bearer-token brute
   *  force, not an anonymous caller) — see the comment on them below. Tuning
   *  one of the two sets should not silently move the other.
   *
   *  Deliberately NOT shared with the two widget READS either, whose demand is
   *  a third party's page-view rate — see publicWidgetReadThrottle.
   *
   *  NOTHING OBSERVES THIS CEILING — see the note on `methodOptions` below,
   *  where both pairs are applied.
   *
   *  WHAT THIS PAIR DOES NOT CLOSE, for the widget's `submit`: it is a RATE
   *  ceiling, not a bound on lifetime volume, and the two members of this pair
   *  are not alike in that respect. A ballot submission has two stopping
   *  conditions beyond the rate — a room is capped at MAX_BALLOT_CAP ballots,
   *  and the session itself can be closed — so 20 rps is a backstop on a
   *  quantity already bounded elsewhere. A feedback form has NEITHER: no cap on
   *  submissions and no closable window, so 20 rps sustained is ~1.7M
   *  submissions/day, indefinitely, from an anonymous caller. Closing that
   *  needs a PER-FORM SUBMISSION CAP, which is durable per-form state rather
   *  than a gateway setting (where the counter lives, what resets it, what the
   *  widget shows when it trips) and so is a separate design, not a number to
   *  tune here. Recorded because it is the one follow-up that addresses the
   *  asymmetry this ceiling only narrows. */
  const publicRouteThrottle: apigateway.MethodDeploymentOptions = {
    throttlingRateLimit: 20,
    throttlingBurstLimit: 40,
  };

  /** 100 rps / burst 200 for the two widget READS — `config` and `iframe`.
   *
   *  A DIFFERENT pair from publicRouteThrottle, on purpose. The 20 rps figure is
   *  argued from a bounded room: MAX_BALLOT_CAP attendees submitting once each,
   *  so 20 rps is ~30x the need. Nothing in that argument transfers here.
   *  `config` is fetched by feedback-widget.js on EVERY PAGE LOAD of every
   *  customer page carrying the widget, and `iframe` on every iframe render, so
   *  the legitimate demand is a third party's traffic, which this stack cannot
   *  bound and does not get told about. A stage method setting is keyed by PATH,
   *  with `{form_id}` as a variable, so the ceiling is shared across every form
   *  in the deployment AND every caller — one busy embed spends the whole
   *  budget.
   *
   *  WHAT A 429 LOOKS LIKE DIFFERS BY ROUTE, which matters because none of the
   *  three symptoms names the rate limit and two are easy to misattribute
   *  (traced through lambda/api/static/feedback-widget.js):
   *    - `config`: the widget shows a flat "Failed to load form.", with no
   *      retry. Note the mechanism — the gateway's 429 carries the deployment's
   *      frontend origin (gatewayErrorCorsHeaders), not '*', so on a customer's
   *      site the browser hides it and the fetch lands in the `.catch`. Only a
   *      dev deployment (origin '*') can read the body and show "Feedback form
   *      unavailable.", byte-identical to what a DISABLED form renders.
   *    - `submit`: a modal `alert('Failed to submit.')` instead, on a different
   *      code path — and the visitor has already typed their feedback. It is
   *      retryable (`isSubmitting` is reset), unlike the reads.
   *    - `iframe`: NO widget code runs at all. The browser navigates to this
   *      route directly, so a 429 is a raw API Gateway error page inside the
   *      customer's iframe — a broken frame, not any widget string.
   *
   *  So the number is stated as what it is: 100 rps is the AGGREGATE widget
   *  page-view rate this deployment supports — ~8.6M/day across all embeds —
   *  and it is the ceiling these routes already had, since it equals the stage
   *  default. Restating it here rather than letting them ride that default is
   *  the point: it pins the reads' ceiling to the demand THEY have, so a later
   *  decision to tighten the stage-wide default cannot silently squeeze a
   *  customer's page.
   *
   *  Cost is the reason this can be the generous side of the pair: `config` is
   *  one get_item, and `iframe` touches no AWS service at all — it interpolates
   *  form_id into a static HTML shell around a module-cached widget script.
   *
   *  CACHING, not a throttle, is the right primary control for `iframe`: the
   *  response is a pure function of form_id and host. It is not adopted here
   *  because both available forms are out of a CDK-only change — an API Gateway
   *  cache is a priced cluster on the stage, and a Cache-Control header is a
   *  feedback_form_handler.py change. Recorded so nobody reads the throttle as
   *  evidence that the route is uncacheable.
   *
   *  DO NOT CACHE `iframe` BEFORE ESCAPING ITS INPUT — issue #379. That route
   *  reflects caller-supplied input into its response unescaped, so caching
   *  would turn a reflected flaw into a stored one served to every subsequent
   *  visitor. The escaping is therefore a PRECONDITION of the caching follow-up,
   *  not a parallel cleanup. Pre-existing and out of scope for a CDK-only
   *  change; the constraint is recorded HERE because this is where the next
   *  reader decides to implement the caching, and the mechanism and fix are in
   *  #379 rather than restated here — one description to keep correct, and it
   *  stops this comment asserting a live vulnerability after #379 is closed.
   *
   *  NOTHING OBSERVES THIS CEILING EITHER — see the note on `methodOptions`
   *  below, where both pairs are applied. */
  const publicWidgetReadThrottle: apigateway.MethodDeploymentOptions = {
    throttlingRateLimit: 100,
    throttlingBurstLimit: 200,
  };

  // The three public feedback-form methods, keyed as
  // `{resource path}/{METHOD}`. CONDITIONAL on the flag above: when it is set
  // the `{form_id}` subtree is not created, and a method setting naming a path
  // that does not exist is not an error — API Gateway simply never applies it —
  // but it is a claim in the template about routes this deploy does not serve.
  // Omitting them keeps the transitional stage honest, and keeps the lockstep
  // test ("every key names a wired method") true for both shapes rather than
  // only the default one.
  const publicFeedbackFormMethodOptions: Record<string, apigateway.MethodDeploymentOptions> =
    skipFeedbackFormItemRoutes ? {} : {
      '/feedback-forms/{form_id}/config/GET': publicWidgetReadThrottle,
      '/feedback-forms/{form_id}/submit/POST': publicRouteThrottle,
      '/feedback-forms/{form_id}/iframe/GET': publicWidgetReadThrottle,
    };

  /** 10 rps / burst 20 for each enabled plugin's webhook receiver
   *  (`/webhooks/<plugin_id>/<METHOD>`).
   *
   *  Unauthenticated at the gateway by necessity — a provider such as GitHub
   *  cannot present a Cognito token — and authenticated in the handler instead,
   *  by the provider's signature (`X-Hub-Signature-256` for github_issues),
   *  which is checked before anything is parsed or enqueued. Every request, even
   *  a forged one, still costs a Lambda invocation and a Secrets Manager read, so
   *  the ceiling is held well below the stage default. LEGITIMATE demand is one
   *  provider's event rate for the configured repos, which is low; a repo busy
   *  enough to exceed it loses nothing, because the scheduled ingestor polls the
   *  same issues and the processor de-duplicates by id.
   *
   *  Keyed only for webhook plugins that are ENABLED, i.e. only for routes this
   *  deploy actually wires: a setting naming an absent path would be an orphan
   *  (see the lockstep in api-stack-feedback-forms.test.ts). */
  const publicWebhookThrottle: apigateway.MethodDeploymentOptions = {
    throttlingRateLimit: 10,
    throttlingBurstLimit: 20,
  };
  const publicWebhookMethodOptions: Record<string, apigateway.MethodDeploymentOptions> = Object.fromEntries(
    webhookPlugins.flatMap((plugin) => (plugin.infrastructure.webhook?.methods ?? [])
      .map((method) => [`/webhooks/${plugin.id}/${method}`, publicWebhookThrottle] as const)),
  );

  // API Gateway CloudWatch Logs
  const apiLogGroup = new logs.LogGroup(stack, 'ApiGatewayLogs', {
    logGroupName: `/aws/apigateway/${ctx.uniqueName('voc-analytics-api')}`,
    retention: logs.RetentionDays.TWO_WEEKS,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const api = new apigateway.RestApi(stack, 'VocAnalyticsApi', {
    restApiName: ctx.uniqueName('voc-analytics-api'),
    description: 'Voice of the Customer Analytics API v2',
    deployOptions: {
      stageName: 'v1',
      throttlingRateLimit: 100,
      throttlingBurstLimit: 200,
      // An EXPLICIT limit on every UNAUTHENTICATED method — the two ballot
      // methods (see /voting-sessions/* below) and the three feedback-form
      // widget methods (see /feedback-forms/* below). Each request costs a
      // DynamoDB read even for an id that does not exist, and nothing in front
      // of them asks who is calling — the session token, or the form's own
      // state, is checked inside the handler, which means the cost is paid
      // before the refusal.
      //
      // "Explicit" rather than "tighter", because the five are not all at one
      // number. The criterion that splits them is BOUNDED vs UNBOUNDED
      // legitimate demand, not read vs write and not cost — which matters
      // because /voting-sessions/{session_id}/config/GET is at 20/40 and is a
      // pure read (get_ballot_config: one get_item and a narrow projection, no
      // write and no model call), so a cost-based reading would move it to the
      // wrong side of its own rule:
      //   - BOUNDED demand, held below the stage default at 20/40: the two
      //     BALLOT methods, capped by a room of MAX_BALLOT_CAP attendees, and
      //     the widget's `submit`, which additionally buys a Bedrock invocation
      //     downstream per request.
      //   - UNBOUNDED demand, restating the default's 100/200 as a limit of
      //     their own: the two widget READS, whose callers are a third party's
      //     page views — a rate this stack cannot bound and is not told about.
      // Stating a value that equals the default is not a no-op: it decouples
      // those two from a stage-wide number that may be tuned for entirely
      // unrelated reasons.
      //
      // As STAGE METHOD SETTINGS rather than as a usage plan, which is what the
      // /mcp route uses: a usage plan's throttle binds per API KEY, and these
      // methods deliberately require none, so a plan attached to them would
      // never apply to the requests that matter. Method settings are keyed by
      // path and apply to every caller.
      //
      // The rationale for each pair lives on the CONSTANT that carries it —
      // publicRouteThrottle and publicWidgetReadThrottle above — so there is one
      // authoritative explanation per pair rather than a general one here that
      // fits only some of the entries. For the two BALLOT entries specifically:
      // 20/s with a burst of 40 is roughly 30x what the feature needs, since a
      // room is bounded by MAX_BALLOT_CAP (200) ballots and submits once each,
      // while still cutting a scripted flood down to something a single small
      // table absorbs. That argument is about a bounded room and does NOT
      // generalise to the widget reads below.
      //
      // NOTHING OBSERVES ANY OF THESE CEILINGS. There is no CloudWatch alarm
      // and no metric filter anywhere in this stack, so a wrongly-sized limit
      // produces no signal on the operator's side: each budget is shared
      // deployment-wide and can be spent by traffic this account does not own or
      // see, and a breach reaches the customer as one of three symptoms that
      // name neither the limit nor each other (per route — see
      // publicWidgetReadThrottle: "Failed to load form." on `config`,
      // indistinguishable from a network outage; an alert box on `submit`; a
      // broken frame on `iframe`), so support looks for the wrong cause in all
      // three. Not a regression — these routes had no alarm at the stage default
      // either — and out of scope for a throttle change, but it is what would
      // make these numbers tunable in practice rather than only in principle. A
      // single alarm on the stage's 4XXError, or better a ThrottledRequests one,
      // is the smallest useful follow-up: smaller than the per-form submission
      // cap (see publicRouteThrottle) or the iframe caching (see
      // publicWidgetReadThrottle). It is not added here because an alarm needs a
      // destination to be worth anything and this stack has no SNS topic or
      // notification path to attach one to.
      methodOptions: {
        '/voting-sessions/{session_id}/config/GET': publicRouteThrottle,
        '/voting-sessions/{session_id}/submit/POST': publicRouteThrottle,
        // The three feedback-form widget methods, which were the only members
        // of the public set still riding the stage default — see
        // INTENTIONALLY_PUBLIC_ROUTES in api-stack.test.ts for the full list
        // of five. TWO different pairs, not one: `submit` joins the ballots at
        // 20/40, while `config` and `iframe` are stated at the stage default's
        // 100/200 because their legitimate demand is a customer's page-view
        // rate rather than a bounded room. The full argument for the split is
        // on publicRouteThrottle / publicWidgetReadThrottle above.
        //
        // `submit` is the one that earns the tighter pair, and the reason is
        // DOWNSTREAM rather than local. In the handler
        // (submit_form_feedback in lambda/api/feedback_form_handler.py) one
        // request costs three operations: a get_item for the form, an optional
        // conditional update_item to anchor its brand (_anchor_form_brand), and
        // an SQS send_message. It never writes the feedback table — and cannot:
        // this role holds feedbackTable.grantReadData only (see above).
        //
        // The write happens in lambda/processor/handler.py, off the queue, and
        // it does not arrive alone: each enqueued record drives Comprehend
        // language detection, a Translate call, Comprehend sentiment AND a
        // Bedrock LLM invocation (invoke_bedrock_llm). So an anonymous caller
        // at this ceiling buys a per-request model invocation against a shared
        // account quota — which is the real reason 20 rps rather than any
        // DynamoDB cost, and the thing to weigh before raising it.
        //
        // This is an UPSTREAM BACKSTOP, not a bound on model consumption, and
        // the difference matters to anyone tuning it. The queue decouples the
        // two: `submit` only enqueues, and the processor is an SQS event source
        // (batchSize 10, no maxConcurrency and no reservedConcurrentExecutions
        // anywhere in these stacks), so what actually paces Bedrock is Lambda's
        // account concurrency draining the queue. This ceiling bounds the
        // STEADY-STATE arrival rate; it does not bound the burst a filled queue
        // replays, and 20 rps sustained is still ~1.7M invocations/day. The
        // effective control is consumer-side — maxConcurrency on the event
        // source, or reservedConcurrentExecutions on the processor — and that is
        // a processing-stack change, so it is DEFERRED rather than considered
        // covered here. Recorded so the Bedrock argument above is not read as
        // bottoming out at API Gateway.
        //
        // Keys are spelled `{form_id}`, matching
        // `feedbackFormsResource.addResource('{form_id}')`, and are omitted
        // entirely when skipFeedbackFormItemRoutes is set (see
        // publicFeedbackFormMethodOptions above).
        ...publicFeedbackFormMethodOptions,
        // Plugin webhook receivers (public: the provider signs, the handler
        // verifies) — see publicWebhookMethodOptions above.
        ...publicWebhookMethodOptions,
        // The global MCP endpoint (global-mcp.ts): its caller holds a bearer
        // token, not a Cognito session, and an invalid token still costs a
        // DynamoDB read before the 401, so it is throttled like the public
        // routes above (20 rps / 40: an agent's tool loop is bursty, and a burst
        // of 40 absorbs a model turn while capping a token brute-force at ~1.7M
        // attempts/day against a 2^256 space). The per-project `/mcp/POST` and
        // `/mcp/{proxy+}` keys went with that server in 3.00.00.
        ...GLOBAL_MCP_METHOD_THROTTLE,
      },
      metricsEnabled: true,
      loggingLevel: apigateway.MethodLoggingLevel.INFO,
      dataTraceEnabled: false,
      accessLogDestination: new apigateway.LogGroupLogDestination(apiLogGroup),
      accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
    },
    defaultCorsPreflightOptions: {
      allowOrigins: apigateway.Cors.ALL_ORIGINS,
      allowMethods: apigateway.Cors.ALL_METHODS,
      allowHeaders: CORS_ALLOW_HEADERS,
      exposeHeaders: CORS_EXPOSE_HEADERS,
    },
    cloudWatchRoleRemovalPolicy: cdk.RemovalPolicy.DESTROY
  });

  NagSuppressions.addResourceSuppressions(api, apiGatewayRequestValidationSuppressions, true);

  // Gateway responses for CORS on errors
  api.addGatewayResponse('Default4XX', {
    type: apigateway.ResponseType.DEFAULT_4XX,
    responseHeaders: gatewayErrorCorsHeaders(allowedOrigin),
  });
  api.addGatewayResponse('Default5XX', {
    type: apigateway.ResponseType.DEFAULT_5XX,
    responseHeaders: gatewayErrorCorsHeaders(allowedOrigin),
  });
  // API-WIDE, deliberately: this fires on every gateway-GENERATED 401 —
  // the MCP token authorizer refusing a malformed Bearer shape, AND the
  // Cognito authorizer rejecting any other route. The challenge is truthful
  // for both, because every credential this API accepts arrives as
  // `Authorization: Bearer …` (a Cognito ID token is a bearer token), so
  // RFC 6750's challenge is the right answer everywhere. A gateway response
  // is also the ONLY place this header can be set on a REST API: 401s
  // produced INSIDE a Lambda proxy integration have it unconditionally
  // remapped to `x-amzn-remapped-www-authenticate` (documented, no opt-out
  // — verified live 2026-08-18), so the MCP handler keeps sending it and
  // clients on that path receive it under the remapped name.
  // Pinned by 'unauthorized gateway response' in api-stack.test.ts.
  api.addGatewayResponse('Unauthorized', {
    type: apigateway.ResponseType.UNAUTHORIZED,
    responseHeaders: {
      // A 401 is the most credential-dependent answer this API gives, and it is
      // produced by the authorizer rather than by the Lambda — so the `Vary`
      // the MCP handler sends on its own responses does not reach it. Without this, an
      // intermediary could cache the authorizer's 401 against the endpoint alone
      // and serve it to a request carrying a perfectly good credential.
      ...gatewayErrorCorsHeaders(allowedOrigin, ['Authorization']),
      'WWW-Authenticate': '\'Bearer error="invalid_token"\'',
      'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS_VALUE,
    },
  });

  // Cognito Authorizer
  const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(stack, 'VocCognitoAuthorizer', {
    cognitoUserPools: [userPool],
    authorizerName: 'voc-cognito-authorizer',
    identitySource: 'method.request.header.Authorization',
  });

  const authMethodOptions: apigateway.MethodOptions = { authorizer: cognitoAuthorizer, authorizationType: apigateway.AuthorizationType.COGNITO };

  return { api, authMethodOptions, skipFeedbackFormItemRoutes };
}

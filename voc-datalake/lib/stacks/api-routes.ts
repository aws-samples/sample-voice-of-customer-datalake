/**
 * VocApiStack's REST routes: every resource and method, wired to its domain
 * Lambda. Resources are created on the stack's RestApi — see api-context.ts.
 */
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NagSuppressions } from 'cdk-nag';
import type { PluginManifest } from '../plugin-loader';
import { snapStartAlias } from '../utils/snapstart';
import {
  publicBallotEndpointSuppressions,
  publicFeedbackEndpointSuppressions,
  publicUnsubscribeEndpointSuppressions,
  publicWebhookEndpointSuppressions,
} from '../utils/nag-suppressions';
import { addBrowserPreflight as cors, type ApiGateway } from './api-gateway';
import { CHAT_STREAM_TIMEOUT, type AssistantLambdas } from './api-assistant-lambdas';
import type { DataLambdas } from './api-data-lambdas';
import type { EngagementLambdas } from './api-engagement-lambdas';
import { partitionOf } from '../utils/model-allowlist';

export interface RouteTargets extends DataLambdas, EngagementLambdas, AssistantLambdas {
  projectsLambda: lambda.Function;
  /** /radar, /radar/{proxy+} (docs/radar.md). */
  radarLambda: lambda.Function;
  /** voc-engagement-api: /participants/*, /feature-requests/*, POST /unsubscribe. */
  engagementLambda: lambda.Function;
  webhookPlugins: PluginManifest[];
  webhookLambdas: Map<string, lambda.Function>;
}

export function addApiRoutes(stack: cdk.Stack, gateway: ApiGateway, targets: RouteTargets): void {
  const { api, authMethodOptions, boardAuthMethodOptions, skipFeedbackFormItemRoutes } = gateway;
  const {
    metricsLambda, feedbackEditLambda, integrationsLambda, scrapersLambda, settingsLambda, usersLambda,
    feedbackFormLambda, chatLambda, chatStreamLambda, projectsLambda, manualImportLambda, logsLambda,
    s3ImportLambda, dataExplorerLambda, ballotsLambda, memoryLambda, agentsLambda, radarLambda, engagementLambda,
    webhookPlugins, webhookLambdas,
  } = targets;

  // Lambda integrations — every one frugal (see frugalIntegration below).
  // SnapStart functions are integrated through their published `live` alias —
  // `$LATEST` is never snapshotted (lib/utils/snapstart.ts).
  const metricsIntegration = frugalIntegration(metricsLambda);
  const feedbackEditIntegration = frugalIntegration(feedbackEditLambda);
  const integrationsIntegration = frugalIntegration(snapStartAlias(integrationsLambda));
  const scrapersIntegration = frugalIntegration(scrapersLambda);
  const settingsIntegration = frugalIntegration(settingsLambda);
  const usersIntegration = frugalIntegration(usersLambda);
  const feedbackFormIntegration = frugalIntegration(snapStartAlias(feedbackFormLambda));
  const chatIntegration = frugalIntegration(chatLambda);
  const chatStreamIntegration = frugalIntegration(chatStreamLambda);
  const projectsIntegration = frugalIntegration(projectsLambda);
  const manualImportIntegration = frugalIntegration(manualImportLambda);
  const logsIntegration = frugalIntegration(logsLambda);
  const s3ImportIntegration = frugalIntegration(s3ImportLambda);
  const dataExplorerIntegration = frugalIntegration(dataExplorerLambda);
  const ballotsIntegration = frugalIntegration(ballotsLambda);
  const memoryIntegration = frugalIntegration(snapStartAlias(memoryLambda));
  const agentsIntegration = frugalIntegration(agentsLambda);

  // ============================================
  // API ROUTES
  // ============================================
  // Every resource that serves a browser method carries its own CORS preflight (`cors`, a MOCK
  // OPTIONS); path-only parents carry none (BROWSER_PREFLIGHT in api-gateway.ts). Every proxy
  // passes `defaultMethodOptions`: a proxy without it is AuthorizationType.NONE.
  const proxyOf = (
    parent: apigateway.IResource, integration: apigateway.LambdaIntegration,
    methodOptions: apigateway.MethodOptions = authMethodOptions,
  ) => cors(parent.addProxy({ defaultIntegration: integration, anyMethod: true, defaultMethodOptions: methodOptions }));
  /** A Cognito `{proxy+}` serving ONLY the listed verbs (no ANY), each to its own integration. */
  const proxyServing = (parent: apigateway.IResource, verbs: Record<string, apigateway.LambdaIntegration>) => {
    const proxy = cors(parent.addProxy({ anyMethod: false, defaultMethodOptions: authMethodOptions }));
    for (const [verb, integration] of Object.entries(verbs)) proxy.addMethod(verb, integration, authMethodOptions);
  };

  // /feedback/* — three resources (5.47.00; ten before). `/feedback/{id}` GET also serves the
  // single-segment reads (`access`, `urgent`, `entities`, `search`, `problems`): the metrics Lambda
  // resolves by PATH and Powertools matches its static routes before `/feedback/<id>`. Under the item,
  // a proxy with GET → metrics (`similar`) and PUT → feedback edit (`category`, `dimensions`, the only
  // feedback WRITE routes, their own Lambda). Never a sibling `{proxy+}` of `{id}`: API Gateway
  // allows one variable path part per level, and CloudFormation creates the new resource before it
  // deletes the old, so that swap fails on every deployed environment.
  const feedbackResource = cors(api.root.addResource('feedback'));
  feedbackResource.addMethod('GET', metricsIntegration, authMethodOptions);
  const feedbackIdResource = cors(feedbackResource.addResource('{id}'));
  feedbackIdResource.addMethod('GET', metricsIntegration, authMethodOptions);
  proxyServing(feedbackIdResource, { GET: metricsIntegration, PUT: feedbackEditIntegration });

  // /metrics/* — proxy to metrics Lambda
  const metricsResource = api.root.addResource('metrics');
  // Release watch (`GET /metrics/release-watch`) is served by this proxy since 5.47.00, and the
  // per-source usefulness distribution (`GET /metrics/data-quality`, docs/data-quality.md) too.
  proxyOf(metricsResource, metricsIntegration);

  // /chat/* — the assistant streams at the static /chat/stream; every other path (the sessions
  // under /chat/conversations) goes to the chat Lambda. There is no non-streaming POST /chat.
  const chatResource = api.root.addResource('chat');
  const chatStreamResource = cors(chatResource.addResource('stream'));
  const chatStreamMethod = chatStreamResource.addMethod('POST', chatStreamIntegration, authMethodOptions);
  proxyOf(chatResource, chatIntegration);

  // Apply API Gateway response-streaming overrides to /chat/stream.
  // Cast through `unknown` to the L1 CfnMethod type — `defaultChild` is typed as
  // `IConstruct | undefined` so a direct cast is rejected by the type checker.
  const chatStreamMethodChild = chatStreamMethod.node.defaultChild;
  if (!(chatStreamMethodChild instanceof apigateway.CfnMethod)) {
    throw new TypeError('Expected chatStreamMethod.node.defaultChild to be an apigateway.CfnMethod');
  }
  const chatStreamCfnMethod = chatStreamMethodChild;
  chatStreamCfnMethod.addPropertyOverride('Integration.ResponseTransferMode', 'STREAM');
  chatStreamCfnMethod.addPropertyOverride('Integration.TimeoutInMillis', CHAT_STREAM_TIMEOUT.toMilliseconds());
  chatStreamCfnMethod.addPropertyOverride(
    'Integration.Uri',
    `arn:${partitionOf(stack.region)}:apigateway:${stack.region}:lambda:path/2021-11-15/functions/${chatStreamLambda.functionArn}/response-streaming-invocations`
  );

  // /integrations/* and /sources/* — ANY on `{source}` serves the one-segment paths (`status`),
  // its proxy everything deeper (credentials, apps, enable, disable, run, reset); the integrations
  // Lambda routes by path. `{source}` stays (no `{proxy+}` sibling, see /feedback above).
  for (const pathPart of ['integrations', 'sources']) {
    const sourceResource = cors(api.root.addResource(pathPart).addResource('{source}'));
    sourceResource.addMethod('ANY', integrationsIntegration, authMethodOptions);
    proxyOf(sourceResource, integrationsIntegration);
  }

  // /scrapers/*
  const scrapersResource = cors(api.root.addResource('scrapers'));
  scrapersResource.addMethod('GET', scrapersIntegration, authMethodOptions);
  scrapersResource.addMethod('POST', scrapersIntegration, authMethodOptions);
  // /scrapers/manual/* — the manual import Lambda (admin middleware on every route).
  proxyOf(scrapersResource.addResource('manual'), manualImportIntegration);
  proxyOf(scrapersResource, scrapersIntegration);

  // /s3-import/* — proxy to s3 import Lambda
  proxyOf(api.root.addResource('s3-import'), s3ImportIntegration);

  // /data-explorer/* — a proxy with GET and PUT ONLY: customer data is never deleted, so no
  // DELETE (and no ANY) is routed under /data-explorer, and the role holds no delete permission
  // either. `PUT /s3` refuses (409) to overwrite an existing object under raw/. The handler is
  // admin-only on every route (require_admin).
  proxyServing(api.root.addResource('data-explorer'), { GET: dataExplorerIntegration, PUT: dataExplorerIntegration });

  // /settings/* — proxy to settings Lambda
  proxyOf(api.root.addResource('settings'), settingsIntegration);

  // /logs/* — proxy to logs Lambda
  proxyOf(api.root.addResource('logs'), logsIntegration);

  // /users/*
  const usersResource = cors(api.root.addResource('users'));
  usersResource.addMethod('GET', usersIntegration, authMethodOptions);
  usersResource.addMethod('POST', usersIntegration, authMethodOptions);
  proxyOf(usersResource, usersIntegration);

  // /feedback-forms/* (multiple forms)
  //
  // Item routes are declared EXPLICITLY instead of behind an `anyMethod` proxy.
  // A proxy with no `defaultMethodOptions` defaults every method to
  // AuthorizationType.NONE, which published form update, form delete and reads
  // of submitted customer feedback with no credentials at all. Explicit routes
  // fail closed: a new handler route is unreachable until it is wired here,
  // rather than silently inheriting a catch-all's (absent) authorization.
  //
  // Only the three routes the embeddable widget needs stay public — verified
  // against lambda/api/static/feedback-widget.js (config + submit) plus the
  // /iframe embed variant, which a browser navigates to directly. Keep this
  // list and lambda/api/feedback_form_handler.py in step: every route the
  // handler registers needs a method here, and api-stack.test.ts asserts that
  // only these three are unauthenticated.
  //
  // Do NOT reintroduce a {proxy+} here to avoid the two-step upgrade it costs
  // on already-deployed environments: {form_id} and {proxy+} cannot coexist as
  // sibling variable paths, which is what makes the upgrade two deploys. See
  // docs/deployment.md, "A sibling ({proxy+}) of this resource...".
  const feedbackFormsResource = cors(api.root.addResource('feedback-forms'));
  feedbackFormsResource.addMethod('GET', feedbackFormIntegration, authMethodOptions);
  feedbackFormsResource.addMethod('POST', feedbackFormIntegration, authMethodOptions);

  // `skipFeedbackFormItemRoutes` — the one-shot flag for upgrading an
  // environment that still has the old /feedback-forms/{proxy+}. Read above the
  // RestApi (it also gates this subtree's stage method settings); this is the
  // branch it exists for.
  //
  // CloudFormation creates new resources before deleting old ones inside a
  // single update, so {form_id} and {proxy+} would exist together and API
  // Gateway rejects two variable path parts at one level. Deploy once with
  // -c skipFeedbackFormItemRoutes=true to retire the proxy, then deploy again
  // without it to create these routes.
  //
  // Absent (the default, and always for fresh deployments) this is a no-op —
  // the synthesized template is identical either way. Never leave it set:
  // while it is on, the per-form routes do not exist and the embeddable widget
  // is down. See docs/deployment.md.
  //
  // RETIREMENT CONDITION: this flag exists only to migrate environments deployed
  // before the item routes became explicit. Once every environment has run the
  // two-deploy upgrade, delete the flag, this branch and its tests — a
  // permanently available "skip the authorization-bearing routes" switch is a
  // footgun once nothing needs it.
  if (skipFeedbackFormItemRoutes) {
    cdk.Annotations.of(stack).addWarningV2(
      'voc:skipFeedbackFormItemRoutes',
      'skipFeedbackFormItemRoutes is set: /feedback-forms/{form_id}/* is NOT being deployed. '
      + 'This is the first of two upgrade deploys — re-deploy without the flag to restore the routes.',
    );
  } else {
    const feedbackFormItem = cors(feedbackFormsResource.addResource('{form_id}'));
    feedbackFormItem.addMethod('PUT', feedbackFormIntegration, authMethodOptions);
    feedbackFormItem.addMethod('DELETE', feedbackFormIntegration, authMethodOptions);
    cors(feedbackFormItem.addResource('submissions')).addMethod('GET', feedbackFormIntegration, authMethodOptions);
    cors(feedbackFormItem.addResource('stats')).addMethod('GET', feedbackFormIntegration, authMethodOptions);

    // Intentionally unauthenticated: the widget runs on the customer's own site.
    //
    // These three are named in INTENTIONALLY_PUBLIC_ROUTES in api-stack.test.ts,
    // and all three carry an EXPLICIT pair in `deployOptions.methodOptions` at
    // the top of this stack — keyed by these exact paths, and pinned against
    // them by a test, because a mistyped key throttles nothing and says nothing.
    //
    // Two pairs, not one, and only ONE of them is below the stage default:
    // `submit` is held at 20/40 (a per-request Bedrock invocation downstream),
    // while `config` and `iframe` RESTATE the stage default's 100/200 as a
    // ceiling of their own. Restating it is not redundant with the default —
    // it pins the two reads to the demand THEY have (a customer's page-view
    // rate), so a later tightening of the stage-wide number cannot silently
    // squeeze a third party's page. See publicWidgetReadThrottle for the full
    // argument before deleting either entry as duplicative.
    const publicFeedbackFormMethods = [
      cors(feedbackFormItem.addResource('config')).addMethod('GET', feedbackFormIntegration),
      cors(feedbackFormItem.addResource('submit')).addMethod('POST', feedbackFormIntegration),
      cors(feedbackFormItem.addResource('iframe')).addMethod('GET', feedbackFormIntegration),
    ];
    for (const publicMethod of publicFeedbackFormMethods) {
      NagSuppressions.addResourceSuppressions(publicMethod, publicFeedbackEndpointSuppressions);
    }
  }

  // /projects/*
  const projectsResource = cors(api.root.addResource('projects'));
  projectsResource.addMethod('GET', projectsIntegration, authMethodOptions);
  projectsResource.addMethod('POST', projectsIntegration, authMethodOptions);
  proxyOf(projectsResource, projectsIntegration);

  // /memory/*, /agents/*, /workflows/* — every method Cognito-authenticated,
  // the proxies included (defaultMethodOptions — a proxy without it is
  // AuthorizationType.NONE). Per-route authorization (owner / admin /
  // memory_reviewer) is the handlers'. Pinned by the route-auth invariant.
  // `rootMethods`: only the verbs the handler registers on the collection itself
  // (api-route-liveness.test.ts fails on a method no handler answers).
  const cognitoCollectionWithProxy = (
    pathPart: string, integration: apigateway.LambdaIntegration, rootMethods: readonly string[] = ['GET', 'POST'],
  ) => {
    const resource = api.root.addResource(pathPart);
    if (rootMethods.length > 0) cors(resource);
    for (const method of rootMethods) resource.addMethod(method, integration, authMethodOptions);
    proxyOf(resource, integration);
  };
  cognitoCollectionWithProxy('memory', memoryIntegration);
  cognitoCollectionWithProxy('agents', agentsIntegration);
  cognitoCollectionWithProxy('workflows', agentsIntegration);
  // Radar (other brands): reads for every signed-in user, admin-only writes in the handler.
  cognitoCollectionWithProxy('radar', frugalIntegration(radarLambda), ['GET']);
  // The company persona library (shared/company_personas_routes.py in the projects Lambda): reads for
  // every signed-in user, admin-only writes in the handler. Its own root resource: the container is
  // never addressable under /projects (the handler answers 404 there).
  cognitoCollectionWithProxy('company-personas', projectsIntegration, ['GET']);

  // Engagement (voc-engagement-api). ONE integration, so ONE invoke permission for all three trees.
  const engagementIntegration = frugalIntegration(engagementLambda);
  // /participants/* — app users only (the main authorizer); nothing is served on the bare collection.
  cognitoCollectionWithProxy('participants', engagementIntegration, []);
  // /feature-requests/* — the board authorizer (app pool + board pool), proxy included.
  const featureRequestsResource = cors(api.root.addResource('feature-requests'));
  for (const method of ['GET', 'POST']) featureRequestsResource.addMethod(method, engagementIntegration, boardAuthMethodOptions);
  proxyOf(featureRequestsResource, engagementIntegration, boardAuthMethodOptions);
  // /review/* — document review links (docs/document-review.md), the BOARD authorizer like
  // /feature-requests: a reviewer outside the company signs in with the board pool's emailed code.
  // Its own root resource, never inside the app-only /projects proxy. Served by the projects
  // Lambda (shared/document_review_routes.py), which re-checks the link and the verified email on
  // every call; throttled 10 rps / 20 by REVIEW_METHOD_KEYS in api-gateway.ts.
  proxyOf(api.root.addResource('review'), projectsIntegration, boardAuthMethodOptions);
  // POST /unsubscribe — intentionally unauthenticated, on its OWN root resource (never a public
  // exception inside an authenticated proxy). A mail recipient, or the mail client's RFC 8058
  // one-click POST, carries only the emailed token; the handler always answers 200, can only
  // unsubscribe the person that token names, and stores only the token's hash. Named in
  // INTENTIONALLY_PUBLIC_ROUTES (test-support/api-stack-template.ts); throttled 5 rps / 10 by
  // UNSUBSCRIBE_METHOD_KEY in api-gateway.ts.
  const unsubscribeMethod = cors(api.root.addResource('unsubscribe')).addMethod('POST', engagementIntegration);
  NagSuppressions.addResourceSuppressions(unsubscribeMethod, publicUnsubscribeEndpointSuppressions);

  // /voting-sessions/* — a room scores one document from their phones.
  //
  // NOT under /projects: that resource ends in a {proxy+} carrying the Cognito
  // authorizer, and the two routes below that a phone reaches have no
  // credentials at all. A public exception inside an authenticated proxy is the
  // defect shape api-stack.test.ts exists to catch, so this gets its own tree.
  //
  // Every method is declared EXPLICITLY, with no {proxy+} anywhere: a proxy
  // without `defaultMethodOptions` defaults to AuthorizationType.NONE, which is
  // how three feedback-form routes became anonymous. Explicit methods fail
  // closed — a route the handler registers is unreachable until it is wired
  // here, which is the direction to fail in for a handler that accepts writes
  // from anyone holding a link.
  const votingSessionsResource = cors(api.root.addResource('voting-sessions'));
  votingSessionsResource.addMethod('POST', ballotsIntegration, authMethodOptions);
  // `?row_id=`: the row's open vote, so a reloaded page can show its link and close it.
  votingSessionsResource.addMethod('GET', ballotsIntegration, authMethodOptions);
  const votingSessionItem = cors(votingSessionsResource.addResource('{session_id}'));
  votingSessionItem.addMethod('GET', ballotsIntegration, authMethodOptions);
  cors(votingSessionItem.addResource('close')).addMethod('POST', ballotsIntegration, authMethodOptions);

  // Intentionally unauthenticated: the room votes from personal phones with no
  // account. The SESSION is the control — a ballot is accepted only against a
  // valid unguessable session token, only while that session is open and
  // unexpired, and only up to its ballot cap (enforced by a conditional atomic
  // increment on the session record). `config` is what lets the page say "this
  // session is closed" instead of showing a blank form.
  //
  // These two are named in INTENTIONALLY_PUBLIC_ROUTES in api-stack.test.ts.
  // That list is the review gate: adding to it is a deliberate act, and the test
  // failing until it is extended is the intended behaviour.
  //
  // Both are throttled below the stage default by `deployOptions.methodOptions`
  // at the top of this stack — keyed by these exact paths, and pinned against
  // them by a test, because a mistyped key throttles nothing and says nothing.
  const publicBallotMethods = [
    cors(votingSessionItem.addResource('config')).addMethod('GET', ballotsIntegration),
    cors(votingSessionItem.addResource('submit')).addMethod('POST', ballotsIntegration),
  ];
  for (const publicMethod of publicBallotMethods) {
    NagSuppressions.addResourceSuppressions(publicMethod, publicBallotEndpointSuppressions);
  }


  // /webhooks/{pluginId} — no CORS preflight: a provider's server-to-server POST never sends one.
  const webhooksResource = api.root.addResource('webhooks');
  for (const plugin of webhookPlugins) {
    const webhookFn = webhookLambdas.get(plugin.id);
    if (!webhookFn || !plugin.infrastructure.webhook) continue;
    const webhookIntegration = frugalIntegration(webhookFn);
    const pluginResource = webhooksResource.addResource(plugin.id);
    for (const method of plugin.infrastructure.webhook.methods) {
      const webhookMethod = pluginResource.addMethod(method, webhookIntegration);
      NagSuppressions.addResourceSuppressions(webhookMethod, publicWebhookEndpointSuppressions);
    }
  }
}

/**
 * A proxy integration that grants its target ONE invoke permission scoped to
 * this RestApi (`…/<restApiId>/*\/*\/*`) instead of CDK's default of two per
 * method (`scopePermissionToMethod: true` → one per method plus one for
 * test-invoke). VocApiStack sits near CloudFormation's 500-resource ceiling
 * (502 once, with every plugin on), and FeedbackFormApi alone spent 20 resources
 * on per-method permissions. The function is still invocable only by API Gateway
 * on THIS RestApi, and only the methods that integrate it route to it — the
 * frugal pattern global-mcp.ts started. Pinned by api-stack-invoke-permissions.test.ts.
 */
function frugalIntegration(handler: lambda.IFunction): apigateway.LambdaIntegration {
  return new apigateway.LambdaIntegration(handler, { proxy: true, scopePermissionToMethod: false });
}

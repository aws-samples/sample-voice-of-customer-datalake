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
  publicWebhookEndpointSuppressions,
} from '../utils/nag-suppressions';
import type { ApiGateway } from './api-gateway';
import { CHAT_STREAM_TIMEOUT, type AssistantLambdas } from './api-assistant-lambdas';
import type { DataLambdas } from './api-data-lambdas';
import type { EngagementLambdas } from './api-engagement-lambdas';

export interface RouteTargets extends DataLambdas, EngagementLambdas, AssistantLambdas {
  projectsLambda: lambda.Function;
  /** /radar, /radar/{proxy+} (docs/radar.md). */
  radarLambda: lambda.Function;
  webhookPlugins: PluginManifest[];
  webhookLambdas: Map<string, lambda.Function>;
}

export function addApiRoutes(stack: cdk.Stack, gateway: ApiGateway, targets: RouteTargets): void {
  const { api, authMethodOptions, skipFeedbackFormItemRoutes } = gateway;
  const {
    metricsLambda, feedbackEditLambda, integrationsLambda, scrapersLambda, settingsLambda, usersLambda,
    feedbackFormLambda, chatLambda, chatStreamLambda, projectsLambda, manualImportLambda, logsLambda,
    s3ImportLambda, dataExplorerLambda, ballotsLambda, memoryLambda, agentsLambda, radarLambda, webhookPlugins, webhookLambdas,
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

  // /feedback/*
  const feedbackResource = api.root.addResource('feedback');
  feedbackResource.addMethod('GET', metricsIntegration, authMethodOptions);
  const feedbackIdResource = feedbackResource.addResource('{id}');
  feedbackIdResource.addMethod('GET', metricsIntegration, authMethodOptions);
  feedbackIdResource.addResource('similar').addMethod('GET', metricsIntegration, authMethodOptions);
  // The only feedback WRITE routes — their own Lambda (see FeedbackEditApi):
  // a review's category, and its dimensions/tags (docs/dimensions.md).
  feedbackIdResource.addResource('category').addMethod('PUT', feedbackEditIntegration, authMethodOptions);
  feedbackIdResource.addResource('dimensions').addMethod('PUT', feedbackEditIntegration, authMethodOptions);
  // The caller's category scope ({all, categories}) for the UI and the assistant.
  feedbackResource.addResource('access').addMethod('GET', metricsIntegration, authMethodOptions);
  feedbackResource.addResource('urgent').addMethod('GET', metricsIntegration, authMethodOptions);
  feedbackResource.addResource('entities').addMethod('GET', metricsIntegration, authMethodOptions);
  feedbackResource.addResource('search').addMethod('GET', metricsIntegration, authMethodOptions);
  // The Problem Analysis tree, aggregated over the whole window (docs/problem-analysis.md). Resolving a
  // problem is /settings/resolved-problems (settings Lambda); the metrics Lambda has no such route.
  feedbackResource.addResource('problems').addMethod('GET', metricsIntegration, authMethodOptions);

  // /metrics/* — proxy to metrics Lambda
  const metricsResource = api.root.addResource('metrics');
  metricsResource.addProxy({ defaultIntegration: metricsIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });
  // Release watch (docs/decisions-and-release-watch.md): declared explicitly beside
  // the proxy so the read-only, Cognito-only contract is visible in the stack.
  metricsResource.addResource('release-watch').addMethod('GET', metricsIntegration, authMethodOptions);

  // /chat/* — the assistant streams at /chat/stream; sessions live under
  // /chat/conversations. There is no non-streaming POST /chat any more.
  const chatResource = api.root.addResource('chat');
  const chatStreamResource = chatResource.addResource('stream');
  const chatStreamMethod = chatStreamResource.addMethod('POST', chatStreamIntegration, authMethodOptions);
  chatResource.addResource('conversations').addProxy({ defaultIntegration: chatIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

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
    `arn:aws:apigateway:${stack.region}:lambda:path/2021-11-15/functions/${chatStreamLambda.functionArn}/response-streaming-invocations`
  );

  // /integrations/*
  // {source} uses a greedy proxy so all sub-paths (credentials, apps, apps/{id})
  // route to the integrations Lambda, which owns the routing.
  const integrationsResource = api.root.addResource('integrations');
  integrationsResource.addResource('status').addMethod('GET', integrationsIntegration, authMethodOptions);
  const intSourceResource = integrationsResource.addResource('{source}');
  intSourceResource.addProxy({ defaultIntegration: integrationsIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

  // /sources/*
  // {source} uses a greedy proxy so all sub-paths (enable, disable, run)
  // route to the integrations Lambda.
  const sourcesResource = api.root.addResource('sources');
  sourcesResource.addResource('status').addMethod('GET', integrationsIntegration, authMethodOptions);
  const srcSourceResource = sourcesResource.addResource('{source}');
  srcSourceResource.addProxy({ defaultIntegration: integrationsIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

  // /scrapers/*
  const scrapersResource = api.root.addResource('scrapers');
  scrapersResource.addMethod('GET', scrapersIntegration, authMethodOptions);
  scrapersResource.addMethod('POST', scrapersIntegration, authMethodOptions);
  const manualResource = scrapersResource.addResource('manual');
  const manualParseResource = manualResource.addResource('parse');
  manualParseResource.addMethod('POST', manualImportIntegration, authMethodOptions);
  manualParseResource.addResource('{jobId}').addMethod('GET', manualImportIntegration, authMethodOptions);
  manualResource.addResource('confirm').addMethod('POST', manualImportIntegration, authMethodOptions);
  manualResource.addResource('json-upload').addMethod('POST', manualImportIntegration, authMethodOptions);
  manualResource.addResource('csv-upload').addMethod('POST', manualImportIntegration, authMethodOptions);
  scrapersResource.addProxy({ defaultIntegration: scrapersIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

  // /s3-import/* — proxy to s3 import Lambda
  const s3ImportResource = api.root.addResource('s3-import');
  s3ImportResource.addProxy({ defaultIntegration: s3ImportIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

  // /data-explorer/* — explicit routes, no {proxy+}: customer data is never
  // deleted, so there is deliberately NO DELETE method on /s3 or /feedback.
  // A catch-all would keep a DELETE reachable at the gateway the day a
  // handler route reappeared; explicit routes make removing it structural.
  // The handler is admin-only on every route (require_admin).
  const dataExplorerResource = api.root.addResource('data-explorer');
  const dataExplorerS3Resource = dataExplorerResource.addResource('s3');
  dataExplorerS3Resource.addMethod('GET', dataExplorerIntegration, authMethodOptions);
  // Refuses (409) to overwrite an existing object under raw/.
  dataExplorerS3Resource.addMethod('PUT', dataExplorerIntegration, authMethodOptions);
  dataExplorerS3Resource.addResource('preview').addMethod('GET', dataExplorerIntegration, authMethodOptions);
  dataExplorerResource.addResource('feedback').addMethod('PUT', dataExplorerIntegration, authMethodOptions);
  dataExplorerResource.addResource('buckets').addMethod('GET', dataExplorerIntegration, authMethodOptions);

  // /settings/* — proxy to settings Lambda
  const settingsResource = api.root.addResource('settings');
  settingsResource.addProxy({ defaultIntegration: settingsIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

  // /logs/* — proxy to logs Lambda
  const logsResource = api.root.addResource('logs');
  logsResource.addProxy({ defaultIntegration: logsIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

  // /users/*
  const usersResource = api.root.addResource('users');
  usersResource.addMethod('GET', usersIntegration, authMethodOptions);
  usersResource.addMethod('POST', usersIntegration, authMethodOptions);
  usersResource.addProxy({ defaultIntegration: usersIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

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
  const feedbackFormsResource = api.root.addResource('feedback-forms');
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
    const feedbackFormItem = feedbackFormsResource.addResource('{form_id}');
    feedbackFormItem.addMethod('PUT', feedbackFormIntegration, authMethodOptions);
    feedbackFormItem.addMethod('DELETE', feedbackFormIntegration, authMethodOptions);
    feedbackFormItem.addResource('submissions').addMethod('GET', feedbackFormIntegration, authMethodOptions);
    feedbackFormItem.addResource('stats').addMethod('GET', feedbackFormIntegration, authMethodOptions);

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
      feedbackFormItem.addResource('config').addMethod('GET', feedbackFormIntegration),
      feedbackFormItem.addResource('submit').addMethod('POST', feedbackFormIntegration),
      feedbackFormItem.addResource('iframe').addMethod('GET', feedbackFormIntegration),
    ];
    for (const publicMethod of publicFeedbackFormMethods) {
      NagSuppressions.addResourceSuppressions(publicMethod, publicFeedbackEndpointSuppressions);
    }
  }

  // /projects/*
  const projectsResource = api.root.addResource('projects');
  projectsResource.addMethod('GET', projectsIntegration, authMethodOptions);
  projectsResource.addMethod('POST', projectsIntegration, authMethodOptions);
  projectsResource.addProxy({ defaultIntegration: projectsIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions });

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
    for (const method of rootMethods) resource.addMethod(method, integration, authMethodOptions);
    resource.addProxy({ defaultIntegration: integration, anyMethod: true, defaultMethodOptions: authMethodOptions });
  };
  cognitoCollectionWithProxy('memory', memoryIntegration);
  cognitoCollectionWithProxy('agents', agentsIntegration);
  cognitoCollectionWithProxy('workflows', agentsIntegration);
  // Radar (other brands): reads for every signed-in user, admin-only writes in the handler.
  cognitoCollectionWithProxy('radar', frugalIntegration(radarLambda), ['GET']);

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
  const votingSessionsResource = api.root.addResource('voting-sessions');
  votingSessionsResource.addMethod('POST', ballotsIntegration, authMethodOptions);
  // `?row_id=`: the row's open vote, so a reloaded page can show its link and close it.
  votingSessionsResource.addMethod('GET', ballotsIntegration, authMethodOptions);
  const votingSessionItem = votingSessionsResource.addResource('{session_id}');
  votingSessionItem.addMethod('GET', ballotsIntegration, authMethodOptions);
  votingSessionItem.addResource('close').addMethod('POST', ballotsIntegration, authMethodOptions);

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
    votingSessionItem.addResource('config').addMethod('GET', ballotsIntegration),
    votingSessionItem.addResource('submit').addMethod('POST', ballotsIntegration),
  ];
  for (const publicMethod of publicBallotMethods) {
    NagSuppressions.addResourceSuppressions(publicMethod, publicBallotEndpointSuppressions);
  }


  // /webhooks/{pluginId}
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

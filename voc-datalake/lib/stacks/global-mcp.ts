/**
 * Global MCP endpoint + personal token API (VocApiStack) — docs/mcp.md.
 *
 *   POST /mcp/global                       → voc-mcp-global-api (mcp_global_handler.py)
 *        bearer token; the token authorizer is this same function (api-mcp.ts,
 *        uncached), and the handler checks again on every request
 *   GET|DELETE /mcp/global                 → 405 from a MOCK integration (same authorizer)
 *   GET|POST /connect/tokens               → voc-mcp-tokens-api (mcp_tokens_handler.py), Cognito
 *   GET|DELETE /connect/tokens/{token_id}  (GET = the token + a page of its audit log)
 *        (not under /mcp: every /mcp… path is the bearer-token surface)
 *
 * The per-project endpoint (POST /mcp, mcp_handler.py) and its MCPTOKEN rows were
 * retired in 3.00.00. The global tokens live in their own partition (MCPGTOKEN),
 * the only one these roles can reach, so a stale per-project credential is a 401.
 *
 * Least privilege, each pinned by api-stack-mcp-global.test.ts:
 *  - global MCP role: GetItem/UpdateItem on the projects table's MCPGTOKEN
 *    partition only; PutItem on the jobs table's MCPAUDIT#… partitions only;
 *    AdminGetUser + AdminListGroupsForUser on this user pool; InvokeFunction
 *    on exactly the five domain functions it delegates to. No feedback,
 *    aggregates, memory or agents table grant — data comes through the
 *    domain functions, which apply their own rules.
 *  - tokens role: Query/GetItem/BatchGetItem/PutItem/UpdateItem on MCPGTOKEN, GetItem on
 *    PROJECT#… (the pin's view check), Query on MCPAUDIT#…; no Cognito, no
 *    invoke.
 *
 * Throttling: `/mcp/global/POST` is a stage method setting (20 rps / 40), set
 * by the owning stack (api-gateway.ts) — see GLOBAL_MCP_METHOD_THROTTLE.
 */
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

import { nonNegativeIntegerContext } from '../utils/context-flag';
import { GLOBAL_MCP_SERVICE_NAME } from '../utils/function-names';
import { snapStartFunctionProps, snapStartInvokeTarget } from '../utils/snapstart';
import { workerRole } from '../utils/worker-lambda';

/** Must equal GLOBAL_TOKEN_PK / AUDIT_PK_PREFIX in lambda/shared/mcp_global_tokens.py (pinned by a test). */
const GLOBAL_TOKEN_PARTITION = 'MCPGTOKEN';
const AUDIT_PARTITION_PREFIX = 'MCPAUDIT#';

/** Stage method-setting key and pair for the global endpoint (reasons in api-gateway.ts). */
export const GLOBAL_MCP_METHOD_THROTTLE: Record<string, apigateway.MethodDeploymentOptions> = {
  '/mcp/global/POST': { throttlingRateLimit: 20, throttlingBurstLimit: 40 },
  // The 405 mocks share the endpoint's ceiling: each still runs the token authorizer.
  '/mcp/global/GET': { throttlingRateLimit: 20, throttlingBurstLimit: 40 },
  '/mcp/global/DELETE': { throttlingRateLimit: 20, throttlingBurstLimit: 40 },
};

/**
 * Reserved concurrency of `voc-mcp-global-api` (docs/mcp.md → Alarms and concurrency). The function is
 * also its own token authorizer, so one request is two short invocations; at the stage ceiling (20 rps)
 * that needs well under 20 concurrent. The cap keeps a runaway client from taking the account's shared
 * pool from every other Lambda, and guarantees the endpoint its 20. It is taken from the account's
 * unreserved concurrency (which must stay at least 100), so the account quota must be 120 or more.
 */
export const GLOBAL_MCP_RESERVED_CONCURRENCY = 20;

/** The context key overriding {@link GLOBAL_MCP_RESERVED_CONCURRENCY}: `-c mcpReservedConcurrency=<n>`, 0 = none. */
const MCP_RESERVED_CONCURRENCY_CONTEXT = 'mcpReservedConcurrency';

/**
 * The endpoint's reservation from `-c mcpReservedConcurrency` (default 20), or undefined for 0: no
 * reservation (the function then shares the account's unreserved pool; a reservation of 0 would throttle
 * every request instead).
 */
function mcpReservedConcurrency(scope: Construct): number | undefined {
  const reserved = nonNegativeIntegerContext(scope.node.tryGetContext(MCP_RESERVED_CONCURRENCY_CONTEXT),
    MCP_RESERVED_CONCURRENCY_CONTEXT, GLOBAL_MCP_RESERVED_CONCURRENCY,
    'Use -c mcpReservedConcurrency=<whole number>, 0 for no reservation.');
  return reserved === 0 ? undefined : reserved;
}

/** The env key each domain's function name arrives in (= DOMAIN_FUNCTION_ENV in mcp_global_tools.py). */
type GlobalMcpDomainFunctions = Record<
  'METRICS_FUNCTION' | 'SETTINGS_FUNCTION' | 'MEMORY_FUNCTION' | 'PROJECTS_FUNCTION' | 'AGENTS_FUNCTION',
  lambda.IFunction
>;

export interface GlobalMcpProps {
  /** The owning stack's prefix-aware `uniqueName()`. */
  uniqueName: (baseName: string) => string;
  /** The owning stack's API-Lambda bundler (api/<file> + shared/). */
  createApiLambdaCode: (handlerFileName: string) => lambda.Code;
  apiLayer: lambda.ILayerVersion;
  allowedOrigin: string;
  /** The existing `/mcp` resource; `global` is added beside its `{proxy+}`. */
  mcpResource: apigateway.IResource;
  /** The `/mcp/global` token-authorizer options, built around the endpoint's own function (api-mcp.ts). */
  mcpMethodOptionsFor: (handler: lambda.IFunction) => apigateway.MethodOptions;
  /** Cognito options every signed-in route uses. */
  authMethodOptions: apigateway.MethodOptions;
  /** The CORS preflight of a method-bearing resource (BROWSER_PREFLIGHT in api-gateway.ts). */
  browserPreflight: apigateway.CorsOptions;
  apiRoot: apigateway.IResource;
  projectsTable: dynamodb.ITable;
  jobsTable: dynamodb.ITable;
  kmsKey: kms.IKey;
  userPool: cognito.IUserPool;
  domainFunctions: GlobalMcpDomainFunctions;
}

export function leadingKeys(table: dynamodb.ITable, actions: string[], operator: 'StringEquals' | 'StringLike', key: string) {
  return new iam.PolicyStatement({
    actions: actions.map((a) => `dynamodb:${a}`),
    resources: [table.tableArn],
    conditions: { [`ForAllValues:${operator}`]: { 'dynamodb:LeadingKeys': [key] } },
  });
}

export class GlobalMcp extends Construct {
  public readonly mcpFunction: lambda.Function;
  public readonly tokensFunction: lambda.Function;
  /** What every tokens route integrates: the function, or its `live` alias with `-c snapStart=true` (lib/utils/snapstart.ts). */
  public readonly tokensInvokeTarget: lambda.IFunction;

  constructor(scope: Construct, id: string, private readonly props: GlobalMcpProps) {
    super(scope, id);
    this.mcpFunction = this.createMcpFunction();
    this.tokensFunction = this.createTokensFunction();
    this.tokensInvokeTarget = snapStartInvokeTarget(this.tokensFunction);
    this.wireRoutes();
  }

  private role(id: string): iam.Role {
    return workerRole(this, id);
  }

  private pythonFunction(id: string, name: string, handlerFile: string, role: iam.Role,
    environment: Record<string, string>, memorySize = 256,
    extra: Partial<lambda.FunctionProps> = {}): lambda.Function {
    const { uniqueName, createApiLambdaCode, apiLayer, allowedOrigin } = this.props;
    const functionName = uniqueName(name);
    return new lambda.Function(this, id, {
      ...extra,
      functionName,
      runtime: lambda.Runtime.PYTHON_3_14,
      architecture: lambda.Architecture.ARM_64,
      handler: `${handlerFile.replace(/\.py$/, '')}.lambda_handler`,
      code: createApiLambdaCode(handlerFile),
      role,
      timeout: cdk.Duration.seconds(30),
      memorySize,
      environment: { ...environment, ALLOWED_ORIGIN: allowedOrigin, POWERTOOLS_SERVICE_NAME: name, LOG_LEVEL: 'INFO' },
      layers: [apiLayer],
      logGroup: new logs.LogGroup(this, `${id}Logs`, {
        logGroupName: `/aws/lambda/${functionName}`,
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
  }

  private createMcpFunction(): lambda.Function {
    const { projectsTable, jobsTable, kmsKey, userPool, domainFunctions } = this.props;
    const role = this.role('GlobalEndpointRole');
    role.addToPolicy(leadingKeys(projectsTable, ['GetItem', 'UpdateItem'], 'StringEquals', GLOBAL_TOKEN_PARTITION));
    role.addToPolicy(leadingKeys(jobsTable, ['PutItem'], 'StringLike', `${AUDIT_PARTITION_PREFIX}*`));
    // Per-request minter check (enabled, same sub) and the per-run_agent admin re-check.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser'],
      resources: [userPool.userPoolArn],
    }));
    // Exact unqualified ARNs (no `:*`): the adapter invokes by unqualified name.
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: Object.values(domainFunctions).map((fn) => fn.functionArn),
    }));
    kmsKey.grantEncryptDecrypt(role);

    const functionNames = Object.fromEntries(
      Object.entries(domainFunctions).map(([envKey, fn]) => [envKey, fn.functionName]),
    );
    return this.pythonFunction('GlobalMcpApi', GLOBAL_MCP_SERVICE_NAME, 'mcp_global_handler.py', role, {
      PROJECTS_TABLE: projectsTable.tableName,
      JOBS_TABLE: jobsTable.tableName,
      USER_POOL_ID: userPool.userPoolId,
      ...functionNames,
    }, 512, { reservedConcurrentExecutions: mcpReservedConcurrency(this) }); // CPU: 80.7 % p95 at 256 MB, 2026-10-18 (lib/sizing/policy.ts)
  }

  private createTokensFunction(): lambda.Function {
    const { projectsTable, jobsTable, kmsKey } = this.props;
    const role = this.role('TokensApiRole');
    // BatchGetItem: "my tokens" reads the token rows its creator pointers name
    // (same partition). The mint's TransactWriteItems is authorised as PutItem.
    role.addToPolicy(leadingKeys(projectsTable, ['Query', 'GetItem', 'BatchGetItem', 'PutItem', 'UpdateItem'],
      'StringEquals', GLOBAL_TOKEN_PARTITION));
    // The pin check reads one project's META through the shared access gate.
    role.addToPolicy(leadingKeys(projectsTable, ['GetItem'], 'StringLike', 'PROJECT#*'));
    role.addToPolicy(leadingKeys(jobsTable, ['Query'], 'StringLike', `${AUDIT_PARTITION_PREFIX}*`));
    kmsKey.grantEncryptDecrypt(role);
    return this.pythonFunction('McpTokensApi', 'voc-mcp-tokens-api', 'mcp_tokens_handler.py', role, {
      PROJECTS_TABLE: projectsTable.tableName,
      JOBS_TABLE: jobsTable.tableName,
    }, 1024, snapStartFunctionProps(this)); // 1024: CPU-bound (98 % p95 at 512 MB, docs/lambda-sizing.md); SnapStart (opt-in): GET /connect/tokens cold start
  }

  private wireRoutes(): void {
    const { mcpResource, authMethodOptions, apiRoot, browserPreflight } = this.props;
    const mcpMethodOptions = this.props.mcpMethodOptionsFor(this.mcpFunction);
    // ONE API-scoped invoke permission per function instead of two per method
    // (scopePermissionToMethod defaults to true). VocApiStack sits near
    // CloudFormation's 500-resource ceiling and the stack count is capped at five,
    // so these routes are wired frugally: 2 permissions instead of 10. Each
    // function is still invocable only by THIS RestApi, and only these methods
    // integrate it.
    const integrationOptions = { proxy: true, scopePermissionToMethod: false };
    const mcpIntegration = new apigateway.LambdaIntegration(this.mcpFunction, integrationOptions);
    const globalResource = mcpResource.addResource('global');
    // A browser-based MCP client preflights its POST (the 405's `Allow` names OPTIONS).
    globalResource.addCorsPreflight(browserPreflight);
    const globalMethod = globalResource.addMethod('POST', mcpIntegration, mcpMethodOptions);
    NagSuppressions.addResourceSuppressions(globalMethod, [
      { id: 'AwsSolutions-COG4', reason: 'The global MCP endpoint uses the MCP bearer-token authorizer — MCP clients cannot use the Cognito auth flow; the authorizer and the handler verify the hashed token, its expiry/revocation and the minter on every request' },
    ]);
    this.wireMethodNotAllowed(globalResource, mcpMethodOptions);

    // /connect/* — one Cognito proxy (5.47.00; explicit /connect/tokens routes before): list / mint
    // (GET/POST /connect/tokens), one token with its audit log (GET .../{token_id}), revoke (DELETE).
    // The handler routes by path and answers 404 to anything else. `defaultMethodOptions` keeps the
    // authorizer on the proxy (a proxy without it is AuthorizationType.NONE).
    // With -c snapStart=true, through the published `live` alias: SnapStart never snapshots `$LATEST`.
    const tokensIntegration = new apigateway.LambdaIntegration(this.tokensInvokeTarget, integrationOptions);
    apiRoot.addResource('connect')
      .addProxy({ defaultIntegration: tokensIntegration, anyMethod: true, defaultMethodOptions: authMethodOptions })
      .addCorsPreflight(browserPreflight);
  }

  /**
   * `GET` and `DELETE` on the MCP endpoint answer **405 Method Not Allowed** with
   * `Allow` and a JSON-RPC error, as Streamable HTTP requires of a server with no
   * standalone SSE stream and no sessions. Without these methods API Gateway
   * itself refused a GET with a 403 (it parses `Authorization: Bearer …` as a
   * malformed SigV4 header), which a strict client reads as an auth failure.
   *
   * A MOCK integration: no handler runs. It sits behind the same token
   * authorizer as POST, so nothing becomes reachable without a token that POST
   * would not already see — an anonymous GET is the authorizer's 401.
   */
  private wireMethodNotAllowed(resource: apigateway.IResource, methodOptions: apigateway.MethodOptions): void {
    const headers = { 'method.response.header.Allow': true, 'method.response.header.Cache-Control': true };
    for (const verb of METHOD_NOT_ALLOWED_VERBS) {
      const integration = new apigateway.MockIntegration({
        requestTemplates: { 'application/json': '{"statusCode": 405}' },
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        integrationResponses: [{
          statusCode: '405',
          responseParameters: {
            'method.response.header.Allow': `'${MCP_ALLOWED_METHODS}'`,
            'method.response.header.Cache-Control': "'no-store'",
          },
          responseTemplates: {
            'application/json': `{"jsonrpc": "2.0", "id": null, "error": {"code": -32600, "message": "Method not allowed: ${verb}"}}`,
          },
        }],
      });
      const method = resource.addMethod(verb, integration, {
        ...methodOptions,
        methodResponses: [{ statusCode: '405', responseParameters: headers }],
      });
      NagSuppressions.addResourceSuppressions(method, [
        { id: 'AwsSolutions-COG4', reason: 'Same MCP bearer-token authorizer as POST /mcp/global; a static 405 mock, no backend' },
      ]);
    }
  }
}

/** Verbs the endpoint refuses with 405 (Streamable HTTP: no GET stream, no DELETE session). */
export const METHOD_NOT_ALLOWED_VERBS = ['GET', 'DELETE'] as const;
/** The `Allow` header of that 405 — the Lambda's own 405 says the same (mcp_global_handler `_ALLOW_HEADER`). */
export const MCP_ALLOWED_METHODS = 'POST, OPTIONS';

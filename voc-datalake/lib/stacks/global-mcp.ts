/**
 * Global MCP endpoint + personal token API (VocApiStack) — todofeatures §6.3, docs/mcp.md.
 *
 *   POST /mcp/global                       → voc-mcp-global-api (mcp_global_handler.py)
 *        bearer token; a shape-only token authorizer (api-mcp.ts), and the
 *        handler does the real check on every request
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

import { snapStartAlias, snapStartFunctionProps } from '../utils/snapstart';
import { workerRole } from '../utils/worker-lambda';

/** Must equal GLOBAL_TOKEN_PK / AUDIT_PK_PREFIX in lambda/shared/mcp_global_tokens.py (pinned by a test). */
const GLOBAL_TOKEN_PARTITION = 'MCPGTOKEN';
const AUDIT_PARTITION_PREFIX = 'MCPAUDIT#';

/** Stage method-setting key and pair for the global endpoint (reasons in api-gateway.ts). */
export const GLOBAL_MCP_METHOD_THROTTLE: Record<string, apigateway.MethodDeploymentOptions> = {
  '/mcp/global/POST': { throttlingRateLimit: 20, throttlingBurstLimit: 40 },
};

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
  /** The `/mcp` token-authorizer options (shape check only). */
  mcpMethodOptions: apigateway.MethodOptions;
  /** Cognito options every signed-in route uses. */
  authMethodOptions: apigateway.MethodOptions;
  apiRoot: apigateway.IResource;
  projectsTable: dynamodb.ITable;
  jobsTable: dynamodb.ITable;
  kmsKey: kms.IKey;
  userPool: cognito.IUserPool;
  domainFunctions: GlobalMcpDomainFunctions;
}

function leadingKeys(table: dynamodb.ITable, actions: string[], operator: 'StringEquals' | 'StringLike', key: string) {
  return new iam.PolicyStatement({
    actions: actions.map((a) => `dynamodb:${a}`),
    resources: [table.tableArn],
    conditions: { [`ForAllValues:${operator}`]: { 'dynamodb:LeadingKeys': [key] } },
  });
}

export class GlobalMcp extends Construct {
  public readonly mcpFunction: lambda.Function;
  public readonly tokensFunction: lambda.Function;

  constructor(scope: Construct, id: string, private readonly props: GlobalMcpProps) {
    super(scope, id);
    this.mcpFunction = this.createMcpFunction();
    this.tokensFunction = this.createTokensFunction();
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
    return this.pythonFunction('GlobalMcpApi', 'voc-mcp-global-api', 'mcp_global_handler.py', role, {
      PROJECTS_TABLE: projectsTable.tableName,
      JOBS_TABLE: jobsTable.tableName,
      USER_POOL_ID: userPool.userPoolId,
      ...functionNames,
    });
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
    }, 1024, snapStartFunctionProps()); // 1024: CPU-bound (98 % p95 at 512 MB, docs/lambda-sizing.md); SnapStart: GET /connect/tokens cold start
  }

  private wireRoutes(): void {
    const { mcpResource, mcpMethodOptions, authMethodOptions, apiRoot } = this.props;
    // ONE API-scoped invoke permission per function instead of two per method
    // (scopePermissionToMethod defaults to true). VocApiStack sits near
    // CloudFormation's 500-resource ceiling and the stack count is capped at five,
    // so these routes are wired frugally: 2 permissions instead of 10. Each
    // function is still invocable only by THIS RestApi, and only these methods
    // integrate it.
    const integrationOptions = { proxy: true, scopePermissionToMethod: false };
    const mcpIntegration = new apigateway.LambdaIntegration(this.mcpFunction, integrationOptions);
    const globalMethod = mcpResource.addResource('global').addMethod('POST', mcpIntegration, mcpMethodOptions);
    NagSuppressions.addResourceSuppressions(globalMethod, [
      { id: 'AwsSolutions-COG4', reason: 'The global MCP endpoint uses the MCP bearer-token authorizer — MCP clients cannot use the Cognito auth flow; the handler verifies the hashed token, its expiry/revocation and the minter on every request' },
    ]);

    // Explicit routes, no {proxy+}: every token-management route is Cognito.
    // Through the published `live` alias: SnapStart never snapshots `$LATEST`.
    const tokensIntegration = new apigateway.LambdaIntegration(snapStartAlias(this.tokensFunction), integrationOptions);
    const tokens = apiRoot.addResource('connect').addResource('tokens');
    tokens.addMethod('GET', tokensIntegration, authMethodOptions);
    tokens.addMethod('POST', tokensIntegration, authMethodOptions);
    const token = tokens.addResource('{token_id}');
    // GET = the token with a page of its audit log; DELETE = revoke.
    token.addMethod('GET', tokensIntegration, authMethodOptions);
    token.addMethod('DELETE', tokensIntegration, authMethodOptions);
  }
}

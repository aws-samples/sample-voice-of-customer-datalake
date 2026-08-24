/**
 * Template-level tests for the Cognito User Pool's UsernameConfiguration.
 *
 * Regression guard for issue #184: signInCaseSensitive (#105) maps to
 * UsernameConfiguration, which Cognito treats as create-only — introducing
 * it on a pool deployed before #105 fails the entire VocCoreStack update
 * ("Updates are not allowed for property - UsernameConfiguration").
 * Pre-#105 environments deploy with `-c omitUserPoolUsernameConfiguration=true`
 * to keep their pool untouched; greenfield keeps case-insensitive sign-in.
 */
import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';
import { VocCoreStack } from './core-stack';
import { ALLOWED_MODEL_IDS, MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION_PX } from '../utils/model-allowlist';

function synthCoreTemplate(context: Record<string, unknown> = {}): Template {
  // Skip asset bundling (Docker) — template assertions only need structure.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], skipFrontendBuildCheck: true, ...context } });
  const stack = new VocCoreStack(app, 'TestCoreStack', {
    env: { account: '111111111111', region: 'us-east-1' },
    brandName: 'TestBrand',
  });
  return Template.fromStack(stack);
}

describe('VocCoreStack admin bootstrap (issue #196)', () => {
  it('synthesizes deterministically — no per-synth password churn', () => {
    // The old code minted a random password at synth time, so every synth
    // produced a different template (and every deploy no-op-updated the
    // stack). Two independent synths must now be byte-identical.
    expect(synthCoreTemplate().toJSON()).toEqual(synthCoreTemplate().toJSON());
  });

  it('embeds no password in the template — generation happens at runtime', () => {
    const template = synthCoreTemplate();

    const bootstraps = template.findResources('Custom::AdminBootstrap');
    const props = Object.values(bootstraps).map((r) => r.Properties ?? {});
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({ Username: 'admin', GroupName: 'admins' });
    expect(props[0]).not.toHaveProperty('Password');
  });

  it('wires InitialAdminPassword to the runtime attribute of the bootstrap resource', () => {
    const template = synthCoreTemplate();
    const output = template.findOutputs('InitialAdminPassword').InitialAdminPassword;
    const bootstrapLogicalIds = Object.keys(template.findResources('Custom::AdminBootstrap'));

    expect(output.Value).toEqual({ 'Fn::GetAtt': [bootstrapLogicalIds[0], 'Password'] });
  });

  it('keeps the provider framework logging at FATAL so Data.Password never reaches CloudWatch', () => {
    // At INFO the CDK provider framework logs the full custom resource
    // response — including the password. FATAL is today's aws-cdk-lib
    // default, but this pins the guarantee against dependency bumps and
    // debugging sessions alike.
    synthCoreTemplate().hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('provider framework - onEvent .*AdminBootstrapProvider'),
      LoggingConfig: Match.objectLike({ ApplicationLogLevel: 'FATAL' }),
    });
  });
});

describe('VocCoreStack UserPool UsernameConfiguration (issue #184)', () => {
  it('sets case-insensitive sign-in by default (greenfield)', () => {
    const template = synthCoreTemplate();

    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameConfiguration: { CaseSensitive: false },
    });
  });

  it('omits UsernameConfiguration entirely with the pre-#105 compatibility flag', () => {
    const template = synthCoreTemplate({ omitUserPoolUsernameConfiguration: true });

    const pools = template.findResources('AWS::Cognito::UserPool');
    const poolProps = Object.values(pools).map((p) => p.Properties ?? {});
    expect(poolProps).toHaveLength(1);
    // The property must be ABSENT — Cognito rejects any update that carries
    // it against a pool created without it.
    expect(poolProps[0]).not.toHaveProperty('UsernameConfiguration');
  });

  it('accepts the string form of the flag (CLI -c passes strings)', () => {
    const template = synthCoreTemplate({ omitUserPoolUsernameConfiguration: 'true' });

    const poolProps = Object.values(template.findResources('AWS::Cognito::UserPool'))
      .map((p) => p.Properties ?? {});
    // Guard against a vacuous pass: the pool must exist for the absence
    // assertion below to mean anything.
    expect(poolProps).toHaveLength(1);
    expect(poolProps[0]).not.toHaveProperty('UsernameConfiguration');
  });
});

describe('VocCoreStack raw-data bucket CORS', () => {
  /**
   * The raw-data bucket is the presigned-upload target for project product
   * docs. The browser PUTs straight to S3, so S3's own CORS rule — not API
   * Gateway's — is what has to allow the method. Shipping GET-only made every
   * upload fail in the browser with an opaque CORS error while the presigned
   * URL itself was perfectly valid, which is a slow thing to diagnose.
   */
  const CorsRuleSchema = z.object({
    AllowedMethods: z.array(z.string()),
    AllowedOrigins: z.array(z.string()),
  });
  const RawBucketSchema = z.object({
    CorsConfiguration: z.object({ CorsRules: z.array(CorsRuleSchema) }),
  });

  /**
   * CORS rules on the raw-data bucket, validated rather than assumed. Parsing
   * the synthesized shape means a CDK property rename surfaces as a schema
   * error instead of an `undefined` that quietly passes every assertion below.
   *
   * Matched on logical id, not BucketName: `uniqueName()` builds names from
   * `Aws.ACCOUNT_ID`/`Aws.REGION` pseudo-parameters, so BucketName synthesizes
   * to an Fn::Join object rather than a comparable string.
   */
  function rawDataBucketCors(): z.infer<typeof CorsRuleSchema>[] {
    const buckets = Object.entries(synthCoreTemplate().findResources('AWS::S3::Bucket'));
    const raw = buckets.filter(([logicalId]) => logicalId.startsWith('RawDataBucket'));
    // Count FIRST, parse second. Parsing inside the filter would report a
    // bucket that exists but lost its CORS block as a raw ZodError, hiding
    // which of the two distinct problems actually occurred.
    expect(raw, 'expected exactly one RawDataBucket in the template').toHaveLength(1);
    const [, bucket] = raw[0];
    return RawBucketSchema.parse(bucket.Properties).CorsConfiguration.CorsRules;
  }

  it('allows browser presigned PUT as well as GET', () => {
    const rules = rawDataBucketCors();

    expect(rules).toHaveLength(1);
    expect(rules[0].AllowedMethods).toEqual(expect.arrayContaining(['GET', 'PUT']));
  });

  it('keeps the localhost dev origins alongside the deployed origin', () => {
    // Dropping these silently breaks the upload flow under `npm run dev`.
    expect(rawDataBucketCors()[0].AllowedOrigins).toEqual(
      expect.arrayContaining(['http://localhost:5173', 'http://localhost:3000']),
    );
  });

  it('grants no method beyond GET and PUT', () => {
    // Presigned URLs are the auth gate, but the origin list includes a
    // *.cloudfront.net wildcard — so the method list must stay minimal.
    // DELETE/POST here would widen that wildcard into a real concern.
    expect(rawDataBucketCors()[0].AllowedMethods.sort()).toEqual(['GET', 'PUT']);
  });
});

/**
 * Server access logging on the buckets that have a separate destination
 * (Checkov CKV_AWS_18 / cdk-nag AwsSolutions-S1).
 *
 * The website bucket shipped without it and carried an AwsSolutions-S1
 * suppression instead, reasoning that CloudFront's own logs covered it. They do
 * not cover the same thing: CloudFront logs viewer requests, S3 server access
 * logs record what actually reached the bucket — including anything that reaches
 * it WITHOUT going through the distribution. Asserted here rather than left to
 * the baseline hash so that removing the property reads as "the website bucket
 * stopped logging" instead of "VocCoreStack's digest moved".
 */
describe('VocCoreStack S3 server access logging', () => {
  const LoggingSchema = z.object({
    DestinationBucketName: z.object({ Ref: z.string() }),
    LogFilePrefix: z.string(),
  });

  /**
   * Logical id of the access-logs bucket, resolved from the template rather than
   * hard-coded: CDK appends an address hash to it, so the literal would need
   * editing whenever the construct tree around it changes.
   */
  function bucketsByPrefix(template: Template, prefix: string) {
    const found = Object.entries(template.findResources('AWS::S3::Bucket'))
      .filter(([logicalId]) => logicalId.startsWith(prefix));
    expect(found, `expected exactly one bucket named ${prefix}*`).toHaveLength(1);
    return found[0];
  }

  it.each([
    ['WebsiteBucket', 'website-bucket/'],
    ['RawDataBucket', 'raw-data-bucket/'],
  ])('ships %s logging into the access-logs bucket under %s', (prefix, logPrefix) => {
    const template = synthCoreTemplate();
    const [accessLogsLogicalId] = bucketsByPrefix(template, 'AccessLogsBucket');
    const [, bucket] = bucketsByPrefix(template, prefix);

    const logging = LoggingSchema.parse(bucket.Properties?.LoggingConfiguration);
    expect(logging.DestinationBucketName.Ref).toBe(accessLogsLogicalId);
    expect(logging.LogFilePrefix).toBe(logPrefix);
  });

  it('leaves the access-logs bucket without a destination of its own', () => {
    // Deliberate, and the one place AwsSolutions-S1 stays unaddressed: S3 does
    // not support a bucket delivering its own access logs to itself, so the
    // scanner's finding here is a false positive rather than a gap.
    const template = synthCoreTemplate();
    const [, accessLogs] = bucketsByPrefix(template, 'AccessLogsBucket');

    expect(accessLogs.Properties ?? {}).not.toHaveProperty('LoggingConfiguration');
  });

  it('carries no cdk_nag suppression on the website bucket', () => {
    // The AwsSolutions-S1 suppression described the missing property above. With
    // the property present the rule no longer fires, so a suppression would be
    // dead metadata that a later audit has to re-litigate.
    const [, website] = bucketsByPrefix(synthCoreTemplate(), 'WebsiteBucket');

    expect(website.Metadata ?? {}).not.toHaveProperty('cdk_nag');
  });
});

/**
 * Regression guards for issue #229: /avatars/* and /prototypes/* were served
 * with no viewer-side authorization at all.
 *
 * There were NO CloudFront assertions in this file before, which is a large part
 * of why the gap shipped and stayed unnoticed — a cache behavior could be added
 * with no access control and nothing failed. These tests assert the property
 * rather than the specific behaviors, so a THIRD private path added later is
 * covered without anyone remembering to extend them.
 */
describe('VocCoreStack CloudFront private asset paths (issue #229)', () => {
  const PRIVATE_PATHS = ['/avatars/*', '/prototypes/*'];

  const BehaviorSchema = z.object({
    PathPattern: z.string(),
    TrustedKeyGroups: z.array(z.unknown()).optional(),
  });
  const DistributionConfigSchema = z.object({
    CacheBehaviors: z.array(BehaviorSchema),
    CustomErrorResponses: z.array(z.object({
      ErrorCode: z.number(),
      ResponseCode: z.number().optional(),
      ResponsePagePath: z.string().optional(),
    })).optional(),
  });

  /**
   * Parse the synthesized distribution rather than assume its shape, matching
   * the rawDataBucketCors() precedent above: a CDK property rename then fails as
   * a schema error instead of an `undefined` that passes every assertion.
   */
  function distributionConfig(): z.infer<typeof DistributionConfigSchema> {
    const distributions = Object.values(synthCoreTemplate().findResources('AWS::CloudFront::Distribution'));
    expect(distributions, 'expected exactly one frontend distribution').toHaveLength(1);
    return DistributionConfigSchema.parse(distributions[0].Properties.DistributionConfig);
  }

  it('restricts every non-default cache behavior to a trusted key group', () => {
    // Property-based on purpose: the default behavior MUST stay public (it
    // serves the login page), and everything else on this distribution serves
    // customer data derived from feedback, so "additional behavior" implies
    // "needs a signature".
    const behaviors = distributionConfig().CacheBehaviors;

    expect(behaviors.map((b) => b.PathPattern).sort()).toEqual([...PRIVATE_PATHS].sort());
    for (const behavior of behaviors) {
      expect(behavior.TrustedKeyGroups, `${behavior.PathPattern} must require a signature`)
        .toBeDefined();
      expect(behavior.TrustedKeyGroups).not.toHaveLength(0);
    }
  });

  it('does not rewrite 403 into a 200, so denials stay observable', () => {
    // Custom error responses are distribution-WIDE — CloudFront cannot scope
    // them per behavior. A 403 -> /index.html (200) rule therefore laundered
    // every denial on every path into a success carrying the SPA shell. With
    // trustedKeyGroups that is actively harmful: a rejected prototype request
    // would render the whole app inside the prototype iframe, and no test could
    // distinguish allow from deny.
    const errorResponses = distributionConfig().CustomErrorResponses ?? [];

    expect(errorResponses.map((r) => r.ErrorCode)).not.toContain(403);
  });

  it('still routes SPA deep links via the 404 rule', () => {
    // The 403 rule was load-bearing for client-side routing, so removing it
    // only works because of the s3:ListBucket grant asserted below.
    const errorResponses = distributionConfig().CustomErrorResponses ?? [];
    const notFound = errorResponses.find((r) => r.ErrorCode === 404);

    expect(notFound).toMatchObject({ ResponseCode: 200, ResponsePagePath: '/index.html' });
  });

  it('lets CloudFront list the website bucket so a missing route is a 404, not a 403', () => {
    // Without s3:ListBucket, S3 answers 403 for a key that does not exist,
    // which is what forced the 403 -> index.html mapping in the first place.
    const policies = Object.entries(synthCoreTemplate().findResources('AWS::S3::BucketPolicy'));
    const websitePolicies = policies.filter(([logicalId]) => logicalId.startsWith('WebsiteBucket'));
    expect(websitePolicies, 'expected a WebsiteBucket policy').toHaveLength(1);

    const statements = websitePolicies[0][1].Properties.PolicyDocument.Statement as {
      Action?: unknown; Principal?: { Service?: string };
    }[];
    const listStatements = statements.filter(
      (s) => s.Action === 's3:ListBucket' && s.Principal?.Service === 'cloudfront.amazonaws.com',
    );

    expect(listStatements).toHaveLength(1);
  });

  it('does NOT let CloudFront list the raw-data bucket', () => {
    // There, 403-for-a-missing-key is the answer we want: whether a given
    // avatar or prototype key exists is not information an unauthenticated
    // viewer is owed.
    const policies = Object.entries(synthCoreTemplate().findResources('AWS::S3::BucketPolicy'));
    const rawPolicies = policies.filter(([logicalId]) => logicalId.startsWith('RawDataBucket'));
    expect(rawPolicies).toHaveLength(1);

    const serialized = JSON.stringify(rawPolicies[0][1].Properties.PolicyDocument);

    expect(serialized).not.toContain('s3:ListBucket');
  });

  it('packages the signing-key handler as an asset, not inline code', () => {
    // The inline form DID deploy at ~6.9KB — CloudFormation accepted it and
    // aws-cdk-lib has no 4096-character check — but that is undocumented
    // tolerance, and inline code would put a size cliff one comment away. An
    // asset also keeps the sibling Python handler and its pytest suite out of
    // this function's zip.
    const functions = Object.values(synthCoreTemplate().findResources('AWS::Lambda::Function'));
    const signingKeyFns = functions.filter(
      (f) => typeof f.Properties?.Handler === 'string'
        && f.Properties.Handler.startsWith('cdn_signing_keys.'),
    );
    expect(signingKeyFns).toHaveLength(1);

    expect(signingKeyFns[0].Properties.Code).not.toHaveProperty('ZipFile');
    expect(signingKeyFns[0].Properties.Code).toHaveProperty('S3Bucket');
  });

  it('keeps the prototype CSP on the prototypes behavior', () => {
    // That response-headers policy is the EGRESS control on model-generated
    // inline JS (default-src 'none', no connect-src). It is easy to lose by
    // moving prototypes to an origin that cannot set response headers, so pin
    // that it is still attached and still forbids everything by default.
    const template = synthCoreTemplate();
    const policies = Object.values(template.findResources('AWS::CloudFront::ResponseHeadersPolicy'));
    const csps = policies.map(
      (p) => p.Properties?.ResponseHeadersPolicyConfig?.SecurityHeadersConfig
        ?.ContentSecurityPolicy?.ContentSecurityPolicy as string | undefined,
    );

    const prototypeCsp = csps.find((csp) => csp?.includes("script-src 'unsafe-inline'"));
    expect(prototypeCsp, 'prototype response-headers policy is missing').toBeDefined();
    expect(prototypeCsp).toContain("default-src 'none'");
    expect(prototypeCsp).not.toContain('connect-src');
  });

  it('never puts signing key MATERIAL in the template', () => {
    // The whole reason a custom resource mints the keypair at deploy time: the
    // private key must not reach the template, `cdk diff`, or stack events.
    //
    // Asserted on the PEM HEADER specifically, not on the looser phrase
    // "PRIVATE KEY". The handler tests incoming secrets with
    // `.includes('PRIVATE KEY')`, so that phrase appears in its source; while
    // the handler was inlined into the template as a ZipFile, the loose search
    // matched its own source and failed against a perfectly clean template. The
    // handler is an asset now so the source is no longer in the template, but
    // the precise assertion is the right one regardless — and it keeps this test
    // honest if anyone moves back to inline code.
    const rendered = JSON.stringify(synthCoreTemplate().toJSON());

    expect(rendered).not.toContain('-----BEGIN PRIVATE KEY-----');
    expect(rendered).not.toContain('-----BEGIN RSA PRIVATE KEY-----');
  });

  it('seeds the signing secret without embedding a key, leaving the handler to populate it', () => {
    const secrets = Object.values(synthCoreTemplate().findResources('AWS::SecretsManager::Secret'));
    const signingSecrets = secrets.filter(
      (s) => typeof s.Properties?.Description === 'string'
        && s.Properties.Description.includes('signs CloudFront URLs'),
    );
    expect(signingSecrets).toHaveLength(1);

    // Generated, not literal: a SecretString here would be the key in the template.
    expect(signingSecrets[0].Properties).toHaveProperty('GenerateSecretString');
    expect(signingSecrets[0].Properties).not.toHaveProperty('SecretString');
  });

  it('still synthesizes deterministically with the keypair custom resource', () => {
    // Generating a key at synth time instead would break this — which is
    // precisely why it is generated at deploy time.
    expect(synthCoreTemplate().toJSON()).toEqual(synthCoreTemplate().toJSON());
  });
});

/**
 * Regression guard for issue #252: the implicit OAuth grant was enabled
 * alongside authorization-code grant. The implicit grant returns tokens
 * in the URL fragment (browser history / Referer leakage) and cannot be
 * protected by PKCE — OAuth 2.1 drops it entirely.
 *
 * The application signs in via SRP (amazon-cognito-identity-js) and never
 * uses the hosted-UI redirect flow, so disabling it is safe. A repository-
 * wide search at the time of writing found core-stack.ts to be the only
 * file referencing the implicit flow or the hosted-UI domain.
 *
 * Tests here assert the flow set POSITIVELY — the code flow present AND the
 * implicit flow absent — so that (a) neither assertion is vacuous and (b) a
 * silent re-enable of implicitCodeGrant causes a test failure.
 */
describe('VocCoreStack Cognito OAuth flow set (issue #252)', () => {
  /**
   * Parse the AllowedOAuthFlows array from the synthesized UserPoolClient.
   * AllowedOAuthFlows is typed `unknown` by Template.toJSON(), so we
   * validate the shape with Zod to surface CDK property renames as schema
   * errors rather than silent `undefined` values that pass every assertion.
   */
  const UserPoolClientSchema = z.object({
    AllowedOAuthFlows: z.array(z.string()),
  });

  function allowedOAuthFlows(): string[] {
    const clients = Object.values(synthCoreTemplate().findResources('AWS::Cognito::UserPoolClient'));
    expect(clients, 'expected exactly one UserPoolClient').toHaveLength(1);
    return UserPoolClientSchema.parse(clients[0].Properties).AllowedOAuthFlows;
  }

  it('enables the authorization-code flow ("code")', () => {
    // Authorization-code grant with PKCE is the recommended flow for browser
    // clients. It must stay present so the hosted-UI path remains available
    // for future use.
    expect(allowedOAuthFlows()).toContain('code');
  });

  it('does NOT enable the implicit flow ("implicit")', () => {
    // The implicit grant returns tokens directly in the redirect URL fragment,
    // which leaks them into browser history and via the Referer header, and
    // it cannot be protected with PKCE. OAuth 2.1 removes it. The app uses
    // SRP sign-in exclusively, so nothing depends on this flow.
    expect(allowedOAuthFlows()).not.toContain('implicit');
  });
});

/**
 * The S3-triggered product-doc extractor (visual grounding, rung 2).
 *
 * PLACEMENT is the property worth pinning. CDK parents a bucket notification
 * under the BUCKET's scope, so wiring this from the processing stack would emit a
 * Custom::S3BucketNotifications in VocCoreStack pointing at a VocProcessingStack
 * function — a CloudFormation cycle, since processing already depends on core.
 * Nothing in a unit test catches that except asserting the notification and the
 * function are BOTH in this template.
 *
 * Matched on LOGICAL ID rather than FunctionName throughout: uniqueName() builds
 * names from the Aws.ACCOUNT_ID/Aws.REGION pseudo-parameters, so FunctionName
 * synthesizes to an Fn::Join object rather than a comparable string.
 */
describe('VocCoreStack product doc extractor', () => {
  const FunctionSchema = z.object({
    Handler: z.string(),
    Runtime: z.string(),
    Timeout: z.number(),
    MemorySize: z.number(),
    Architectures: z.array(z.string()),
    Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }),
  });

  /** The extractor function's properties, validated rather than assumed. */
  function extractorFunction(): z.infer<typeof FunctionSchema> {
    const functions = Object.entries(synthCoreTemplate().findResources('AWS::Lambda::Function'));
    const extractors = functions.filter(([logicalId]) => logicalId.startsWith('ProductDocExtractorLambda'));
    // Count FIRST, parse second: a function that exists but lost its
    // Environment block should read as a schema error, not as "not found".
    expect(extractors, 'expected exactly one ProductDocExtractorLambda').toHaveLength(1);
    return FunctionSchema.parse(extractors[0][1].Properties);
  }

  /** Statements from the extractor role's default policy. */
  function extractorPolicyStatements(): { Action?: unknown; Resource?: unknown }[] {
    const policies = Object.entries(synthCoreTemplate().findResources('AWS::IAM::Policy'))
      .filter(([logicalId]) => logicalId.startsWith('ProductDocExtractorLambdaServiceRoleDefaultPolicy'));
    expect(policies, 'expected exactly one extractor role policy').toHaveLength(1);
    return policies[0][1].Properties.PolicyDocument.Statement;
  }

  it('exists as an ARM Python function with a 120s timeout', () => {
    const fn = extractorFunction();

    expect(fn.Handler).toBe('handler.lambda_handler');
    expect(fn.Architectures).toEqual(['arm64']);
    // Must stay well under product_context.py's EXTRACTION_STALL_SECONDS (300),
    // which fails any record not extracted inside that window — a longer timeout
    // would start marking SUCCESSFUL extractions as failed.
    expect(fn.Timeout).toBe(120);
    expect(fn.MemorySize).toBeGreaterThanOrEqual(512);
  });

  it('ships without a bundled layer, so CoreStack stays container-free', () => {
    // CoreStack deliberately needs no Docker/finch: its signing-key custom
    // resource is written in Node for exactly this reason. A Layers entry here
    // would mean a pip-installed layer and container bundling in this stack.
    const functions = Object.entries(synthCoreTemplate().findResources('AWS::Lambda::Function'))
      .filter(([logicalId]) => logicalId.startsWith('ProductDocExtractorLambda'));

    expect(functions[0][1].Properties).not.toHaveProperty('Layers');
  });

  it('registers the notification on the RawDataBucket in THIS stack, filtered to projects/', () => {
    const template = synthCoreTemplate();
    const notifications = Object.values(template.findResources('Custom::S3BucketNotifications'))
      .filter((r) => JSON.stringify(r.Properties?.BucketName ?? '').includes('RawDataBucket'));
    expect(notifications, 'expected a notification on the RawDataBucket').toHaveLength(1);

    const configs = notifications[0].Properties.NotificationConfiguration
      .LambdaFunctionConfigurations as {
        Events: string[];
        Filter?: { Key: { FilterRules: { Name: string; Value: string }[] } };
        LambdaFunctionArn: { 'Fn::GetAtt': string[] };
      }[];
    // ONE rule: S3 permits a single prefix per rule and rejects overlapping
    // rules for the same event type, so this cannot be narrowed per project.
    expect(configs).toHaveLength(1);
    expect(configs[0].Events).toEqual(['s3:ObjectCreated:*']);
    expect(configs[0].Filter?.Key.FilterRules).toEqual([{ Name: 'prefix', Value: 'projects/' }]);
    // Same-stack target — this is the assertion that would fail if the function
    // were ever moved to the processing stack.
    expect(configs[0].LambdaFunctionArn['Fn::GetAtt'][0]).toMatch(/^ProductDocExtractorLambda/);
  });

  it('grants Bedrock invoke on the allowlisted models only', () => {
    const bedrockStatements = extractorPolicyStatements()
      .filter((s) => s.Action === 'bedrock:InvokeModel');
    expect(bedrockStatements).toHaveLength(1);

    const resources = bedrockStatements[0].Resource as string[];
    // Every allowlisted model, and nothing that would let it reach another one.
    for (const modelId of ALLOWED_MODEL_IDS) {
      expect(resources.some((arn) => arn.includes(modelId))).toBe(true);
    }
    expect(resources.some((arn) => arn === '*' || arn.endsWith('foundation-model/*'))).toBe(false);
  });

  it('scopes the S3 write to the extracted/ prefix and never to raw/', () => {
    // A write grant reaching raw/ would let this role overwrite the user's own
    // uploads — including the input it is about to read.
    const writeStatements = extractorPolicyStatements().filter(
      (s) => Array.isArray(s.Action) && (s.Action as string[]).includes('s3:PutObject'),
    );
    expect(writeStatements).toHaveLength(1);

    const rendered = JSON.stringify(writeStatements[0].Resource);
    expect(rendered).toContain('/projects/*/product_docs/extracted/*');
    expect(rendered).not.toContain('product_docs/raw');

    const readStatements = extractorPolicyStatements().filter(
      (s) => Array.isArray(s.Action) && (s.Action as string[]).includes('s3:GetObject*'),
    );
    expect(readStatements).toHaveLength(1);
    expect(JSON.stringify(readStatements[0].Resource)).toContain('/projects/*/product_docs/raw/*');
  });

  it('injects a MODEL_ALLOWLIST that parses to a non-empty array of allowlisted ids', () => {
    // The handler cannot import shared/model_config.py (powertools would force a
    // layer), so this env var IS its allowlist. An empty or malformed value would
    // make it reject every configured model and silently fall back to the default.
    const env = extractorFunction().Environment.Variables;

    expect(typeof env.MODEL_ALLOWLIST).toBe('string');
    const parsed: unknown = JSON.parse(env.MODEL_ALLOWLIST as string);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed as string[]).toEqual([...ALLOWED_MODEL_IDS]);
    expect((parsed as string[]).length).toBeGreaterThan(0);
  });

  it('injects the image caps and the default model, all resolvable at runtime', () => {
    const env = extractorFunction().Environment.Variables;

    // Strings, because Lambda environment values are strings — a number here
    // fails at synth, but a missing one only fails in production.
    expect(env.MAX_IMAGE_BYTES).toBe(String(MAX_IMAGE_BYTES));
    expect(env.MAX_IMAGE_DIMENSION_PX).toBe(String(MAX_IMAGE_DIMENSION_PX));
    expect(ALLOWED_MODEL_IDS).toContain(env.DEFAULT_MODEL_ID as string);
    for (const key of ['RAW_DATA_BUCKET', 'PROJECTS_TABLE', 'AGGREGATES_TABLE']) {
      expect(env[key], `${key} must be injected`).toBeDefined();
    }
  });
  it('injects the structured-logging variables under their non-powertools names', () => {
    // The handler emits JSON from a stdlib Formatter subclass because it cannot
    // import powertools (that would need a layer, and building one would force
    // container bundling into this stack). So the names are SERVICE_NAME and
    // LOG_LEVEL rather than POWERTOOLS_SERVICE_NAME: a POWERTOOLS_* variable on
    // a function with no powertools would promise a library that is absent.
    // The emitted FIELD is still `service`, so an operator's query is unchanged.
    const env = extractorFunction().Environment.Variables;
    expect(env.LOG_LEVEL).toBe('INFO');
    // A bare string, not a namespaced physical name: the handler compares it to
    // nothing, it only labels a log field, and `uniqueName()` would make it an
    // unresolved token here — plus it would show up in the baseline's name
    // inventory as if a resource name had been added.
    expect(env.SERVICE_NAME).toBe('voc-product-doc-extractor');
    expect(env).not.toHaveProperty('POWERTOOLS_SERVICE_NAME');
  });
});

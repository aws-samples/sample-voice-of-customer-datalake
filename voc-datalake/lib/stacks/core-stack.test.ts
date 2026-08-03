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
    // Asserted on the PEM header specifically. A looser search for
    // "PRIVATE KEY" matches the inlined handler's OWN SOURCE (it tests incoming
    // secrets with `.includes('PRIVATE KEY')`), so it would fail while the
    // template was perfectly clean.
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

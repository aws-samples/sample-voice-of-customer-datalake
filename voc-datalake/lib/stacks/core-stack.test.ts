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
// The same fixed synth environment and committed feature flags the whole-app
// harness uses, imported rather than re-declared: a second copy of either drifts
// silently. Importing costs nothing at module load — synth-app.ts only shells out
// to `cdk synth` inside `synthApp()`, and its sole module-level work is a `join()`
// on two path constants.
import { SYNTH_ACCOUNT, SYNTH_REGION, cdkJsonContextStrict, committedFeatureFlags } from '../test-support/synth-app';

/**
 * cdk.json's CDK feature flags, resolved once for every case in this file.
 *
 * Read rather than listed because several flags change the SHAPE of the
 * synthesized template and not just its details, so a bare `App` would let this
 * file assert against a template no deploy of this project produces. The one the
 * S3-logging block below depends on is
 * `@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy`, which decides whether log
 * delivery is granted by a statement on the destination's bucket policy or by a
 * `LogDeliveryWrite` ACL — both of which render an identical
 * `LoggingConfiguration` on the source, so only a destination-side assertion can
 * tell them apart. Reading the file rather than pinning a literal keeps the test
 * and the deploy configuration from parting company unnoticed.
 *
 * FEATURE FLAGS ONLY — `committedFeatureFlags()` filters to `@aws-cdk`-prefixed
 * keys, and that filter is load-bearing for this file specifically. cdk.json's
 * `context` is also where project-level `-c` defaults would live, and several
 * cases here assert a CDK or app DEFAULT: `sets case-insensitive sign-in by
 * default (greenfield)` passes only while `omitUserPoolUsernameConfiguration` is
 * unset. A project key added to cdk.json and spread in here would invert what
 * those cases measure while they stayed green.
 *
 * These flags DO change this file's other blocks, which is intended and worth
 * naming rather than discovering: `@aws-cdk/aws-iam:minimizePolicies` merges IAM
 * statements, so the extractor role's default policy carries 6 statements here
 * against 10 under a bare `App`, the CDN signing-key policy 1 against 2, and the
 * KMS key policy 5 against 6. No assertion's outcome changes — the extractor's
 * S3 read and write statements have different resources and so never merge — but
 * a case that counts statements must be written against these numbers.
 * `merges IAM statements the way a real deploy's feature flags do` below is what
 * turns that from a comment into a guard.
 */
const CDK_FEATURE_FLAGS = committedFeatureFlags();

function synthCoreTemplate(context: Record<string, unknown> = {}): Template {
  // Skip asset bundling (Docker) — template assertions only need structure.
  const app = new cdk.App({
    context: {
      ...CDK_FEATURE_FLAGS,
      'aws:cdk:bundling-stacks': [],
      skipFrontendBuildCheck: true,
      ...context,
    },
  });
  const stack = new VocCoreStack(app, 'TestCoreStack', {
    env: { account: SYNTH_ACCOUNT, region: SYNTH_REGION },
    brandName: 'TestBrand',
  });
  return Template.fromStack(stack);
}

/** Any policy document, down to the statement list. */
const StatementsSchema = z.object({ Statement: z.array(z.unknown()) });

/**
 * The synth context every case in this file runs under, pinned.
 *
 * `synthCoreTemplate()` spreads cdk.json's feature flags, which changes the
 * synth for EVERY describe block here and not only the S3-logging one that
 * needs it. That is the right end state — a suite asserting about deployed
 * behaviour should synthesize the way a deploy does — but it is a whole-file
 * coupling, so the two properties it rests on are asserted rather than assumed:
 * that the spread carries feature flags only, and that the statement-merging it
 * enables lands on the counts the cases downstream were written against.
 */
describe('VocCoreStack synth context', () => {
  it('spreads CDK feature flags only, never a project-level context key', () => {
    // The barrier for every case in this file that asserts a DEFAULT. A project
    // key in cdk.json's `context` — `omitUserPoolUsernameConfiguration` being the
    // live example, since the issue #184 greenfield case needs it UNSET — would
    // otherwise reach those cases and silently flip what they measure.
    //
    // Compared against cdk.json's RAW context rather than just inspecting the
    // filtered result, which would be tautological: `committedFeatureFlags()`
    // filters by this very prefix, so its own output trivially satisfies it.
    //
    // What this case does NOT do is prove the filter exists. It is a conjunction:
    // it fails only when cdk.json holds a non-`@aws-cdk` key AND the filter has
    // stopped dropping it. With every committed key prefixed today, deleting the
    // filter leaves this green — so the filter's own removal is caught by
    // `committedFeatureFlags` in lib/test-support/synth-app.test.ts, which feeds it
    // synthetic context and therefore does not depend on what cdk.json happens to
    // hold. This case guards the OTHER half: the day a project key is committed,
    // it fails here rather than silently inverting a default-asserting case below.
    //
    // The first assertion is entailed by the third — if every key in
    // CDK_FEATURE_FLAGS is prefixed then no unprefixed key can be `in` it — and is
    // kept only because its failure message names the consequence.
    const rawContext = cdkJsonContextStrict();
    const projectKeys = Object.keys(rawContext).filter((key) => !key.startsWith('@aws-cdk'));

    expect(
      projectKeys.filter((key) => key in CDK_FEATURE_FLAGS),
      'synthCoreTemplate() must not spread cdk.json project context',
    ).toEqual([]);
    // And that the flags themselves really do arrive, so a cdk.json that lost its
    // `context` block cannot satisfy the assertion above by supplying nothing.
    expect(CDK_FEATURE_FLAGS['@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy']).toBe(true);
    expect(Object.keys(CDK_FEATURE_FLAGS)).toEqual(
      Object.keys(rawContext).filter((key) => key.startsWith('@aws-cdk')),
    );
  });

  it('merges IAM statements the way a real deploy\'s feature flags do', () => {
    // `@aws-cdk/aws-iam:minimizePolicies` merges statements that share a
    // resource set, so these three resources genuinely change shape between a
    // bare `App` and this one (10→6, 2→1, 6→5).
    //
    // Named for the mechanism rather than for the numbers because the numbers
    // move for TWO unrelated causes, and the failure gives no hint which: the
    // flag stopped arriving (a synth-context regression, which would also take
    // the S3 log-delivery grants with it — the same read supplies both), or one
    // of these policies legitimately gained a statement. The assertion messages
    // say so, since `expected 7 to be 6` after a least-privilege change would
    // otherwise send a reader hunting through cdk.json.
    //
    // Worth a case at all because the flag going missing is not a digest-only
    // event: it would fail all five app-baseline.test.ts comparisons too, whose
    // message tells the maintainer to regenerate the baseline — exactly the wrong
    // instruction. This is the case that names the cause.
    const template = synthCoreTemplate();

    const statementCount = (type: string, logicalIdPrefix: string, documentKey: string): number => {
      const found = Object.entries(template.findResources(type))
        .filter(([logicalId]) => logicalId.startsWith(logicalIdPrefix));
      expect(found, `expected exactly one ${logicalIdPrefix}*`).toHaveLength(1);
      return StatementsSchema.parse(found[0][1].Properties?.[documentKey]).Statement.length;
    };

    const because = (resource: string) =>
      `${resource}'s statement count moved: either the synth context lost `
      + '@aws-cdk/aws-iam:minimizePolicies, or this policy gained a statement. Both want reading.';

    expect(
      statementCount('AWS::IAM::Policy', 'ProductDocExtractorLambdaServiceRoleDefaultPolicy', 'PolicyDocument'),
      because('the doc-extractor role'),
    ).toBe(6);
    expect(
      statementCount('AWS::IAM::Policy', 'CdnSigningKeysLambdaServiceRoleDefaultPolicy', 'PolicyDocument'),
      because('the CDN signing-key role'),
    ).toBe(1);
    expect(statementCount('AWS::KMS::Key', 'VocKmsKey', 'KeyPolicy'), because('the KMS key')).toBe(5);
  });
});

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
 *
 * Each producer is checked at BOTH ends — the `LoggingConfiguration` on the
 * source and the log-delivery grant on the destination's policy — because the
 * source half alone can be perfectly well-formed while nothing is ever
 * delivered.
 */
describe('VocCoreStack S3 server access logging', () => {
  const LoggingSchema = z.object({
    DestinationBucketName: z.object({ Ref: z.string() }),
    LogFilePrefix: z.string(),
  });

  /**
   * The log-delivery grant CDK writes onto the DESTINATION bucket's policy.
   *
   * `Resource` is an `Fn::Join` of the destination's Arn and `/<prefix>*`, and
   * the condition pair is what scopes the grant to one named producer in one
   * account rather than to any bucket anywhere that guesses the path.
   */
  const LogDeliveryStatementSchema = z.object({
    Action: z.literal('s3:PutObject'),
    Effect: z.literal('Allow'),
    Principal: z.object({ Service: z.literal('logging.s3.amazonaws.com') }),
    Resource: z.object({ 'Fn::Join': z.tuple([z.literal(''), z.array(z.unknown())]) }),
    Condition: z.object({
      ArnLike: z.object({
        'aws:SourceArn': z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.literal('Arn')]) }),
      }),
      StringEquals: z.object({ 'aws:SourceAccount': z.string() }),
    }),
  });

  /** Suppression ids on a resource, or none when the metadata block is absent. */
  const NagMetadataSchema = z.object({
    cdk_nag: z.object({ rules_to_suppress: z.array(z.object({ id: z.string() })) }).optional(),
  });

  /** A bucket policy resource, down to the statement list this block reads. */
  const PolicyResourceSchema = z.object({
    Properties: z.object({ PolicyDocument: z.object({ Statement: z.array(z.unknown()) }) }),
  });

  /**
   * The access-logs bucket's retention rule.
   *
   * `.strict()` is the whole guard, and it has to be the schema rather than a
   * separate assertion: zod STRIPS unlisted keys by default, so a rule that grew
   * a `Prefix` would parse to an object without one and any
   * `not.toHaveProperty('Prefix')` written below would pass vacuously. Listing
   * only the two expected keys and rejecting the rest means an added `Prefix`
   * fails at the parse, naming the offending key
   * (`Unrecognized key(s) in object: 'Prefix'`).
   *
   * That strictness is deliberately BROADER than the case's stated claim: ANY key
   * not listed here fails the parse, including a benign one. Adding
   * `id: 'expire-logs'` to the rule — no prefix, no retention change, the sort of
   * edit made to reference a rule in the console — fails with
   * `Unrecognized key(s) in object: 'Id'`, which reads like a prefix regression
   * when nothing about prefixes moved. The remedy in that case is to ADD the key
   * here, not to hunt a lifecycle bug. Over-rejection is the accepted trade
   * because the alternative is worse in kind rather than degree: a lenient parse
   * drops the key and the assertion passes while the property it guards is gone.
   */
  const LifecycleSchema = z.object({
    Rules: z.array(z.object({ ExpirationInDays: z.number(), Status: z.string() }).strict()),
  });

  /**
   * Resolve one bucket from the template by logical-id prefix.
   *
   * By logical id and not by BucketName, per the `rawDataBucketCors()` precedent
   * above: `uniqueDnsName()` builds names from `Aws.ACCOUNT_ID`/`Aws.REGION`
   * pseudo-parameters, so BucketName synthesizes to an `Fn::Join` rather than a
   * comparable string. By PREFIX because CDK appends an address hash to the id,
   * which a hard-coded literal would have to chase every time the surrounding
   * construct tree moves.
   *
   * Counts before returning, so "no such bucket" and "bucket present but
   * malformed" surface as two distinct failures rather than one ZodError.
   */
  function bucketByLogicalIdPrefix(template: Template, prefix: string) {
    const found = Object.entries(template.findResources('AWS::S3::Bucket'))
      .filter(([logicalId]) => logicalId.startsWith(prefix));
    expect(found, `expected exactly one bucket named ${prefix}*`).toHaveLength(1);
    return found[0];
  }

  /**
   * Statements on the access-logs bucket's own resource policy.
   *
   * Guarantees two things before returning, as two distinct failures: exactly one
   * `AccessLogsBucketPolicy*` resource exists, and its document carries a
   * `Statement` array. Parsed with zod rather than cast, per `rawDataBucketCors()`
   * above — a CDK property rename then surfaces as a schema error instead of an
   * `undefined` that quietly satisfies every assertion downstream.
   */
  function accessLogsPolicyStatements(template: Template): unknown[] {
    const policies = Object.entries(template.findResources('AWS::S3::BucketPolicy'))
      .filter(([logicalId]) => logicalId.startsWith('AccessLogsBucketPolicy'));
    expect(policies, 'expected exactly one AccessLogsBucket policy').toHaveLength(1);
    return PolicyResourceSchema.parse(policies[0][1]).Properties.PolicyDocument.Statement;
  }

  // ONLY these two: the S3-import bucket is the third producer into this
  // destination, but it is built by VocIngestionStack (`createS3ImportBucket`),
  // so it is absent from this template and a third row here would fail on
  // bucketByLogicalIdPrefix's count. Covering it needs a case that synthesizes
  // the ingestion stack, and neither schema below would fit it unchanged: the
  // destination reference becomes a cross-stack `Fn::ImportValue` rather than a
  // `Ref`, and CDK omits the aws:SourceArn/aws:SourceAccount conditions
  // entirely for a producer in another stack (verified against the synthesized
  // VocCoreStack template, where the `/s3-import-bucket/*` grant carries no
  // `Condition` at all). So this is two of the THREE S3-BUCKET producers by
  // necessity, not by oversight. (The comment below counts differently and is
  // also right: four producers in total, the fourth being the CloudFront
  // distribution's `cloudfront-frontend/` prefix, which is not a bucket.)
  it.each([
    ['WebsiteBucket', 'website-bucket/'],
    ['RawDataBucket', 'raw-data-bucket/'],
  ])('ships %s logging into the access-logs bucket under %s', (prefix, logPrefix) => {
    const template = synthCoreTemplate();
    const [accessLogsLogicalId] = bucketByLogicalIdPrefix(template, 'AccessLogsBucket');
    const [sourceLogicalId, bucket] = bucketByLogicalIdPrefix(template, prefix);

    const logging = LoggingSchema.parse(bucket.Properties?.LoggingConfiguration);
    expect(logging.DestinationBucketName.Ref).toBe(accessLogsLogicalId);
    expect(logging.LogFilePrefix).toBe(logPrefix);

    // The OTHER half of working server access logging, and the half that fails
    // silently. `LoggingConfiguration` alone is a request; S3 delivers nothing
    // unless the destination's policy also lets logging.s3.amazonaws.com PUT
    // there. CDK writes that statement automatically, but only while the
    // destination is a Bucket CONSTRUCT in this stack — point
    // serverAccessLogsBucket at `Bucket.fromBucketName(...)` and the template
    // still carries a complete-looking LoggingConfiguration with no grant behind
    // it, announced by nothing louder than an
    // `@aws-cdk/aws-s3:accessLogsPolicyNotAdded` warning. Without this
    // assertion every case above still passes in that state, which is the exact
    // failure this block exists to make legible.
    const grants = accessLogsPolicyStatements(template)
      .flatMap((statement) => {
        // flatMap rather than filter+map on `success`: narrowing the safeParse
        // union that way leans on TS 5.5+ inferred type predicates, and this
        // reads the same without the dependency on that inference.
        const parsed = LogDeliveryStatementSchema.safeParse(statement);
        return parsed.success ? [parsed.data] : [];
      })
      .filter((statement) => statement.Condition.ArnLike['aws:SourceArn']['Fn::GetAtt'][0] === sourceLogicalId);
    expect(grants, `no log-delivery grant for ${prefix} — S3 would accept the config and deliver nothing`)
      .toHaveLength(1);

    // Scoped to this producer's own prefix, so one bucket's grant cannot be
    // used to write over another's logs.
    const joinParts = grants[0].Resource['Fn::Join'][1];
    expect(joinParts.at(-1)).toBe(`/${logPrefix}*`);
    expect(grants[0].Condition.StringEquals['aws:SourceAccount']).toBe(SYNTH_ACCOUNT);
  });

  it('leaves the access-logs bucket without a destination of its own', () => {
    // Self-targeting IS available — S3 permits the target to be the source, and
    // in CDK a `serverAccessLogsPrefix` with no `serverAccessLogsBucket`
    // self-targets — so this is a declined option, not an impossible one. It is
    // declined because log deliveries themselves generate access log records:
    // the bucket would grow on its own writes, against a lifecycle rule that is
    // UNPREFIXED and expires everything at 90 days, and buy no visibility that
    // the four producer prefixes do not already give.
    //
    // No suppression is missing either. cdk-nag's AwsSolutions-S1 has a fallback
    // branch for a bucket with no loggingConfiguration: it scans `Stack.of(node)`
    // for a CfnBucket naming this one as its destination and returns COMPLIANT if
    // it finds one. TWO do — RawDataBucket and WebsiteBucket — and the count is of
    // SAME-STACK producers only, which is the part that is easy to get wrong: the
    // S3-import bucket writes into this destination but lives in
    // VocIngestionStack, outside the scan, and the CloudFront distribution's
    // `cloudfront-frontend/` prefix never counts because a distribution is not a
    // CfnBucket. So two of the FOUR producers in total — three buckets plus the
    // distribution — satisfy the rule, this bucket is
    // compliant by construction and raises no finding —
    // AwsSolutions-VocCoreStack-NagReport.csv records it as `Compliant`. Worth
    // stating because the tempting wrong conclusion is that some suppression
    // elsewhere is quietly covering it; none is. Move RawDataBucket to another
    // stack and only WebsiteBucket would remain — move both and the rule starts
    // firing here with nothing else changed.
    const template = synthCoreTemplate();
    const [, accessLogs] = bucketByLogicalIdPrefix(template, 'AccessLogsBucket');

    expect(accessLogs.Properties ?? {}).not.toHaveProperty('LoggingConfiguration');
  });

  it('expires everything in the access-logs bucket at 90 days, with no prefix', () => {
    // The premise two comments in this block rest on, and the reason adding a
    // fourth producer needed no lifecycle change at all: the rule is BUCKET-WIDE,
    // so `website-bucket/` — and `raw-data-bucket/`, `s3-import-bucket/`,
    // `cloudfront-frontend/` — inherit the 90-day expiry without a rule of their
    // own. The absence of `Prefix` is the load-bearing half. Add a prefix-scoped
    // rule (the plausible next step: "keep CloudFront logs 30 days, S3 logs 90")
    // and every unlisted prefix accumulates forever, which is invisible in a diff
    // and would silently falsify both the comment above and this PR's claim that
    // the destination needed no changes.
    //
    // That absence is enforced by LifecycleSchema's `.strict()`, not by an
    // assertion here — see its comment for why the assertion form cannot work.
    const [, accessLogs] = bucketByLogicalIdPrefix(synthCoreTemplate(), 'AccessLogsBucket');

    const rules = LifecycleSchema.parse(accessLogs.Properties?.LifecycleConfiguration).Rules;
    expect(rules, 'expected exactly one lifecycle rule on the access-logs bucket').toHaveLength(1);
    expect(rules[0].ExpirationInDays).toBe(90);
    expect(rules[0].Status).toBe('Enabled');
  });

  it('carries no AwsSolutions-S1 suppression on the website bucket', () => {
    // The retired suppression described the missing property above. With the
    // property present the rule no longer fires, so a suppression would be dead
    // metadata that a later audit has to re-litigate.
    //
    // Narrowed to this one rule on purpose: a future suppression on this bucket
    // for some OTHER finding is a legitimate act, and it must not fail a case
    // whose whole subject is AwsSolutions-S1.
    const [, website] = bucketByLogicalIdPrefix(synthCoreTemplate(), 'WebsiteBucket');

    const suppressions = NagMetadataSchema.parse(website.Metadata ?? {}).cdk_nag?.rules_to_suppress ?? [];
    expect(suppressions.map((rule) => rule.id)).not.toContain('AwsSolutions-S1');
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
 * Regression guard for issue #254: the Identity Pool's AUTHENTICATED role must
 * not be able to invoke a Lambda directly.
 *
 * The role carried `lambda:InvokeFunction` + `lambda:InvokeFunctionUrl` on
 * `function:*voc-chat-stream*` from the era when the browser signed a Lambda
 * Function URL with SigV4. Streaming chat is `POST /chat/stream` on the REST API
 * now (Cognito authorizer, `Integration.ResponseTransferMode: STREAM`) and the
 * Function URL is gone — but the grant is not merely dead, it is a bypass: any
 * signed-in user can exchange their JWT for pool credentials and call the
 * function directly, skipping the authorizer, per-method throttling, request
 * validation and access logs.
 *
 * Reached through the ROLE ATTACHMENT rather than by logical id, so the case
 * measures "whatever role a signed-in browser can actually assume" and not
 * "the construct that happens to be called CognitoAuthenticatedRole". It reads
 * all three shapes a permission can arrive through whose contents are IN this
 * template — an inline `Policies` block on the role, a standalone
 * `AWS::IAM::Policy` naming it, and an `AWS::IAM::ManagedPolicy` naming it from
 * the policy side — and fails loudly on the one shape it does not read, any
 * `ManagedPolicyArns` entry, since resolving such a reference is not attempted
 * whether it points outside the template or at a policy defined in it.
 */
describe('VocCoreStack Identity Pool authenticated role (issue #254)', () => {
  // Action/Resource are typed rather than `z.unknown()` + a cast: CloudFormation
  // renders either as a bare string or an array of them, and a shape that is
  // neither (an `Fn::If`, or the `Fn::Join` a token-bearing ARN renders as) must
  // STOP this block rather than flow through as an opaque object that
  // `/^lambda:/` fails to match and `toContain` never substring-searches. The
  // union throws on it instead, and says what to do about it — a legitimate
  // future grant on this role is the likely way it fires.
  //
  // `NotAction`/`NotResource` fail loudly for the opposite reason: `Allow` +
  // `NotAction` is a superset of the grant this block guards, and would read as
  // an empty action set because both fields above are then legitimately absent.
  const ActionOrResourceSchema = z
    .union([z.string(), z.array(z.string())], {
      errorMap: () => ({
        message:
          'unreadable Action/Resource shape (an Fn::If or Fn::Join?) — extend this schema to read it',
      }),
    })
    .optional();
  /**
   * Says what to do when the `aud` condition stops rendering readably.
   *
   * Scoped to that ONE case on purpose. A missing `aud`, or a hardcoded pool id,
   * is perfectly readable and is a bypass this case exists to catch — telling
   * the reader to "extend this schema" there would be advice to widen the guard
   * until it accepts the regression, so both are let through to the assertion
   * below and fail on their value instead.
   */
  const UNREADABLE_POOL_REF = {
    errorMap: () => ({
      message:
        'unreadable Identity Pool reference (a cross-stack import or Fn::GetAtt?) — extend this schema to read it',
    }),
  };
  const StatementSchema = z.object({
    Action: ActionOrResourceSchema,
    Resource: ActionOrResourceSchema,
    NotAction: z.never().optional(),
    NotResource: z.never().optional(),
  });
  const PolicyDocumentSchema = z.object({ Statement: z.array(StatementSchema) });

  /** A rendered `Action`/`Resource`, normalised to a list. */
  function toList(value: string | string[] | undefined): string[] {
    if (value === undefined) return [];
    return typeof value === 'string' ? [value] : value;
  }

  /**
   * Does a policy's `Roles` list name this role?
   *
   * A same-stack role renders as `{ Ref: <logical id> }`, so the ref is matched
   * structurally rather than by searching the stringified list — the logical id
   * appearing in some other position (a `PolicyName`, say) must not count.
   * Anything else in the list is some OTHER role: this one has no explicit
   * `roleName` to be referenced by, and it is defined here, not imported.
   */
  function namesRole(roles: unknown, logicalId: string): boolean {
    return z
      .array(z.unknown())
      .parse(roles ?? [])
      .some((entry) => {
        const ref = z.object({ Ref: z.string() }).safeParse(entry);
        return ref.success && ref.data.Ref === logicalId;
      });
  }

  /** The logical id the Identity Pool hands to a signed-in browser. */
  function authenticatedRoleLogicalId(template: Template): string {
    const attachments = Object.values(
      template.findResources('AWS::Cognito::IdentityPoolRoleAttachment'),
    );
    // The attachment itself is the still-required wiring: Amplify's JWT ->
    // AWS-credentials exchange fails outright without it, so its absence is a
    // regression and NOT a way for this case to pass by finding no role.
    expect(attachments, 'expected exactly one IdentityPoolRoleAttachment').toHaveLength(1);
    const authenticated = z
      .object({ 'Fn::GetAtt': z.tuple([z.string(), z.literal('Arn')]) })
      .parse(attachments[0].Properties?.Roles?.authenticated);
    return authenticated['Fn::GetAtt'][0];
  }

  /** The logical id of THIS deployment's Identity Pool, for the `aud` condition. */
  function identityPoolLogicalId(template: Template): string {
    const pools = Object.keys(template.findResources('AWS::Cognito::IdentityPool'));
    expect(pools, 'expected exactly one Identity Pool').toHaveLength(1);
    return pools[0];
  }

  /**
   * The pool a trust statement is scoped to, as something the case can diff.
   *
   * `identityPool.ref` renders as `{ Ref: <logical id> }`, so that ref is the
   * value worth comparing. Anything that is not a plain object is READABLE and
   * is handed back untouched to fail on its value: the condition absent
   * (`undefined` — assumable by any pool in any account), a hardcoded pool id,
   * or a list naming others besides this one. Only an object of some OTHER shape
   * — the `Fn::GetAtt` a cross-stack import would render — is genuinely
   * unreadable, and it alone gets the "extend this schema" diagnostic, which on
   * any of the former would be advice to widen the guard until it accepts them.
   */
  function audienceOf(audience: unknown): unknown {
    if (typeof audience !== 'object' || audience === null || Array.isArray(audience)) {
      return audience;
    }
    return z
      .object({ Ref: z.string(UNREADABLE_POOL_REF) }, UNREADABLE_POOL_REF)
      .parse(audience).Ref;
  }

  /** Every statement that role can act under, however the policy is attached. */
  function authenticatedRoleStatements(template: Template): z.infer<typeof StatementSchema>[] {
    const logicalId = authenticatedRoleLogicalId(template);
    const role = template.findResources('AWS::IAM::Role')[logicalId];
    expect(role, `the attachment names ${logicalId}, which is not a role in this template`)
      .toBeDefined();

    // ANY `ManagedPolicyArns` entry fails loudly, because this guard does not
    // follow the reference: an AWS-managed or cross-stack ARN is a string whose
    // contents are genuinely not in this template, and an in-stack policy attached
    // with `role.addManagedPolicy()` renders a `{ Ref }` here whose contents ARE
    // readable — but only by resolving it, which is not done. Failing on both
    // beats reporting a clean action set that looks clean only because the grant
    // moved out of the extractor's reach. The one managed-policy form collected
    // below instead is the POLICY-side `new ManagedPolicy(..., { roles: [role] })`,
    // which never lands here.
    expect(
      role.Properties?.ManagedPolicyArns ?? [],
      'authenticated role gained a managed policy — inspect it, and extend this guard to read it if it is in-stack',
    ).toEqual([]);

    // All three IN-TEMPLATE attachment shapes, reduced to a flat list of policy
    // DOCUMENTS:
    //   1. an inline `Policies` entry on the role;
    //   2. a standalone AWS::IAM::Policy naming it (what `addToPolicy()` renders);
    //   3. an AWS::IAM::ManagedPolicy naming it from the POLICY side, i.e.
    //      `new iam.ManagedPolicy(..., { roles: [role] })` — which leaves both
    //      `Policies` and `ManagedPolicyArns` undefined and emits no
    //      AWS::IAM::Policy, so without this leg a live grant reads as clean.
    // (2) and (3) are filtered identically: both carry `Roles` and
    // `PolicyDocument` with the same shapes.
    const attachedDocuments = (type: string): unknown[] =>
      Object.values(template.findResources(type))
        .filter((policy) => namesRole(policy.Properties?.Roles, logicalId))
        .map((policy) => policy.Properties?.PolicyDocument);

    const documents: unknown[] = [
      ...z
        .array(z.object({ PolicyDocument: z.unknown() }))
        .parse(role.Properties?.Policies ?? [])
        .map((policy) => policy.PolicyDocument),
      ...attachedDocuments('AWS::IAM::Policy'),
      ...attachedDocuments('AWS::IAM::ManagedPolicy'),
    ];

    return documents.flatMap((document) => PolicyDocumentSchema.parse(document).Statement);
  }

  it('can still read statements off a role that has them', () => {
    // The positive control the two cases below need. With the grant removed,
    // `authenticatedRoleStatements()` legitimately returns `[]` — so both of them
    // now pass on an empty list, and would keep passing if any of the three
    // attachment legs silently stopped finding policies (a CDK change to how
    // `addToPolicy` renders, say). The trust-policy case guards that the ROLE
    // still exists; it says nothing about whether the extractor can see a grant.
    //
    // Run over the same `AWS::IAM::Policy` + `namesRole` + `PolicyDocumentSchema`
    // path, pointed at whichever other role in this template does carry statements.
    // If this fails, the two guards below have gone decorative and the finding they
    // protect is unguarded — which is exactly what an all-clear cannot show.
    const template = synthCoreTemplate();
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const authenticated = authenticatedRoleLogicalId(template);
    const otherRoleRefs = policies
      .flatMap((policy) => z.array(z.unknown()).parse(policy.Properties?.Roles ?? []))
      .map((entry) => z.object({ Ref: z.string() }).safeParse(entry))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data.Ref)
      .filter((ref) => ref !== authenticated);
    expect(otherRoleRefs.length, 'this template must have another role with a policy')
      .toBeGreaterThan(0);

    // A looser statement shape than `PolicyDocumentSchema` on purpose. That schema
    // requires `Resource` to be a string or string array, which is right for the
    // role under test but not for an arbitrary neighbour: an ARN built by
    // `Fn::GetAtt` renders as an object, and parsing it here would fail this
    // control for a reason that has nothing to do with what it is checking. The
    // claim is that the DOCUMENT and STATEMENT LIST are reachable — which is the
    // part shared with the guards below — so `Action` is the only field read.
    const statements = policies
      .filter((policy) => namesRole(policy.Properties?.Roles, otherRoleRefs[0]))
      .flatMap((policy) => z
        .object({ Statement: z.array(z.object({ Action: ActionOrResourceSchema })) })
        .parse(policy.Properties?.PolicyDocument).Statement);

    expect(statements.length, 'the extractor reads statements when statements are there')
      .toBeGreaterThan(0);
    expect(statements.flatMap((statement) => toList(statement.Action)).length)
      .toBeGreaterThan(0);
  });

  it('grants neither lambda:InvokeFunction nor lambda:InvokeFunctionUrl', () => {
    const statements = authenticatedRoleStatements(synthCoreTemplate());

    // Asserted on the parsed action set, not on a substring of the rendered
    // template: `lambda:InvokeFunctionUrl` contains `lambda:InvokeFunction` as a
    // prefix, so a naive `toContain` on JSON cannot tell the two apart, and a
    // single-action statement renders as a bare string rather than an array.
    const actions = statements.flatMap((statement) => toList(statement.Action));

    expect(actions, 'a signed-in browser must reach chat only through API Gateway')
      .not.toContain('lambda:InvokeFunction');
    expect(actions).not.toContain('lambda:InvokeFunctionUrl');
    // And nothing else in the lambda: namespace either — `lambda:*` or
    // `lambda:InvokeAsync` would be the same bypass under a different spelling.
    expect(actions.filter((action) => /^lambda:|^\*$/.test(action))).toEqual([]);
  });

  it('names no chat-stream Lambda among its resources', () => {
    // The complement of the action check, and the one that survives a rename of
    // the action: the role has no business referencing that function at all.
    const resources = authenticatedRoleStatements(synthCoreTemplate()).flatMap((statement) =>
      toList(statement.Resource),
    );

    for (const resource of resources) {
      expect(resource).not.toContain('voc-chat-stream');
    }
  });

  it('keeps the pool attachment and the federated trust policy intact', () => {
    // The removal above is a permission removal only. The pool, the role and the
    // attachment stay — Amplify is configured from `identityPoolId` and the
    // credential exchange needs an assumable role — so a change that deleted the
    // role outright would make the two cases above vacuously green.
    const template = synthCoreTemplate();
    const role = template.findResources('AWS::IAM::Role')[authenticatedRoleLogicalId(template)];

    // StatementsSchema, not PolicyDocumentSchema: the latter's statement shape
    // lists Action/Resource and zod strips the rest, which would drop the
    // `Principal` this case is about.
    const trust = StatementsSchema.parse(role.Properties?.AssumeRolePolicyDocument);
    // Every federated statement, not the first one `find()` happens to return:
    // IAM evaluates a trust document as a UNION, so the trust is only as tight as
    // its LOOSEST statement. Reading one of them made the guard's outcome depend
    // on statement ORDER — appending a second federated statement with no `aud`
    // and `amr: unauthenticated` left this case green while the role became
    // assumable by anonymous identities from any pool in any AWS account.
    const federatedStatements = trust.Statement.filter(
      (statement) =>
        z
          .object({ Principal: z.object({ Federated: z.string() }) })
          .safeParse(statement)
          .data?.Principal.Federated === 'cognito-identity.amazonaws.com',
    );

    // Non-empty is the anti-vacuity half — the role must STILL be assumable by
    // the pool, so deleting it cannot green the cases above. Exactly-one is the
    // fail-open half: a second federated statement has no legitimate purpose
    // here, so refusing the shape beats trying to read every way it could widen
    // the trust, the same stance the `ManagedPolicyArns` guard takes.
    expect(
      federatedStatements,
      'the trust must be exactly one federated statement, and must still have one',
    ).toHaveLength(1);
    // And nothing else in the document either. A statement with a NON-federated
    // principal (`Principal.AWS: '*'` + `sts:AssumeRole`) never matches the
    // predicate above, so counting only federated statements would not see it,
    // yet it widens who can assume this role just as much.
    expect(trust.Statement, 'the trust must carry no statement beyond that one').toHaveLength(1);

    const federated = federatedStatements[0];

    // The assertions carrying weight, read structurally rather than as substrings
    // of the rendered statement: the presence of a condition KEY says nothing
    // about its VALUE, so flipping `amr` to `unauthenticated` — handing the role a
    // signed-in browser assumes to any anonymous pool identity — used to read as
    // clean here. Every field is typed narrowly on purpose: a shape this cannot
    // read (an `amr` list, an `Action` array) must stop the case rather than pass
    // it. Zod strips what it is not told about, so a condition key omitted from
    // this parse is a condition key this case does not guard: both halves of the
    // ONE statement asserted above are named, not just the one that regressed.
    const assumable = z
      .object({
        Action: z.string(),
        Condition: z.object({
          // Read, not constrained: an audience that is missing or is a literal
          // pool id must fail on its VALUE below, where the message names the
          // bypass. Constraining the shape here would fail those two at
          // `.parse()` instead, under the diagnostic for a legitimate future
          // render change — see `audienceOf()`.
          StringEquals: z
            .object({ 'cognito-identity.amazonaws.com:aud': z.unknown() })
            .optional(),
          'ForAnyValue:StringLike': z.object({
            'cognito-identity.amazonaws.com:amr': z.string(),
          }),
        }),
      })
      .parse(federated);

    // The mechanism — web identity. "Only that way" is what the two length
    // assertions above establish, since a second statement could name another.
    expect(assumable.Action).toBe('sts:AssumeRoleWithWebIdentity');
    // WHICH pool. Without this, dropping the `aud` condition makes the role
    // assumable via web identity by any Identity Pool in any AWS account — a
    // cross-ACCOUNT bypass, strictly worse than the cross-authorizer one this
    // block is about. Matched against the pool in this template rather than a
    // literal, so a hardcoded or foreign pool id fails too, and so does the
    // condition being absent: `audienceOf(undefined)` is `undefined`, which is
    // not the logical id.
    expect(
      audienceOf(assumable.Condition.StringEquals?.['cognito-identity.amazonaws.com:aud']),
      'the trust must be scoped to THIS Identity Pool',
    ).toBe(identityPoolLogicalId(template));
    // WHO within it: authenticated identities only.
    expect(
      assumable.Condition['ForAnyValue:StringLike']['cognito-identity.amazonaws.com:amr'],
      'the trust must admit AUTHENTICATED pool identities only',
    ).toBe('authenticated');
  });

  it('leaves no AwsSolutions-IAM5 suppression on the role with no wildcard left to suppress', () => {
    // The grant's blanket suppression (no `appliesTo`) was removed with it. A
    // suppression that outlives its finding is worse than none: it silences
    // whatever wildcard the next edit adds here, and cdk-nag would not complain.
    //
    // SCOPE: this reads the suppressions attached to the ROLE RESOURCE. A
    // stack-level one (`NagSuppressions.addStackSuppressions`) or one on an
    // ancestor construct lands elsewhere in the template and is not seen here.
    const template = synthCoreTemplate();
    const role = template.findResources('AWS::IAM::Role')[authenticatedRoleLogicalId(template)];

    expect(JSON.stringify(role.Metadata ?? {})).not.toContain('AwsSolutions-IAM5');
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

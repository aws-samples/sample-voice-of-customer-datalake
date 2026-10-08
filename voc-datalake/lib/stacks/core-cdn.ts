/**
 * VocCoreStack's CloudFront layer: the SPA distribution with its security
 * headers, the CloudFront URL-signing key pair (issue #229), the private
 * /avatars/* and /prototypes/* behaviors, and the design-integrations secret.
 * Created on the stack itself (not a child construct), so logical ids are unchanged.
 */
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { NagSuppressions } from 'cdk-nag';
import {
  apiSecretsSuppressions,
  cdkCustomResourceSuppressions,
  cdnSigningKeySuppressions,
  cloudfrontDefaultCertSuppressions,
  lambdaBasicExecutionRoleSuppressions,
} from '../utils/nag-suppressions';

/** What a VocCoreStack builder needs from the stack: itself and its prefix-aware names. */
export interface CoreBuildContext {
  stack: cdk.Stack;
  uniqueName: (baseName: string) => string;
  uniqueDnsName: (baseName: string) => string;
}

export interface CdnInputs {
  kmsKey: kms.Key;
  rawDataBucket: s3.Bucket;
  websiteBucket: s3.Bucket;
  accessLogsBucket: s3.Bucket;
}

export interface CoreCdn {
  frontendDistribution: cloudfront.Distribution;
  frontendDomainName: string;
  cdnSigningSecretArn: string;
  cdnSigningKeyPairId: string;
  designIntegrationsSecretArn: string;
  avatarsCdnUrl: string;
  prototypesCdnUrl: string;
}

export function createCoreCdn(ctx: CoreBuildContext, inputs: CdnInputs): CoreCdn {
  const { stack } = ctx;
  const { kmsKey, rawDataBucket, websiteBucket, accessLogsBucket } = inputs;

  // ============================================
  // CLOUDFRONT DISTRIBUTIONS
  // ============================================
  
  // Security headers policy
  const securityHeadersPolicy = new cloudfront.ResponseHeadersPolicy(stack, 'SecurityHeadersPolicy', {
    securityHeadersBehavior: {
      contentSecurityPolicy: {
        // frame-src 'self': required so the SPA can embed generated prototype HTML via
        // <iframe src="https://<this-domain>/prototypes/*"> (PR #131 Finding 3 fix). This is
        // a SEPARATE concern from frame-ancestors below: frame-ancestors governs who may embed
        // THIS page, frame-src governs what THIS page may embed. Without it, frame-src falls
        // back to default-src 'none' and blocks framing of anything, even same-origin content —
        // the /prototypes/* behavior's own PrototypeHeadersPolicy (script-src 'unsafe-inline')
        // still governs script execution inside that framed document; this only permits the
        // cross-document load itself.
        contentSecurityPolicy: `default-src 'none'; font-src 'self' data:; img-src 'self' data:; script-src 'self';manifest-src 'self'; style-src 'unsafe-inline' 'self'; style-src-elem 'unsafe-inline' 'self'; object-src 'none'; frame-src 'self'; connect-src 'self' https://*.amazoncognito.com https://*.amazonaws.com https://*.lambda-url.${cdk.Stack.of(stack).region}.on.aws; upgrade-insecure-requests; frame-ancestors 'none'; base-uri 'none';`,
        override: true,
      },
      contentTypeOptions: { override: true },
      frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
      referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.SAME_ORIGIN, override: true },
      strictTransportSecurity: {
        accessControlMaxAge: cdk.Duration.seconds(63072000),
        includeSubdomains: true,
        preload: true,
        override: true,
      },
      xssProtection: { protection: true, modeBlock: true, override: true },
    },
  });

  // Frontend hosting distribution (created first so we can use its domain for CORS)
  const frontendDistribution = new cloudfront.Distribution(stack, 'FrontendDistribution', {
    defaultBehavior: {
      origin: origins.S3BucketOrigin.withOriginAccessControl(websiteBucket),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
      compress: true,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy: securityHeadersPolicy,
    },
    defaultRootObject: 'index.html',
    // SPA deep-link routing: an unknown path is not a real 404, it is a
    // client-side route, so it has to return index.html.
    //
    // 403 IS DELIBERATELY NOT MAPPED HERE (issue #229). Custom error
    // responses are distribution-WIDE — CloudFront gives no way to scope
    // them per behavior — so a 403 rule laundered EVERY denial on this
    // distribution into a 200 carrying index.html. That is precisely why
    // unauthenticated access to /avatars/* and /prototypes/* went unnoticed,
    // and with trustedKeyGroups in place it would be actively harmful: a
    // rejected prototype request would render the entire SPA inside the
    // prototype iframe instead of failing, and no test could tell allow from
    // deny. Deep links keep working through the 404 rule because the
    // s3:ListBucket grant below makes S3 answer 404 (not 403) for a missing
    // key.
    errorResponses: [
      { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
    ],
    priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    enableLogging: true,
    logBucket: accessLogsBucket,
    logFilePrefix: 'cloudfront-frontend/',
  });
  NagSuppressions.addResourceSuppressions(frontendDistribution, cloudfrontDefaultCertSuppressions);
  const frontendDomainName = frontendDistribution.distributionDomainName;

  // Let CloudFront distinguish "missing object" from "not allowed" on the SPA
  // bucket. Without s3:ListBucket, S3 answers 403 for a key that does not
  // exist (it will not confirm absence to a caller that cannot list), which
  // forced the 403 -> index.html mapping removed above and with it the
  // laundering of every genuine denial into a 200 (issue #229). With the
  // grant, an unknown SPA route is a clean 404 and the 404 rule serves the
  // app shell.
  //
  // Scoped to this distribution and to the SPA bucket ONLY. The raw-data
  // bucket deliberately does NOT get it: there, 403-for-missing-key is the
  // desired answer, since confirming whether a given avatar or prototype key
  // exists is itself information we do not owe an unauthenticated viewer.
  websiteBucket.addToResourcePolicy(new iam.PolicyStatement({
    actions: ['s3:ListBucket'],
    principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
    resources: [websiteBucket.bucketArn],
    conditions: {
      StringEquals: {
        'AWS:SourceArn': cdk.Stack.of(stack).formatArn({
          service: 'cloudfront',
          region: '',
          resource: 'distribution',
          resourceName: frontendDistribution.distributionId,
        }),
      },
    },
  }));

  // ── Signed-URL trust for the private CDN paths (issue #229) ──────────────
  // /avatars/* and /prototypes/* used to be world-readable: Cognito is
  // enforced at API Gateway, never at the CDN, and both were plain cache
  // behaviors on the distribution that must stay public to serve the login
  // page. They are now restricted to a trusted key group, so a viewer needs
  // a signature the already-authenticated API mints per request.
  //
  // The keypair is generated at DEPLOY time by a custom resource which writes
  // the private half straight to Secrets Manager and returns only the public
  // half. Generating at SYNTH time would break the deterministic-synth
  // guarantee that core-stack.test.ts asserts, and a KMS asymmetric key
  // cannot stand in — kms:Sign has no SHA-1 option and CloudFront requires
  // RSA-SHA1. CloudFormation still owns the PublicKey and KeyGroup below, so
  // their create/update/delete ordering is not hand-rolled.
  const cdnSigningSecret = new secretsmanager.Secret(stack, 'CdnSigningKeySecret', {
    secretName: ctx.uniqueName('voc-cdn-signing-key'),
    description: 'RSA private key that signs CloudFront URLs for /avatars/* and /prototypes/*',
    encryptionKey: kmsKey,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const cdnSigningKeysLambda = new lambda.Function(stack, 'CdnSigningKeysLambda', {
    functionName: ctx.uniqueName('voc-cdn-signing-keys'),
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    handler: 'cdn_signing_keys.handler',
    // Node rather than Python: crypto.generateKeyPairSync is stdlib, so this
    // needs no layer. Python would need `cryptography`, i.e. Docker bundling
    // in CoreStack. Real, unit-tested file (lib/stacks/cdn-signing-keys.test.ts).
    //
    // fromAsset, NOT fromInline: at ~7KB this handler is comfortably past the
    // widely-cited 4096-character ceiling for an inline `Code.ZipFile`. In
    // practice CloudFormation accepted it and aws-cdk-lib 2.261.0 does not
    // check the limit at all, so the inline version deployed fine — but that
    // is undocumented tolerance, and this is a sample repo other people deploy
    // into their own accounts. An asset removes the question, and removes the
    // trap where adding a comment to the handler breaks a deploy.
    code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/custom_resources'), {
      // Ship only the Node handler. The directory also holds the Python
      // admin-bootstrap handler and its pytest suite, which would otherwise
      // be packaged into this function's zip.
      //
      // These patterns match AT ANY DEPTH, not just the top level: the default
      // IgnoreMode.GLOB uses .gitignore semantics, where a pattern containing
      // no slash matches by basename anywhere in the tree. Verified by staging
      // a nested `.py` and confirming it was excluded, so `**/*.py` is not
      // needed. The deployed zip contains exactly one file.
      exclude: ['*.py', '*.d.ts', 'test', '__pycache__'],
    }),
    timeout: cdk.Duration.minutes(1),
    // 256, not the 128 default: production measured 78.9% of 128 MB and a 4.4 s
    // run of pure CPU (generateKeyPairSync), over the 70% memory/CPU rule.
    // Lambda CPU scales with memory, so this also halves the keygen time.
    memorySize: 256,
    description: 'Generates the CloudFront URL-signing keypair once, then reuses it',
    logGroup: new logs.LogGroup(stack, 'CdnSigningKeysLambdaLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });
  // GetSecretValue is what makes the handler idempotent (reuse over rotate);
  // PutSecretValue writes the generated key.
  // Safe to use the L2 grants here: this Lambda is in THIS stack, so the
  // KMS key-policy statement they add names a same-stack role and creates no
  // cross-stack cycle (unlike the API stack's roles — see cdnSigningSecretArn).
  cdnSigningSecret.grantRead(cdnSigningKeysLambda);
  cdnSigningSecret.grantWrite(cdnSigningKeysLambda);
  const cdnSigningSecretArn = cdnSigningSecret.secretArn;

  // Figma / GitHub tokens for the design system (docs/company-context.md).
  // Starts as `{}`; PUT /settings/design-integrations writes it, and GET only
  // ever reports `{figma: bool, github: bool}`. RETAINed: an admin-entered
  // credential is not recreatable from the template.
  const designIntegrationsSecret = new secretsmanager.Secret(stack, 'DesignIntegrationsSecret', {
    secretName: ctx.uniqueName('voc/design-integrations'),
    description: 'Figma and GitHub tokens the design system reads designs and tokens with (write-only via the settings API)',
    encryptionKey: kmsKey,
    secretObjectValue: {},
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  NagSuppressions.addResourceSuppressions(designIntegrationsSecret, apiSecretsSuppressions);
  const designIntegrationsSecretArn = designIntegrationsSecret.secretArn;

  const cdnSigningKeysProvider = new cr.Provider(stack, 'CdnSigningKeysProvider', {
    onEventHandler: cdnSigningKeysLambda,
    // Same reasoning as AdminBootstrapProvider: at INFO the provider
    // framework logs the whole custom-resource response to CloudWatch. The
    // response carries only the PUBLIC key, but keeping this at FATAL means a
    // future field added to Data cannot leak by default.
    frameworkLambdaLoggingLevel: lambda.ApplicationLogLevel.FATAL,
    logGroup: new logs.LogGroup(stack, 'CdnSigningKeysProviderLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
  });

  const cdnSigningKeys = new cdk.CustomResource(stack, 'CdnSigningKeys', {
    serviceToken: cdnSigningKeysProvider.serviceToken,
    resourceType: 'Custom::CdnSigningKeys',
    properties: {
      SecretId: cdnSigningSecret.secretArn,
    },
  });

  NagSuppressions.addResourceSuppressions(cdnSigningSecret, cdnSigningKeySuppressions);
  NagSuppressions.addResourceSuppressions(cdnSigningKeysLambda, lambdaBasicExecutionRoleSuppressions, true);
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${stack.stackName}/CdnSigningKeysProvider/framework-onEvent`,
    [
      ...cdkCustomResourceSuppressions,
      ...lambdaBasicExecutionRoleSuppressions,
      {
        id: 'AwsSolutions-IAM5',
        reason: 'The CDK Provider framework invokes its handler by qualified ARN, requiring a version/alias wildcard scoped to CdnSigningKeysLambda only (same pattern as AdminBootstrapLambda).',
        appliesTo: [{ regex: '/Resource::<.*CdnSigningKeysLambda.*\\.Arn>:\\*/' }],
      },
    ],
    true
  );

  // The L2 PublicKey validates the PEM prefix only for resolved strings, so
  // an unresolved custom-resource attribute is accepted here by design.
  const cdnSigningPublicKey = new cloudfront.PublicKey(stack, 'CdnSigningPublicKey', {
    encodedKey: cdnSigningKeys.getAttString('PublicKeyPem'),
    comment: 'Signs /avatars/* and /prototypes/* URLs',
  });
  const cdnSigningKeyGroup = new cloudfront.KeyGroup(stack, 'CdnSigningKeyGroup', {
    items: [cdnSigningPublicKey],
    comment: 'Viewers must present a signature for the private CDN paths',
  });
  const cdnSigningKeyPairId = cdnSigningPublicKey.publicKeyId;

  // Avatars served from the same distribution under /avatars/* path
  // This avoids CSP issues (same-origin) and eliminates the need for a separate distribution
  //
  // Shared by both private paths: GET/HEAD only, compressed, and a cache key
  // that forwards no query strings. CACHING_OPTIMIZED means the signature is
  // NOT part of the cache key — signed URLs stay shareable across viewers at
  // the edge instead of fragmenting the cache per user. The consequence: an
  // object must never be overwritten in place, or the edge keeps the old bytes
  // for the TTL. Avatars therefore get a new content-addressed key per image
  // (`avatars/{persona_id}/{digest}.{ext}`, shared/avatar.py), prototypes a key per
  // document — a stale-image fix belongs in the key, not in this cache policy.
  const signedPathBehavior: cloudfront.AddBehaviorOptions = {
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
    cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
    compress: true,
    cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    trustedKeyGroups: [cdnSigningKeyGroup],
  };
  frontendDistribution.addBehavior(
    '/avatars/*',
    origins.S3BucketOrigin.withOriginAccessControl(rawDataBucket),
    signedPathBehavior,
  );
  const avatarsCdnUrl = `https://${frontendDomainName}/avatars`;

  // Prototypes served from the same distribution under /prototypes/* with their
  // OWN response-headers policy that permits inline <script>/<style>. Bedrock
  // (Opus 5) generates self-contained single-file HTML with inline JS for
  // in-prototype navigation; the main SPA's securityHeadersPolicy above
  // (script-src 'self') would block that JS entirely if reused here — hence a
  // dedicated policy scoped ONLY to this path, applied via a second cache
  // behavior (not a second distribution: cheaper, no extra propagation lag,
  // mirrors the /avatars/* pattern). This is same-origin/same-domain as the
  // main app, not a genuinely separate origin — the SCRIPT isolation that
  // matters (the model's JS can't reach the parent app's DOM/storage/cookies)
  // comes from the frontend loading this via a cross-document <iframe src=...>,
  // not from the domain differing.
  //
  // TWO THINGS THIS POLICY IS, WHICH ARE EASY TO CONFLATE (issue #229):
  //  1. It is NOT access control. Script isolation says nothing about who may
  //     fetch the URL; that is the trustedKeyGroups line below.
  //  2. It IS the EGRESS control on model-authored JS. `default-src 'none'`
  //     with no `connect-src` is what stops inline script in a prototype —
  //     running in a document holding PRD/PR-FAQ-derived content — from
  //     making outbound requests. Serving prototypes from anywhere that
  //     cannot set response headers (S3 directly, for instance) silently
  //     drops that, so this policy has to travel with the path.
  const prototypeHeadersPolicy = new cloudfront.ResponseHeadersPolicy(stack, 'PrototypeHeadersPolicy', {
    securityHeadersBehavior: {
      contentSecurityPolicy: {
        contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'; object-src 'none'; base-uri 'none';",
        override: true,
      },
      contentTypeOptions: { override: true },
    },
  });
  frontendDistribution.addBehavior(
    '/prototypes/*',
    origins.S3BucketOrigin.withOriginAccessControl(rawDataBucket),
    {
      ...signedPathBehavior, // prototypes are immutable per doc_id, so the same cache policy fits
      responseHeadersPolicy: prototypeHeadersPolicy,
    },
  );
  const prototypesCdnUrl = `https://${frontendDomainName}/prototypes`;

  return {
    frontendDistribution, frontendDomainName, cdnSigningSecretArn, cdnSigningKeyPairId,
    designIntegrationsSecretArn, avatarsCdnUrl, prototypesCdnUrl,
  };
}

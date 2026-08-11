/**
 * Unit-level rules for the deployment prefix: what a prefix may be, and where
 * it lands in a name.
 *
 * The end-to-end behaviour (five prefixed stacks, prefixed exports, the length
 * guard firing on the app's real longest name) lives in
 * lib/app-deployment-prefix.test.ts, which synthesizes the actual app. These
 * cover the branches that would otherwise only be reachable through a synth.
 */
import * as cdk from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';

import {
  DeploymentNaming,
  DNS_LABEL_LENGTH_LIMIT,
  NAME_LENGTH_LIMIT,
  PATH_NAME_LENGTH_LIMIT,
  validateDeploymentPrefix,
} from './naming';

function namingFor(prefix?: string): { stack: cdk.Stack; naming: DeploymentNaming } {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '111111111111', region: 'us-east-1' } });
  return { stack, naming: new DeploymentNaming(stack, prefix) };
}

describe('validateDeploymentPrefix', () => {
  it('treats an absent prefix as no prefix, which is the byte-identical default', () => {
    expect(validateDeploymentPrefix(undefined)).toBeUndefined();
    expect(validateDeploymentPrefix(null)).toBeUndefined();
  });

  it('treats an empty or whitespace-only prefix as no prefix', () => {
    // `-c deploymentPrefix=` reaches CDK as the empty string. Treating that as
    // a prefix would produce "-voc-feedback-..." — a name no service accepts,
    // failing at deploy rather than here.
    expect(validateDeploymentPrefix('')).toBeUndefined();
    expect(validateDeploymentPrefix('   ')).toBeUndefined();
  });

  it('trims surrounding whitespace rather than baking it into every name', () => {
    expect(validateDeploymentPrefix(' stg ')).toBe('stg');
  });

  it('accepts lowercase letters, digits and inner hyphens', () => {
    expect(validateDeploymentPrefix('stg')).toBe('stg');
    expect(validateDeploymentPrefix('team-a')).toBe('team-a');
    expect(validateDeploymentPrefix('d2')).toBe('d2');
  });

  it.each([
    ['Stg', 'uppercase — S3 bucket names reject it'],
    ['-stg', 'a leading hyphen'],
    ['stg-', 'a trailing hyphen'],
    ['stg_1', 'an underscore — S3 bucket names reject it'],
    ['stg.1', 'a dot, which would read as a bucket subdomain'],
    ['stg 1', 'an inner space'],
  ])('rejects %j (%s)', (value) => {
    expect(() => validateDeploymentPrefix(value)).toThrow(/Invalid deploymentPrefix/);
  });

  it('rejects a non-string, e.g. -c deploymentPrefix=true parsed from JSON context', () => {
    expect(() => validateDeploymentPrefix(true)).toThrow(/must be a string/);
    expect(() => validateDeploymentPrefix(7)).toThrow(/must be a string/);
  });

  it('rejects an absurdly long prefix by talking about the prefix, not a resource', () => {
    // A prefix that cannot fit ANY name should not report whichever resource
    // happened to overflow first — that reads as a resource problem.
    expect(() => validateDeploymentPrefix('a'.repeat(40)))
      .toThrow(/is 40 characters; the absolute maximum is 20/);
  });

  it('does not present the 20-character ceiling as a workable budget', () => {
    // 20 is an order of magnitude above the real budget — the app's longest name
    // leaves ONE character in us-east-1 with the committed plugin set. Reporting
    // only "the maximum is 20" sends the operator off to try a 19-character
    // prefix that cannot deploy.
    //
    // Asserted on the FIGURES, not on the prose around them: an earlier version
    // of this case pinned two sentence fragments, which couples the suite to
    // copy-editing and fails on a reword that keeps every number right.
    const message = messageFrom(() => validateDeploymentPrefix('a'.repeat(21)));
    expect(message).toContain('is 21 characters; the absolute maximum is 20');
    expect(message).toContain('64'); // the limit that actually binds
    expect(message).toMatch(/ONE character/); // ...and the budget it leaves
  });

  it('accepts a purely numeric prefix, which is legal in every namespace it lands in', () => {
    // The pattern permits a leading digit, so state the intent: `2-voc-raw-data-…`
    // is a valid bucket name and a valid Cognito domain prefix (only a leading
    // hyphen or an uppercase letter would not be), so there is nothing to reject.
    expect(validateDeploymentPrefix('2')).toBe('2');
    expect(validateDeploymentPrefix('2-a')).toBe('2-a');
  });
});

/** The message of the error `run` throws, or `''` when it throws nothing. */
function messageFrom(run: () => unknown): string {
  try {
    run();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : '';
  }
}

describe('uniqueName', () => {
  it('is unchanged with no prefix — the invariant that keeps existing deployments intact', () => {
    const { stack, naming } = namingFor();
    expect(stack.resolve(naming.uniqueName('voc-feedback'))).toEqual({
      'Fn::Join': ['', ['voc-feedback-', { Ref: 'AWS::AccountId' }, '-', { Ref: 'AWS::Region' }]],
    });
  });

  it('keeps account and region as deploy-time tokens so templates stay portable', () => {
    const { stack, naming } = namingFor('stg');
    const resolved = JSON.stringify(stack.resolve(naming.uniqueName('voc-feedback')));
    expect(resolved).toContain('stg-voc-feedback-');
    expect(resolved).toContain('AWS::AccountId');
    expect(resolved).toContain('AWS::Region');
    // The prefix itself is a synth-time literal, not a token.
    expect(resolved).not.toContain('${Token');
  });
});

describe('prefixed', () => {
  it('puts the prefix on the voc segment of a path-shaped name, not in front of /aws', () => {
    // `/aws/lambda/...` is a namespace CloudWatch and the console understand,
    // and the api-stack log groups are built as `/aws/lambda/${uniqueName()}`,
    // which already lands the prefix there. Front-prefixing would give two
    // shapes for the same kind of resource inside one deployment.
    const { naming } = namingFor('stg');
    expect(naming.prefixed('/aws/lambda/voc-ingestor-webscraper')).toBe('/aws/lambda/stg-voc-ingestor-webscraper');
    expect(naming.prefixed('/aws/stepfunctions/voc-research-workflow')).toBe('/aws/stepfunctions/stg-voc-research-workflow');
  });

  it('prefixes a bare name at the front', () => {
    const { naming } = namingFor('stg');
    expect(naming.prefixed('VocFrontendDomainName')).toBe('stg-VocFrontendDomainName');
    expect(naming.prefixed('voc-ingestor')).toBe('stg-voc-ingestor');
  });

  it('keeps a path shape even when no segment starts with voc', () => {
    // Unreachable today — every name the app generates is `voc`-stemmed — which
    // is exactly why it needs pinning: the branch a future name would take was
    // front-prefixing, giving `stg-/aws/lambda/x`. That breaks the `/aws/...`
    // namespace this placement rule exists to preserve, so the prefix goes on
    // the last segment, the one identifying the resource.
    const { naming } = namingFor('stg');
    expect(naming.prefixed('/aws/lambda/my-thing')).toBe('/aws/lambda/stg-my-thing');
    expect(naming.prefixed('/aws/apigateway/access-logs')).toBe('/aws/apigateway/stg-access-logs');
    // A flat name has one segment, so the two branches agree there.
    expect(naming.prefixed('my-thing')).toBe('stg-my-thing');
  });

  it('is the identity with no prefix', () => {
    const { naming } = namingFor();
    expect(naming.prefixed('/aws/lambda/voc-x')).toBe('/aws/lambda/voc-x');
    expect(naming.prefixed('VocFrontendDomainName')).toBe('VocFrontendDomainName');
  });
});

describe('the name-length guard', () => {
  /** Longest base name that still fits unprefixed: 64 - len('-<12>-us-east-1'). */
  const budget = NAME_LENGTH_LIMIT - '-111111111111-us-east-1'.length;

  function overrunsFor(
    prefix: string | undefined,
    baseNames: string[],
    kind: 'default' | 'dns-label' = 'default',
  ): string[] {
    const { stack, naming } = namingFor(prefix);
    for (const baseName of baseNames) {
      if (kind === 'dns-label') naming.uniqueDnsName(baseName);
      else naming.uniqueName(baseName);
    }
    return stack.node.validate();
  }

  it('never fires without a prefix, even on a name that is already long', () => {
    // Some log-group names the app generates today already exceed 64 characters,
    // and they deploy fine. A new synth failure on the default would be a
    // regression, not a guard, so the check is prefix-only by construction.
    expect(overrunsFor(undefined, ['a'.repeat(budget + 20)])).toEqual([]);
  });

  it('accepts a prefix that exactly reaches the limit', () => {
    // An off-by-one here would reject a prefix that deploys perfectly well.
    expect(overrunsFor('ab', ['x'.repeat(budget - 3)])).toEqual([]);
  });

  it('rejects a prefix one character past the limit', () => {
    const errors = overrunsFor('abc', ['x'.repeat(budget - 3)]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`over the ${NAME_LENGTH_LIMIT}-character limit`);
  });

  it('names the offending resource and the remaining budget', () => {
    // "prefix too long" alone forces the operator to guess; the message has to
    // say which name broke and what would fit.
    const [error] = overrunsFor('staging', ['voc-ingest-app_reviews_android-schedule']);
    expect(error).toContain('staging-voc-ingest-app_reviews_android-schedule');
    expect(error).toContain('70 characters');
    expect(error).toContain('Use a prefix of at most 1 character');
  });

  it('reports every overrunning name, not just the first', () => {
    // One synth should list everything to fix rather than one name per attempt.
    const errors = overrunsFor('staging', [
      'voc-ingest-app_reviews_android-schedule',
      'voc-ingest-app_reviews_ios-schedule',
    ]);
    expect(errors).toHaveLength(2);
  });

  it('says no prefix fits when even one character overruns', () => {
    const [error] = overrunsFor('a', ['x'.repeat(budget)]);
    expect(error).toContain('No prefix fits this name');
  });

  it('holds log groups and secrets to their own, larger ceiling', () => {
    // Path-shaped names are CloudWatch log groups and Secrets Manager secrets,
    // which allow 512. Judging them against 64 would fail on names the app
    // already deploys today.
    const pathBudget = PATH_NAME_LENGTH_LIMIT - '-111111111111-us-east-1'.length;
    expect(overrunsFor('stg', [`/aws/lambda/${'x'.repeat(80)}`])).toEqual([]);
    const errors = overrunsFor('stg', [`/aws/lambda/voc-${'x'.repeat(pathBudget)}`]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`over the ${PATH_NAME_LENGTH_LIMIT}-character limit`);
    expect(errors[0]).toContain('log group and secret names');
  });

  it('holds bucket names and Cognito domain prefixes to 63, not 64', () => {
    // The gap is one character, and it decides whether the name deploys: S3 and
    // the Cognito hosted UI both want a single DNS label. A name of exactly 64
    // would clear a 64-character guard at synth and fail at `cdk deploy`, which
    // is the worst place to find out.
    const dnsBudget = DNS_LABEL_LENGTH_LIMIT - '-111111111111-us-east-1'.length;

    // Same base name, same prefix: allowed as a Lambda name, rejected as a bucket.
    const asLambda = overrunsFor('stg', ['x'.repeat(dnsBudget - 3)], 'default');
    expect(asLambda).toEqual([]);
    const asBucket = overrunsFor('stg', ['x'.repeat(dnsBudget - 3)], 'dns-label');
    expect(asBucket).toHaveLength(1);
    expect(asBucket[0]).toContain(`over the ${DNS_LABEL_LENGTH_LIMIT}-character limit`);
    expect(asBucket[0]).toContain('S3 bucket names and Cognito domain prefixes');
  });

  it('rejects a prefix that takes voc-access-logs to exactly 64 in the widest region', () => {
    // The reachable case, with the app's real numbers:
    // `voc-access-logs-<12-digit account>-ap-southeast-7` is 43 characters, and
    // a 20-character prefix — which validateDeploymentPrefix admits — takes it to
    // 64. One over the bucket limit, and previously accepted.
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'WidestRegionStack', {
      env: { account: '111111111111', region: 'ap-southeast-7' },
    });
    const naming = new DeploymentNaming(stack, 'a'.repeat(20));
    expect(naming.uniqueDnsName('voc-access-logs')).toContain('voc-access-logs');

    const [error] = stack.node.validate();
    expect(error).toContain('64 characters');
    expect(error).toContain(`over the ${DNS_LABEL_LENGTH_LIMIT}-character limit`);
    expect(error).toContain('S3 bucket names and Cognito domain prefixes');
    // 63 - 43 - 1 separator = 19.
    expect(error).toContain('Use a prefix of at most 19 characters');
  });

  it('ignores name patterns, which are not resource names', () => {
    // `voc-ingestor-{source}-...` is handed to a Lambda as an environment
    // variable; the concrete functions register their own lengths where they are
    // created. Counting the pattern would reject a prefix over a name that never
    // exists.
    const { stack, naming } = namingFor('stg');
    naming.uniqueNamePattern('x'.repeat(budget));
    expect(stack.node.validate()).toEqual([]);
  });
});

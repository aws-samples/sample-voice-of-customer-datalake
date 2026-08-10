import { Aws, Stack, Token } from 'aws-cdk-lib';

/**
 * SINGLE SOURCE OF TRUTH for physical resource names, and for the optional
 * per-deployment prefix that lets TWO independent copies of the platform live
 * in ONE account and region (issue: side-by-side deployments).
 *
 * `${base}-${account}-${region}` makes a name unique ACROSS accounts, which is
 * what a public sample needs, but it does nothing for two deployments INSIDE
 * one account and region — both resolve to the same string and the second
 * deploy collides. `deploymentPrefix` adds the missing dimension:
 *
 *   no prefix  ->  voc-feedback-123456789012-us-east-1        (unchanged)
 *   prefix stg ->  stg-voc-feedback-123456789012-us-east-1
 *
 * The prefix is OPT-IN and the unset case is byte-identical to the templates
 * this repo synthesized before the prefix existed — deliberately, because
 * CloudFormation implements a rename of a table, bucket or user pool as a
 * REPLACEMENT, i.e. silent data loss on every existing deployment.
 * `lib/app-baseline.test.ts` proves that byte-identity rather than asserting it.
 */

/** Longest name a Lambda function, IAM role or EventBridge rule may carry. */
export const NAME_LENGTH_LIMIT = 64;

/**
 * Ceiling for the "path-shaped" names (`/aws/lambda/...`,
 * `/aws/stepfunctions/...`, `voc-datalake/api-credentials`), which are
 * CloudWatch log groups and Secrets Manager secrets. Both allow 512, and the
 * app already generates log-group names past 64 today, so validating them
 * against {@link NAME_LENGTH_LIMIT} would fail on the no-prefix default.
 */
export const PATH_NAME_LENGTH_LIMIT = 512;

/** Every AWS account id is 12 digits, so the token's resolved width is known. */
const ACCOUNT_ID_LENGTH = 12;

/**
 * Width assumed for `${Aws.REGION}` when the stack is environment-agnostic and
 * the region is still a token at synth time. The app always passes a concrete
 * region (bin/voc-datalake.ts defaults to us-east-1), so this is a safety net
 * rather than the normal path; it is the widest region name AWS has shipped so
 * that the budget it reports is never optimistic.
 */
const WIDEST_REGION_NAME = 'ap-southeast-7';

/**
 * Placeholder a Lambda substitutes at runtime in the name patterns CDK hands
 * it (`INGESTOR_FUNCTION_NAME_PATTERN`, `INGEST_SCHEDULE_RULE_NAME_PATTERN`).
 *
 * MUST stay in lockstep with the Python side — `lambda/api/integrations_handler.py`
 * and `plugins/_shared/circuit_breaker.py` — which
 * lambda/api/test/test_integrations_handler_prefix.py pins.
 */
export const SOURCE_PLACEHOLDER = '{source}';

/** Characters a prefix may contain, and where a hyphen may sit. */
const PREFIX_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Upper bound on the prefix itself, independent of any single name. S3 bucket
 * names and Cognito domain prefixes are the tightest namespaces the prefix
 * lands in, and a prefix longer than this cannot fit anywhere — reject it with
 * a message about the prefix instead of about an arbitrary resource.
 */
const PREFIX_MAX_LENGTH = 20;

/**
 * Validate and normalize the `deploymentPrefix` context value.
 *
 * Returns `undefined` for "not supplied" (absent, empty, or whitespace) so a
 * caller can pass the result straight through to stack props and get today's
 * unprefixed names. Anything present but unusable throws at synth: a typo in a
 * prefix must not silently deploy under a DIFFERENT name than intended, which
 * for buckets and tables means a second, empty copy of the data layer.
 */
export function validateDeploymentPrefix(contextValue: unknown): string | undefined {
  if (contextValue === undefined || contextValue === null) return undefined;
  if (typeof contextValue !== 'string') {
    throw new Error(
      `deploymentPrefix must be a string, got ${JSON.stringify(contextValue)}. ` +
      'Pass it as -c deploymentPrefix=<prefix>, e.g. -c deploymentPrefix=stg.',
    );
  }
  const prefix = contextValue.trim();
  if (prefix === '') return undefined;
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      `Invalid deploymentPrefix ${JSON.stringify(contextValue)}. ` +
      'Use lowercase letters, digits and inner hyphens only (e.g. stg, demo, team-a): ' +
      'the prefix becomes part of S3 bucket names and Cognito domain prefixes, which ' +
      'accept nothing else.',
    );
  }
  if (prefix.length > PREFIX_MAX_LENGTH) {
    throw new Error(
      `deploymentPrefix ${JSON.stringify(prefix)} is ${prefix.length} characters; ` +
      `the maximum is ${PREFIX_MAX_LENGTH}. Every generated name carries the prefix, ` +
      'so a long one leaves no room for the name itself.',
    );
  }
  return prefix;
}

/** Length limit that applies to the resolved form of `baseName`. */
export function nameLengthLimit(baseName: string): number {
  return baseName.includes('/') ? PATH_NAME_LENGTH_LIMIT : NAME_LENGTH_LIMIT;
}

/**
 * Builds the physical names for one stack, and — when a prefix is in play —
 * checks that none of them overruns its service limit.
 *
 * The check is registered as a stack validation rather than thrown from
 * {@link uniqueName} so that ONE synth reports the tightest budget across every
 * name the app actually generates, instead of whichever name happened to be
 * constructed first. It only runs when a prefix is set: with no prefix the
 * names are exactly the ones this repo has always deployed, and a new synth
 * failure on them would be a regression, not a guard.
 */
export class DeploymentNaming {
  private readonly baseNames: string[] = [];

  constructor(
    private readonly stack: Stack,
    /** Already normalized by {@link validateDeploymentPrefix}. */
    private readonly prefix?: string,
  ) {
    if (prefix) {
      this.stack.node.addValidation({ validate: () => this.overrunMessages() });
    }
  }

  /** The prefix in force, or `undefined` when this is an unprefixed deployment. */
  get deploymentPrefix(): string | undefined {
    return this.prefix;
  }

  /**
   * Namespace a bare name: stack ids, CloudFormation export names and the
   * wildcard ARNs that must not reach across deployments.
   */
  prefixed(name: string): string {
    return this.prefix ? `${this.prefix}-${name}` : name;
  }

  /**
   * Physical resource name. Account and region stay CDK tokens so templates
   * remain portable; the prefix (when set) is a literal, resolved at synth.
   */
  uniqueName(baseName: string): string {
    this.baseNames.push(baseName);
    return `${this.prefixed(baseName)}-${Aws.ACCOUNT_ID}-${Aws.REGION}`;
  }

  /**
   * A name PATTERN for a runtime consumer, e.g.
   * `voc-ingestor-{source}-<account>-<region>` handed to a Lambda that resolves
   * `{source}` per request. Not itself a resource name — the concrete resources
   * it describes register their own lengths where they are created — so it is
   * deliberately excluded from the length check.
   */
  uniqueNamePattern(baseNameTemplate: string): string {
    return `${this.prefixed(baseNameTemplate)}-${Aws.ACCOUNT_ID}-${Aws.REGION}`;
  }

  /** Resolved width of `${baseName}-${account}-${region}`, prefix excluded. */
  private unprefixedLength(baseName: string): number {
    const region = Token.isUnresolved(this.stack.region) ? WIDEST_REGION_NAME : this.stack.region;
    return baseName.length + 1 + ACCOUNT_ID_LENGTH + 1 + region.length;
  }

  /**
   * One message per name the prefix pushes over its limit, each naming the
   * offending resource and how many characters a prefix may actually use.
   */
  private overrunMessages(): string[] {
    const prefix = this.prefix;
    if (!prefix) return [];
    const cost = prefix.length + 1; // the prefix plus its "-" separator
    return this.baseNames
      .map((baseName) => ({
        baseName,
        limit: nameLengthLimit(baseName),
        length: this.unprefixedLength(baseName),
      }))
      .filter(({ limit, length }) => length + cost > limit)
      .map(({ baseName, limit, length }) => {
        const budget = limit - length - 1; // -1 for the separator
        const affordable = budget > 0
          ? `Use a prefix of at most ${budget} character${budget === 1 ? '' : 's'}`
          : 'No prefix fits this name';
        return (
          `deploymentPrefix "${prefix}" makes "${this.prefixed(baseName)}-<account>-<region>" ` +
          `${length + cost} characters, over the ${limit}-character limit for ` +
          `${baseName.includes('/') ? 'log group and secret names' : 'Lambda function, IAM role and EventBridge rule names'}. ` +
          `${affordable}, or shorten the resource name (e.g. disable the plugin that owns it).`
        );
      });
  }
}

/**
 * Creates a unique resource name using CDK tokens, with no deployment prefix.
 *
 * Retained for callers outside a {@link DeploymentNaming}-aware stack. Prefer
 * `this.uniqueName()` on VocStack, which honours `deploymentPrefix`; a name
 * built here can collide when two copies share an account and region.
 */
export function uniqueName(baseName: string): string {
  return `${baseName}-${Aws.ACCOUNT_ID}-${Aws.REGION}`;
}

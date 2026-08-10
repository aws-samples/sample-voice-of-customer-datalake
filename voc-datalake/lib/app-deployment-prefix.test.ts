/**
 * What `-c deploymentPrefix=<p>` must actually achieve: two independent copies
 * of the platform coexisting in ONE account and region.
 *
 * `${base}-${account}-${region}` makes names unique across accounts but not
 * within one, so before this flag a second deploy either collided or — worse,
 * because it is silent — UPDATED the first deployment's stacks. Isolation is an
 * all-or-nothing property: one unprefixed name is one shared resource, and a
 * shared IAM wildcard is one deployment reaching into the other's ingestors. So
 * these assert the whole surface rather than samples of it.
 *
 * The companion guard is lib/app-baseline.test.ts, which proves the UNSET case
 * changes nothing.
 */
import { describe, expect, it } from 'vitest';

import { nameInventory } from './test-support/name-inventory';
import { diagnostics, SynthFailure, synthApp, SYNTH_ACCOUNT, SYNTH_REGION } from './test-support/synth-app';

/**
 * Short on purpose. The tightest budget in the app is the
 * `app_reviews_android` schedule rule: `voc-ingest-app_reviews_android-schedule`
 * plus `-<12-digit account>-us-east-1` is already 62 of the 64 characters
 * EventBridge allows, so only a ONE-character prefix fits with every plugin
 * enabled. That is the real number, and the length guard derives it rather than
 * trusting this comment.
 */
const PREFIX = 'b';

const BASE_STACK_IDS = [
  'VocApiStack',
  'VocCoreStack',
  'VocIngestionStack',
  'VocProcessingStack',
  'VocWebSearchStack',
];

const prefixed = synthApp({ deploymentPrefix: PREFIX });
const unprefixed = synthApp();

describe('a prefixed deployment', () => {
  it('names its stacks distinctly from an unprefixed one, without adding a stack', () => {
    // Still five templates: a downstream packaging consumer accepts at most
    // five, and that ceiling is invisible to `cdk synth`.
    expect(prefixed.stackNames).toEqual(BASE_STACK_IDS.map((id) => `${PREFIX}-${id}`).sort());
    expect(prefixed.stackNames).toHaveLength(5);
    expect(new Set(prefixed.stackNames)).not.toEqual(new Set(unprefixed.stackNames));
  });

  it('prefixes every physical resource name', () => {
    // Every name the unprefixed synth produces must appear prefixed here — an
    // exhaustive mapping, so a resource that skipped the naming helper fails
    // this rather than going unexamined. That is the point: isolation is
    // all-or-nothing, and EventBridge rule names for instance are assembled by
    // hand in ingestion-stack.ts, not by any shared construct, so "changed the
    // helper" is not evidence that every name moved.
    for (const baseId of BASE_STACK_IDS) {
      const before = nameInventory(unprefixed.template(baseId)).physicalNames
        .filter((entry) => !isApiScopedName(entry));
      const after = nameInventory(prefixed.template(`${PREFIX}-${baseId}`)).physicalNames
        .filter((entry) => !isApiScopedName(entry));
      expect(after, baseId).toEqual(before.map((name) => insertPrefix(name)));
    }
  });

  it('leaves API-Gateway-scoped names alone, since they share no cross-deployment namespace', () => {
    // The complement of the exhaustive check above, stated rather than merely
    // filtered out. An authorizer name is unique only within its own RestApi,
    // and each deployment has its own, so prefixing these would add churn
    // without preventing any collision. Asserted so the exemption stays a
    // decision instead of quietly widening.
    const exempt = nameInventory(prefixed.template(`${PREFIX}-VocApiStack`)).physicalNames
      .filter((entry) => isApiScopedName(entry));
    expect(exempt).toEqual([
      'AWS::ApiGateway::Authorizer Name = voc-cognito-authorizer',
      'AWS::ApiGateway::Authorizer Name = voc-mcp-token-authorizer',
    ]);
  });

  it('prefixes the hand-written CloudFormation export, which is unique per account and region', () => {
    // The app's only manual exportName. It collides between two copies before
    // any resource name does, because CFN export names share one namespace.
    const coreExports = nameInventory(prefixed.template(`${PREFIX}-VocCoreStack`)).exportNames;
    expect(coreExports).toContain(`${PREFIX}-VocFrontendDomainName`);
    expect(coreExports).not.toContain('VocFrontendDomainName');
  });

  it('prefixes the automatic cross-stack exports too, by way of the stack name', () => {
    // CDK derives these from the stack name, so prefixing the stack id covers
    // all of them — assert it rather than assume it, since it is the mechanism
    // the whole stack-id change relies on.
    const autoExports = nameInventory(prefixed.template(`${PREFIX}-VocCoreStack`)).exportNames
      .filter((name) => name.includes(':ExportsOutput'));
    expect(autoExports.length).toBeGreaterThan(0);
    for (const name of autoExports) {
      expect(name.startsWith(`${PREFIX}-VocCoreStack:`)).toBe(true);
    }
  });

  it('scopes the three ingestor IAM wildcards to its own deployment', () => {
    // Unprefixed, one copy's API role can invoke the OTHER copy's ingestors and
    // toggle its schedules — which makes the isolation worthless. The trailing
    // `*` stays: it stands in for `-<account>-<region>`, and narrowing these to
    // exact names is issue #234, deliberately separate.
    const resources = nameInventory(prefixed.template(`${PREFIX}-VocApiStack`)).policyResources;
    const arn = (service: string, tail: string): string =>
      `arn:aws:${service}:${SYNTH_REGION}:${SYNTH_ACCOUNT}:${tail}`;

    expect(resources).toContain(arn('lambda', `function:${PREFIX}-voc-ingestor-*`));
    expect(resources).toContain(arn('lambda', `function:${PREFIX}-voc-ingestor-webscraper-*`));
    expect(resources).toContain(arn('lambda', `function:${PREFIX}-voc-manual-import-processor-*`));
    expect(resources).toContain(arn('events', `rule/${PREFIX}-voc-ingest-*-schedule*`));

    // And nothing still points at the unprefixed namespace, which is the other
    // deployment's.
    for (const resource of resources) {
      expect(resource).not.toMatch(/:(?:function|rule\/)voc-/);
    }
  });

  it('resolves the manually triggered ingestor name in CDK, not in the handler', () => {
    // POST /sources/{source}/run used to rebuild `voc-ingestor-{source}-{account}-{region}`
    // inside integrations_handler.py. Under a prefix that names a function which
    // does not exist: ResourceNotFoundException, surfacing to the user as "the
    // scraper runs but pulls no reviews". The pattern is per-plugin, so one
    // fixed name will not do — but resolving it is still infrastructure's job.
    const env = nameInventory(prefixed.template(`${PREFIX}-VocApiStack`)).environmentNames;
    expect(env).toContain(
      `INGESTOR_FUNCTION_NAME_PATTERN = ${PREFIX}-voc-ingestor-{source}-<AWS::AccountId>-<AWS::Region>`,
    );
    expect(env).toContain(
      `INGEST_SCHEDULE_RULE_NAME_PATTERN = ${PREFIX}-voc-ingest-{source}-schedule-<AWS::AccountId>-<AWS::Region>`,
    );

    // The pattern must name functions that this deployment actually creates.
    const ingestors = nameInventory(prefixed.template(`${PREFIX}-VocIngestionStack`)).physicalNames
      .filter((name) => name.includes('AWS::Lambda::Function FunctionName'));
    expect(ingestors.length).toBeGreaterThan(0);
    for (const ingestor of ingestors) {
      expect(ingestor).toContain(`${PREFIX}-voc-ingestor-`);
    }
  });

  it('tells each ingestor the schedule rule its circuit breaker must disable', () => {
    // The breaker disables the plugin's own schedule after repeated failures,
    // deriving the rule name from DEPLOY_ACCOUNT_ID/DEPLOY_REGION. Under a
    // prefix that name does not exist, so a failing plugin would keep hammering
    // the source — the exact thing the breaker exists to stop.
    const template = prefixed.template(`${PREFIX}-VocIngestionStack`);
    const ruleNames = nameInventory(template).physicalNames
      .filter((name) => name.startsWith('AWS::Events::Rule Name = '))
      .map((name) => name.slice('AWS::Events::Rule Name = '.length));
    expect(ruleNames.length).toBeGreaterThan(0);

    const declared = nameInventory(template).environmentNames
      .filter((entry) => entry.startsWith('INGEST_SCHEDULE_RULE_NAME = '))
      .map((entry) => entry.slice('INGEST_SCHEDULE_RULE_NAME = '.length));
    // One per scheduled plugin, and each one an actual rule in this template.
    expect(new Set(declared)).toEqual(new Set(ruleNames));
  });

  it('synthesizes with zero warnings', () => {
    // Notably this covers the cdk-nag suppressions, whose `appliesTo` regexes
    // quote the concrete ARN: a hardcoded `voc-ingestor-` there silently stops
    // matching under a prefix and leaves a fresh IAM5 finding behind (at
    // severity `aws:cdk:error`, not warning).
    //
    // The collector this reads is itself guarded — see
    // lib/test-support/synth-app.test.ts. It has to be: an empty annotation
    // list is indistinguishable from a clean synth, and that is exactly how
    // this assertion previously passed while four IAM5 errors were being
    // emitted.
    expect(prefixed.readsRealAnnotations, 'the annotation collector found nothing at all').toBe(true);
    const found = diagnostics(prefixed);
    expect(found, JSON.stringify(found, null, 2)).toEqual([]);
  });
});

describe('the name-length budget', () => {
  it('rejects a prefix that overruns the longest name the app generates', () => {
    // A prefix that silently produces a 70-character rule name is a deploy-time
    // error with a useless message, so it has to fail at synth instead.
    let failure: SynthFailure | undefined;
    try {
      synthApp({ deploymentPrefix: 'staging' });
    } catch (error) {
      if (error instanceof SynthFailure) failure = error;
      else throw error;
    }
    expect(failure, 'expected the 7-character prefix "staging" to be rejected').toBeDefined();

    const message = failure?.output ?? '';
    // Names the offending resource...
    expect(message).toContain('voc-ingest-app_reviews_android-schedule');
    // ...its actual and permitted length...
    expect(message).toContain('over the 64-character limit');
    // ...and the remaining budget, so the operator can pick a prefix that fits.
    expect(message).toContain('Use a prefix of at most 1 character');
  });

  it('accepts the longest prefix that does fit', () => {
    // The complement of the rejection above: the guard must be a real ceiling,
    // not merely conservative. One character is what the app's longest name
    // leaves, and it must synthesize.
    expect(prefixed.stackNames).toHaveLength(5);
  });
});

/**
 * Names scoped to a single RestApi, which is itself per-deployment: an
 * authorizer name only has to be unique inside its own API, so it needs no
 * prefix to keep two deployments apart.
 */
function isApiScopedName(inventoryEntry: string): boolean {
  return inventoryEntry.startsWith('AWS::ApiGateway::Authorizer Name = ');
}

/**
 * The prefixed form of one inventory entry.
 *
 * `Type Property = voc-x-<tokens>` -> `... = <PREFIX>-voc-x-<tokens>`, and for a
 * path-shaped name the prefix lands on the `voc` segment:
 * `/aws/lambda/voc-x` -> `/aws/lambda/<PREFIX>-voc-x`. That placement is not
 * cosmetic — `/aws/...` is a namespace CloudWatch understands, and the api-stack
 * log groups are `/aws/lambda/${uniqueName(base)}`, so front-prefixing would
 * give two shapes for the same kind of resource in one deployment.
 */
function insertPrefix(inventoryEntry: string): string {
  const marker = ' = ';
  const at = inventoryEntry.indexOf(marker);
  const head = inventoryEntry.slice(0, at + marker.length);
  const name = inventoryEntry.slice(at + marker.length);
  const segments = name.split('/');
  const target = segments.findIndex((segment) => segment.startsWith('voc'));
  if (target === -1) return `${head}${PREFIX}-${name}`;
  segments[target] = `${PREFIX}-${segments[target]}`;
  return `${head}${segments.join('/')}`;
}

/**
 * Every cdk-nag suppression the app declares still suppresses something.
 *
 * A suppression outlives the resource or the finding it was written for: the resource is removed, a grant is
 * narrowed, an `appliesTo` names an ARN pattern the stack no longer renders. It then silences nothing today
 * and, worse, silences the NEXT finding of that rule on that resource without anyone reviewing it. Nothing
 * else notices: cdk-nag reports findings, never suppressions that matched none.
 *
 * How. The real app (`bin/voc-datalake.ts`) is synthesized IN PROCESS with `AwsSolutionsChecks` given one
 * extra logger (`additionalLoggers`, cdk-nag's `INagLogger`). Every `onSuppressed` / `onSuppressedError` call
 * names the resource, the rule and the finding; the suppression that consumed it is found the way cdk-nag
 * picks it (`NagPack.ignoreRule`: the FIRST entry, resource-level before stack-level, whose `id` is the rule
 * and whose `appliesTo` — when it has one — matches the finding). An entry, or one `appliesTo` item of it,
 * that consumed nothing in EITHER synth shape is unused:
 *
 *   - the default deploy, and
 *   - every context-gated feature on (inbound email, participant email + the board pool, the fixture
 *     provider, a model pin, Bedrock model access, data protection), so a feature-gated suppression counts.
 *
 * An entry is identified by its rule, reason and `appliesTo` item, not by where it was applied: a shared list
 * (`dynamoDbGsiSuppressions` on three stacks, `lambdaBasicExecutionRoleSuppressions` on every stack) is judged
 * across all of them, so it is used when any one stack needs it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type CfnResource, Stack } from 'aws-cdk-lib';
import type { INagLogger, NagLoggerSuppressedData, NagLoggerSuppressedErrorData, NagPackProps } from 'cdk-nag';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ALL_FEATURES_CONTEXT } from './test-support/all-features-context';
import { isRecord } from './test-support/guards';
import { SYNTH_ACCOUNT, SYNTH_REGION, SYNTH_TIMEOUT_MS } from './test-support/synth-app';
import { byCodeUnit } from './utils/compare';

const VALIDATION_FAILURE_ID = 'CdkNagValidationFailure';
const PROJECT_ROOT = join(__dirname, '..');

/** What one suppressed finding needs to find the entry that consumed it. */
interface Consumed {
  readonly resource: CfnResource;
  readonly ruleId: string;
  readonly findingId: string;
  readonly validationFailure: boolean;
}

const recorder = vi.hoisted(() => ({ consumed: new Array<Consumed>(), resources: new Set<CfnResource>() }));

vi.mock('cdk-nag', async (importOriginal) => {
  const original = await importOriginal<typeof import('cdk-nag')>();
  const seen = (data: { resource: CfnResource }) => { recorder.resources.add(data.resource); };
  const logger: INagLogger = {
    onCompliance: seen,
    onNonCompliance: seen,
    onNotApplicable: seen,
    onError: seen,
    onSuppressed: (data: NagLoggerSuppressedData) => {
      seen(data);
      recorder.consumed.push({ resource: data.resource, ruleId: data.ruleId, findingId: data.findingId, validationFailure: false });
    },
    onSuppressedError: (data: NagLoggerSuppressedErrorData) => {
      seen(data);
      recorder.consumed.push({ resource: data.resource, ruleId: data.ruleId, findingId: '', validationFailure: true });
    },
  };
  class RecordingChecks extends original.AwsSolutionsChecks {
    constructor(props?: NagPackProps) {
      super({ ...props, additionalLoggers: [...(props?.additionalLoggers ?? []), logger] });
    }
  }
  return { ...original, AwsSolutionsChecks: RecordingChecks };
});

// ── suppressions as cdk-nag reads them ────────────────────────────────

const AppliesToSchema = z.union([z.string(), z.object({ regex: z.string() })]);
const SuppressionSchema = z.object({
  id: z.string(),
  reason: z.string(),
  applies_to: z.array(AppliesToSchema).optional(),
  is_reason_encoded: z.boolean().optional(),
});
type Suppression = z.infer<typeof SuppressionSchema>;
type AppliesTo = z.infer<typeof AppliesToSchema>;

const MetadataSchema = z.object({ rules_to_suppress: z.array(SuppressionSchema).optional() }).optional();

/** Resource-level then stack-level entries, in the order cdk-nag tries them (`NagSuppressionHelper.getSuppressions`). */
function suppressionsOf(resource: CfnResource): Suppression[] {
  const own = MetadataSchema.parse(resource.getMetadata('cdk_nag'))?.rules_to_suppress ?? [];
  const metadata: unknown = Stack.of(resource).templateOptions.metadata;
  const stack = MetadataSchema.parse(isRecord(metadata) ? metadata.cdk_nag : undefined)?.rules_to_suppress ?? [];
  return [...own, ...stack];
}

const reasonOf = (s: Suppression) => (s.is_reason_encoded ? Buffer.from(s.reason, 'base64').toString() : s.reason);

function itemMatches(item: AppliesTo, findingId: string): boolean {
  if (typeof item === 'string') return item === findingId;
  // cdk-nag's `toRegEx`: `/<source>/<flags>`, split at the LAST slash.
  const first = item.regex.indexOf('/');
  const last = item.regex.lastIndexOf('/');
  return first >= 0 && last > first && new RegExp(item.regex.slice(first + 1, last), item.regex.slice(last + 1)).test(findingId);
}

/** The `appliesTo` items of `s` that make it apply (all of `s` when it has none), or null (`doesApply`). */
function applyingItems(s: Suppression, ruleId: string, findingId: string): AppliesTo[] | null {
  if (s.id !== ruleId) return null;
  if (!s.applies_to) return [];
  const hits = findingId ? s.applies_to.filter((item) => itemMatches(item, findingId)) : [];
  return hits.length ? hits : null;
}

const itemText = (item: AppliesTo) => (typeof item === 'string' ? item : `regex ${item.regex}`);
/** One judged unit: an entry without `appliesTo`, or one `appliesTo` item of an entry. */
const unitKey = (s: Suppression, item?: AppliesTo) =>
  [s.id, reasonOf(s).slice(0, 70), ...(item === undefined ? [] : [itemText(item)])].join(' :: ');

function unitsOf(s: Suppression): string[] {
  return s.applies_to ? s.applies_to.map((item) => unitKey(s, item)) : [unitKey(s)];
}

/** The units the FIRST applying entry consumes (`NagPack.ignoreRule`). */
function consumedUnits(c: Consumed): string[] {
  for (const s of suppressionsOf(c.resource)) {
    const items = applyingItems(s, c.ruleId, c.findingId)
      ?? (c.validationFailure ? applyingItems(s, VALIDATION_FAILURE_ID, c.ruleId) : null);
    if (items !== null) return items.length ? items.map((item) => unitKey(s, item)) : [unitKey(s)];
  }
  return [];
}

// ── the two synth shapes ──────────────────────────────────────────────

/** cdk.json's context + cdk.context.json, no Docker bundling, no frontend-freshness check (synth-app.ts). */
function committedContext(): Record<string, unknown> {
  const read = (file: string): Record<string, unknown> => {
    const parsed: unknown = JSON.parse(readFileSync(join(PROJECT_ROOT, file), 'utf8'));
    return isRecord(parsed) ? parsed : {};
  };
  const cdkJson = read('cdk.json');
  return {
    ...(isRecord(cdkJson.context) ? cdkJson.context : {}), ...read('cdk.context.json'),
    'aws:cdk:bundling-stacks': [], skipFrontendBuildCheck: true,
  };
}

const outdirs: string[] = [];
afterAll(() => { for (const dir of outdirs) rmSync(dir, { recursive: true, force: true }); });

/** [declared units, consumed units] of what the recording logger saw since the last reset. */
function judged(): [Set<string>, Set<string>] {
  const declared = new Set<string>();
  for (const resource of recorder.resources) {
    for (const s of suppressionsOf(resource)) unitsOf(s).forEach((u) => declared.add(u));
  }
  return [declared, new Set(recorder.consumed.flatMap(consumedUnits))];
}

function resetRecorder(): void {
  recorder.consumed.length = 0;
  recorder.resources.clear();
}

/** Run bin/voc-datalake.ts in process with `context`. */
async function synthShape(context: Record<string, unknown>): Promise<[Set<string>, Set<string>]> {
  resetRecorder();
  const outdir = mkdtempSync(join(tmpdir(), 'voc-nag-'));
  outdirs.push(outdir);
  vi.stubEnv('CDK_OUTDIR', outdir);
  vi.stubEnv('CDK_DEFAULT_ACCOUNT', SYNTH_ACCOUNT);
  vi.stubEnv('CDK_DEFAULT_REGION', SYNTH_REGION);
  vi.stubEnv('CDK_CONTEXT_JSON', JSON.stringify({ ...committedContext(), ...context }));
  vi.resetModules();
  await import('../bin/voc-datalake');
  vi.unstubAllEnvs();
  return judged();
}

describe('cdk-nag suppressions', () => {
  it('reports a planted suppression that matches nothing, and not one that does (or its shadowed twin)', async () => {
    resetRecorder();
    const { App, Aspects, Stack: StackOf } = await import('aws-cdk-lib');
    const sqs = await import('aws-cdk-lib/aws-sqs');
    const nag = await import('cdk-nag');
    const app = new App({ outdir: mkdtempSync(join(tmpdir(), 'voc-nag-fx-')) });
    outdirs.push(app.outdir);
    const stack = new StackOf(app, 'Fx');
    const queue = new sqs.Queue(stack, 'Queue', { enforceSSL: true });
    nag.NagSuppressions.addResourceSuppressions(queue, [
      { id: 'AwsSolutions-SQS3', reason: 'A planted queue with no DLQ, on purpose' },
      { id: 'AwsSolutions-SQS3', reason: 'A planted second entry the first one shadows' },
      { id: 'AwsSolutions-S1', reason: 'A planted rule the queue is never checked for' },
    ]);
    Aspects.of(app).add(new nag.AwsSolutionsChecks());
    app.synth();
    const [declared, used] = judged();
    expect([...declared].filter((unit) => !used.has(unit)).sort(byCodeUnit)).toStrictEqual([
      'AwsSolutions-S1 :: A planted rule the queue is never checked for',
      'AwsSolutions-SQS3 :: A planted second entry the first one shadows',
    ]);
  });

  it('every suppression (and every appliesTo item) suppresses a finding in the default or the all-features synth', async () => {
    const [declaredDefault, usedDefault] = await synthShape({});
    const [declaredAll, usedAll] = await synthShape(ALL_FEATURES_CONTEXT);
    const declared = new Set([...declaredDefault, ...declaredAll]);
    const used = new Set([...usedDefault, ...usedAll]);
    // Vacuity: the logger saw the app's suppressions and the findings they consume.
    expect(declared.size).toBeGreaterThan(50);
    expect(used.size).toBeGreaterThan(50);
    expect([...declared].filter((unit) => !used.has(unit)).sort(byCodeUnit)).toStrictEqual([]);
  }, SYNTH_TIMEOUT_MS * 2);
});

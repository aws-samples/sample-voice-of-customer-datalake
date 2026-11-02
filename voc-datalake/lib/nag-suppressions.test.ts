/**
 * Every cdk-nag finding is acknowledged, and every acknowledgement the app declares still covers a finding.
 *
 * An acknowledgement outlives the resource or the finding it was written for: the resource is removed, a
 * grant is narrowed, a rendered ARN stops matching. It then covers nothing today and, worse, covers the NEXT
 * identical finding on that construct without anyone reviewing it. Nothing else notices: cdk-nag 3 reports
 * findings, never acknowledgements that matched none.
 *
 * How. The real app (`bin/voc-datalake.ts`) is synthesized IN PROCESS with `AwsSolutionsChecks` replaced by a
 * subclass that records every finding cdk-nag computes (its `applyRule`, before the acknowledgement check):
 * the resource and the id (`AwsSolutions-IAM5[<finding>]`, or the bare rule). The acknowledgement covering
 * a finding is found the way cdk-nag looks (lib/utils/nag-ack.ts `acknowledgementCovering`: the resource,
 * then its ancestors), nearest first. A declared acknowledgement that covered nothing in EITHER synth shape
 * is unused:
 *
 *   - the default deploy, and
 *   - every context-gated feature on (inbound email, participant email + the board pool, the fixture
 *     provider, a model pin, Bedrock model access, data protection), so a feature-gated one counts.
 *
 * An acknowledgement is identified by its id and reason, not by the construct it sits on: a shared list
 * (`lambdaBasicExecutionRoleSuppressions` on every provider and stack) is judged across all of them, so it
 * is used when any one placement needs it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CfnResource } from 'aws-cdk-lib';
import type { IApplyRule } from 'cdk-nag';
import type { IConstruct } from 'constructs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ALL_FEATURES_CONTEXT } from './test-support/all-features-context';
import { isRecord } from './test-support/guards';
import { SYNTH_ACCOUNT, SYNTH_REGION, SYNTH_TIMEOUT_MS } from './test-support/synth-app';
import { byCodeUnit } from './utils/compare';
import { acknowledgementCovering, acknowledgementsOn, MIN_REASON_LENGTH } from './utils/nag-ack';

const PROJECT_ROOT = join(__dirname, '..');
const PACK = 'AwsSolutions-';

/** One finding cdk-nag computed: the resource and the id an acknowledgement must name. */
interface Finding {
  readonly resource: CfnResource;
  readonly id: string;
}

const recorder = vi.hoisted(() => ({ findings: new Array<Finding>(), roots: new Array<IConstruct>() }));

vi.mock('cdk-nag', async (importOriginal) => {
  const original = await importOriginal<typeof import('cdk-nag')>();
  /** The ids cdk-nag 3.0.2 derives from a rule result (`NagPack.applyRule`). */
  const idsOf = (ruleId: string, params: IApplyRule): string[] => {
    try {
      const result = params.rule(params.node);
      if (result === original.NagRuleCompliance.NON_COMPLIANT) return [ruleId];
      return Array.isArray(result) ? result.map((finding) => `${ruleId}[${finding}]`) : [];
    } catch {
      return [ruleId]; // a rule that throws is reported (and acknowledged) by its bare id
    }
  };
  class RecordingChecks extends original.AwsSolutionsChecks {
    override validateScope(scope: IConstruct) {
      recorder.roots.push(scope);
      return super.validateScope(scope);
    }
    protected override applyRule(params: IApplyRule): void {
      const ruleId = `${this.readPackName}-${params.ruleSuffixOverride ?? params.rule.name}`;
      for (const id of idsOf(ruleId, params)) recorder.findings.push({ resource: params.node, id });
      super.applyRule(params);
    }
  }
  return { ...original, AwsSolutionsChecks: RecordingChecks };
});

// ── judging ───────────────────────────────────────────────────────────

const unitKey = (id: string, reason: string) => `${id} :: ${reason.slice(0, 70)}`;

interface Judged {
  /** Every acknowledgement of a pack rule the app declares. */
  readonly declared: Set<string>;
  /** The acknowledgements that covered a finding. */
  readonly used: Set<string>;
  /** Findings no acknowledgement covers (`<path> <id>`). */
  readonly unacknowledged: string[];
  /** Declared acknowledgements whose reason is too short (`<path> <id>`). */
  readonly reasonless: string[];
}

/** The pack-rule acknowledgements recorded on `construct`, as units, plus those whose reason is too short. */
function declaredOn(construct: IConstruct): { units: string[]; reasonless: string[] } {
  const acks = acknowledgementsOn(construct).filter(({ id }) => id.startsWith(PACK));
  return {
    units: acks.map((ack) => unitKey(ack.id, ack.reason)),
    reasonless: acks.filter((ack) => ack.reason.trim().length < MIN_REASON_LENGTH).map((ack) => `${construct.node.path} ${ack.id}`),
  };
}

function judged(): Judged {
  const declared = new Set<string>();
  const reasonless: string[] = [];
  for (const construct of recorder.roots.flatMap((root) => root.node.findAll())) {
    const found = declaredOn(construct);
    found.units.forEach((unit) => declared.add(unit));
    reasonless.push(...found.reasonless);
  }
  const used = new Set<string>();
  const unacknowledged: string[] = [];
  for (const { resource, id } of recorder.findings) {
    const covering = acknowledgementCovering(resource, id);
    if (covering) used.add(unitKey(id, covering.reason));
    else unacknowledged.push(`${resource.node.path} ${id}`);
  }
  return { declared, used, unacknowledged, reasonless };
}

function resetRecorder(): void {
  recorder.findings.length = 0;
  recorder.roots.length = 0;
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

/** Run bin/voc-datalake.ts in process with `context`. */
async function synthShape(context: Record<string, unknown>): Promise<Judged> {
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

const unusedOf = ({ declared, used }: Pick<Judged, 'declared' | 'used'>) =>
  [...declared].filter((unit) => !used.has(unit)).sort(byCodeUnit);

describe('cdk-nag acknowledgements', () => {
  it('reports a planted acknowledgement that covers nothing, and a shadowed one, but not one that covers', async () => {
    resetRecorder();
    const { App, Stack, Validations } = await import('aws-cdk-lib');
    const sqs = await import('aws-cdk-lib/aws-sqs');
    const nag = await import('cdk-nag');
    const { acknowledgeNag, acknowledgeNagOnResource } = await import('./utils/nag-ack');
    const app = new App({ outdir: mkdtempSync(join(tmpdir(), 'voc-nag-fx-')) });
    outdirs.push(app.outdir);
    const stack = new Stack(app, 'Fx');
    const queue = new sqs.Queue(stack, 'Queue', { enforceSSL: true });
    acknowledgeNagOnResource(queue, [
      { id: 'AwsSolutions-SQS3', reason: 'A planted queue with no DLQ, on purpose' },
      { id: 'AwsSolutions-S1', reason: 'A planted rule the queue is never checked for' },
    ]);
    acknowledgeNag(stack, [{ id: 'AwsSolutions-SQS3', reason: 'A planted stack-wide twin the queue one shadows' }]);
    Validations.of(app).addPlugins(new nag.AwsSolutionsChecks(app));
    app.synth();
    const result = judged();
    expect(result.unacknowledged).toStrictEqual([]);
    expect(unusedOf(result)).toStrictEqual([
      'AwsSolutions-S1 :: A planted rule the queue is never checked for',
      'AwsSolutions-SQS3 :: A planted stack-wide twin the queue one shadows',
    ]);
  });

  it('reports a finding nothing acknowledges', async () => {
    resetRecorder();
    const { App, Stack, Validations } = await import('aws-cdk-lib');
    const sqs = await import('aws-cdk-lib/aws-sqs');
    const nag = await import('cdk-nag');
    const app = new App({ outdir: mkdtempSync(join(tmpdir(), 'voc-nag-fx-')) });
    outdirs.push(app.outdir);
    new sqs.Queue(new Stack(app, 'Fx'), 'Queue', { enforceSSL: true });
    Validations.of(app).addPlugins(new nag.AwsSolutionsChecks(app));
    expect(() => app.synth()).toThrow(/AwsSolutions-SQS3/);
    expect(judged().unacknowledged).toStrictEqual(['Fx/Queue/Resource AwsSolutions-SQS3']);
  });

  describe('over the default and the all-features synth', () => {
    let shapes: Judged[] = [];
    beforeAll(async () => {
      shapes = [await synthShape({}), await synthShape(ALL_FEATURES_CONTEXT)];
    }, SYNTH_TIMEOUT_MS * 2);

    it('acknowledges every finding, each with a reason', () => {
      expect(shapes.flatMap((shape) => shape.unacknowledged)).toStrictEqual([]);
      expect(shapes.flatMap((shape) => shape.reasonless)).toStrictEqual([]);
    });

    it('declares no acknowledgement that covers nothing in either shape', () => {
      const declared = new Set(shapes.flatMap((shape) => [...shape.declared]));
      const used = new Set(shapes.flatMap((shape) => [...shape.used]));
      // Vacuity: the recorder saw the app's acknowledgements and the findings they cover.
      expect(Math.min(declared.size, used.size)).toBeGreaterThan(100);
      expect(unusedOf({ declared, used })).toStrictEqual([]);
    });
  });
});

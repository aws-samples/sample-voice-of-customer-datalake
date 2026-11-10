/**
 * The cross-track behaviour fixture: what `voc-plan-step` (THIS code, over
 * stubbed delegates and Bedrock) answers for each write/think step of the Example Air
 * plan, recorded so the Python conductor suite can drive the whole plan
 * (`lambda/api/test/test_plan_cross_track.py`) with the real answers.
 *
 * Committed as `lambda/shared/test/fixtures/plan-step-example.json`; regenerate
 * after changing the plan-step runner, the write requests or the plan:
 *
 *   cd voc-datalake/lambda/stream && npx jiti scripts/write-plan-step-fixtures.mjs > ../shared/test/fixtures/plan-step-example.json
 *
 * `example-run-fixtures.test.ts` fails when the committed file is stale.
 *
 * The plan is `valid-example` with ONE deliberate deviation: s5's project name
 * carries a trailing space, which create_project's schema trims, so the final
 * write differs from the approved literal → `needs_approval`; the recorded
 * second run is that step with the approver's `approved_pending`.
 *
 * Each recorded run holds the event the runner was given (plan id
 * `PLAN_ID_PLACEHOLDER`; `resolved` / `think_outputs` only the entries the step
 * reads), every delegate request it made, and its answer.
 */
import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { buildCatalogue } from '../assistant/tools/catalogue.js';
import { AssistantToolError } from '../assistant/tools/errors.js';
import type { ApiCall } from '../assistant/tools/internal-api.js';
import { fakeDeps } from '../assistant/tools/test-fixtures.js';
import type { PlanStepDeps } from './deps.js';
import type { PendingWrite, PlanStepAnswer } from './event.js';
import { runPlanStep } from './run-step.js';

/** A scripted run that cannot be recorded (a fixture bug, never a runner answer). */
class FixtureError extends Error {
  override name = 'FixtureError';
}

const PLAN_ID_PLACEHOLDER = 'pl_000000000000';
const APPROVER = { sub: 'admin-sub', username: 'alice' };
const PROJECT = 'proj_example1';
const SUMMARY = 'Late refunds (41 reviews) and check-in crashes (17).';

function claims(admin: boolean): Record<string, string> {
  return {
    sub: APPROVER.sub, 'cognito:username': APPROVER.username, 'cognito:groups': admin ? 'admins,users' : 'users',
    'voc:acting_subject': APPROVER.sub, 'voc:principal': `plan:${PLAN_ID_PLACEHOLDER}`,
  };
}

const text = (answer: string, stopReason: ConverseCommandOutput['stopReason'] = 'end_turn'): ConverseCommandOutput => ({
  output: { message: { role: 'assistant', content: [{ text: answer }] } }, stopReason, $metadata: {}, metrics: undefined, usage: undefined,
});

type Step = Record<string, unknown> & { id: string; kind: string };

/** The connector's source_platform (`<app_name>_iOS`, plugins/app_reviews_ios): the jobs read only these reviews. */
const EXAMPLE_SOURCE = 'ExampleAir iOS_iOS';
const PERSONA_SCOPE = 'Example Air customers, from the ExampleAir iOS app reviews only';
const FEATURE_IDEA = 'Ancillaries for Example Air travellers (hotels, cars, eSIM), from the ExampleAir iOS app reviews only';

/** The Example Air plan of `valid-example.json`, with s5's deliberate deviation. */
export function examplePlan(): { schema: string; goal: string; steps: Step[] } {
  const p = `{{s5.project_id}}`;
  return {
    schema: 'voc-plan/1',
    goal: 'Example Air: import iOS reviews, find problems, ancillaries project with personas, PR/FAQ, prototype',
    steps: [
      { id: 's1', pack: 'scrapers', kind: 'write', title: 'Connect the ExampleAir iOS app', write: { tool: 'create_app_connector', args: { source: 'app_reviews_ios', app_id: '1234567890', app_name: 'ExampleAir iOS' } }, produces: ['app_config_id'] },
      { id: 's2', pack: 'scrapers', kind: 'write', after: ['s1'], title: 'Import the iOS reviews', write: { tool: 'run_source', args: { source: 'app_reviews_ios' } }, produces: ['execution_id'] },
      { id: 's3', pack: 'scrapers', kind: 'wait', after: ['s2'], title: 'Wait for the import', wait: { for: 'source_run', source: 'app_reviews_ios', execution_id: '{{s2.execution_id}}', timeout_minutes: 60 } },
      { id: 's4', pack: 'insights', kind: 'think', after: ['s3'], title: 'What Example Air does wrong', think: { brief: 'Summarise the main problems in the Example Air reviews, with counts and quotes.' }, produces: ['summary'] },
      { id: 's5', pack: 'core', kind: 'write', title: 'Create the ancillaries project', write: { tool: 'create_project', args: { name: 'Example Air - Ancillaries ', description: '{{free}}' } }, produces: ['project_id'] },
      { id: 's6', pack: 'project', kind: 'write', after: ['s4', 's5'], title: 'Generate personas', write: { tool: 'generate_personas', args: { project_id: p, persona_count: 4, custom_instructions: PERSONA_SCOPE, sources: [EXAMPLE_SOURCE] } }, produces: ['job_id'] },
      { id: 's7', pack: 'project', kind: 'wait', after: ['s6'], title: 'Wait for the personas', wait: { for: 'project_job', project_id: p, job_id: '{{s6.job_id}}' } },
      { id: 's8', pack: 'project', kind: 'write', after: ['s7'], title: 'Write the PR/FAQ', write: { tool: 'generate_document', args: { project_id: p, doc_type: 'prfaq', title: 'Ancillaries PR/FAQ', feature_idea: FEATURE_IDEA, sources: [EXAMPLE_SOURCE] } }, produces: ['job_id'] },
      { id: 's9', pack: 'project', kind: 'wait', after: ['s8'], title: 'Wait for the PR/FAQ', wait: { for: 'project_job', project_id: p, job_id: '{{s8.job_id}}' } },
      { id: 's10', pack: 'project', kind: 'write', after: ['s9'], title: 'Build the prototype', write: { tool: 'build_prototype', args: { project_id: p, title: '{{free}}' } }, produces: ['job_id'] },
      { id: 's11', pack: 'project', kind: 'wait', after: ['s10'], title: 'Wait for the prototype', wait: { for: 'project_job', project_id: p, job_id: '{{s10.job_id}}', timeout_minutes: 120 } },
    ],
  };
}

interface RunSpec {
  step: string;
  admin: boolean;
  resolved?: Record<string, string>;
  thinkOutputs?: Record<string, string>;
  /** The approved pending write of the previous run of this step (its `needs_approval` answer). */
  approvedFrom?: number;
  /** Delegate answers by `METHOD path`. */
  routes?: Record<string, unknown>;
  /** Bedrock answers, in order. */
  answers?: ConverseCommandOutput[];
}

const RUNS: readonly RunSpec[] = [
  {
    step: 's1', admin: true,
    routes: { 'GET /integrations/app_reviews_ios/apps': { apps: [] }, 'POST /integrations/app_reviews_ios/apps': { success: true, app: { id: 'app_7' } } },
  },
  { step: 's2', admin: true, resolved: { 's1.app_config_id': 'app_7' }, routes: { 'POST /sources/app_reviews_ios/run': { success: true, execution_id: 'ex_ios_1' } } },
  { step: 's4', admin: false, answers: [text(SUMMARY)] },
  { step: 's5', admin: false, answers: [text('{"description": "Hotels, cars and eSIM for Example Air travellers."}')] },
  { step: 's5', admin: false, approvedFrom: 3, routes: { 'POST /projects': { success: true, project: { project_id: PROJECT } } } },
  { step: 's6', admin: false, resolved: { 's5.project_id': PROJECT }, routes: { [`POST /projects/${PROJECT}/personas/generate`]: { success: true, job_id: 'job_personas' } } },
  {
    step: 's8', admin: false, resolved: { 's5.project_id': PROJECT }, thinkOutputs: { 's4.summary': SUMMARY },
    routes: { [`POST /projects/${PROJECT}/document`]: { success: true, job_id: 'job_prfaq' } },
  },
  {
    step: 's10', admin: false, resolved: { 's5.project_id': PROJECT }, thinkOutputs: { 's4.summary': SUMMARY },
    answers: [text('{"title": "Example Air ancillaries checkout"}')],
    routes: { [`POST /projects/${PROJECT}/build-prototype`]: { success: true, job_id: 'job_proto' } },
  },
];

export interface RecordedRun {
  event: Record<string, unknown> & { step: Step };
  requests: ApiCall[];
  answer: PlanStepAnswer;
}

function stubDeps(spec: RunSpec, requests: ApiCall[]): PlanStepDeps {
  const queue = [...(spec.answers ?? [])];
  return {
    invoke: (call) => {
      requests.push(call);
      const answer = spec.routes?.[`${call.method} ${call.path}`];
      return answer === undefined ? Promise.reject(new AssistantToolError('not_found', 'Not found.')) : Promise.resolve(answer);
    },
    catalogue: buildCatalogue(fakeDeps()),
    converse: () => {
      const next = queue.shift();
      return next === undefined ? Promise.reject(new FixtureError('no model answer scripted')) : Promise.resolve(next);
    },
    resolveModel: () => Promise.resolve('global.anthropic.claude-sonnet-5-5'),
    lookupStoreApp: () => Promise.resolve({ status: 'found', app: { name: '', developer: '' } }),
  };
}

function approvedPending(runs: readonly RecordedRun[], index: number | undefined): Pick<PendingWrite, 'tool' | 'args' | 'fingerprint'> | undefined {
  if (index === undefined) return undefined;
  const answer = runs[index]?.answer;
  if (answer?.status !== 'needs_approval') throw new FixtureError(`run ${String(index)} did not pause`);
  const { tool, args, fingerprint } = answer.pending;
  return { tool, args, fingerprint };
}

async function record(spec: RunSpec, step: Step, runs: readonly RecordedRun[]): Promise<RecordedRun> {
  const approved = approvedPending(runs, spec.approvedFrom);
  const event = {
    plan_id: PLAN_ID_PLACEHOLDER, step, resolved: spec.resolved ?? {}, think_outputs: spec.thinkOutputs ?? {}, claims: claims(spec.admin),
    ...(approved === undefined ? {} : { approved_pending: approved }),
  };
  const requests: ApiCall[] = [];
  const answer = await runPlanStep(event, stubDeps(spec, requests));
  return { event, requests, answer };
}

/** Every recorded run, in order. */
export async function exampleRunFixture(): Promise<{ $comment: string; plan: ReturnType<typeof examplePlan>; runs: RecordedRun[] }> {
  const plan = examplePlan();
  const runs = await RUNS.reduce<Promise<RecordedRun[]>>(async (previous, spec) => {
    const done = await previous;
    const step = plan.steps.find((candidate) => candidate.id === spec.step);
    if (step === undefined) throw new FixtureError(`unknown step ${spec.step}`);
    return [...done, await record(spec, step, done)];
  }, Promise.resolve([]));
  return {
    $comment: 'GENERATED by lambda/stream/scripts/write-plan-step-fixtures.mjs from src/plan-step/example-run-fixtures.ts; do not edit.',
    plan,
    runs,
  };
}

/** The committed file's text. */
export async function exampleRunFixtureJson(): Promise<string> {
  return `${JSON.stringify(await exampleRunFixture(), null, 2)}\n`;
}

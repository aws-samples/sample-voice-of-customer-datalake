import { describe, expect, it } from 'vitest';
import { canonicalWriteFingerprint } from '../assistant/plan/fingerprint.js';
import { exampleRunFixture, exampleRunFixtureJson } from './example-run-fixtures.js';

/** The committed text of the fixture the Python conductor suite reads. */
const committed = Object.values(
  import.meta.glob<string>('../../../shared/test/fixtures/plan-step-example.json', { eager: true, query: '?raw', import: 'default' }),
)[0];

describe('lambda/shared/test/fixtures/plan-step-example.json', () => {
  it('is what the plan-step runner answers today (regenerate: scripts/write-plan-step-fixtures.mjs)', async () => {
    expect(committed).toBe(await exampleRunFixtureJson());
  });

  it('records the deliberate deviation: s5 pauses with the trimmed name, then runs exactly the approved write', async () => {
    const { runs } = await exampleRunFixture();
    const s5 = runs.filter((run) => run.event.step.id === 's5');
    expect(s5.map((run) => run.answer.status)).toStrictEqual(['needs_approval', 'done']);
    expect(s5[0]?.answer).toMatchObject({ pending: { tool: 'create_project', args: { name: 'Example Air - Ancillaries' } } });
    expect(s5[1]?.requests.at(-1)?.body).toStrictEqual({ name: 'Example Air - Ancillaries', description: 'Hotels, cars and eSIM for Example Air travellers.' });
  });

  it('runs create_app_connector with exactly the planned arguments and fingerprints every executed write', async () => {
    const { runs } = await exampleRunFixture();
    const writes = runs.filter((run) => run.answer.status === 'done' && run.event.step.kind === 'write');
    expect(runs[0]?.requests.at(-1)).toMatchObject({ method: 'POST', path: '/integrations/app_reviews_ios/apps', body: { app: { app_name: 'ExampleAir iOS', app_id: '1234567890' } } });
    expect(runs[0]?.answer).toMatchObject({ status: 'done', outputs: { app_config_id: 'app_7' }, model_calls: 0, fingerprint: canonicalWriteFingerprint('create_app_connector', { source: 'app_reviews_ios', app_id: '1234567890', app_name: 'ExampleAir iOS' }) });
    expect(writes.every((run) => run.answer.status === 'done' && typeof run.answer.fingerprint === 'string')).toBe(true);
  });
});

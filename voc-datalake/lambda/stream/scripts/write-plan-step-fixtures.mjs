/**
 * Prints lambda/shared/test/fixtures/plan-step-example.json: what voc-plan-step answers for each step of the
 * Example Air plan (src/plan-step/example-run-fixtures.ts), read by lambda/api/test/test_plan_cross_track.py.
 * Run from voc-datalake/lambda/stream:
 *   npx jiti scripts/write-plan-step-fixtures.mjs > ../shared/test/fixtures/plan-step-example.json
 * (src/plan-step/example-run-fixtures.test.ts pins the result.)
 */
import process from 'node:process';
import { exampleRunFixtureJson } from '../src/plan-step/example-run-fixtures.ts';

process.stdout.write(await exampleRunFixtureJson());

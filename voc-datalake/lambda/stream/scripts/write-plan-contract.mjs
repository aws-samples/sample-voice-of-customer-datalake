/**
 * Prints lambda/shared/plan_contract.json from the TypeScript plan contract.
 * Run from voc-datalake/lambda/stream:
 *   npx jiti scripts/write-plan-contract.mjs > ../shared/plan_contract.json
 * (jiti loads the TypeScript sources directly; src/assistant/plan/contract-json.test.ts pins the result.)
 */
import process from 'node:process';
import { planContractJson } from '../src/assistant/plan/contract-json.ts';

process.stdout.write(planContractJson());

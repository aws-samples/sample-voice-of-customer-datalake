/**
 * Test support: the real app entry (bin/voc-datalake.ts) with the refused hard delete built, for the suites and audits
 * that pin its job and grants (lib/test-support/synth-app.ts `synthApp(…, { buildWorkspaceHardDelete: true })`,
 * scripts/audit/py_assembly.py). Never a deployment's entry: bin/ never builds the job (lib/utils/workspace-hard-delete.ts).
 */
import { HARD_DELETE_TEST_SWITCH } from '../utils/workspace-hard-delete';

HARD_DELETE_TEST_SWITCH.built = true;
// After the switch: the app's own module graph, run as `cdk synth` runs it.
void import('../../bin/voc-datalake');

/**
 * Read-only ops checks against a deployment's AWS account (no browser login, no
 * writes, no cleanup): tests/ops-capacity.spec.ts and tests/ops-postdeploy.spec.ts.
 * They use the operator's ambient AWS credentials through lib/aws.ts.
 *
 *   E2E_OPS=1 [E2E_OPS_HOURS=24 | E2E_OPS_SINCE=<ISO>] [E2E_AWS_REGION=us-west-2] \
 *     npx playwright test -c playwright.ops.config.ts
 */
import { defineConfig } from '@playwright/test'
const { sharedConfig } = await import('./lib/runConfig')

export default defineConfig({
  ...sharedConfig({ timeout: 15 * 60_000, use: {} }),
  testMatch: /ops-(capacity|postdeploy)\.spec\.ts/,
})

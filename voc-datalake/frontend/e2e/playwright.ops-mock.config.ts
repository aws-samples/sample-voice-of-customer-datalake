/**
 * Mock-only config for the ops visual check (tests/ops-visual-check.spec.ts): no
 * production auth setup, nothing touches a deployment. Start the dev mock first
 * (`npm run dev -- --port 5291` from the repo root), then:
 *   E2E_MOCK=1 E2E_TRACK=ops npx playwright test -c playwright.ops-mock.config.ts
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: /ops-visual-check\.spec\.ts/,
  timeout: 120_000,
  reporter: 'line',
  use: { viewport: { width: 1440, height: 1000 } },
})

/**
 * Production e2e suite. Run from voc-datalake/frontend: `npm run e2e:prod`
 * (see e2e/README.md for the env vars). Serial on purpose: it drives a shared
 * production deployment and must not hammer it. With `E2E_MOCK=1` the same
 * config drives the local dev mock instead (`MOCK_SPECS` in lib/env.ts).
 */
import { defineConfig } from '@playwright/test'
// One run id for the whole run: workers inherit the env, so names stay stable
// across the worker restarts Playwright performs after a failure.
// With E2E_TRACK set (parallel QA tracks against one deployment) the id is
// `<track>-<epoch ms>`; cleanup deletes only this run's ledger entries anyway.
const { MOCK, MOCK_SPECS, storageStatePath, defaultRunId } = await import('./lib/env')
process.env['E2E_RUN_ID'] ??= defaultRunId()
const { sharedConfig } = await import('./lib/runConfig')

// E2E_MOCK=1 (lib/env.ts): only the specs that model the dev mock, as the admin,
// with no login, no saved session and no setup / cleanup.
const mockProjects = [
  { name: 'admin', testMatch: MOCK_SPECS, metadata: { role: 'admin' }, use: { storageState: { cookies: [], origins: [] } } },
]

const productionProjects = [
  // teardown (not a dependent project) so cleanup runs even when a spec fails.
  { name: 'setup', testMatch: /auth\.setup\.ts/, teardown: 'cleanup' },
  {
    name: 'admin',
    dependencies: ['setup'],
    testIgnore: /auth\.setup\.ts|cleanup\.spec\.ts/,
    metadata: { role: 'admin' },
    use: { storageState: storageStatePath('admin') },
  },
  {
    name: 'user',
    dependencies: ['setup'],
    testIgnore: /auth\.setup\.ts|cleanup\.spec\.ts|writes\.spec\.ts/,
    metadata: { role: 'user' },
    use: { storageState: storageStatePath('user') },
  },
  // Deletes only the entities THIS run recorded (created.json) and proves it with list calls.
  { name: 'cleanup', testMatch: /cleanup\.spec\.ts/ },
]

export default defineConfig({
  ...sharedConfig({
    timeout: 180_000,
    use: { viewport: { width: 1440, height: 900 }, actionTimeout: 20_000, trace: 'retain-on-failure' },
  }),
  projects: MOCK ? mockProjects : productionProjects,
})

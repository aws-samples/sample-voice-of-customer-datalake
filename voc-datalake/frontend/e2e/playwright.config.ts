/**
 * Production e2e suite. Run from voc-datalake/frontend: `npm run e2e:prod`
 * (see e2e/README.md for the env vars). The specs that write run one at a time
 * (`admin` / `user`, `E2E_WRITE_WORKERS`, default 1): they drive a shared
 * production deployment and the same two users. The read-only specs
 * (lib/parallel.ts) run beside them in `admin-read` / `user-read`, fully
 * parallel, up to `E2E_READ_WORKERS` (default 4). With `E2E_MOCK=1` the same
 * config drives the local dev mock instead (`MOCK_SPECS` in lib/env.ts).
 */
import { defineConfig, type Project } from '@playwright/test'
import type { WorkerPlan } from './lib/parallel'
// One run id for the whole run: workers inherit the env, so names stay stable
// across the worker restarts Playwright performs after a failure.
// With E2E_TRACK set (parallel QA tracks against one deployment) the id is
// `<track>-<epoch ms>`; cleanup deletes only this run's ledger entries anyway.
const { MOCK, MOCK_SPECS, ROLES, storageStatePath, defaultRunId } = await import('./lib/env')
process.env['E2E_RUN_ID'] ??= defaultRunId()
const { sharedConfig } = await import('./lib/runConfig')
const { READ_ONLY_SPECS, workerPlan } = await import('./lib/parallel')

// E2E_MOCK=1 (lib/env.ts): only the specs that model the dev mock, as the admin,
// with no login, no saved session and no setup / cleanup.
const mockProjects: Project[] = [
  { name: 'admin', testMatch: MOCK_SPECS, metadata: { role: 'admin' }, use: { storageState: { cookies: [], origins: [] } } },
]

/**
 * The production projects for a worker plan (pinned by unit/projects.spec.ts). Typed `Project[]`
 * so a key the pinned Playwright does not support is a type error, not a silently ignored option.
 */
export function productionProjects(workers: WorkerPlan): Project[] {
  return [
    // teardown (not a dependent project) so cleanup runs even when a spec fails.
    { name: 'setup', testMatch: /auth\.setup\.ts/, teardown: 'cleanup' },
    {
      name: 'admin',
      dependencies: ['setup'],
      testIgnore: [/auth\.setup\.ts|cleanup\.spec\.ts/, READ_ONLY_SPECS],
      metadata: { role: 'admin' },
      workers: workers.write,
      use: { storageState: storageStatePath('admin') },
    },
    {
      name: 'user',
      dependencies: ['setup'],
      testIgnore: [/auth\.setup\.ts|cleanup\.spec\.ts|writes\.spec\.ts/, READ_ONLY_SPECS],
      metadata: { role: 'user' },
      workers: workers.write,
      use: { storageState: storageStatePath('user') },
    },
    // Read-only specs (lib/parallel.ts): nothing shared, so every test may run on its own worker.
    ...ROLES.map((role): Project => ({
      name: `${role}-read`,
      dependencies: ['setup'],
      testMatch: READ_ONLY_SPECS,
      fullyParallel: true,
      metadata: { role },
      workers: workers.read,
      use: { storageState: storageStatePath(role) },
    })),
    // Deletes only the entities THIS run recorded (created.json) and proves it with list calls.
    { name: 'cleanup', testMatch: /cleanup\.spec\.ts/ },
  ]
}

// The env worker counts are parsed (and a bad value refused) only for a production run.
const plan = MOCK ? null : workerPlan()

export default defineConfig({
  ...sharedConfig({
    workers: plan === null ? 1 : plan.total,
    timeout: 180_000,
    use: { viewport: { width: 1440, height: 900 }, actionTimeout: 20_000, trace: 'retain-on-failure' },
  }),
  projects: plan === null ? mockProjects : productionProjects(plan),
})

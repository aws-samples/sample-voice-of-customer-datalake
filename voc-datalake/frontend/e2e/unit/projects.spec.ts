/**
 * The production project graph of playwright.config.ts (5.61.00): which project tears down after
 * which, and how many workers each may use. A mistake here does not fail a run, it silently changes
 * it (cleanup starts while specs still write, or the writing specs run side by side), so it is pinned
 * offline.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import config, { productionProjects } from '../playwright.config'
import { MOCK } from '../lib/env'
import { workerPlan } from '../lib/parallel'

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Distinct counts, so a read project carrying the write count (or the reverse) cannot pass.
const PLAN = { read: 7, write: 3, total: 10 }
const WRITE_PROJECTS = ['admin', 'user']
const READ_PROJECTS = ['admin-read', 'user-read']
// TestProject.workers (a per-project worker limit) exists since Playwright 1.52; older versions ignore it.
const MIN_PROJECT_WORKERS_VERSION = [1, 52] as const

/** The `@playwright/test` entry of e2e/package.json's devDependencies, or '' when absent. */
function playwrightPin(pkg: unknown): string {
  if (typeof pkg !== 'object' || pkg === null || !('devDependencies' in pkg)) return ''
  const deps: unknown = pkg.devDependencies
  if (typeof deps !== 'object' || deps === null || !('@playwright/test' in deps)) return ''
  const version: unknown = deps['@playwright/test']
  return typeof version === 'string' ? version : ''
}

function pinnedPlaywright(): readonly number[] {
  const version = playwrightPin(JSON.parse(fs.readFileSync(path.join(E2E_DIR, 'package.json'), 'utf8')))
  // An exact pin ("1.64.1"): a range would let an install pick a version this spec never saw.
  expect(version, '@playwright/test is pinned exactly').toMatch(/^\d+\.\d+\.\d+$/)
  return version.split('.').map(Number)
}

test('cleanup is the teardown of setup, and every other project depends on setup', () => {
  const projects = productionProjects(PLAN)
  expect(projects.find((p) => p.name === 'setup')?.teardown).toBe('cleanup')
  // Playwright (1.64) runs a teardown project only after its setup project AND every project that
  // depends on that setup have finished. So a project without `dependencies: ['setup']` could still
  // be running (and writing) while cleanup deletes this run's entities.
  const others = projects.filter((p) => p.name !== 'setup' && p.name !== 'cleanup')
  expect(others.map((p) => p.name)).toStrictEqual([...WRITE_PROJECTS, ...READ_PROJECTS])
  for (const project of others) expect(project.dependencies ?? [], String(project.name)).toContain('setup')
  // A teardown that itself depended on setup would be an ordinary dependent project instead.
  expect(projects.find((p) => p.name === 'cleanup')?.dependencies).toBeUndefined()
})

test('the writing projects take the write workers and the read projects the read workers', () => {
  const workers = Object.fromEntries(productionProjects(PLAN).map((p) => [p.name, p.workers]))
  for (const name of WRITE_PROJECTS) expect(workers[name], name).toBe(PLAN.write)
  for (const name of READ_PROJECTS) expect(workers[name], name).toBe(PLAN.read)
  const [major = 0, minor = 0] = pinnedPlaywright()
  const [minMajor, minMinor] = MIN_PROJECT_WORKERS_VERSION
  expect(major > minMajor || (major === minMajor && minor >= minMinor), `Playwright ${major}.${minor} supports TestProject.workers`).toBe(true)
})

test('the resolved config runs exactly these projects with the env worker plan', () => {
  test.skip(MOCK, 'E2E_MOCK=1 resolves the mock projects')
  const plan = workerPlan()
  expect(config.workers).toBe(plan.total)
  expect(config.projects).toStrictEqual(productionProjects(plan))
})

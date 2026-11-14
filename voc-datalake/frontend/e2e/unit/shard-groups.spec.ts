/**
 * e2e/shard-groups.txt (`run-sharded.sh --groups`) holds every production spec exactly once, so a new spec cannot be
 * left out of a grouped run; and the runner refuses a groups file it cannot use before it starts anything.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const E2E_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GROUPS_FILE = path.join(E2E_ROOT, 'shard-groups.txt')

/** Specs that never run in a grouped production run, and why (README). */
const NOT_GROUPED: Readonly<Record<string, string>> = {
  'tests/s1-a-data.spec.ts': 'QA track s1 only (writes feedback that cannot be deleted)',
  'tests/s1-b-assistant.spec.ts': 'QA track s1 only',
  'tests/s2-agents.spec.ts': 'QA track s2: runs alone with --project=admin --no-deps',
  'tests/s2-workflow-rebuild.spec.ts': 'QA track s2: runs alone with --project=admin --no-deps',
  'tests/csv-dataset-update.spec.ts': 'dev mock only (writes feedback)',
  'tests/workspaces.spec.ts': 'dev mock only (it needs the mock\'s two fictional workspaces)',
  'tests/workspace-admin.spec.ts': 'dev mock only (creates a workspace and changes memberships, which a deployment cannot undo yet)',
  'tests/cross-workspace.spec.ts': 'dev mock only (it needs the mock\'s two fictional workspaces)',
  'tests/cleanup.spec.ts': 'the shared teardown, run by every group',
}

interface Group { name: string; tokens: string[] }

function groups(): Group[] {
  return fs.readFileSync(GROUPS_FILE, 'utf8').split('\n')
    .map((line) => line.split('#')[0]?.trim() ?? '')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name = '', ...tokens] = line.split(/\s+/)
      return { name, tokens }
    })
}

const specsOf = (group: Group): string[] => group.tokens.filter((t) => !t.startsWith('--') && !/^workers=\d+$/.test(t))

test('every production spec is in exactly one group, or listed as not grouped with a reason', () => {
  const listed = groups().flatMap(specsOf)
  const specs = fs.readdirSync(path.join(E2E_ROOT, 'tests')).filter((f) => f.endsWith('.spec.ts')).map((f) => `tests/${f}`)
  const expected = specs.filter((spec) => !(spec in NOT_GROUPED)).sort()
  expect([...listed].sort(), 'each spec once').toStrictEqual(expected)
  for (const spec of Object.keys(NOT_GROUPED)) expect(specs, `${spec} still exists`).toContain(spec)
})

test('group names are unique, and every token is a spec, workers=<n> or a --flag', () => {
  const all = groups()
  expect(new Set(all.map((g) => g.name)).size).toBe(all.length)
  for (const group of all) {
    expect(specsOf(group).length, `${group.name} names a spec`).toBeGreaterThan(0)
    for (const token of group.tokens) expect(token, group.name).toMatch(/^(tests\/[a-z0-9-]+\.spec\.ts|workers=[1-9]\d*|--[a-z-]+)$/)
  }
})

test('the runner refuses a missing groups file, a group without specs or one with only a comment, before it starts anything', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'voc-e2e-groups-'))
  const bad = path.join(out, 'groups.txt')
  fs.writeFileSync(bad, 'lonely\n')
  const commentOnly = path.join(out, 'comment-only.txt')
  fs.writeFileSync(commentOnly, 'notes # only a comment, no spec\n')
  for (const args of [['--groups'], ['--groups', path.join(out, 'missing.txt')], ['--groups', bad], ['--groups', commentOnly]]) {
    const run = spawnSync('bash', ['scripts/run-sharded.sh', ...args], {
      cwd: E2E_ROOT, env: { ...process.env, E2E_SHARD_OUT: path.join(out, 'run') },
    })
    expect(run.status, args.join(' ')).toBe(2)
  }
  expect(fs.existsSync(path.join(out, 'run'))).toBe(false)
  fs.rmSync(out, { recursive: true, force: true })
})

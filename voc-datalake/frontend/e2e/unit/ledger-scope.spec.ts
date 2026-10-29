/**
 * 5.35.01 sharded e2e: s2-agents' own cleanup (s2-99) took every project in the shard's
 * ledger, so it deleted the project s3 was generating personas for, two minutes into the
 * generation (s3 steps 02-11 failed). A spec's own cleanup now deletes only what that spec
 * recorded; the shared teardown still takes the whole run.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { currentSpec, recordCreated, runLedger, specLedger } from '../lib/ledger'
import { OUT_DIR, RUN_ID } from '../lib/env'

const FILE = path.join(OUT_DIR, 'created.json')
const TESTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests')

test('an entry is stamped with the spec that recorded it, and a spec cleans up only its own', () => {
  fs.rmSync(FILE, { force: true })
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const other = { kind: 'project', id: 'proj_s3', name: 'e2e-s3-project', at: new Date().toISOString(), runId: RUN_ID, spec: 's3-personas-documents.spec.ts' }
  fs.writeFileSync(FILE, JSON.stringify([other]))

  recordCreated('project', 'proj_mine', 'e2e-mine')

  expect(currentSpec()).toBe('ledger-scope.spec.ts')
  expect(specLedger().map((e) => [e.id, e.spec])).toStrictEqual([['proj_mine', 'ledger-scope.spec.ts']])
  expect(runLedger().map((e) => e.id)).toStrictEqual(['proj_s3', 'proj_mine'])
  expect(specLedger('s3-personas-documents.spec.ts').map((e) => e.id)).toStrictEqual(['proj_s3'])
  expect(specLedger('cleanup.spec.ts')).toStrictEqual([])
})

/** A spec's own delete fed the whole run's ledger (or the default, which is the whole run). */
const crossSpecDeletes = (source: string): string[] =>
  [...source.matchAll(/delete(?:Projects|Conversations)\((?:runLedger\(|runConversations\(\)|readLedger\()/g)].map((m) => m[0])

test('no spec but the shared teardown deletes from the whole run ledger', () => {
  expect(crossSpecDeletes('await deleteProjects(runLedger().filter((e) => e.kind === "project"))')).toHaveLength(1)
  expect(crossSpecDeletes('await deleteConversations(runConversations())')).toHaveLength(1)
  expect(crossSpecDeletes('await deleteConversations(runConversations(specLedger()))')).toStrictEqual([])
  const offenders = fs.readdirSync(TESTS)
    .filter((file) => file.endsWith('.spec.ts') && file !== 'cleanup.spec.ts')
    .flatMap((file) => crossSpecDeletes(fs.readFileSync(path.join(TESTS, file), 'utf8')).map((hit) => `${file}: ${hit}`))
  expect(offenders).toStrictEqual([])
})

test('a spec that clicks Run now also confirms the 5.35 "Start a run now?" dialog', () => {
  const clicksRunNow = /name: 'Run now' \}\)\.click\(\)/
  const unconfirmed = fs.readdirSync(TESTS)
    .filter((file) => file.endsWith('.spec.ts'))
    .filter((file) => {
      const source = fs.readFileSync(path.join(TESTS, file), 'utf8')
      return clicksRunNow.test(source) && !source.includes("dialogNamed(page, 'Start a run now?')")
    })
  expect(unconfirmed).toStrictEqual([])
})

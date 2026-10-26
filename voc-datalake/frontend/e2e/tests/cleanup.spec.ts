/**
 * Teardown: deletes every entity THIS RUN recorded in its ledger (created.json
 * entries with this run id), then PROVES it with list calls. By default it
 * deletes nothing else, so tracks running in parallel against one deployment
 * never delete each other's data. `E2E_SWEEP_LEFTOVERS=1` also sweeps leftovers
 * of earlier aborted runs: names matching SUITE_NAME (with E2E_TRACK, only that
 * track's `e2e-<track>-<epoch>-…`). Never touches a name outside `e2e-`.
 * Proof is written to OUT_DIR/cleanup-proof.json.
 *
 * Kinds without a delete route are retired the way the product retires them,
 * from the ledger only (never swept by name): agents and workflows are archived
 * (`DELETE` archives; agents first, because a workflow an active agent runs
 * answers 409), global MCP tokens revoked and memories forgotten, each as the
 * role that owns it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect } from '@playwright/test'
import { test } from '../lib/test'
import { apiCall, listOf, stringField } from '../lib/api'
import { isRecord } from '../lib/guards'
import { E2E_PREFIX, OUT_DIR, RUN_ID, SUITE_NAME, type Role } from '../lib/env'
import { runLedger, type Created, type EntityKind } from '../lib/ledger'
import { deleteConversations, runConversations } from '../lib/runCleanup'

interface Collection {
  kind: EntityKind
  list: string
  key: string
  idKeys: string[]
  del: (id: string) => string
}

const COLLECTIONS: readonly Collection[] = [
  { kind: 'project', list: '/projects', key: 'projects', idKeys: ['project_id', 'id'], del: (id) => `/projects/${encodeURIComponent(id)}` },
  { kind: 'feedback-form', list: '/feedback-forms', key: 'forms', idKeys: ['form_id', 'id'], del: (id) => `/feedback-forms/${encodeURIComponent(id)}` },
  { kind: 'scraper', list: '/scrapers', key: 'scrapers', idKeys: ['id'], del: (id) => `/scrapers/${encodeURIComponent(id)}` },
]

interface ProofLine {
  action: string
  status: number
  ms: number
  detail: string
}

/** Opt-in leftover sweep (earlier aborted runs): this suite's, and with E2E_TRACK this track's, names only. */
const SWEEP_LEFTOVERS = process.env['E2E_SWEEP_LEFTOVERS'] === '1'
const isSuiteName = (name: string): boolean => SUITE_NAME.test(name)

/** Belt and braces: a ledger entry is deleted only when its name is an e2e name of some run. */
const LEDGER_NAME = new RegExp(`^${E2E_PREFIX}(?:[a-z][a-z0-9]{0,15}-)?\\d{12,}-`)
const isLedgerName = (name: string): boolean => LEDGER_NAME.test(name)

/** `body[key].status` (the entity a retire route answers with). */
function statusOf(body: unknown, key: string): string | undefined {
  const entity = isRecord(body) ? body[key] : undefined
  return isRecord(entity) && typeof entity['status'] === 'string' ? entity['status'] : undefined
}

/** Archive this run's agents, then its workflows (admin); prove neither list still shows one. */
async function archiveAgentsAndWorkflows(ledger: readonly Created[], proof: ProofLine[]): Promise<void> {
  for (const [kind, route, listKey] of [['agent', '/agents', 'items'], ['workflow', '/workflows', 'items']] as const) {
    const mine = ledger.filter((e) => e.kind === kind && isLedgerName(e.name))
    if (mine.length === 0) continue
    for (const entry of mine) {
      const res = await apiCall('admin', 'DELETE', `${route}/${encodeURIComponent(entry.id)}`)
      proof.push({ action: `DELETE ${route}/{${entry.name}} (archive)`, status: res.status, ms: res.ms, detail: entry.id })
      expect.soft(res.status, `archive ${kind} ${entry.id}`).toBe(200)
    }
    const after = await apiCall('admin', 'GET', route)
    const ids = new Set(mine.map((e) => e.id))
    const left = listOf(after.body, listKey).filter((item) => ids.has(stringField(item, `${kind}_id`, 'id') ?? ''))
    proof.push({ action: `GET ${route} (after)`, status: after.status, ms: after.ms, detail: `run ${RUN_ID} ${kind}s still listed: ${left.length}` })
    expect.soft(after.status).toBe(200)
    expect.soft(left, `${kind}: this run's e2e items still listed`).toEqual([])
  }
}

/** Revoke this run's global MCP tokens and forget its memories, each as its owner; the answer proves it. */
async function retireOwned(ledger: readonly Created[], proof: ProofLine[]): Promise<void> {
  for (const token of ledger.filter((e) => e.kind === 'token' && isLedgerName(e.name))) {
    const owner: Role = token.role ?? 'admin'
    const res = await apiCall(owner, 'DELETE', `/connect/tokens/${encodeURIComponent(token.id)}`)
    proof.push({ action: `DELETE /connect/tokens/{${token.name}} as ${owner}`, status: res.status, ms: res.ms, detail: `status ${statusOf(res.body, 'token') ?? '?'}` })
    expect.soft(res.status, `revoke ${token.id}`).toBe(200)
    expect.soft(statusOf(res.body, 'token')).toBe('revoked')
  }
  for (const memory of ledger.filter((e) => e.kind === 'memory' && isLedgerName(e.name))) {
    const owner: Role = memory.role ?? 'admin'
    const res = await apiCall(owner, 'POST', `/memory/${encodeURIComponent(memory.id)}/forget`, {})
    proof.push({ action: `POST /memory/{e2e memory}/forget as ${owner}`, status: res.status, ms: res.ms, detail: `${memory.id}: status ${statusOf(res.body, 'memory') ?? '?'}` })
    expect.soft(res.status, `forget ${memory.id}`).toBe(200)
    expect.soft(statusOf(res.body, 'memory')).toBe('archived')
  }
}

async function listed(role: Role, c: Collection): Promise<Array<{ id: string; name: string }>> {
  const res = await apiCall(role, 'GET', c.list)
  return listOf(res.body, c.key)
    .map((item) => ({ id: stringField(item, ...c.idKeys) ?? '', name: stringField(item, 'name') ?? '' }))
    .filter((item) => item.id !== '')
}

// Soft assertions throughout: one kind that fails to clean up must not keep the
// others (or the proof file) from being done; the test still fails.
test('cleanup: delete this run\'s e2e entities and prove it', async () => {
  const proof: ProofLine[] = []
  const ledger = runLedger()
  const role: Role = 'admin'

  for (const c of COLLECTIONS) {
    const fromLedger = ledger.filter((e) => e.kind === c.kind && isLedgerName(e.name))
    const before = await listed(role, c)
    const leftovers = SWEEP_LEFTOVERS ? before.filter((item) => isSuiteName(item.name)) : []
    const targets = new Map<string, string>()
    for (const e of [...fromLedger, ...leftovers]) targets.set(e.id, e.name)
    const listedBefore = new Set(before.map((item) => item.id))
    for (const [id, name] of targets) {
      // DELETE is idempotent on these routes (200 for an id that is already gone),
      // so whether it still existed is taken from the list made just before.
      const existed = listedBefore.has(id)
      const res = await apiCall(role, 'DELETE', c.del(id))
      proof.push({ action: `DELETE ${c.list}/{${name}}`, status: res.status, ms: res.ms, detail: existed ? 'was still listed: deleted now' : 'not listed (already deleted by the UI flow); idempotent delete' })
    }
    const after = await apiCall(role, 'GET', c.list)
    const remaining = listOf(after.body, c.key).filter((item) => {
      const name = stringField(item, 'name') ?? ''
      return (SWEEP_LEFTOVERS && isSuiteName(name)) || targets.has(stringField(item, ...c.idKeys) ?? '')
    })
    proof.push({ action: `GET ${c.list} (after)`, status: after.status, ms: after.ms, detail: `run ${RUN_ID} targets remaining: ${remaining.length}; total listed: ${listOf(after.body, c.key).length}` })
    expect.soft(after.status).toBe(200)
    expect.soft(remaining, `${c.kind}: this run's e2e items left`).toEqual([])
  }

  // Assistant conversations the run saved. Each lives in its creator's USER#
  // partition, so it is deleted (and checked) as that role: as the admin, a
  // user's conversation would answer 404 whether or not it still existed.
  for (const conv of await deleteConversations(runConversations(ledger))) {
    proof.push({ action: `DELETE /chat/conversations/{e2e conversation} as ${conv.owner}`, status: conv.deleteStatus, ms: 0, detail: conv.id })
    proof.push({ action: 'GET /chat/conversations/{e2e conversation} (after)', status: conv.getStatus, ms: 0, detail: 'expect 404' })
    expect.soft(conv.getStatus).toBe(404)
  }

  await archiveAgentsAndWorkflows(ledger, proof)
  await retireOwned(ledger, proof)

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'cleanup-proof.json'), JSON.stringify({ at: new Date().toISOString(), ledger, proof }, null, 2))
})

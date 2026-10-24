/**
 * @fileoverview Keeps the assist-job poll statuses in step across the three
 * packages that read them: the backend's own (`lambda/shared/assist_jobs.py`),
 * the SPA's poll schema (`assistJobs.ts`) and the stream tool's
 * (`lambda/stream/src/assistant/tools/server/assist-job.ts`). The two TypeScript
 * schemas mirror each other on purpose (separate packages); this is their pin.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../../..')

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

/** The status values `assist_jobs.py` binds (`PENDING: Final = 'pending'` …). */
function pythonStatuses(source: string): string[] {
  return ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'].map((name) => {
    const value = new RegExp(`^${name}: Final = '([a-z]+)'$`, 'm').exec(source)?.[1]
    if (value === undefined) throw new Error(`assist_jobs.py no longer binds ${name} as a literal`)
    return value
  })
}

/** The members of the `status: z.enum([...])` in a poll schema. */
function schemaStatuses(source: string): string[] {
  const members = /status: z\.enum\(\[([^\]]*)\]\)/.exec(source)?.[1]
  if (members === undefined) throw new Error('the poll schema no longer spells status as z.enum([...])')
  return [...members.matchAll(/'([a-z]+)'/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]))
}

describe('assist job statuses', () => {
  const backend = pythonStatuses(read('lambda/shared/assist_jobs.py'))

  it.each([
    ['the SPA poll schema', 'frontend/src/api/assistJobs.ts'],
    ['the stream tool poll schema', 'lambda/stream/src/assistant/tools/server/assist-job.ts'],
  ])('%s accepts exactly the backend statuses', (_label, file) => {
    const statuses = schemaStatuses(read(file))
    expect(statuses).toHaveLength(backend.length)
    expect(new Set(statuses)).toStrictEqual(new Set(backend))
  })

  it('reads four distinct backend statuses', () => {
    expect(new Set(backend).size).toBe(4)
  })
})

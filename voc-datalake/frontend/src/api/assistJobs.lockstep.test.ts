/**
 * @fileoverview Keeps the assist-job poll statuses in step with the backend that
 * writes them (`lambda/shared/assist_jobs.py`). The SPA and the stream tool read the
 * job with one schema, the stream's `assistJobPollSchema`
 * (`@stream/assistant/tools/server/assist-job-values`), so that schema is pinned
 * here against the Python file, read as text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assistJobPollSchema } from '@stream/assistant/tools/server/assist-job-values'

const ROOT = join(__dirname, '../../..')

/** The status values `assist_jobs.py` binds (`PENDING: Final = 'pending'` …). */
function pythonStatuses(source: string): string[] {
  return ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'].map((name) => {
    const value = new RegExp(`^${name}: Final = '([a-z]+)'$`, 'm').exec(source)?.[1]
    if (value === undefined) throw new Error(`assist_jobs.py no longer binds ${name} as a literal`)
    return value
  })
}

describe('assist job statuses', () => {
  const backend = pythonStatuses(readFileSync(join(ROOT, 'lambda/shared/assist_jobs.py'), 'utf8'))

  it('the shared poll schema accepts exactly the backend statuses', () => {
    const statuses = assistJobPollSchema.shape.status.options
    expect(statuses).toHaveLength(backend.length)
    expect(new Set(statuses)).toStrictEqual(new Set(backend))
  })

  it('reads four distinct backend statuses', () => {
    expect(new Set(backend).size).toBe(4)
  })
})

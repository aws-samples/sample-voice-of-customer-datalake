/**
 * @fileoverview The methodology block on an agent run's journal events and on a plan step
 * (lambda/agents/run_methodology.py, shared/plans_store.step_view): read leniently, a malformed
 * block is dropped and never fails the event or the step.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi } from '@test/fetchApiRoutes'
import { agentsApi } from './agentsApi'
import { normalizePlanView } from './plansApi'

const BLOCK = {
  step: 'prd', skipped: [{ step: 'prfaq', reason: 'missing' }],
  warnings: [{ code: 'missing_upstream', step: 'prfaq', message: 'This PRD is made without a PR/FAQ.' }],
  evidence: null,
}

describe('run events', () => {
  it('carry the block, and lose only a malformed one', async () => {
    fetchApi.mockResolvedValueOnce({
      items: [
        { seq: 1, at: '', kind: 'message', summary: 'Methodology (PRD): skipped a PR/FAQ.', methodology: BLOCK },
        { seq: 2, at: '', kind: 'node_finished', summary: 'PRD written', methodology: 'prd' },
      ],
      next_after: 2,
    })
    const page = await agentsApi.listEvents('ag_1', 'ar_1', 0)
    expect(page.items.map((e) => e.methodology?.skipped)).toStrictEqual([[{ step: 'prfaq', reason: 'missing' }], undefined])
    expect(page.items.map((e) => e.summary)).toStrictEqual(['Methodology (PRD): skipped a PR/FAQ.', 'PRD written'])
  })
})

describe('plan steps', () => {
  it('carry the block a methodology step started with', () => {
    const view = normalizePlanView({ plan: {
      plan_id: 'pl_a1b2c3d4e5f6', status: 'running', goal: 'G', created_at: '', updated_at: '',
      steps: [
        { id: 's1', title: 'Write the PRD', pack: 'project', kind: 'write', status: 'done', outputs: {}, methodology: BLOCK },
        { id: 's2', title: 'Create', pack: 'core', kind: 'write', status: 'done', outputs: {}, methodology: { step: 7 } },
      ],
    } })
    expect(view?.steps.map((s) => s.methodology?.warnings.length)).toStrictEqual([1, 0])
  })
})

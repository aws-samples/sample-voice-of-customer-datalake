/**
 * Which poll changes are announced (a plan ended, a step newly needs approval)
 * and which tool results count as an approved plan.
 */
import { describe, it, expect } from 'vitest'
import { normalizePlanView } from '../../api/plansApi'
import { approvedPlanIds, createdProjectId } from './planIds'
import { planNoticeBetween } from './usePlanProgress'
import type { PlanView } from '../../api/plansApi'

function plan(status: string, steps: { id: string; status: string; outputs?: Record<string, string> }[]): PlanView {
  const view = normalizePlanView({ plan: { plan_id: 'pl_a1b2c3d4e5f6', status, goal: 'G', created_at: '', updated_at: '', steps } })
  if (view === null) throw new Error('fixture did not parse')
  return view
}

describe('planNoticeBetween', () => {
  it.each([
    ['completed', 'done'],
    ['completed_with_errors', 'issues'],
    ['failed', 'issues'],
    ['cancelled', 'issues'],
  ] as const)('a running plan that ends %s announces %s', (status, notice) => {
    expect(planNoticeBetween(plan('running', []), plan(status, []))).toBe(notice)
  })

  it('announces a step that newly needs approval, once', () => {
    const asking = plan('running', [{ id: 's1', status: 'needs_approval' }])
    expect(planNoticeBetween(plan('running', [{ id: 's1', status: 'running' }]), asking)).toBe('approval')
    expect(planNoticeBetween(asking, asking)).toBeNull()
  })

  it('says nothing on the first read or between two terminal reads', () => {
    expect(planNoticeBetween(undefined, plan('completed', []))).toBeNull()
    expect(planNoticeBetween(plan('completed', []), plan('completed', []))).toBeNull()
  })
})

describe('approvedPlanIds', () => {
  const call = (id: string, name = 'propose_plan') => ({ id, function: { name } })

  it('reads the plan id of executed proposals only, in call order', () => {
    const toolResults = {
      c1: JSON.stringify({ status: 'executed', summary: 's', data: { plan_id: 'pl_000000000001' } }),
      c2: JSON.stringify({ status: 'declined' }),
      c3: JSON.stringify({ status: 'executed', summary: 's', data: { plan_id: 'pl_000000000003' } }),
    }
    expect(approvedPlanIds([call('c1'), call('c2'), call('c3')], { toolResults })).toStrictEqual(['pl_000000000001', 'pl_000000000003'])
  })

  it('ignores other tools, malformed ids and unparsable results', () => {
    const toolResults = {
      c1: JSON.stringify({ status: 'executed', summary: 's', data: { plan_id: 'pl_000000000001' } }),
      c2: JSON.stringify({ status: 'executed', summary: 's', data: { plan_id: '../agents' } }),
      c3: 'not json',
    }
    expect(approvedPlanIds([call('c1', 'create_project'), call('c2'), call('c3')], { toolResults })).toStrictEqual([])
  })
})

describe('createdProjectId', () => {
  it('is the first well-formed project id a step produced', () => {
    const view = plan('completed', [{ id: 's1', status: 'done', outputs: { project_id: 'a/b' } }, { id: 's2', status: 'done', outputs: { project_id: 'proj_1' } }])
    expect(createdProjectId(view)).toBe('proj_1')
  })
})

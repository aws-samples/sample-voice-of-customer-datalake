/**
 * Plan-mode approval cards: the propose_plan PlanCard (goal, ordered steps,
 * placeholders spelled out, "will ask again", limits; Approve and run / Change /
 * Decline) and the run_source, build_prototype and cancel_plan cards, each
 * running exactly its REST request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'

const fetchApiDoubles = await vi.hoisted(async () => import('@test/fetchApiRoutes'))
vi.mock('../../api/client', fetchApiDoubles.clientWithMockedFetchApi)
vi.mock('../../store/authStore', fetchApiDoubles.authStoreModule)

import { resetExecutions } from './executionStore'
import { stubElementScrollIntoView } from '../../test/stubScrollTo'
import { adminFlag, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { approve, outcomeOf, renderApprovalCard, resumedToolMessage, writes } from '@test/approvalCardHarness'
import type { AssistantToolCall } from '../types'

beforeEach(() => {
  vi.clearAllMocks()
  resetFetchApi()
  resetExecutions()
  adminFlag.isAdmin = true
  return stubElementScrollIntoView()
})

const PLAN = {
  schema: 'voc-plan/1',
  goal: 'Acme: project with personas',
  steps: [
    { id: 's1', pack: 'core', kind: 'write', title: 'Create the project',
      write: { tool: 'create_project', args: { name: 'Acme', description: '{{free}}' } }, produces: ['project_id'] },
    { id: 's2', pack: 'project', kind: 'write', after: ['s1'], title: 'Generate personas',
      write: { tool: 'generate_personas', args: { project_id: '{{s1.project_id}}', persona_count: 4 } }, produces: ['job_id'] },
    { id: 's3', pack: 'project', kind: 'wait', after: ['s2'], title: 'Wait for the personas',
      wait: { for: 'project_job', project_id: '{{s1.project_id}}', job_id: '{{s2.job_id}}' } },
  ],
}
const proposal = (plan: unknown = PLAN): AssistantToolCall => ({ id: 'c1', name: 'propose_plan', args: plan })
const renderPlan = (plan?: unknown) =>
  renderApprovalCard(proposal(plan), { kind: 'home', path: '/' }, { conversationId: 'conv_1' })
const step = (id: string) => within(screen.getByTestId(`plan-step-${id}`))

describe('propose_plan card', () => {
  it('shows the goal and every step in order with its page label', () => {
    renderPlan()
    expect(screen.getByText('Acme: project with personas')).toBeInTheDocument()
    expect(screen.getAllByTestId(/^plan-step-/).map((el) => el.dataset.testid)).toStrictEqual(['plan-step-s1', 'plan-step-s2', 'plan-step-s3'])
    expect(step('s2').getByText('Project')).toBeInTheDocument()
  })

  it('spells out references and free-text fields instead of raw placeholders', () => {
    renderPlan()
    expect(step('s2').getByText('← output of step 1 (project_id)')).toBeInTheDocument()
    expect(step('s1').getByText('written when it runs')).toBeInTheDocument()
    expect(screen.queryByText('{{s1.project_id}}')).not.toBeInTheDocument()
  })

  it('marks a never-pre-approvable tool "will ask again"', () => {
    renderPlan({ ...PLAN, steps: [...PLAN.steps, { id: 's4', pack: 'project', kind: 'write', after: ['s1'], title: 'Remove the draft',
      write: { tool: 'delete_document', args: { project_id: '{{s1.project_id}}', document_id: 'doc_1' } } }] })
    expect(step('s4').getByText('will ask again')).toBeInTheDocument()
    expect(step('s1').queryByText('will ask again')).not.toBeInTheDocument()
  })

  it('states the counts against the plan limits', () => {
    renderPlan()
    expect(screen.getByTestId('plan-limits')).toHaveTextContent('3 of 20 steps · 2 of 12 writes · 1 of 6 waits · 0 of 4 analyses')
  })

  it('Approve and run posts the plan with the conversation and resumes with the plan id', async () => {
    routeFetchApi({ 'POST /agents/plans': () => ({ plan_id: 'pl_a1b2c3d4e5f6', status: 'approved' }) })
    const { user, onResolve } = renderPlan()
    await user.click(screen.getByRole('button', { name: 'Approve and run' }))
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1))
    expect(writes()).toStrictEqual([['/agents/plans', 'POST', { plan: PLAN, conversation_id: 'conv_1' }]])
    expect(resumedToolMessage(onResolve, 'c1')).toMatchObject({ status: 'executed', data: { plan_id: 'pl_a1b2c3d4e5f6' } })
  })

  it('Change declines with a note that asks the assistant to revise the plan', async () => {
    const { user, onResolve } = renderPlan()
    await user.click(screen.getByRole('button', { name: 'Change' }))
    await user.type(screen.getByLabelText('What should change?'), 'use 3 personas')
    await user.click(screen.getByRole('button', { name: 'Ask for changes' }))
    const outcome = outcomeOf(onResolve)
    expect(outcome?.status).toBe('declined')
    expect(outcome?.status === 'declined' ? outcome.reason : '').toMatch(/change the plan.*use 3 personas.*propose it again/)
  })

  it('a plan naming an admin-only tool shows the problem to a non-admin and posts nothing on approve', async () => {
    adminFlag.isAdmin = false
    const { user, onResolve } = renderPlan({ schema: 'voc-plan/1', goal: 'Import', steps: [
      { id: 's1', pack: 'scrapers', kind: 'write', title: 'Import', write: { tool: 'run_source', args: { source: 'app_reviews_ios' } } }] })
    expect(screen.getByRole('alert')).toHaveTextContent('This plan has problems')
    await user.click(screen.getByRole('button', { name: 'Approve and run' }))
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1))
    const outcome = outcomeOf(onResolve)
    expect(outcome?.status === 'failed' ? outcome.error : '').toMatch(/^The plan was not started because it is invalid/)
    expect(writes()).toStrictEqual([])
  })
})

describe('run_source / build_prototype / cancel_plan cards', () => {
  it('run_source starts the source run and resumes with its execution id', async () => {
    routeFetchApi({ 'POST /sources/app_reviews_ios/run': () => ({ success: true, message: 'ok', source: 'app_reviews_ios', execution_id: 'run_1' }) })
    const { user, onResolve } = renderApprovalCard({ id: 'c2', name: 'run_source', args: { source: 'app_reviews_ios' } }, { kind: 'scrapers', path: '/scrapers' })
    await approve(user, onResolve)
    expect(writes()).toStrictEqual([['/sources/app_reviews_ios/run', 'POST', undefined]])
    expect(resumedToolMessage(onResolve, 'c2')).toMatchObject({ status: 'executed', data: { source: 'app_reviews_ios', execution_id: 'run_1' } })
  })

  it('run_source cannot be approved by a non-admin', () => {
    adminFlag.isAdmin = false
    renderApprovalCard({ id: 'c2', name: 'run_source', args: { source: 'app_reviews_ios' } }, { kind: 'scrapers', path: '/scrapers' })
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
  })

  it('build_prototype posts the build with the revised prototype as base and resumes with the job id', async () => {
    routeFetchApi({ 'POST /projects/proj_1/build-prototype': () => ({ success: true, job_id: 'job_9', status: 'pending', message: 'ok' }) }, { ignoreQuery: true })
    const args = { project_id: 'proj_1', title: 'Ancillaries', feedback: 'Bigger buttons', base_prototype_id: 'doc_7' }
    const { user, onResolve } = renderApprovalCard({ id: 'c3', name: 'build_prototype', args }, { kind: 'project', path: '/projects/proj_1', projectId: 'proj_1' })
    await approve(user, onResolve)
    expect(writes()).toStrictEqual([['/projects/proj_1/build-prototype', 'POST', expect.objectContaining({ title: 'Ancillaries', feedback: 'Bigger buttons', base_prototype_id: 'doc_7' })]])
    expect(resumedToolMessage(onResolve, 'c3')).toMatchObject({ status: 'executed', data: { job_id: 'job_9' } })
  })

  it('cancel_plan cancels that plan and reports its new status', async () => {
    routeFetchApi({ 'POST /agents/plans/pl_a1b2c3d4e5f6/cancel': () => ({ plan: { plan_id: 'pl_a1b2c3d4e5f6', status: 'cancelled', steps: [] } }) })
    const { user, onResolve } = renderApprovalCard({ id: 'c4', name: 'cancel_plan', args: { plan_id: 'pl_a1b2c3d4e5f6' } }, { kind: 'home', path: '/' })
    await approve(user, onResolve)
    expect(resumedToolMessage(onResolve, 'c4')).toMatchObject({ status: 'executed', data: { plan_id: 'pl_a1b2c3d4e5f6', status: 'cancelled' } })
  })
})

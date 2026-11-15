/**
 * The draft_prototype_revision approval card (docs/prototype-builder.md, part 2): it names the prototype
 * (its title and version, from the project record) and shows the exact instruction the draft job gets, as
 * text; Approve starts the draft job once (`POST …/prototypes/{document_id}/drafts`, the instruction alone
 * plus the reply language) and resumes with the job id; Decline starts nothing.
 *
 * The set_prototype_walkthrough card (Part 1), on the same prototype: every step as it will show, or that the
 * walkthrough is removed; Approve saves the steps once as a new version (`PUT …/walkthrough`, with an edit id).
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
import { FEEDBACK_ANSWER } from '../../api/prototype-feedback-fixtures'

const PAGE = { kind: 'project', path: '/projects/proj_1', projectId: 'proj_1', documentId: 'proto_3' } as const
const INSTRUCTION = 'Make the summary a **sticky** footer on phones <b>now</b>'
const call = (args: unknown = { project_id: 'proj_1', document_id: 'proto_3', instruction: INSTRUCTION }): AssistantToolCall =>
  ({ id: 'c1', name: 'draft_prototype_revision', args })
const SAVED = { document_id: 'proto_4', document_type: 'prototype', title: 'Checkout flow (v4)', content: '', created_at: '2026-11-14T10:00:00Z', version: 4 }

beforeEach(() => {
  vi.clearAllMocks()
  resetFetchApi()
  resetExecutions()
  adminFlag.isAdmin = false
  routeFetchApi({
    'GET /projects/proj_1': () => ({
      project: { project_id: 'proj_1', name: 'Checkout', access: { role: 'editor', can_view: true, can_edit: true, can_manage: false } },
      personas: [],
      documents: [{ document_id: 'proto_3', document_type: 'prototype', title: 'Checkout flow (v3)', content: '', created_at: '2026-11-13T10:00:00Z' }],
    }),
    'POST /projects/proj_1/prototypes/proto_3/drafts': () => ({ success: true, job_id: 'job_7', status: 'pending', message: 'Prototype draft started.' }),
    'GET /projects/proj_1/prototypes/proto_3/feedback': () => FEEDBACK_ANSWER,
    'PUT /projects/proj_1/prototypes/proto_3/walkthrough': () => ({ success: true, document: SAVED }),
  })
  return stubElementScrollIntoView()
})

describe('draft_prototype_revision card', () => {
  it('names the prototype and shows the instruction verbatim, as text', async () => {
    renderApprovalCard(call(), PAGE)

    expect(await screen.findByText('Checkout flow (v3)')).toBeInTheDocument()
    const instruction = screen.getByTestId('prototype-draft-instruction')
    expect(instruction.textContent).toBe(INSTRUCTION)
    expect(instruction.querySelector('b, strong')).toBeNull()
  })

  it('Approve starts the draft job once and resumes with its job id; nothing else is written', async () => {
    const { user, onResolve } = renderApprovalCard(call(), PAGE)
    await screen.findByText('Checkout flow (v3)')

    await approve(user, onResolve)

    expect(writes()).toStrictEqual([['/projects/proj_1/prototypes/proto_3/drafts', 'POST', { instruction: INSTRUCTION, response_language: 'en' }]])
    expect(resumedToolMessage(onResolve, 'c1')).toMatchObject({ status: 'executed', data: { job_id: 'job_7', draft_id: 'job_7' } })
  })

  it('Decline starts nothing', async () => {
    const { user, onResolve } = renderApprovalCard(call(), PAGE)

    // Decline opens the optional reason step; Decline again sends it without one.
    await user.click(screen.getByRole('button', { name: 'Decline' }))
    await user.click(screen.getByRole('button', { name: 'Decline' }))

    await waitFor(() => { expect(outcomeOf(onResolve)?.status).toBe('declined') })
    expect(writes()).toStrictEqual([])
  })
})

// docs/prototype-builder.md Part 3: incorporating tester pins, ids only.
describe('draft_prototype_revision card with pin_ids', () => {
  const PINS = ['pin_00000000000000000001abcdef', 'pin_00000000000000000002abcdef']
  const pinCall = () => call({ project_id: 'proj_1', document_id: 'proto_3', pin_ids: PINS })
  const answer = {
    ...FEEDBACK_ANSWER,
    groups: [{ route: '/checkout', items: [{ ...FEEDBACK_ANSWER.groups[0]?.items[0], pin_ids: PINS, pins: [] }] }],
  }

  it('lists how many pins and where, and that the server writes the instruction', async () => {
    routeFetchApi({ 'GET /projects/proj_1/prototypes/proto_3/feedback': () => answer })
    renderApprovalCard(pinCall(), PAGE)

    const pins = await screen.findByTestId('prototype-draft-pins')
    expect(pins).toHaveTextContent('2 selected tester pins')
    expect(await within(pins).findByText('/checkout')).toBeInTheDocument()
    expect(pins).toHaveTextContent('the server reads these pins itself and writes the instruction')
    expect(screen.queryByTestId('prototype-draft-instruction')).toBeNull()
  })

  it('Approve posts the pin ids alone (no text)', async () => {
    routeFetchApi({
      'GET /projects/proj_1/prototypes/proto_3/feedback': () => answer,
      'POST /projects/proj_1/prototypes/proto_3/drafts': () => ({ success: true, job_id: 'job_8', status: 'pending', message: 'Prototype draft started.' }),
    })
    const { user, onResolve } = renderApprovalCard(pinCall(), PAGE)

    await approve(user, onResolve)

    expect(writes()).toStrictEqual([['/projects/proj_1/prototypes/proto_3/drafts', 'POST', { pin_ids: PINS, response_language: 'en' }]])
  })
})

describe('set_prototype_walkthrough card', () => {
  const STEPS = [
    { title: 'Where your order is', body: 'This card says when it arrives.', selector: '#order-status' },
    { title: 'Pay here', body: 'The total includes shipping.', anchor: { route: '', bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } } },
  ]
  const walkthroughCall = (steps: unknown = STEPS): AssistantToolCall =>
    ({ id: 'c2', name: 'set_prototype_walkthrough', args: { project_id: 'proj_1', document_id: 'proto_3', steps } })

  it('lists each step with where it points', async () => {
    renderApprovalCard(walkthroughCall(), PAGE)
    expect(await screen.findByText('Checkout flow (v3)')).toBeInTheDocument()
    expect(within(screen.getByTestId('walkthrough-preview-steps')).getAllByRole('listitem').map((row) => row.textContent)).toStrictEqual([
      'Step 1 of 2Where your order isThis card says when it arrives.#order-status',
      'Step 2 of 2Pay hereThe total includes shipping.a position on this screen',
    ])
  })

  it('says how many saved steps the proposal replaces (the assistant cannot read them)', async () => {
    const saved = [1, 2, 3].map((n) => ({ title: `Saved ${String(n)}`, body: 'Text.', selector: '#a' }))
    routeFetchApi({ 'GET /projects/proj_1/prototypes/proto_3/walkthrough': () => ({ steps: saved }) })
    renderApprovalCard(walkthroughCall(), PAGE)
    expect(await screen.findByTestId('walkthrough-preview-replaces')).toHaveTextContent('Replaces the 3 saved steps.')
  })

  it('says the walkthrough is removed when the steps are empty', async () => {
    renderApprovalCard(walkthroughCall([]), PAGE)
    expect(await screen.findByText('The walkthrough is removed.')).toBeInTheDocument()
  })

  it('Approve saves the steps once as a new version, with an edit id, and resumes with it', async () => {
    const { user, onResolve } = renderApprovalCard(walkthroughCall(), PAGE)
    await screen.findByText('Checkout flow (v3)')

    await approve(user, onResolve)

    expect(writes()).toMatchObject([['/projects/proj_1/prototypes/proto_3/walkthrough', 'PUT', { steps: STEPS }]])
    // Its edit id makes a retried save a replay, not a second version.
    expect(JSON.stringify(writes())).toMatch(/"edit_id":"[0-9a-f-]{36}"/)
    expect(resumedToolMessage(onResolve, 'c2')).toMatchObject({ status: 'executed', data: { document_id: 'proto_4', version: 4 } })
  })
})

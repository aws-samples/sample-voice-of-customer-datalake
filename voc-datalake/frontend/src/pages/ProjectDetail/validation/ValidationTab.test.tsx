/**
 * @fileoverview Project → Validate (7.68.00): editors only (its results quote testers); the criteria saved with the
 * revision the editor loaded; the results judged on real testers with the personas' figure beside them, labelled
 * synthetic; Create decision once a report exists, prefilled from it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { makeDocument } from '../project-detail-fixtures'
import ValidationTab from './ValidationTab'
import type { ValidationView } from '../../../api/validationApi'

const api = vi.hoisted(() => ({
  get: vi.fn(), saveCriteria: vi.fn(), extractCriteria: vi.fn(), writePlan: vi.fn(), runSynthetic: vi.fn(),
  saveCard: vi.fn(), writeReport: vi.fn(),
}))
vi.mock('../../../api/validationApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../api/validationApi')>(), validationApi: api,
}))

const BLOCK: ValidationView['validation'] = {
  criteria: [{ id: 'c00aa11', text: 'Paying is quick', target: 4.5 }], tasks: [{ id: 't00aa11', text: 'Pay' }],
  prd_document_id: 'prd_1', prototype_document_id: 'proto_1', plan_document_id: null, run_document_id: 'doc_run',
  report_document_id: null, form_id: 'pf_0123456789abcdef', form_open: true, form_language: 'en',
  card_in_prototype: true, status: 'testing',
  revision: 3, updated_at: null,
}

function view(overrides: Partial<ValidationView> = {}): ValidationView {
  return {
    validation: BLOCK,
    form: { form_id: 'pf_0123456789abcdef', revision: 2, open: true, questions: 4, has_responses: true, stale: false },
    synthetic: { synthetic: true, document_id: 'doc_run', created_at: '2026-11-20T10:00:00Z', personas: 3 },
    real: { responses: 2, last_response_at: null, ces: { n: 2, average: 6, score: 100 },
      missing: [{ text: 'An export button', at: null, response_id: 'f1' }] },
    criteria: [{ id: 'c00aa11', text: 'Paying is quick', target: 4.5, target_set: true, real: { n: 2, average: 5 },
      outcome: 'not_enough_data', synthetic: { synthetic: true, n: 3, average: 5, reading: 'likely_met' } }],
    tasks: [{ id: 't00aa11', text: 'Pay', real: { n: 2, yes: 2, no: 0, rate: 1 },
      synthetic: { synthetic: true, completed: 3, struggled: 0, failed: 0, n: 3 } }],
    decision_prefill: { title: 'Decide', verdict: 'park', rationale: 'r', success_metric: 'Paying is quick',
      evidence: { document_ids: [], feedback_ids: ['f1'] } },
    methodology: undefined,
    ...overrides,
  }
}

const PROTOTYPE = makeDocument({ document_id: 'proto_1', document_type: 'prototype', title: 'Checkout' })

function renderTab(canEdit = true) {
  renderWithQueryClient(
    <MemoryRouter>
      <ValidationTab projectId="proj_1" canEdit={canEdit} documents={[PROTOTYPE]} onSelectDoc={vi.fn()} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  Object.values(api).forEach((mock) => { mock.mockReset() })
  api.get.mockResolvedValue(view())
})

describe('the Validate tab', () => {
  it('is for editors: a viewer is told why and nothing is read', () => {
    renderTab(false)
    expect(screen.getByText(/Only the project's editors can open the validation/)).toBeInTheDocument()
    expect(api.get).not.toHaveBeenCalled()
  })

  it('judges each criterion on real testers, the personas beside it labelled synthetic', async () => {
    renderTab()
    await screen.findByRole('cell', { name: 'Paying is quick' })
    const row = screen.getByRole('row', { name: /Paying is quick/ })
    expect(within(row).getByText('Not enough data')).toBeInTheDocument()
    expect(within(row).getByTestId('synthetic-figure')).toHaveTextContent('5 of 5 (3)Synthetic')
    expect(screen.getByText('“An export button”')).toBeInTheDocument()
  })

  it('saves the criteria with the revision it loaded', async () => {
    api.saveCriteria.mockResolvedValue(BLOCK)
    renderTab()
    const user = userEvent.setup()
    const text = await screen.findByRole('textbox', { name: 'Criterion 1' })
    await user.clear(text)
    await user.type(text, 'Paying takes a minute')
    await user.click(screen.getByRole('button', { name: 'Save criteria' }))
    expect(api.saveCriteria).toHaveBeenCalledWith('proj_1', [{ id: 'c00aa11', text: 'Paying takes a minute', target: 4.5 }], 3)
  })

  it('edits the rows (a target, a removed and an added criterion) before they are saved', async () => {
    api.saveCriteria.mockResolvedValue(BLOCK)
    renderTab()
    const user = userEvent.setup()
    const target = await screen.findByRole('spinbutton', { name: 'Target of 5 1' })
    await user.clear(target)
    await user.type(target, '4')
    await user.click(screen.getByRole('button', { name: 'Add a criterion' }))
    await user.type(screen.getByRole('textbox', { name: 'Criterion 2' }), 'Testers find the export')
    await user.click(screen.getByRole('button', { name: 'Remove criterion 1' }))
    await user.click(screen.getByRole('button', { name: 'Save criteria' }))
    expect(api.saveCriteria).toHaveBeenCalledWith('proj_1', [{ text: 'Testers find the export' }], 3)
  })

  it('reads the criteria from the PRD over saved ones only once the editor confirms', async () => {
    api.extractCriteria.mockResolvedValue(BLOCK)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    renderTab()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Read them from the PRD' }))
    expect(api.extractCriteria).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Read them from the PRD' }))
    expect(api.extractCriteria).toHaveBeenCalledWith('proj_1', true, 'en')
    confirm.mockRestore()
  })

  it('offers Create decision once a report exists, prefilled from it', async () => {
    api.get.mockResolvedValue(view({ validation: { ...BLOCK, report_document_id: 'doc_rep' } }))
    renderTab()
    const link = await screen.findByRole('link', { name: 'Create decision' })
    expect(link.getAttribute('href')).toContain('/projects/proj_1/decisions?newDecision=1')
    expect(link.getAttribute('href')).toContain('successMetric=Paying+is+quick')
  })

  it('has no Create decision before the report', async () => {
    renderTab()
    await screen.findByRole('button', { name: 'Write the report' })
    expect(screen.queryByRole('link', { name: 'Create decision' })).not.toBeInTheDocument()
  })
})

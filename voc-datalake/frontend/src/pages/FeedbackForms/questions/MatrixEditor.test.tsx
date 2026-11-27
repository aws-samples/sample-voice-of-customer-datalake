import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import type { DraftHarnessOptions } from '../test/draftHarness'
import { useDraft } from '../builder/formDraftContext'
import type { FormV2, MatrixQuestion } from '../model/formsV2'
import QuestionEditor from './QuestionEditor'
import QuestionList from './QuestionList'
import StatusLineProvider from './statusLine'

vi.mock('../../../hooks/useCategories', () => ({ useCategoriesConfig: () => ({ data: { categories: [] } }) }))

const en = (text: string) => ({ en: text })
const matrix: MatrixQuestion = {
  id: 'q_phases', type: 'matrix', headline: en('How was each phase?'), required: true, shuffle_rows: false, display: 'auto',
  rows: [{ code: 'intro', label: en('Intro') }, { code: 'lab', label: en('Lab') }],
  columns: [{ code: 'poor', label: en('Poor'), score: 1 }, { code: 'good', label: en('Good'), score: 2 }],
}

function LiveEditor() {
  const { form } = useDraft()
  const question = form.questions[0]
  return question === undefined ? null : <QuestionEditor question={question} index={0} />
}

function renderMatrix(question: MatrixQuestion = matrix, options: DraftHarnessOptions = {}) {
  return renderWithDraft(<LiveEditor />, sampleForm({ questions: [question] }), options)
}

const stored = (form: FormV2 | undefined): MatrixQuestion | undefined => {
  const question = form?.questions[0]
  return question?.type === 'matrix' ? question : undefined
}

describe('MatrixEditor', () => {
  it('lists the rows and the scored columns, with how many there may be', () => {
    renderMatrix()
    expect(screen.getByRole('textbox', { name: 'Row 2' })).toHaveValue('Lab')
    expect(screen.getByRole('textbox', { name: 'Column 1' })).toHaveValue('Poor')
    expect(screen.getByRole('spinbutton', { name: 'Score of column 2' })).toHaveValue(2)
    expect(screen.getAllByText(/^2 of (20|10)$/).map((node) => node.textContent)).toStrictEqual(['2 of 20', '2 of 10'])
  })

  it('adds a row whose code follows its label until the save, and Enter adds one below', async () => {
    const user = userEvent.setup()
    const harness = renderMatrix()
    await user.click(screen.getByRole('button', { name: 'Add row' }))
    await user.type(screen.getByRole('textbox', { name: 'Row 3' }), 'Wrap-up{Enter}')
    expect(stored(harness.probe.current?.form)?.rows.map((row) => row.code)).toStrictEqual(['intro', 'lab', 'wrap_up', 'row'])
    expect(screen.getByRole('textbox', { name: 'Row 4' })).toHaveFocus()
  })

  it('removes a column, scores one, and keeps a matrix at its two columns', async () => {
    const user = userEvent.setup()
    const harness = renderMatrix({ ...matrix, columns: [...matrix.columns, { code: 'great', label: en('Great') }] })
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Score of column 3' }), { target: { value: '3' } })
    await user.click(screen.getByRole('button', { name: 'More actions for column 1' }))
    await user.click(screen.getByRole('menuitem', { name: /^Delete/ }))
    expect(stored(harness.probe.current?.form)?.columns).toStrictEqual([{ code: 'good', label: en('Good'), score: 2 }, { code: 'great', label: en('Great'), score: 3 }])
    await user.click(screen.getByRole('button', { name: 'More actions for column 1' }))
    expect(screen.getByRole('menuitem', { name: /^Delete/ })).toHaveAttribute('aria-disabled', 'true')
  })

  it('moves a row with Alt+Shift+Arrow', () => {
    const harness = renderMatrix()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Row 1' }), { key: 'ArrowDown', altKey: true, shiftKey: true })
    expect(stored(harness.probe.current?.form)?.rows.map((row) => row.code)).toStrictEqual(['lab', 'intro'])
  })

  it('edits a code under Show codes, refusing a reserved one, and locks the codes once there are responses', async () => {
    const user = userEvent.setup()
    const harness = renderMatrix()
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    await user.click(screen.getByRole('switch', { name: /^Show codes/ }))
    const code = screen.getByRole('textbox', { name: 'Code of row 1' })
    await user.clear(code)
    await user.type(code, 'prototype')
    expect(screen.getByRole('alert')).toHaveTextContent('prototype is a reserved name; choose another.')
    await user.clear(code)
    await user.type(code, 'opening')
    await user.tab()
    expect(stored(harness.probe.current?.form)?.rows[0]?.code).toBe('opening')
  })

  it('shows locked codes on an answered form', async () => {
    const user = userEvent.setup()
    renderMatrix(matrix, { meta: { has_responses: true } })
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    await user.click(screen.getByRole('switch', { name: /^Show codes/ }))
    expect(screen.queryByRole('textbox', { name: 'Code of column 1' })).toBeNull()
    expect(screen.getByLabelText('Code of column 1')).toHaveTextContent('poor')
  })

  it('shuffles rows and changes how it shows', async () => {
    const user = userEvent.setup()
    const harness = renderMatrix()
    await user.click(screen.getByRole('switch', { name: /^Shuffle rows/ }))
    await user.click(screen.getByRole('button', { name: 'Stacked' }))
    expect(stored(harness.probe.current?.form)).toMatchObject({ shuffle_rows: true, display: 'stacked' })
    expect(screen.getByText('Always each row on its own, with its choices under it.')).toBeInTheDocument()
  })

  it('asks for every row while required, and for at least N rows once optional', async () => {
    const user = userEvent.setup()
    const harness = renderMatrix()
    expect(screen.getByText('Every row must be answered.')).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: /^Required/ }))
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Rows to answer, at least' }), { target: { value: '3' } })
    expect(stored(harness.probe.current?.form)?.min_rows).toBe(3)
    expect(screen.getByText('Rows to answer must be from 1 to the number of rows (2).')).toBeInTheDocument()
  })
})

describe('adding a matrix', () => {
  it('gives it a scale in the form\'s language, scored 1 to 4, and rows whose codes follow their labels', async () => {
    const user = userEvent.setup()
    const harness = renderWithDraft(<StatusLineProvider><QuestionList selected={null} onSelect={vi.fn()} /></StatusLineProvider>, sampleForm())
    await user.click(screen.getByRole('button', { name: 'Add question' }))
    await user.click(screen.getByRole('menuitem', { name: /^Matrix/ }))
    const added = harness.probe.current?.form.questions.at(-1)
    expect(added?.type === 'matrix' ? added.columns : []).toStrictEqual([
      { code: 'poor', label: en('Poor'), score: 1 }, { code: 'fair', label: en('Fair'), score: 2 },
      { code: 'good', label: en('Good'), score: 3 }, { code: 'excellent', label: en('Excellent'), score: 4 },
    ])
    expect(harness.probe.current?.freshCodes).toStrictEqual(new Set(['q_matrix:rows:row', 'q_matrix:rows:row_2']))
  })
})

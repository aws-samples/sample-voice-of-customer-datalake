/**
 * A step's assertions (7.52.00 C2, N4): while building, each stored one edited from the vocabulary (a role's select, a
 * number kept in its bounds, its on_fail among the ones its place allows), removed, or one more added from the checks
 * the kind is checked on (the chosen one, with its first values), at most the vocabulary's max; outside building, a
 * list with each one's arguments, its on_fail and, in a run, what the board recorded. An unreadable stored entry is
 * left out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { VOCABULARY, setUpInspector } from '../flowInspector-fixtures'
import { AssertionsField } from './AssertionsField'
import type { AssertionsFieldProps } from './AssertionsField'
import type { StepAssertion } from './assertions'
import type { FlowMode } from '../nodes/nodeData'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))
vi.mock('../../../runtimeConfig', (importOriginal) =>
  import('@test/engineeringModule').then((m) => m.runtimeConfigModule(importOriginal)))

const TASKS = {
  check: 'tasks.posted', asks: 'at least min tasks were posted for the role', label_key: '', description_key: '',
  args: [{ name: 'role', type: 'role', minimum: null, maximum: null }, { name: 'min', type: 'number', minimum: 1, maximum: 5 }],
  kinds: ['agent'], on_fail: ['block', 'warn'],
}
const GATE_ONLY = { ...TASKS, check: 'gate.passed', asks: 'the gate passed', args: [], kinds: ['quality_gate'], on_fail: ['block'] }
const CHECKS = [...VOCABULARY.checks, TASKS, GATE_ONLY]
/** What the step stores: the tasks check on coordinators at 2, warning, and an entry that is not one. */
const STORED: unknown = [{ check: 'tasks.posted', args: { role: 'coordinator', min: 2 }, on_fail: 'warn' }, { args: {} }, 'patch.submitted']

beforeEach(() => {
  setUpInspector({ 'GET /agents/engineering/assertions': () => ({ ...VOCABULARY, checks: CHECKS, roles: ['coordinator', 'fixer'], max: 2 }) })
})

function field(mode: FlowMode, props: Partial<AssertionsFieldProps> = {}) {
  const onChange = vi.fn<(next: StepAssertion[]) => void>()
  renderWithQueryClient(<AssertionsField place="agent" value={STORED} mode={mode} onChange={onChange} {...props} />)
  return { onChange, user: userEvent.setup() }
}

const TASKS_LABEL = 'At least min tasks were posted for the role'
const STORED_TASKS = { check: 'tasks.posted', args: { role: 'coordinator', min: 2 }, on_fail: 'warn' }

describe('building', () => {
  it('edits a stored assertion\'s role, number (kept in its bounds) and on_fail', async () => {
    const { onChange, user } = field('build')
    await user.selectOptions(await screen.findByLabelText('role'), 'fixer')
    await user.type(screen.getByLabelText('min'), '9')
    await user.selectOptions(screen.getByLabelText(`${TASKS_LABEL}: when it fails`), 'block')
    expect(onChange.mock.calls.map(([next]) => next)).toStrictEqual([
      [{ ...STORED_TASKS, args: { role: 'fixer', min: 2 } }], [{ ...STORED_TASKS, args: { role: 'coordinator', min: 5 } }],
      [{ ...STORED_TASKS, on_fail: 'block' }],
    ])
  })

  it('adds the check chosen, with its first values, from the ones the kind is checked on', async () => {
    const { onChange, user } = field('build', { value: [] })
    expect(await screen.findByText('No assertions. Add one to check what this step recorded.')).toBeInTheDocument()
    const add = within(screen.getByRole('group', { name: 'Add an assertion' }))
    expect(add.getAllByRole('option').map((option) => option.textContent)).toStrictEqual(['Choose a check', 'A patch was submitted', TASKS_LABEL])
    await user.selectOptions(add.getByLabelText('Check'), 'tasks.posted')
    await user.click(add.getByRole('button', { name: 'Add an assertion' }))
    expect(onChange).toHaveBeenLastCalledWith([{ check: 'tasks.posted', args: { role: 'coordinator', min: 1 }, on_fail: 'block' }])
  })

  it('removes a stored one, and offers no more past the vocabulary\'s max', async () => {
    const { onChange, user } = field('build', { value: [STORED_TASKS, { check: 'patch.submitted' }] })
    expect(await screen.findByText('At most 2 assertions.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: `Remove ${TASKS_LABEL}` }))
    expect(onChange).toHaveBeenLastCalledWith([{ check: 'patch.submitted' }])
  })

  it('says when no check applies to the kind', async () => {
    field('build', { place: 'map', value: [] })
    expect(await screen.findByText('No check applies to this kind of step.')).toBeInTheDocument()
  })
})

describe('outside building', () => {
  it('lists each with its arguments and on_fail, and what the board recorded in a run', async () => {
    field('run', {
      value: [STORED_TASKS, { check: 'patch.submitted' }],
      results: [{ step: 'fix', check: 'tasks.posted', on_fail: 'warn', status: 'fail', attempt: 1, detail: '', at: null }],
    })
    const row = (await screen.findByText(TASKS_LABEL)).closest('li')
    expect(row).toHaveTextContent('Fail')
    expect(row).toHaveTextContent('role: coordinator · min: 2')
    expect(screen.getByText('A patch was submitted').closest('li')).toHaveTextContent('blocks')
  })

  it('says a step has none', () => {
    field('view', { value: undefined })
    expect(screen.getByText('No assertions.')).toBeInTheDocument()
  })
})

/**
 * @fileoverview The inspector per kind (7.52.00 C2; docs/ux part 5 §5.4): "In this flow" is edited only while building
 * (text otherwise, never disabled inputs), "From the card" is always read only, a gate shows its packs and edits its
 * reviewers, a call names the flow it calls and its inputs, Start's settings and a decision say what happens, an
 * arrow reads "Always" where its source reports no verdict, a step's assertions are edited from the vocabulary, and
 * a run's step shows its agents.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { changedStep, inspect, setUpInspector } from './flowInspector-fixtures'
import type { InspectorRun } from './inspector/inspectorParts'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))
vi.mock('../../runtimeConfig', (importOriginal) =>
  import('@test/engineeringModule').then((m) => m.runtimeConfigModule(importOriginal)))

beforeEach(() => { setUpInspector() })

const inFlow = () => screen.getByRole('region', { name: 'In this flow' })

describe('an agent', () => {
  it('edits its own fields while building, and reads its card, read only', async () => {
    inspect({ kind: 'step', id: 'fix' })
    expect(within(inFlow()).getByLabelText('Title')).toHaveValue('Fix the bug')
    const card = screen.getByRole('region', { name: 'From the card' })
    expect(await within(card).findByText('Smallest fix for one confirmed bug.')).toBeInTheDocument()
    expect(within(card).queryAllByRole('textbox')).toStrictEqual([])
  })

  it('reads its own fields as text when viewed, saying it is read only', () => {
    inspect({ kind: 'step', id: 'fix' }, 'view')
    expect(screen.getByText('Read only.')).toBeInTheDocument()
    expect(within(inFlow()).queryAllByRole('textbox')).toStrictEqual([])
    expect(within(inFlow()).getByText('Fix the bug')).toBeInTheDocument()
  })

  it('adds an assertion from the vocabulary, with its default on_fail', async () => {
    const onChange = inspect({ kind: 'step', id: 'fix' })
    await userEvent.click(screen.getByRole('tab', { name: 'Assertions' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Add an assertion' }))
    expect(changedStep(onChange, 'fix')?.data.params?.assert).toStrictEqual([{ check: 'patch.submitted', on_fail: 'block' }])
  })

  it('shows a run\'s agents on the step, from the run workspace', () => {
    const run: InspectorRun = { revision: 4, states: new Map(), agentsOf: () => <p>fixer-1 is at work</p> }
    inspect({ kind: 'step', id: 'fix' }, 'run', run)
    expect(screen.getByText('As this run used it · r4')).toBeInTheDocument()
    expect(screen.getByText('fixer-1 is at work')).toBeInTheDocument()
  })
})

describe('a gate', () => {
  it('names who runs it and where GO and NO-GO go, and edits its reviewers', async () => {
    const onChange = inspect({ kind: 'step', id: 'gate' })
    expect(await screen.findByText('GO → Pull request · NO-GO → A person decides')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('first-principles: blocks or advisory'), 'blocks')
    expect(changedStep(onChange, 'gate')?.data.params?.reviewers).toStrictEqual([{ name: 'security' }, { name: 'quality' }, { name: 'first-principles', advisory: false }])
  })

  it('shows its packs read only: their steps in words and the repository\'s own pins', async () => {
    inspect({ kind: 'step', id: 'gate' })
    await userEvent.click(screen.getByRole('tab', { name: 'Packs' }))
    expect(await screen.findByText(': if ruff.toml is there')).toBeInTheDocument()
    expect(screen.getByText('The repository\'s own pins.')).toBeInTheDocument()
  })
})

describe('a call, a decision, the trigger and an arrow', () => {
  it('names the flow a call calls at its revision, and the inputs that flow declares', async () => {
    inspect({ kind: 'step', id: 'triage' })
    expect(await screen.findByLabelText('issue (required)')).toBeInTheDocument()
    expect(await screen.findByRole('option', { name: 'Issue triage' })).toBeInTheDocument()
  })

  it('says what a decision does, edits only its title, and Start\'s pull request state', () => {
    inspect({ kind: 'step', id: 'human' })
    expect(screen.getByText('Learn reads it after 48 h')).toBeInTheDocument()
    expect(within(inFlow()).getByLabelText('Title')).toHaveValue('A person decides')
  })

  it('edits Start\'s settings: the pull request opens as a draft', () => {
    inspect({ kind: 'step', id: 'start' })
    expect(screen.getByLabelText('Pull request')).toHaveValue('draft')
  })

  it('reads an arrow out of a step without a verdict as always taken, outside building', () => {
    inspect({ kind: 'edge', id: 'e2' }, 'view')
    expect(screen.getByText('Always: this step reports no verdict')).toBeInTheDocument()
  })
})

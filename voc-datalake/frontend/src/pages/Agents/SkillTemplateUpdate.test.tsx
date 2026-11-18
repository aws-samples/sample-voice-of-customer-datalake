/**
 * @fileoverview Agents → Skills, "Template updated" (7.50.00; 7.52.00 on the shared document component): a role whose
 * history names a bundled template newer than its versions (`template: {version, label, newer}`) says **Update
 * available (vN)** in `badge-info` on its panel; the panel compares the template with the version in use once asked
 * (the instructions as the document reads, what else changes listed), then **Propose vN from the template**, which
 * makes it a version the administrator proposed (never accepted by itself) and opens it for review. A role whose
 * template is not newer, or a history that names none, says nothing of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { parseHistory, parseTemplateUpdate } from '../../api/engineeringSkillsApi'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { EngineeringSkills } = await import('./EngineeringSkills')

const ROLES = 'GET /agents/engineering/skills?connection='
const HISTORY = 'GET /agents/engineering/skills/fixer/versions?connection='
const LATEST = { version: 3, status: 'accepted', summary: 'One more example', proposed_at: '2026-11-10T09:00:00Z' }
const FIXER = { role: 'fixer', current_version: 3, versions: 3, latest: LATEST }
const NEWER = { version: 2, label: 'fixer@template-2', newer: true }
const history = (template: unknown) => ({ connection: '', role: 'fixer', current_version: 3, versions: [], next_page: null, template })
const NO_DIFF = { instructions: [], examples: [], tools_added: [], tools_removed: [], tools_reordered: false, model: null,
  harness: null, first: false }
const UPDATE = {
  connection: '', role: 'fixer', template: NEWER, current_version: 3,
  record: { instructions: 'Read the issue first.', examples: [], tool_policy: ['read_issue'], model: 'm', harness: 'converse' },
  diff: { ...NO_DIFF, instructions: [['+', 'Read the issue with read_issue first.']], tools_added: ['read_issue'] },
}
const CURRENT = { connection: '', role: 'fixer', version: {
  version: 3, status: 'accepted', summary: 'One more example', why: { run_id: '', failure: '', comment: '' }, proposed_by: 'alice',
  proposed_by_kind: 'person', proposed_at: '2026-11-10T09:00:00Z', base: null, benchmark: { claimed: null, measured: null },
  events: [], made_with: null, record: { instructions: 'Plan the smallest fix.', examples: [], tool_policy: [], model: 'm', harness: 'converse' },
  diff: { instructions: [], examples: [], tools_added: [], tools_removed: [], tools_reordered: false, model: null, harness: null, first: true },
} }
const ADOPTED = {
  version: 4, status: 'proposed', summary: 'Adopted the repository’s template v2', proposed_by: 'alice',
  proposed_by_kind: 'person', proposed_at: '2026-11-16T12:00:00Z',
}

function route(routes: Record<string, RouteHandler>) {
  routeFetchApi({
    'GET /agents/engineering/connections': () => ({ connections: [], limit: 20 }),
    [ROLES]: () => ({ connection: '', roles: [FIXER] }),
    ...routes,
  }, { missStatus: 500 })
}

function Where() {
  const location = useLocation()
  return <p data-testid="where">{location.pathname}</p>
}

function renderSkills(entry = '/agents/skills/fixer') {
  return renderWithQueryClient(
    <TestRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/agents/skills/*" element={<><EngineeringSkills /><Where /></>} />
      </Routes>
    </TestRouter>,
  )
}

beforeEach(() => { resetFetchApi() })

/** The Skills page rendered; its "Template updated" panel opened on what it changes, and its Propose pressed. */
async function proposeTheTemplate() {
  renderSkills()
  const panel = await screen.findByRole('region', { name: 'Template updated' })
  await userEvent.click(within(panel).getByRole('button', { name: 'Show what it changes' }))
  await userEvent.click(await within(panel).findByRole('button', { name: 'Propose v2 from the template' }))
  return panel
}

describe('the wire shape', () => {
  it('reads the template a history names, and none from one that names none or one it cannot read', () => {
    expect([parseHistory(history(NEWER)).template, parseHistory(history(undefined)).template, parseHistory(history('v2')).template])
      .toStrictEqual([NEWER, null, null])
  })

  it('reads a template\'s diff strictly', () => {
    expect(parseTemplateUpdate(UPDATE).diff.tools_added).toStrictEqual(['read_issue'])
    expect(() => parseTemplateUpdate({ template: NEWER })).toThrow('The skill template answer was unreadable')
  })
})

describe('Template updated', () => {
  const ADOPTABLE = {
    [HISTORY]: () => history(NEWER),
    'GET /agents/engineering/skills/fixer/template?connection=': () => UPDATE,
    'GET /agents/engineering/skills/fixer/versions/3?connection=': () => CURRENT,
    'POST /agents/engineering/skills/fixer/template/adopt?connection=': () => ({ connection: '', role: 'fixer', version: ADOPTED }),
  }

  /** The role's panel with the template's diff shown. */
  async function shownDiff(): Promise<HTMLElement> {
    route(ADOPTABLE)
    renderSkills()
    const panel = await screen.findByRole('region', { name: 'Template updated' })
    await userEvent.click(within(panel).getByRole('button', { name: 'Show what it changes' }))
    await within(panel).findByText('Template v2 against the current version v3')
    return panel
  }

  it('badges the role\'s panel as an update (badge-info), reading the template only once its compare is asked for', async () => {
    route(ADOPTABLE)
    renderSkills()
    const panel = await screen.findByRole('region', { name: 'Template updated' })
    expect(within(panel).getByText('Update available (v2)')).toHaveClass('badge', 'badge-info')
    expect(within(panel).queryByRole('button', { name: 'Propose v2 from the template' })).toBeNull()
    expect(fetchApi.mock.calls.some(([path]) => path.includes('/template'))).toBe(false)
  })

  it('compares the template with the version in use as the document reads, and lists what else it changes', async () => {
    const panel = await shownDiff()
    expect(await within(panel).findByText('Read the issue first.')).toBeInTheDocument()
    expect(within(panel).getByText('read_issue').closest('li')).toHaveTextContent('Added: read_issue')
    expect(within(panel).getByRole('button', { name: 'Propose v2 from the template' })).toBeEnabled()
  })

  it('proposes it from what the screen showed, and opens the proposal for review', async () => {
    route({ ...ADOPTABLE, 'GET /agents/engineering/skills/fixer/versions/4?connection=': () => ({ ...CURRENT,
      version: { ...CURRENT.version, version: 4, status: 'proposed', base: { shared: true, version: 3 } } }) })
    const panel = await proposeTheTemplate()
    expect(await within(panel).findByRole('status')).toHaveTextContent('The template is proposed as version 4')
    expect(sentFetchApiBody('/agents/engineering/skills/fixer/template/adopt?connection=', 'POST'))
      .toStrictEqual({ expected_current: 3, template_version: 2 })
    await userEvent.click(within(panel).getByRole('button', { name: 'Open the proposal' }))
    expect(await screen.findByRole('dialog', { name: 'Fixer · v4' })).toBeInTheDocument()
  })

  it('shows the server\'s refusal of an adoption', async () => {
    route({
      ...ADOPTABLE,
      'POST /agents/engineering/skills/fixer/template/adopt?connection=': () => {
        throw new Error('it changed since you opened it: the current version moved; read it again')
      },
    })
    const panel = await proposeTheTemplate()
    expect(await within(panel).findByRole('alert')).toHaveTextContent("The template couldn't be adopted.")
  })

  it.each([
    ['not newer', { ...NEWER, newer: false }],
    ['none', null],
  ])('says nothing of a template %s', async (_name, template) => {
    route({ [HISTORY]: () => history(template) })
    renderSkills()
    expect(await screen.findByText('Fixer · Shared skills')).toBeInTheDocument()
    await waitFor(() => { expect(fetchApi).toHaveBeenCalledWith('/agents/engineering/skills/fixer/versions?connection=', undefined) })
    expect(screen.queryByRole('region', { name: 'Template updated' })).toBeNull()
  })
})

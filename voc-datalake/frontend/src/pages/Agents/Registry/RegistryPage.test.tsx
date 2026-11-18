/**
 * @fileoverview Agents → Registry (7.52.00): the cards for a scope (roles first, then the ones made from a skill, an
 * empty state with Create from a skill), the **Quality gates** filter as a path (`/agents/registry/gates`) with each
 * pack's steps, tools (the versions a connection's gate record holds) and the owner's brief read only when opened
 * (gap N) on the panel variant with Open full page, a brief's own page, a card's page with its facts and its source
 * (gap S), and Create from a skill with its validation errors by field and the server's refusal in its words.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { ApiError } from '../../../lib/errors'
import Where from '@test/LocationWhere'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../../store/authStore', (importOriginal) =>
  import('@test/fetchApiRoutes').then((m) => m.authStoreWithOriginal(importOriginal)))
vi.mock('../../../runtimeConfig', (importOriginal) =>
  import('@test/engineeringModule').then((m) => m.runtimeConfigModule(importOriginal)))

const { default: RegistryPage } = await import('./RegistryPage')
const { engineeringModule } = await import('@test/engineeringModule')

const SKILL = { source: 'store', label: 'fixer@shared/3', connection: '', version: 3, status: 'accepted', provenance: 'person',
  template_version: 1, template_newer: true }
const FIXER = {
  kind: 'role', id: 'fixer', base_role: 'fixer', title: 'fixer', purpose: 'Smallest fix for one confirmed bug.', launchable: true,
  template: { version: 3, label: 'fixer@template-3', digest: 'sha256:f' }, skill: SKILL, model: 'model-s', tools: ['read_file', 'run'],
  harness: 'converse', caps: { max_turns: 150 }, inputs: [{ name: 'bug', from: 'hunter.post_subtask', required: true }],
  outputs: [{ name: 'patch', kind: 'submitted_patch', recorded_on: 'task' }], gates: null, scorecard: null,
  spend: { month: '2026-11', usd: 3.2, tokens_in: 0, tokens_out: 0, microvm_seconds: 0 },
}
const PACK = {
  id: 'python', name: 'Python', languages: ['python'], image: { python: '3.12' }, network: ['pypi.org'],
  tools: [{ name: 'ruff', version_argv: ['ruff', '--version'] }],
  steps: [{ id: 'py.ruff', language: 'python', name: 'ruff check', kind: 'lint', argv: ['ruff', 'check'], timeout_s: 600,
    when_any: [{ file: 'pyproject.toml' }], empty_exit_codes: [], expect_output: '', messages: [], looked_at_nothing: null }],
  briefs: ['python-ts'], recorded: { tool_versions: { ruff: '0.7.2' }, run_id: 'RUN1', at: '2026-11-16T09:00:00Z' },
}
const GATES = {
  packs: [PACK], briefs: [{ id: 'python-ts', path: 'gates/briefs/python-ts.md', packs: ['python', 'typescript'], digest: 'sha256:b', bytes: 45_627 }],
  own_gate: { file: 'scripts/validate.sh', argv: ['bash', 'scripts/validate.sh'], timeout_s: 7200 }, runners: ['final-go', 'gate-runner'],
  defaults: { runner: 'gate-runner@latest', final_go: 'final-go@latest' },
  stops: [{ code: 'review_blocked', decision: 'no_fail_path', actions: [], text_key: 'gates.stops.review_blocked', text: 'A review blocked it' }],
  connection: 'storefront',
}
const BRIEF = { ...GATES.briefs[0], text: '## Python\n\nInstall with uv.\n\n## TypeScript\n\nUse pnpm.\n\n## Both\n\nPin them.\n' }
const BRIEF_READ = 'GET /agents/engineering/gates/briefs/python-ts'

function route(routes: Record<string, RouteHandler> = {}) {
  routeFetchApi({
    'GET /agents/engineering/connections': () => ({ connections: [], limit: 20 }),
    'GET /agents/engineering/registry': () => ({ month: '2026-11', connection: '', cards: [FIXER] }),
    'GET /agents/engineering/gates?connection=storefront': () => GATES,
    [BRIEF_READ]: () => BRIEF,
    ...routes,
  }, { missStatus: 500 })
}

function renderRegistry(entry = '/agents/registry') {
  return renderWithQueryClient(
    <TestRouter initialEntries={[entry]}>
      <Routes><Route path="/agents/registry/*" element={<><RegistryPage /><Where /></>} /></Routes>
    </TestRouter>,
  )
}

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
  engineeringModule.available = true
})

describe('Agents → Registry: the cards', () => {
  it('lists the roles\' cards with what each runs, a newer template in badge-info, and an empty state for the made ones', async () => {
    route()
    renderRegistry()
    const roles = await screen.findByRole('region', { name: 'Roles' })
    expect(within(roles).getByRole('link', { name: 'Open Fixer' })).toHaveAttribute('href', '/agents/registry/fixer')
    expect(within(roles).getByText('Update available (v3)')).toHaveClass('badge', 'badge-info')
    expect(within(screen.getByRole('region', { name: 'Made from a skill' })).getByText('No agent cards yet.')).toBeInTheDocument()
  })

  it('says it is for administrators where the engineering agents are on', () => {
    adminFlag.isAdmin = false
    route()
    renderRegistry()
    expect(screen.getByText('The Registry is for administrators, where the engineering agents are on.')).toBeInTheDocument()
  })
})

describe('Agents → Registry: the Quality gates filter', () => {
  it('is a path of its own, and keeps the scope in the query', async () => {
    route()
    renderRegistry('/agents/registry?connection=storefront')
    await userEvent.click(await screen.findByRole('button', { name: 'Quality gates' }))
    await waitFor(() => { expect(screen.getByTestId('where')).toHaveTextContent('/agents/registry/gates?connection=storefront') })
    expect(screen.getByRole('button', { name: 'Quality gates' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows each pack\'s steps, when each applies, and the tools\' recorded versions; the stops in words', async () => {
    route()
    renderRegistry('/agents/registry/gates?connection=storefront')
    const steps = await screen.findByRole('region', { name: 'Steps of Python' })
    expect(within(steps).getByText('ruff check')).toBeInTheDocument()
    expect(within(steps).getByText('if the repository has pyproject.toml')).toBeInTheDocument()
    expect([screen.getByText(/Last recorded: ruff 0\.7\.2/), screen.getByText('A review blocked it: the final go said NO-GO.')])
      .toHaveLength(2)
  })

  it('reads the owner\'s brief only when it is opened, on the panel with Open full page (gap N)', async () => {
    route()
    renderRegistry('/agents/registry/gates?connection=storefront')
    const toggle = await screen.findByRole('button', { name: 'The owner\'s brief · python-ts.md · 45 KB' })
    expect(fetchApi.mock.calls.some(([path]) => path.includes('/gates/briefs/'))).toBe(false)
    await userEvent.click(toggle)
    const panel = await screen.findByRole('region', { name: 'python-ts.md' })
    expect(await within(panel).findByRole('heading', { name: 'Python' })).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: /Open full page/ })).toHaveAttribute('href', '/agents/registry/gates/briefs/python-ts')
  })

  it('opens a brief on a page of its own, read only as the template\'s, with its Contents', async () => {
    route()
    renderRegistry('/agents/registry/gates/briefs/python-ts')
    expect(await screen.findByRole('navigation', { name: 'Contents' })).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('From the template. It changes with a release, in templates/orchestration.')
  })
})

describe('Agents → Registry: a card', () => {
  it('shows its facts as a definition list, its skill version linking to Skills, and its source (gap S)', async () => {
    route({
      'GET /agents/engineering/registry/fixer': () => ({ card: FIXER, versions: [], events: [] }),
      'GET /agents/engineering/templates/skill/fixer/source': () => ({ kind: 'skill', id: 'fixer', path: 'agents/fixer/SKILL.md',
        text: '---\nname: fixer\n---\n## Role\n\nFix one bug.\n', digest: 'sha256:s', template_version: 3 }),
    })
    renderRegistry('/agents/registry/fixer')
    expect(await screen.findByRole('link', { name: 'Open the skill version' })).toHaveAttribute('href', '/agents/skills/fixer/versions/3')
    expect(screen.getByText('bug (from hunter.post_subtask, required)')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Role' })).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Properties' })).getByText('fixer')).toBeInTheDocument()
  })
})

describe('Agents → Registry: Create from a skill', () => {
  const VERSIONS = 'GET /agents/engineering/skills/fixer/versions?connection='
  const accepted = { version: 3, status: 'accepted', summary: 'One more example', proposed_by: 'alice', proposed_by_kind: 'person',
    proposed_at: '2026-11-10T09:00:00Z' }

  async function openForm(routes: Record<string, RouteHandler> = {}) {
    route({ [VERSIONS]: () => ({ current_version: 3, versions: [accepted], next_page: null }), ...routes })
    renderRegistry()
    await userEvent.click(await screen.findByRole('button', { name: 'Create from a skill' }))
    return screen.findByRole('dialog', { name: 'Create an agent card from a skill' })
  }

  it('says what to fix by field before anything is sent', async () => {
    const sheet = await openForm()
    await userEvent.type(within(sheet).getByLabelText('Slug'), 'Not OK')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Create card' }))
    expect(within(sheet).getByText('Pick an accepted skill version.')).toBeInTheDocument()
    expect(within(sheet).getByLabelText('Slug')).toHaveAccessibleDescription(/Use 1 to 40 lowercase letters, digits and dashes/)
    expect(within(sheet).getByText('Say what the card is for.')).toBeInTheDocument()
    expect(fetchApi).not.toHaveBeenCalledWith('/agents/engineering/registry/cards', expect.anything())
  })

  it('makes the card from an accepted version, and opens its page', async () => {
    const created = { ...FIXER, kind: 'card', id: 'fixer-careful', version: 1, title: 'fixer-careful' }
    const sheet = await openForm({ 'POST /agents/engineering/registry/cards': () => ({ card: created }) })
    await userEvent.selectOptions(await within(sheet).findByLabelText('Skill version'), 'v3 · One more example')
    await userEvent.type(within(sheet).getByLabelText('Slug'), 'careful')
    await userEvent.type(within(sheet).getByLabelText('Purpose'), 'The fixer, held to fewer turns.')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Create card' }))
    await waitFor(() => { expect(screen.getByTestId('where')).toHaveTextContent('/agents/registry/fixer-careful') })
    expect(sentFetchApiBody('/agents/engineering/registry/cards', 'POST')).toStrictEqual({
      from_skill: { role: 'fixer', version: 3 }, slug: 'careful', purpose: 'The fixer, held to fewer turns.' })
  })

  it('says the server\'s refusal in its words, the form kept', async () => {
    const sheet = await openForm({ 'POST /agents/engineering/registry/cards': () => {
      throw new ApiError(409, 'a card with that id exists: name the version you read (expected_version) to make its next version, or pick another slug')
    } })
    await userEvent.selectOptions(await within(sheet).findByLabelText('Skill version'), 'v3 · One more example')
    await userEvent.type(within(sheet).getByLabelText('Slug'), 'careful')
    await userEvent.type(within(sheet).getByLabelText('Purpose'), 'Again.')
    await userEvent.click(within(sheet).getByRole('button', { name: 'Create card' }))
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('The card was not made: a card with that id exists')
    expect(within(sheet).getByLabelText('Slug')).toHaveValue('careful')
  })
})

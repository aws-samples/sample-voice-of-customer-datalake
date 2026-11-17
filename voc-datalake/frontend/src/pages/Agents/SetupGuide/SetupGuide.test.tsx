/**
 * @fileoverview The setup guide (7.50.00): the steps in the recommended order with where each stands, the step the
 * guide recommends at `/agents/setup`, Skip for now on any step (saved from the revision read, moving on to the next
 * step still open) with what skipping costs, Understand and Tenets arriving in 7.52, an automation's step with its
 * control and readiness, Ready to go, and the Agents list's first-visit offer. Administrators only, where the
 * engineering agents are on. 7.50.01: the deployment's own facts apart from each automation's readiness ("once set
 * up"), asked of the deployment's only connection while the automation names none. 7.50.02: step 0 is Connect GitHub
 * and Confirm CI, and the GitHub Issues source and its label are automatic ticks read from the source as the
 * connections drive it (`GET /agents/engineering/issues-source`, no workspace header).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { workflowView } from '@test/workflowFixtures'
import { findEngineeringTemplate } from '../../../api/engineeringTemplates'
import { SETUP_STEP_IDS } from '../../../api/engineeringSetupApi'
import { ApiError } from '../../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'

/** Whether the mocked caller is a platform admin (the deployment's Data sources link). */
const platform = vi.hoisted(() => ({ admin: false }))

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../../store/authStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../store/authStore')>()),
  ...(await import('@test/fetchApiRoutes')).authStoreModule(),
  useIsPlatformAdmin: () => platform.admin,
}))
vi.mock('../../../runtimeConfig', (importOriginal) =>
  import('@test/engineeringModule').then((m) => m.runtimeConfigModule(importOriginal)))

const { default: SetupGuide } = await import('./SetupGuide')
const { SetupPrompt } = await import('./SetupGuideEntry')
const { useOffersSetupPrompt } = await import('./useSetupGuide')

/** The Automations list's Engineering group's prompt, as it reads its offer (no automation yet). */
function SetupIntro() {
  return <SetupPrompt progress={useOffersSetupPrompt([])} />
}
const { engineeringModule } = await import('@test/engineeringModule')

const NOTHING = Object.fromEntries(SETUP_STEP_IDS.map((step) => [step, 'pending']))
const progress = (steps: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
  steps: { ...NOTHING, ...steps }, intro: 'unseen', revision: 2, updated_at: null, updated_by: null, ...extra,
})

const engineering = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  agent_id: id, name, description: '', enabled: false, status: 'active', workflow_id: 'wf_1',
  triggers: [{ kind: 'github_issue', label: 'voc-agent', trusted_authors: false, lookback_days: 7 }],
  engineering: { connection: 'storefront', language: 'python', feedback_type: 'bug' }, ...extra,
})
const TRIAGE = engineering('ag_17a9e5c3b2d0', 'Issue triage')
const BUG_FIXER = engineering('ag_b0f1e2d3c4a5', 'Bug fixer')
const CONNECTION = {
  connection_id: 'storefront', host: 'github', repository: 'example-org/storefront', default_branch: 'main',
  credential: { kind: 'app_reference', set: true, app_id: '1', installation_id: '2', expires_at: null }, version: 1,
  ci_attestation: null,
}
const APP = { app_id: '1', slug: 'voc-autonomous-agent', owner: 'example-org', owner_type: 'Organization',
  html_url: 'https://github.com/apps/voc-autonomous-agent', webhook: true, connections: ['storefront'], version: 1 }
/** The GitHub Issues source as the connections drive it (7.50.02): storefront read, its label created. */
const issuesView = (entry: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  deployed: true, signs_in: 'app', app_id: '1', repositories: ['example-org/storefront'], managed: ['example-org/storefront'],
  schedule: 'on', label: 'voc-agent',
  connections: [{ connection_id: 'storefront', repository: 'example-org/storefront', read: true, reading: true, reason: null,
    label: 'created', ...entry }],
  ...extra,
})
const ISSUES_SOURCE = 'GET /agents/engineering/issues-source'

/** What a run truly needs (the server's required checks, item B of 7.50.00): the other checks are advice. */
const REQUIRED = new Set(['connection', 'ci_attestation', 'image', 'bedrock_models', 'budget', 'dial'])
const check = (id: string, status: string) => ({
  id, status, detail: `${id} detail`, fix: `${id} fix`, docs: '', required: REQUIRED.has(id),
})

function routes(extra: Record<string, RouteHandler> = {}, agents: unknown[] = [TRIAGE, BUG_FIXER]): void {
  const template = findEngineeringTemplate('bug-hunt-and-fix')
  if (template === undefined) throw new Error('no bug-hunt-and-fix template')
  routeFetchApi({
    'GET /agents': () => ({ items: agents }),
    'GET /agents/engineering/connections': () => ({ connections: [CONNECTION], limit: 20 }),
    'GET /agents/engineering/github-apps': () => ({ apps: [APP], limit: 5 }),
    'GET /agents/engineering/setup': () => progress(),
    [ISSUES_SOURCE]: () => issuesView(),
    'GET /workflows': () => ({ items: [{ workflow_id: 'wf_1', name: 'Bug flow', revision: 1, kind: 'engineering', monthly_budget_usd: 50 }] }),
    'GET /workflows/wf_1': () => workflowView(1, { ...template.definition, budget: { monthly_usd: 50 } },
      { kind: 'engineering', monthly_budget_usd: 50 }),
    'GET /agents/engineering/readiness?automation=ag_17a9e5c3b2d0': () => ({
      checks: [check('ci_attestation', 'fail'), check('issues_source', 'pass'), check('dial', 'pass')] }),
    'GET /agents/engineering/readiness?automation=ag_b0f1e2d3c4a5': () => ({
      checks: [check('ci_attestation', 'fail'), check('issue_label', 'warn')] }),
    ...extra,
  }, { missStatus: 500 })
}

function Where() {
  const location = useLocation()
  return <p data-testid="where">{location.pathname}</p>
}

function renderGuide(entry = '/agents/setup') {
  return renderWithQueryClient(
    <TestRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/agents/setup/*" element={<><SetupGuide /><Where /></>} />
        <Route path="/agents" element={<p>Agents list</p>} />
      </Routes>
    </TestRouter>,
  )
}

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
  platform.admin = false
  engineeringModule.available = true
})

describe('the guide', () => {
  it('lists the steps in the recommended order and opens the one it recommends', async () => {
    routes()
    renderGuide()
    const nav = await screen.findByRole('navigation', { name: 'Setup steps' })
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toStrictEqual([
      '0. PrerequisitesTo do', '1. Understand the repositoryArrives in 7.52', '2. TenetsArrives in 7.52',
      '3. Issue triageTo do', '4. Bug fixerTo do', '5. Feature builderTo do', '6. Ready to goTo do',
    ])
    // (the CI is not attested: the prerequisites come first)
    expect(await screen.findByTestId('setup-step')).toHaveAttribute('data-step', 'prerequisites')
    expect(within(nav).getByRole('link', { name: /Prerequisites/ })).toHaveAttribute('aria-current', 'step')
  })

  /** The prerequisites step once the automations' readiness is in (the source and its label are known from it). */
  async function prerequisites(extra: Record<string, RouteHandler> = {}, agents?: unknown[], connections?: unknown[]): Promise<HTMLElement> {
    routes({
      ...(connections === undefined ? {} : { 'GET /agents/engineering/connections': () => ({ connections, limit: 20 }) }),
      ...extra,
    }, agents)
    renderGuide('/agents/setup/prerequisites')
    const step = await screen.findByTestId('setup-step')
    await within(step).findByTestId('setup-readiness-bug_fixer')
    return step
  }

  /** The badges of the deployment's facts: GitHub connected, the CI attested, the issues read and the label (automatic). */
  const badges = (step: HTMLElement) => within(within(step).getByRole('list', { name: 'Prerequisites' })).getAllByRole('listitem')
    .map((item) => item.querySelector('.badge')?.textContent)

  it('shows where each prerequisite stands, with the page that sets it', async () => {
    const step = await prerequisites()
    await waitFor(() => { expect(badges(step)).toStrictEqual(['Done', 'To do', 'Done', 'Done']) })
    // (the deployment's own facts, under their own heading)
    expect([within(step).getByRole('heading', { name: 'This deployment' }), within(step).getByText('Connected through an App: storefront.')])
      .toHaveLength(2)
    expect(within(step).getAllByRole('link', { name: 'Open Connections' })[0]).toHaveAttribute('href', '/agents/connections')
  })

  it('ticks the issues and the label automatically from the connections, read without a workspace header (7.50.02)', async () => {
    const step = await prerequisites()
    const list = within(step).getByRole('list', { name: 'Prerequisites' })
    expect(await within(list).findByText('Issues: read automatically from 1 repository.')).toBeInTheDocument()
    expect(within(list).getByText('Label voc-agent: created.')).toBeInTheDocument()
    const automatic = within(list).getAllByRole('listitem').filter((item) => item.dataset.automatic === 'true')
    // (each says it is automatic; nothing to do: no link under a tick that is done)
    expect(automatic.map((item) => [item.textContent.includes('Automatic'), item.querySelectorAll('a').length]))
      .toStrictEqual([[true, 0], [true, 0]])
    expect([new Set(fetchApi.mock.calls.filter(([path]) => path === '/agents/engineering/issues-source').map((call) => call[2])),
      fetchApi.mock.calls.some(([path]) => path === '/integrations/status')]).toStrictEqual([new Set(['deployment']), false])
  })

  it('leaves both ticks to do while no repository is read, pointing to Connections', async () => {
    const step = await prerequisites({ [ISSUES_SOURCE]: () => issuesView({ read: false, reading: false, reason: 'off', label: null }) })
    await waitFor(() => { expect(badges(step)).toStrictEqual(['Done', 'To do', 'To do', 'To do']) })
    const list = within(step).getByRole('list', { name: 'Prerequisites' })
    expect(within(list).getByText('Issues: read automatically once a repository is connected through the App.')).toBeInTheDocument()
    expect(within(list).getAllByRole('link', { name: 'Open Connections' })).toHaveLength(4)
  })

  it('leaves the label to do while it could not be created', async () => {
    const step = await prerequisites({ [ISSUES_SOURCE]: () => issuesView({ label: 'failed' }) })
    await waitFor(() => { expect(badges(step)).toStrictEqual(['Done', 'To do', 'Done', 'To do']) })
  })

  it('sends a platform admin to the GitHub Issues card when the source signs in with a token', async () => {
    platform.admin = true
    const step = await prerequisites({ [ISSUES_SOURCE]: () => issuesView({ reading: false, reason: 'token', label: null },
      { signs_in: 'token', app_id: null }) })
    const list = within(step).getByRole('list', { name: 'Prerequisites' })
    expect(await within(list).findByText(/the GitHub Issues source signs in with a token/)).toBeInTheDocument()
    expect(within(list).getByRole('link', { name: 'Open Administration → Data sources' }))
      .toHaveAttribute('href', '/admin/sources/github_issues?scope=deployment')
  })

  it('sends anyone else to the sources outside any workspace when the source signs in with a token', async () => {
    const step = await prerequisites({ [ISSUES_SOURCE]: () => issuesView({ reading: false, reason: 'token', label: null },
      { signs_in: 'token', app_id: null }) })
    expect(await within(step).findByRole('link', { name: 'Open Administration → Data sources' }))
      .toHaveAttribute('href', '/admin/sources')
  })

  it('says the ticks are not known yet when the source cannot be read', async () => {
    const step = await prerequisites({ [ISSUES_SOURCE]: () => { throw new ApiError(500, 'unavailable') } })
    await waitFor(() => { expect(badges(step)).toStrictEqual(['Done', 'To do', 'Not known yet', 'Not known yet']) })
  })

  it('shows each automation\'s prerequisite checks apart, "once set up", with each fix', async () => {
    const step = await prerequisites()
    const triage = within(step).getByRole('region', { name: 'Readiness for Issue triage, once set up' })
    const bugFixer = within(step).getByRole('region', { name: 'Readiness for Bug fixer, once set up' })
    const statuses = (region: HTMLElement) => within(region).getAllByTestId(/^readiness-/).map((row) => [row.dataset.testid, row.dataset.status])
    expect(within(triage).getByText('ci_attestation fix')).toBeInTheDocument()
    // (each its own: the Bug fixer's label warning is not the triage's; the way of working is no prerequisite)
    expect(statuses(triage)).toStrictEqual([['readiness-ci_attestation', 'fail'], ['readiness-issues_source', 'pass']])
    expect(statuses(bugFixer)).toStrictEqual([['readiness-ci_attestation', 'fail'], ['readiness-issue_label', 'warn']])
  })

  it('asks an automation\'s readiness of the deployment\'s only connection while it names none', async () => {
    const attested = { ...CONNECTION, ci_attestation: { version: 1, state: 'attested', repository: 'example-org/storefront',
      points: [], by: 'alice', at: '2026-11-17T00:00:00+00:00', connection_version: 1 } }
    const unset = { engineering: { connection: null, language: null, feedback_type: 'bug' } }
    const step = await prerequisites({
      'GET /agents/engineering/readiness?automation=ag_17a9e5c3b2d0&connection=storefront': () => ({
        checks: [check('ci_attestation', 'pass'), check('issues_source', 'pass')] }),
      'GET /agents/engineering/readiness?automation=ag_b0f1e2d3c4a5&connection=storefront': () => ({
        checks: [check('ci_attestation', 'pass'), check('issue_label', 'unknown')] }),
    }, [{ ...TRIAGE, ...unset }, { ...BUG_FIXER, ...unset }], [attested])
    // The deployment's CI attestation and each automation's agree.
    expect([badges(step)[1], within(step).queryByText('CI attested for storefront.') !== null]).toStrictEqual(['Done', true])
    const triage = within(step).getByRole('region', { name: 'Readiness for Issue triage, once set up' })
    expect(within(triage).getByTestId('readiness-ci_attestation')).toHaveAttribute('data-status', 'pass')
    expect(fetchApi.mock.calls.some(([path]) => path === '/agents/engineering/readiness?automation=ag_17a9e5c3b2d0')).toBe(false)
  })

  it('skips a step for now from the revision read, saying what skipping costs, and moves on', async () => {
    routes({ 'PUT /agents/engineering/setup': () => progress({ understand: 'skipped' }, { revision: 3 }) })
    renderGuide('/agents/setup/understand')
    const step = await screen.findByTestId('setup-step')
    expect([within(step).getByText(/Its flow arrives in 7.52/), within(step).getByText('What skipping costs'),
      within(step).getByText(/the agents learn the repository from scratch on every run/),
      within(step).getByText(/Not done before this one: Prerequisites\./)]).toHaveLength(4)
    await userEvent.click(within(step).getByRole('button', { name: 'Skip for now' }))
    await waitFor(() => { expect(screen.getByTestId('where')).toHaveTextContent('/agents/setup/tenets') })
    expect(sentFetchApiBody('/agents/engineering/setup', 'PUT')).toStrictEqual({ revision: 2, steps: { understand: 'skipped' } })
  })

  it('takes a skip back', async () => {
    routes({
      'GET /agents/engineering/setup': () => progress({ triage: 'skipped' }),
      'PUT /agents/engineering/setup': () => progress({}, { revision: 3 }),
    })
    renderGuide('/agents/setup/triage')
    const step = await screen.findByTestId('setup-step')
    await userEvent.click(await within(step).findByRole('button', { name: 'Take the skip back' }))
    expect(sentFetchApiBody('/agents/engineering/setup', 'PUT')).toStrictEqual({ revision: 2, steps: { triage: 'pending' } })
    await waitFor(() => { expect(within(step).getByRole('button', { name: 'Skip for now' })).toBeInTheDocument() })
  })

  it('says so when another administrator saved the guide meanwhile', async () => {
    routes({ 'PUT /agents/engineering/setup': () => { throw new ApiError(409, 'the setup guide changed since you opened it') } })
    renderGuide('/agents/setup/tenets')
    const step = await screen.findByTestId('setup-step')
    await userEvent.click(within(step).getByRole('button', { name: 'Skip for now' }))
    expect(await within(step).findByRole('alert')).toHaveTextContent('Another administrator changed the guide meanwhile.')
  })

  it('shows an automation\'s row (its state, what to fix, Set up as the step\'s action) and its readiness open on its step', async () => {
    routes()
    renderGuide('/agents/setup/bug-fixer')
    const step = await screen.findByTestId('setup-step')
    expect(within(step).getByRole('link', { name: 'Bug fixer' })).toHaveAttribute('href', '/agents/ag_b0f1e2d3c4a5')
    expect(await within(step).findByRole('button', { name: 'Set up Bug fixer' })).toHaveClass('btn-primary')
    expect(await within(step).findByTestId('readiness-ci_attestation')).toBeVisible()
    expect(within(step).getByRole('region', { name: 'Readiness for Bug fixer, once set up' })).toBeInTheDocument()
  })

  it('says why an automation is not found', async () => {
    routes()
    renderGuide('/agents/setup/feature-builder')
    expect(await screen.findByText(/Feature builder is not among this deployment's agents/)).toBeInTheDocument()
  })

  it('finishes on Ready to go, offering a run on an issue only from an enabled triage or bug fixer', async () => {
    routes({ 'PUT /agents/engineering/setup': () => progress({ ready: 'done' }, { revision: 3 }) })
    renderGuide('/agents/setup/ready')
    const step = await screen.findByTestId('setup-step')
    expect(within(step).getByText('Enable Issue triage or Bug fixer first: a run on an issue starts from one of them.'))
      .toBeInTheDocument()
    expect(within(step).getByRole('link', { name: 'Open Skills' })).toHaveAttribute('href', '/agents/skills')
    await userEvent.click(within(step).getByRole('button', { name: 'Finish the guide' }))
    expect(await screen.findByText('Agents list')).toBeInTheDocument()
    expect(sentFetchApiBody('/agents/engineering/setup', 'PUT')).toStrictEqual({ revision: 2, steps: { ready: 'done' } })
  })

  it('offers no skip on Ready to go', async () => {
    routes()
    renderGuide('/agents/setup/ready')
    const step = await screen.findByTestId('setup-step')
    expect(within(step).queryByRole('button', { name: 'Skip for now' })).toBeNull()
  })

  it('offers Run on an issue now from the enabled triage automation', async () => {
    routes({}, [{ ...TRIAGE, enabled: true }, BUG_FIXER])
    renderGuide('/agents/setup/ready')
    const step = await screen.findByTestId('setup-step')
    expect(within(step).getByText(/Start a run of Issue triage on one issue of its repository now/)).toBeInTheDocument()
    expect(within(step).getByRole('button', { name: 'Run on an issue now' })).toBeEnabled()
  })

  it('is for administrators where the engineering agents are on', async () => {
    routes()
    adminFlag.isAdmin = false
    renderGuide()
    expect(await screen.findByText(/The setup guide is for administrators/)).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Setup steps' })).toBeNull()
  })
})

describe('the first visit\'s offer', () => {
  const renderIntro = () => renderWithQueryClient(
    <TestRouter initialEntries={['/agents']}>
      <Routes>
        <Route path="/agents" element={<SetupIntro />} />
        <Route path="/agents/setup" element={<p>The guide</p>} />
      </Routes>
    </TestRouter>,
  )

  it('offers Start the setup guide while nothing is set up, saving the choice, then opens the guide', async () => {
    routes({
      'GET /agents/engineering/connections': () => ({ connections: [], limit: 20 }),
      'PUT /agents/engineering/setup': () => progress({}, { intro: 'started', revision: 3 }),
    })
    renderIntro()
    await userEvent.click(await screen.findByRole('button', { name: 'Start the setup guide' }))
    expect(await screen.findByText('The guide')).toBeInTheDocument()
    expect(sentFetchApiBody('/agents/engineering/setup', 'PUT')).toStrictEqual({ revision: 2, intro: 'started' })
  })

  it('goes on Not now, and is not offered once a choice is made or anything is set up', async () => {
    routes({
      'GET /agents/engineering/connections': () => ({ connections: [], limit: 20 }),
      'PUT /agents/engineering/setup': () => progress({}, { intro: 'skipped', revision: 3 }),
    })
    renderIntro()
    await userEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    await waitFor(() => { expect(screen.queryByTestId('setup-prompt')).toBeNull() })
    expect(sentFetchApiBody('/agents/engineering/setup', 'PUT')).toStrictEqual({ revision: 2, intro: 'skipped' })
  })

  it('is not offered while a GitHub connection is stored', async () => {
    routes()
    renderIntro()
    await waitFor(() => { expect(screen.queryByTestId('setup-prompt')).toBeNull() })
    expect(screen.queryByRole('button', { name: 'Start the setup guide' })).toBeNull()
  })
})

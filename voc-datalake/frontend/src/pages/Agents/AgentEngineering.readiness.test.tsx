/**
 * @fileoverview An engineering automation's readiness before Enable (7.50.00): the Set up dialog, the agents list's
 * card and the switch show each check (passed, failing, with a warning, unknown) with its fix and doc link; Enable
 * waits while a required check does not pass, never for an advisory one (in the dialog, only the budget it sets itself
 * does not hold it); an Enable refused with 409 `{error, checks}` shows the checks it names; the way-of-working check
 * links to Users. 7.50.01: the dialog reads the readiness of its selection (read again when the connection or the
 * language changes), fits the window with its buttons in view, and folds the checks that passed. 7.50.02: a failing way
 * of working offers "Set mine to AI-driven", whose inline confirm saves the caller's own and reads the readiness again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { workflowView } from '@test/workflowFixtures'
import { findEngineeringTemplate } from '../../api/engineeringTemplates'
import { normalizeAgent } from '../../api/agentsApi'
import { ApiError } from '../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'
import type { Agent } from '../../api/agentsApi'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { EngineeringEnableControl, EngineeringSetUpCard } = await import('./AgentEngineering')

const AGENT = 'ag_b0f1e2d3c4a5'
const READINESS = `GET /agents/engineering/readiness?automation=${AGENT}`
/** The dialog's readiness: the agent as if set up with its selection (7.50.01). */
const previewOf = (connection: string, language = 'python') =>
  `GET /agents/engineering/readiness?automation=${AGENT}&connection=${connection}&language=${language}`
const PREVIEW = previewOf('storefront')

function agentOf(extra: Record<string, unknown> = {}): Agent {
  const agent = normalizeAgent({
    agent_id: AGENT, name: 'Bug fixer', enabled: false, workflow_id: 'wf_1',
    triggers: [{ kind: 'github_issue', label: 'voc-agent', trusted_authors: false, lookback_days: 7 }],
    engineering: { connection: 'storefront', language: 'python', feedback_type: 'bug' }, ...extra,
  })
  if (agent === null) throw new Error('fixture agent did not normalise')
  return agent
}

const CONNECTION = {
  connection_id: 'storefront', host: 'github', repository: 'example-org/storefront', default_branch: 'main',
  credential: { kind: 'app', set: true, app_id: null, installation_id: null, expires_at: null }, version: 1,
}
const SANDBOX = { ...CONNECTION, connection_id: 'voc-agents-sandbox', repository: 'example-org/voc-agents-sandbox' }

/** What a run truly needs (the server's required checks, item B of 7.50.00): the other checks are advice. */
const REQUIRED = new Set(['connection', 'ci_attestation', 'image', 'bedrock_models', 'budget', 'dial'])
const check = (id: string, status: string, extra: Record<string, string> = {}) => ({
  id, status, detail: `${id} detail`, fix: `${id} fix`, docs: 'docs/autonomous-agents.md#setup-guide',
  required: REQUIRED.has(id), ...extra,
})

function routes(checks: unknown[], extra: Record<string, RouteHandler> = {}, connections: unknown[] = [CONNECTION]): void {
  const template = findEngineeringTemplate('bug-hunt-and-fix')
  if (template === undefined) throw new Error('no bug-hunt-and-fix template')
  routeFetchApi({
    'GET /agents/engineering/connections': () => ({ connections, limit: 20 }),
    'GET /workflows/wf_1': () => workflowView(3, { ...template.definition, budget: { monthly_usd: 50 } },
      { kind: 'engineering', monthly_budget_usd: 50 }),
    [READINESS]: () => ({ checks }),
    ...extra,
  }, { missStatus: 500 })
}

const renderControl = (agent: Agent) =>
  renderWithQueryClient(<TestRouter><EngineeringEnableControl agent={agent} isAdmin /></TestRouter>)

beforeEach(() => { resetFetchApi() })

describe('the switch of a set-up agent', () => {
  const THREE = [check('network', 'pass'), check('agentcore_quota', 'warn'), check('ci_attestation', 'fail')]

  it('waits while a check a run needs fails, and says why', async () => {
    routes(THREE)
    renderControl(agentOf())
    const toggle = await screen.findByRole('switch', { name: 'Enabled' })
    await waitFor(() => { expect(toggle).toBeDisabled() })
    expect(screen.getByText('Enable waits until every check a run needs passes.')).toBeInTheDocument()
  })

  it('folds the checks under their summary, failing first, then warnings, then passes', async () => {
    routes(THREE)
    renderControl(agentOf())
    await userEvent.click(await screen.findByText('Failing: 1 · Unknown: 0 · Warnings: 1 · Passed: 1'))
    expect(screen.getAllByTestId(/^readiness-/).map((row) => row.dataset.status)).toStrictEqual(['fail', 'warn', 'pass'])
    // (a check that passed shows no fix)
    expect(within(screen.getByTestId('readiness-network')).queryByText('network fix')).toBeNull()
  })

  it('shows a failing check with its name, its fix and its doc link', async () => {
    routes(THREE)
    renderControl(agentOf())
    await userEvent.click(await screen.findByText('Failing: 1 · Unknown: 0 · Warnings: 1 · Passed: 1'))
    const failing = screen.getByTestId('readiness-ci_attestation')
    expect([within(failing).getByText('CI attestation'), within(failing).getByText('ci_attestation fix')]).toHaveLength(2)
    expect(within(failing).getByRole('link', { name: /Docs/ })).toHaveAttribute('href',
      'https://github.com/aws-samples/sample-voice-of-customer-datalake/blob/main/docs/autonomous-agents.md#setup-guide')
  })

  it('is on offer when only warnings remain, and a 409 from Enable shows the checks it names', async () => {
    const failing = [check('dial', 'fail', { fix: 'Set your way of working to AI-driven.' })]
    routes([check('agentcore_quota', 'warn')], {
      [`POST /agents/${AGENT}/enable`]: () => { throw new ApiError(409, 'a check a run needs fails', undefined, undefined, failing) },
    })
    renderControl(agentOf())
    const toggle = await screen.findByRole('switch', { name: 'Enabled' })
    await waitFor(() => { expect(fetchApi).toHaveBeenCalledWith(`/agents/engineering/readiness?automation=${AGENT}`, undefined) })
    await userEvent.click(toggle)
    const alert = await screen.findByRole('alert')
    expect([within(alert).getByText('Not enabled: these checks a run needs fail.'),
      within(alert).getByText('Set your way of working to AI-driven.')]).toHaveLength(2)
    // The way-of-working check links to Users, where the administrator sets AI-driven.
    expect(within(alert).getByRole('link', { name: 'Set your way of working in Users' })).toHaveAttribute('href', '/admin/access/users')
  })

  it('waits for a required check that is unknown', async () => {
    routes([check('bedrock_models', 'unknown'), check('ci_protection', 'pass')])
    renderControl(agentOf())
    const toggle = await screen.findByRole('switch', { name: 'Enabled' })
    await waitFor(() => { expect(toggle).toBeDisabled() })
  })

  it('is on offer while only an advisory check fails', async () => {
    routes([check('ci_protection', 'fail'), check('bedrock_models', 'pass')])
    renderControl(agentOf())
    const toggle = await screen.findByRole('switch', { name: 'Enabled' })
    await waitFor(() => { expect(fetchApi).toHaveBeenCalledWith(`/agents/engineering/readiness?automation=${AGENT}`, undefined) })
    expect(toggle).toBeEnabled()
  })

  it('reads no readiness once the agent is enabled', async () => {
    routes([check('dial', 'fail')])
    renderControl(agentOf({ enabled: true }))
    expect(await screen.findByRole('switch', { name: 'Enabled' })).toBeEnabled()
    expect(fetchApi.mock.calls.some(([path]) => path.startsWith('/agents/engineering/readiness'))).toBe(false)
  })
})

describe('the Set up dialog', () => {
  const NOT_SET_UP = { engineering: { connection: null, language: null, feedback_type: 'bug' } }
  const ALL_PASS = ['connection', 'app_installation', 'ci_attestation', 'image', 'dial', 'budget', 'bedrock_models']
    .map((id) => check(id, 'pass'))
  /** Every check passing but `id`, which answers `status`. */
  const allPassBut = (id: string, status: string) => [...ALL_PASS.filter((entry) => entry.id !== id), check(id, status)]

  async function openDialog(agent: Agent = agentOf(NOT_SET_UP)): Promise<HTMLElement> {
    renderControl(agent)
    await userEvent.click(await screen.findByRole('button', { name: 'Set up' }))
    return screen.findByRole('dialog')
  }

  it('shows the readiness of its selection, and the budget it sets itself does not hold Save and enable', async () => {
    routes([check('connection', 'fail')], {
      [PREVIEW]: () => ({ checks: allPassBut('budget', 'fail') }),
      [`PUT /agents/${AGENT}`]: () => ({ agent: agentOf() }),
      [`POST /agents/${AGENT}/enable`]: () => ({ agent: agentOf({ enabled: true }) }),
    })
    const dialog = await openDialog()
    expect(await within(dialog).findByTestId('readiness-budget')).toHaveAttribute('data-status', 'fail')
    expect(within(dialog).getByRole('button', { name: 'Save and enable' })).toBeEnabled()
    expect(fetchApi).toHaveBeenCalledWith(PREVIEW.replace('GET ', ''), undefined)
  })

  it('enables Save and enable on a first set-up once every required check passes for the selection', async () => {
    // (the stored agent names no connection, so its own readiness fails the CI attestation; the selection's passes)
    routes([check('connection', 'fail'), check('ci_attestation', 'fail')], {
      [PREVIEW]: () => ({ checks: [...ALL_PASS, check('ci_protection', 'unknown'), check('hard_cap', 'warn')] }),
    })
    const dialog = await openDialog()
    await within(dialog).findByText('Failing: 0 · Unknown: 1 · Warnings: 1 · Passed: 7')
    expect(within(dialog).getByTestId('readiness-ci_attestation')).toHaveAttribute('data-status', 'pass')
    expect(within(dialog).getByRole('button', { name: 'Save and enable' })).toBeEnabled()
    expect(within(dialog).queryByText('Enable waits until every check a run needs passes.')).toBeNull()
  })

  it('reads the readiness again when the connection or the language changes', async () => {
    routes([], {
      [PREVIEW]: () => ({ checks: allPassBut('ci_attestation', 'fail') }),
      [previewOf('voc-agents-sandbox')]: () => ({ checks: ALL_PASS }),
    }, [CONNECTION, SANDBOX])
    const dialog = await openDialog()
    const save = within(dialog).getByRole('button', { name: 'Save and enable' })
    expect(await within(dialog).findByTestId('readiness-ci_attestation')).toHaveAttribute('data-status', 'fail')
    expect(save).toBeDisabled()
    await userEvent.selectOptions(within(dialog).getByLabelText('Repository connection'), 'voc-agents-sandbox')
    await waitFor(() => { expect(within(dialog).getByTestId('readiness-ci_attestation')).toHaveAttribute('data-status', 'pass') })
    expect(save).toBeEnabled()
  })

  it('reads the readiness again when the language changes', async () => {
    routes([], {
      [PREVIEW]: () => ({ checks: ALL_PASS }),
      [previewOf('storefront', 'node')]: () => ({ checks: allPassBut('image', 'fail') }),
    })
    const dialog = await openDialog()
    const save = within(dialog).getByRole('button', { name: 'Save and enable' })
    await waitFor(() => { expect(save).toBeEnabled() })
    await userEvent.selectOptions(within(dialog).getByLabelText('Language'), 'node')
    await waitFor(() => { expect(within(dialog).getByTestId('readiness-image')).toHaveAttribute('data-status', 'fail') })
    expect([save.hasAttribute('disabled'), fetchApi.mock.calls.some(([path]) => `GET ${path}` === previewOf('storefront', 'node'))])
      .toStrictEqual([true, true])
  })

  it('holds Save and enable while a check it does not set fails, the way of working included', async () => {
    routes([], { [PREVIEW]: () => ({ checks: allPassBut('dial', 'fail') }) })
    const dialog = await openDialog()
    await within(dialog).findByTestId('readiness-dial')
    expect(within(dialog).getByRole('button', { name: 'Save and enable' })).toBeDisabled()
    expect(within(dialog).getByText('Enable waits until every check a run needs passes.')).toBeInTheDocument()
  })

  describe('a failing way of working (7.50.02)', () => {
    const MINE = 'PUT /users/me/ai-mode'
    const SET_MINE = 'Set mine to AI-driven'
    const saved = () => ({ success: true, ai_mode: { mode: 'ai_driven', ai_writing_prfaq: false, ai_writing_prd: false, saved: true } })

    /** The dialog, with its fix's inline confirm open. */
    async function openConfirm(): Promise<{ dialog: HTMLElement; confirm: HTMLElement }> {
      const dialog = await openDialog()
      await userEvent.click(await within(dialog).findByRole('button', { name: SET_MINE }))
      return { dialog, confirm: within(dialog).getByRole('group', { name: /lets AI write your PR\/FAQs and PRDs/ }) }
    }

    it('opens an inline confirm naming both effects, which takes focus, and saves nothing yet', async () => {
      const mine = vi.fn(saved)
      routes([], { [PREVIEW]: () => ({ checks: allPassBut('dial', 'fail') }), [MINE]: mine })
      const { confirm } = await openConfirm()
      expect(confirm).toHaveTextContent('This lets the automations you enable push to voc-agent/* branches and open pull requests')
      expect([document.activeElement === confirm, mine.mock.calls.length]).toStrictEqual([true, 0])
    })

    it('saves nothing on Cancel, and the button is back', async () => {
      const mine = vi.fn(saved)
      routes([], { [PREVIEW]: () => ({ checks: allPassBut('dial', 'fail') }), [MINE]: mine })
      const { dialog, confirm } = await openConfirm()
      await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
      expect([within(dialog).queryByRole('group', { name: /lets AI write your PR\/FAQs/ }), mine.mock.calls.length]).toStrictEqual([null, 0])
      expect(within(dialog).getByRole('button', { name: SET_MINE })).toBeInTheDocument()
    })

    it('saves the caller\'s own way of working on Set to AI-driven, and reads the readiness again', async () => {
      const mine = vi.fn(saved)
      routes([], {
        // (the readiness the server answers once the way of working is saved)
        [PREVIEW]: () => ({ checks: mine.mock.calls.length > 0 ? ALL_PASS : allPassBut('dial', 'fail') }),
        [MINE]: mine,
      })
      const { dialog, confirm } = await openConfirm()
      await userEvent.click(within(confirm).getByRole('button', { name: 'Set to AI-driven' }))
      await waitFor(() => { expect(within(dialog).getByTestId('readiness-dial')).toHaveAttribute('data-status', 'pass') })
      // (PUT /users/me/ai-mode: the caller's own subject, never another person's flags)
      expect([sentFetchApiBody('/users/me/ai-mode', 'PUT'), mine.mock.calls.length,
        fetchApi.mock.calls.some(([path]) => path.endsWith('/flags'))]).toStrictEqual([{ ai_mode: 'ai_driven' }, 1, false])
      expect([within(dialog).queryByTestId('dial-fix'), within(dialog).getByRole('button', { name: 'Save and enable' }).hasAttribute('disabled')])
        .toStrictEqual([null, false])
    })

    it('is not offered while the way of working passes, nor for another failing check', async () => {
      routes([], { [PREVIEW]: () => ({ checks: allPassBut('ci_attestation', 'fail') }) })
      const dialog = await openDialog()
      await within(dialog).findByTestId('readiness-ci_attestation')
      expect([within(dialog).queryByTestId('dial-fix'), within(dialog).queryByRole('button', { name: SET_MINE })]).toStrictEqual([null, null])
    })

    it('says a refused save in the server\'s words', async () => {
      routes([], {
        [PREVIEW]: () => ({ checks: allPassBut('dial', 'fail') }),
        [MINE]: () => { throw new ApiError(403, 'Admin access required') },
      })
      const { dialog, confirm } = await openConfirm()
      await userEvent.click(within(confirm).getByRole('button', { name: 'Set to AI-driven' }))
      expect(await within(within(dialog).getByTestId('dial-fix')).findByRole('alert')).toHaveTextContent('Admin access required')
    })
  })

  it('shows the failing checks of a refused Enable, the settings saved', async () => {
    const failing = [check('image', 'fail', { fix: 'Push the node image.' })]
    routes([], {
      [PREVIEW]: () => ({ checks: [check('connection', 'pass')] }),
      [`PUT /agents/${AGENT}`]: () => ({ agent: agentOf() }),
      [`POST /agents/${AGENT}/enable`]: () => { throw new ApiError(409, 'API Error: 409', undefined, undefined, failing) },
    })
    const dialog = await openDialog()
    await within(dialog).findByTestId('readiness-connection')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save and enable' }))
    const alert = await within(dialog).findByRole('alert')
    expect(within(alert).getByText('Push the node image.')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('fits the window: its body scrolls, the title and the buttons stay outside it, the passes folded', async () => {
    const SEVENTEEN = ['connection', 'app_installation', 'ci_attestation', 'ci_protection', 'image', 'pack', 'tenets',
      'issues_source', 'issue_label', 'dial', 'budget', 'hard_cap', 'bedrock_models', 'agentcore_quota', 'memory_setting',
      'network', 'session_storage'].map((id) => check(id, id === 'ci_attestation' ? 'fail' : 'pass'))
    routes([], { [PREVIEW]: () => ({ checks: SEVENTEEN }) })
    const dialog = await openDialog()
    const failing = await within(dialog).findByTestId('readiness-ci_attestation')
    const body = dialog.querySelector('.dialog-body')
    const footer = within(dialog).getByRole('button', { name: 'Cancel' }).closest('.dialog-footer')
    const save = within(dialog).getByRole('button', { name: 'Save and enable' })
    const heading = within(dialog).getByRole('heading', { name: /Set up/ })
    // The panel is held to the window; the checks scroll in its body, the title and both buttons stay outside it.
    expect([dialog.classList.contains('max-h-[90vh]'), body?.contains(failing), body?.contains(footer), footer?.contains(save),
      body?.contains(heading)]).toStrictEqual([true, true, false, true, false])
    // Compact: the summary, the failing check listed, the 16 that passed folded under one line.
    expect(within(dialog).getByText('Failing: 1 · Unknown: 0 · Warnings: 0 · Passed: 16')).toBeInTheDocument()
    const passed = within(dialog).getByTestId('readiness-passed')
    expect([passed.tagName, passed.hasAttribute('open'), passed.contains(failing), within(passed).getAllByTestId(/^readiness-/).length])
      .toStrictEqual(['DETAILS', false, false, 16])
    expect(within(passed).getByText('Checks that passed (16)')).toBeInTheDocument()
  })
})

describe('the agents list\'s card', () => {
  it('keeps a set-up, disabled agent whose readiness fails, with its Set up and the checks folded', async () => {
    routes([check('ci_attestation', 'fail'), check('network', 'pass')])
    renderWithQueryClient(<TestRouter><EngineeringSetUpCard agent={agentOf()} /></TestRouter>)
    const card = await screen.findByTestId('engineering-setup-card')
    expect(within(card).getByRole('button', { name: 'Set up' })).toBeInTheDocument()
    expect(within(card).getByText('Failing: 1 · Unknown: 0 · Warnings: 0 · Passed: 1')).toBeInTheDocument()
  })

  it('shows nothing for a set-up agent with nothing failing', async () => {
    routes([check('agentcore_quota', 'warn')])
    const agent = agentOf()
    renderWithQueryClient(<TestRouter><EngineeringEnableControl agent={agent} isAdmin /><EngineeringSetUpCard agent={agent} /></TestRouter>)
    expect(await screen.findByRole('switch', { name: 'Enabled' })).toBeEnabled()
    await waitFor(() => { expect(screen.getAllByText('Failing: 0 · Unknown: 0 · Warnings: 1 · Passed: 0').length).toBeGreaterThan(0) })
    expect(screen.queryByTestId('engineering-setup-card')).toBeNull()
  })
})

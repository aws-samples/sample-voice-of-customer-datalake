/**
 * The role playbook on Home (7.66.00): the person picks a role, gets its steps with a link each, ticks a step by hand
 * (and unticks it), sees a step its evidence ticked as done, changes role, and asks the assistant to walk them through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { OpenAssistantRequest } from '../../../assistant/store/openAssistant'

const assistant = vi.hoisted(() => ({ openAssistant: vi.fn<(request: OpenAssistantRequest) => void>() }))
vi.mock('../../../assistant/store/openAssistant', () => assistant)
vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { DEFAULT_ONBOARDING } from '../../../api/onboardingApi'
import type { OnboardingPreference, PlaybookRole } from '../../../api/onboardingApi'
import { useAuthStore } from '../../../store/authStore'
import RolePlaybook from './RolePlaybook'

const onChooseRole = vi.fn<(role: PlaybookRole | null) => void>()
const onTicks = vi.fn<(steps: readonly string[]) => void>()

function render(preference: Partial<OnboardingPreference> = {}) {
  return renderWithQueryClient(
    <TestRouter>
      <RolePlaybook preference={{ ...DEFAULT_ONBOARDING, ...preference }} isSaving={false} onChooseRole={onChooseRole}
        onTicks={onTicks} />
    </TestRouter>,
  )
}

const stepRow = (title: string) => {
  const row = screen.getByRole('heading', { name: title }).closest('li')
  if (row === null) throw new Error(`no step ${title}`)
  return row
}

beforeEach(() => {
  resetFetchApi()
  onChooseRole.mockReset()
  onTicks.mockReset()
  assistant.openAssistant.mockReset()
  useAuthStore.setState({ user: { username: 'ada', email: 'ada@example.com', groups: [], sub: 'sub-ada' } })
  routeFetchApi({ 'GET /chat/conversations/_list?kind=assistant': () => ({ conversations: [] }),
    'GET /projects': () => ({ projects: [] }) })
})

describe('RolePlaybook', () => {
  it('offers the four roles and picks one', async () => {
    render()
    const roles = screen.getAllByRole('button').map((button) => button.querySelector('span')?.textContent)
    expect(roles).toStrictEqual(['Product manager', 'Scrum master', 'QA', 'Engineering'])
    await userEvent.click(screen.getByRole('button', { name: /^Scrum master/ }))
    expect(onChooseRole).toHaveBeenCalledWith('scrum_master')
    // Nothing is read for a person who has not chosen.
    expect(fetchApi).not.toHaveBeenCalled()
  })

  const QA_SIGNALS = { feedback_present: true, feedback_form_configured: true, form_test_response: false }

  it('lists the QA steps in order, each linking to its screen', () => {
    render({ playbook: 'qa', signals: QA_SIGNALS })
    expect(screen.getByText('Playbook: QA')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').map((row) => row.dataset['step'])).toStrictEqual([
      'create_form', 'test_form', 'search_feedback', 'review_problems', 'watch_release', 'ask_assistant'])
    expect(within(stepRow('Test a form with its test link')).getByRole('link', { name: /Open Feedback Forms/ }))
      .toHaveAttribute('href', '/feedback-forms')
  })

  it("ticks a step from the server's signals and counts it", async () => {
    render({ playbook: 'qa', signals: QA_SIGNALS })
    expect(within(stepRow('Create a feedback form')).getByText('Done')).toBeInTheDocument()
    expect(stepRow('Test a form with its test link')).toHaveAttribute('data-status', 'todo')
    await waitFor(() => expect(stepRow('Ask the assistant a question about your customers')).toHaveAttribute('data-status', 'todo'))
    expect(screen.getByRole('progressbar', { name: 'Playbook progress' })).toHaveAttribute('aria-valuetext', '1 of 6 done')
  })

  it('ticks and unticks a step by hand, keeping the other ticks', async () => {
    const user = userEvent.setup()
    const { unmount } = render({ playbook: 'qa', playbook_done: ['watch_release'] })
    await user.click(within(stepRow('Find the feedback behind an issue')).getByRole('checkbox', { name: 'Mark as done' }))
    expect(onTicks).toHaveBeenLastCalledWith(['watch_release', 'search_feedback'])
    const watched = within(stepRow('Watch the feedback after a release')).getByRole('checkbox', { name: 'Mark as done' })
    expect(watched).toBeChecked()
    await user.click(watched)
    expect(onTicks).toHaveBeenLastCalledWith([])
    unmount()
  })

  it('changes role', async () => {
    render({ playbook: 'engineering' })
    await userEvent.click(screen.getByRole('button', { name: 'Change role' }))
    expect(onChooseRole).toHaveBeenCalledWith(null)
  })

  it('asks the assistant to walk the person through the playbook, sending nothing itself', async () => {
    render({ playbook: 'product' })
    await userEvent.click(screen.getByRole('button', { name: 'Ask the assistant to walk me through it' }))
    const [request] = assistant.openAssistant.mock.calls[0] ?? []
    expect(request?.prompt).toContain('playbook for the Product manager role')
    expect(request?.prompt).toContain("1. Read this week's dashboard")
    expect(request?.prompt).toContain('7. Subscribe to the morning brief')
  })
})

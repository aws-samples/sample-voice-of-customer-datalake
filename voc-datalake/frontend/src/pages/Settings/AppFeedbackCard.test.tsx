/**
 * Administration → General → In-app feedback (7.66.00): off by default; an admin chooses a form, turns it on and picks
 * the actions, each saved at once; a refused form says why; everyone else reads it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../api/client', async (importOriginal) =>
  import('@test/fetchApiRoutes').then((m) => m.clientWithMockedFetchApi(importOriginal)))

import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { api } from '../../api/client'
import type { FeedbackForm } from '../../api/types'
import { ApiError } from '../../lib/errors'
import AppFeedbackCard from './AppFeedbackCard'

const API = 'https://api.example.com'
const ACTIONS = ['personas', 'research', 'prfaq', 'prd', 'prototype', 'form_draft', 'import', 'engineering_run']
const FORM = { form_id: 'ff_app', found: true, name: 'App feedback', enabled: true, languages: ['en'], problems: [] }

function serve(refuse?: () => never) {
  const state: Record<string, unknown> = { enabled: false, form_id: null, actions: ACTIONS, tag: 'voc_app', form: null,
    active: false }
  const puts: unknown[] = []
  routeFetchApi({
    'GET /settings/app-feedback': () => state,
    'PUT /settings/app-feedback': (body) => {
      puts.push(body)
      if (refuse !== undefined) refuse()
      Object.assign(state, body)
      state['form'] = state['form_id'] === null ? null : FORM
      state['active'] = state['enabled'] === true && state['form'] !== null
      return state
    },
  })
  return puts
}

function render(canEdit = true) {
  return renderWithQueryClient(<TestRouter><AppFeedbackCard apiEndpoint={API} canEdit={canEdit} /></TestRouter>)
}

/** A form of the list, as `GET /feedback-forms` answers it (only its id, name and type matter here). */
const listed = (form_id: string, name: string, extra: Partial<FeedbackForm> = {}): FeedbackForm => ({
  form_id, name, enabled: true, category: '', subcategory: '', title: '', description: '', question: '', placeholder: '',
  rating_enabled: false, rating_type: 'stars', rating_max: 5, submit_button_text: '', success_message: '',
  theme: { primary_color: '', background_color: '', text_color: '', border_radius: '' }, collect_email: false,
  collect_name: false, custom_fields: [], ...extra,
})
const FORMS = [listed('ff_app', 'App feedback'), listed('ff_pin', 'Pin', { form_type: 'prototype_pin' })]

beforeEach(() => {
  resetFetchApi()
  // (the forms list is the real client's method, read on its own call: answered here)
  vi.spyOn(api, 'getFeedbackForms').mockResolvedValue({ success: true, forms: FORMS })
})

describe('AppFeedbackCard', () => {
  it('is off by default, offers the template and lists the forms but a prototype pin', async () => {
    serve()
    render()
    const toggle = await screen.findByRole('checkbox', { name: 'Ask after key actions' })
    expect([toggle.matches(':checked'), toggle.matches(':disabled')]).toStrictEqual([false, true])
    expect(screen.getByRole('link', { name: 'Create one from the In-app micro-feedback template' }))
      .toHaveAttribute('href', '/feedback-forms/new?template=app_micro_feedback')
    await waitFor(() => expect(screen.getAllByRole('option').map((option) => option.textContent)).toStrictEqual(
      ['No form chosen', 'App feedback']))
  })

  it('saves the chosen form, then turns it on', async () => {
    const puts = serve()
    const user = userEvent.setup()
    render()
    const select = await screen.findByRole('combobox', { name: 'Form that receives the answers' })
    await screen.findByRole('option', { name: 'App feedback' })
    await user.selectOptions(select, 'ff_app')
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Ask after key actions' })).toBeEnabled())
    await user.click(screen.getByRole('checkbox', { name: 'Ask after key actions' }))
    expect(await screen.findByText(/The thumbs show after the actions below/)).toBeInTheDocument()
    expect(puts).toStrictEqual([{ form_id: 'ff_app' }, { enabled: true }])
  })

  it('saves the actions it asks after, never none', async () => {
    const puts = serve()
    const user = userEvent.setup()
    render()
    await user.click(await screen.findByRole('checkbox', { name: 'A PRD written' }))
    expect(puts.at(-1)).toStrictEqual({ actions: ACTIONS.filter((action) => action !== 'prd') })
  })

  it("says why a form can't receive it", async () => {
    serve(() => { throw new ApiError(400, 'refused', 'app_feedback_form_unfit') })
    render()
    const select = await screen.findByRole('combobox', { name: 'Form that receives the answers' })
    await screen.findByRole('option', { name: 'App feedback' })
    await userEvent.selectOptions(select, 'ff_app')
    expect(await screen.findByText(/choose one made from the In-app micro-feedback template/)).toBeInTheDocument()
  })

  it('is read-only for everyone else', async () => {
    serve()
    render(false)
    expect(await screen.findByText(/Only administrators change in-app feedback/)).toBeInTheDocument()
    expect(await screen.findByRole('combobox', { name: 'Form that receives the answers' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'A PRD written' })).toBeDisabled()
  })
})

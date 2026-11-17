/**
 * @fileoverview The thread's composer posts to the ORCHESTRATOR only (`POST …/steer`, never `…/messages` and never to
 * an agent): about the agent whose thread is open unless unticked, its placeholder saying where it goes, Enter
 * sending, the 1 KB bound counted with the "About <agent>: " the server adds, and the server's refusal shown.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { ApiError } from '../../../lib/errors'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import fixture from '@test/engineeringRunWorkspace.json'
import { SteerComposer } from './SteerComposer'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const STEER = fixture.steer.path

beforeEach(() => {
  resetFetchApi()
  routeFetchApi({ [`POST ${STEER}`]: () => fixture.steer.answer })
})

const field = () => screen.getByRole('textbox', { name: 'Steer the orchestrator' })
const posted = () => fetchApi.mock.calls.filter(([, options]) => options?.method === 'POST').map(([endpoint]) => endpoint)

describe('the composer', () => {
  it('says it messages the orchestrator about the agent, and posts the steering there, about it', async () => {
    renderWithQueryClient(<SteerComposer runId={fixture.run_id} primary agent={fixture.agent} />)
    expect(field()).toHaveAttribute('placeholder', 'Message the orchestrator about fixer-3: it decides what to relay…')
    await userEvent.type(field(), `${fixture.steer.body.text}{Enter}`)
    await waitFor(() => expect(sentFetchApiBody(STEER, 'POST')).toStrictEqual(fixture.steer.body))
    expect(posted()).toStrictEqual([STEER])
  })

  it('sends no "about" once unticked, and none from the orchestrator\'s own thread', async () => {
    const first = renderWithQueryClient(<SteerComposer runId={fixture.run_id} primary agent={fixture.agent} />)
    await userEvent.click(screen.getByRole('checkbox', { name: 'About fixer-3' }))
    await userEvent.type(field(), 'Skip the docs{Enter}')
    await waitFor(() => expect(sentFetchApiBody(STEER, 'POST')).toStrictEqual({ text: 'Skip the docs' }))
    first.unmount()
    renderWithQueryClient(<SteerComposer runId={fixture.run_id} primary agent={null} />)
    expect([field().getAttribute('placeholder'), screen.queryByRole('checkbox')])
      .toStrictEqual(['Message the orchestrator: it decides what to relay to its agents…', null])
  })

  it('says it was sent and clears the field; a new line with Shift+Enter sends nothing', async () => {
    renderWithQueryClient(<SteerComposer runId={fixture.run_id} primary agent={null} />)
    await userEvent.type(field(), 'Try ops.py first{Shift>}{Enter}{/Shift}')
    expect(posted()).toStrictEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Send to the orchestrator' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Sent to the orchestrator.')
    expect(field()).toHaveValue('')
  })

  it('holds steering past 1 KB with the agent it is about counted', async () => {
    renderWithQueryClient(<SteerComposer runId={fixture.run_id} primary agent={fixture.agent} />)
    await userEvent.click(field())
    await userEvent.paste('x'.repeat(1010))
    expect(screen.getByText('1,025 / 1,024 bytes')).toHaveClass('text-danger')
    expect(screen.getByRole('button', { name: 'Send to the orchestrator' })).toBeDisabled()
  })

  it('is the primary button only in the session in focus', () => {
    const focused = renderWithQueryClient(<SteerComposer runId={fixture.run_id} primary agent={null} />)
    expect(screen.getByRole('button', { name: 'Send to the orchestrator' })).toHaveClass('btn-primary')
    focused.unmount()
    renderWithQueryClient(<SteerComposer runId={fixture.run_id} primary={false} agent={null} />)
    expect(screen.getByRole('button', { name: 'Send to the orchestrator' })).toHaveClass('btn-secondary')
  })

  it('shows the server\'s reason for a refusal', async () => {
    routeFetchApi({ [`POST ${STEER}`]: () => { throw new ApiError(409, 'The run has ended: steering goes nowhere') } })
    renderWithQueryClient(<SteerComposer runId={fixture.run_id} primary agent={null} />)
    await userEvent.type(field(), 'Stop{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('The run has ended: steering goes nowhere')
  })
})

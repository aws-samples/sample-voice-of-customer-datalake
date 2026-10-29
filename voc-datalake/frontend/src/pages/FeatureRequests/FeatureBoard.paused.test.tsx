/**
 * A paused board: still readable (list, detail, every +1), with the "Paused" notice, and no way to
 * post, +1, edit a request or a +1. An admin keeps triage (status, delete a request or a +1).
 */
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import { ADMIN, APP_USER, fakeBoard, fixtureBoard, fixtureRequest, fixtureSupport, renderBoard } from './feature-board-fixtures'
import type { BoardViewer } from '../../api/featureRequestsApi'

const NOTICE = 'Paused: new requests and votes are closed for now.'
const SSO = fixtureRequest('fr_1', { title: 'Single sign-on', reporter_email: APP_USER.email })
const SUPPORTS = [
  fixtureSupport('sup_1', { is_reporter: true, email: APP_USER.email, name: APP_USER.name }),
  fixtureSupport('sup_2', { email: 'kim@example.com', name: 'Kim', customer: 'Example Air' }),
]

function renderPaused(viewer: BoardViewer, paused: boolean, entry = '/feature-requests/sales-board') {
  const board = fixtureBoard('sales', { paused })
  renderBoard(fakeBoard(viewer, [SSO], { fr_1: SUPPORTS }, { board }).api, entry, 'app', 'sales-board')
}

async function openDetail(viewer: BoardViewer, paused: boolean) {
  renderPaused(viewer, paused, '/feature-requests/sales-board?request=fr_1')
  const dialog = within(await screen.findByRole('dialog', { name: 'Single sign-on' }))
  await dialog.findByText('Example Air')
  return dialog
}

describe('a paused board', () => {
  it('lists its requests with the notice, and no New request', async () => {
    renderPaused(APP_USER, true)
    expect(await screen.findByRole('button', { name: /Single sign-on/ })).toBeInTheDocument()
    expect(screen.getByTestId('board-paused-notice')).toHaveTextContent(NOTICE)
    expect(screen.queryByRole('button', { name: 'New request' })).not.toBeInTheDocument()
  })

  it('shows a request with the notice, but offers its reporter no edit of it or of their +1', async () => {
    const dialog = await openDetail(APP_USER, true)
    expect(dialog.getByText(NOTICE)).toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: 'Edit my +1' })).not.toBeInTheDocument()
  })

  it('offers no change or removal of a +1 to its author', async () => {
    const dialog = await openDetail(APP_USER, true)
    expect(dialog.queryByRole('button', { name: /^Edit the support/ })).not.toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: /^Delete the support/ })).not.toBeInTheDocument()
  })

  it('still lets an admin triage: status, delete a request or a +1', async () => {
    const dialog = await openDetail(ADMIN, true)
    expect(dialog.getByRole('combobox', { name: 'Status' })).toBeEnabled()
    expect(dialog.getByRole('button', { name: 'Delete request' })).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Delete the support for Example Air' })).toBeInTheDocument()
  })

  it('gives an admin no edit and no +1 either', async () => {
    const dialog = await openDetail(ADMIN, true)
    expect(dialog.queryByRole('button', { name: 'Edit the support for Example Air' })).not.toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(dialog.queryByRole('button', { name: '+1 with my customer' })).not.toBeInTheDocument()
  })
})

describe('the same board resumed', () => {
  it('offers New request again, without the notice', async () => {
    renderPaused(APP_USER, false)
    expect(await screen.findByRole('button', { name: 'New request' })).toBeInTheDocument()
    expect(screen.queryByTestId('board-paused-notice')).not.toBeInTheDocument()
  })

  it('offers the reporter Edit and Edit my +1 again', async () => {
    const dialog = await openDetail(APP_USER, false)
    expect(dialog.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Edit my +1' })).toBeInTheDocument()
  })
})

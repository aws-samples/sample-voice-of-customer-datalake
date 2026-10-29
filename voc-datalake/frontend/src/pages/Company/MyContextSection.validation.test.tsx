/**
 * @fileoverview 5.34.00 live finding (Account → Objectives): a KPI with a name
 * but no target was sent, the server answered 400 "kpis[0].target is required",
 * and the form only said "Could not save. Try again." Now Save checks the draft
 * and marks the field, and a field error the server still returns lands on the
 * field it names.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { serverFieldError, validateMyContext } from './myContextValidation'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const { default: MyContextSection } = await import('./MyContextSection')

const puts = () => fetchApi.mock.calls.filter(([, options]) => options?.method === 'PUT')

async function kpiWithoutTarget() {
  const user = userEvent.setup()
  renderWithQueryClient(<MemoryRouter><MyContextSection /></MemoryRouter>)
  await user.click(await screen.findByRole('button', { name: 'Add objective' }))
  await user.type(screen.getByRole('textbox', { name: 'Objective title' }), 'Ship returns redesign')
  await user.click(screen.getByRole('button', { name: 'Add KPI' }))
  await user.type(screen.getByRole('textbox', { name: 'KPI name' }), 'Complaints')
  return user
}

/** The KPI without a target, after a refused Save; resolves to its Target field. */
async function refusedSave() {
  routeFetchApi({ 'GET /settings/my-context': () => ({ objectives: [] }) })
  const user = await kpiWithoutTarget()
  await user.click(screen.getByRole('button', { name: /save changes/i }))
  return { user, target: screen.getByRole('textbox', { name: 'Target' }) }
}

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = false
})

describe('My objectives & KPIs: field-level errors', () => {
  it('marks a KPI without a target next to the field, focuses it, and sends nothing', async () => {
    const { target } = await refusedSave()
    expect(target).toHaveAccessibleDescription('Required: fill this in, or remove the row')
    await waitFor(() => expect(target).toHaveFocus())
    expect(screen.getByRole('alert')).toHaveTextContent('Not saved: fix the highlighted fields.')
    expect(puts()).toHaveLength(0)
  })

  it('clears the mark as soon as the target is filled in', async () => {
    const { user, target } = await refusedSave()
    expect(target).toHaveAttribute('aria-invalid', 'true')
    await user.type(target, '-30')
    expect(target).toHaveAttribute('aria-invalid', 'false')
  })

  it('shows a field error the server returns on the field its path names', async () => {
    routeFetchApi({
      'GET /settings/my-context': () => ({ objectives: [] }),
      'PUT /settings/my-context': () => Promise.reject(new ApiError(400, 'objectives[0].kpis[0].unit must be at most 120 characters')),
    })
    const user = await kpiWithoutTarget()
    await user.type(screen.getByRole('textbox', { name: 'Target' }), '-30')
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    const unit = await screen.findByRole('textbox', { name: 'Unit' })
    await waitFor(() => expect(unit).toHaveAttribute('aria-invalid', 'true'))
    expect(unit).toHaveAccessibleDescription('must be at most 120 characters')
    expect(screen.getByRole('alert')).toHaveTextContent('Not saved: fix the highlighted fields.')
  })
})

describe('myContextValidation', () => {
  const objective = (id: string, title: string, kpis: { name: string; target: string; unit?: string }[] = []) =>
    ({ id, title, description: '', due: undefined, kpis: kpis.map((k) => ({ unit: undefined, ...k })) })

  it('drops wholly blank rows without an error and asks for a title once the objective has content', () => {
    const errors = validateMyContext({ objectives: [
      objective('a', ''), objective('b', '', [{ name: 'Churn', target: '5' }]), objective('c', 'Ok', [{ name: '', target: '' }]),
    ] })
    expect([...errors.keys()]).toStrictEqual(['obj:b:title'])
  })

  it('maps a body index back to the draft row, skipping the rows the body drops', () => {
    const context = { objectives: [
      objective('blank', ''), objective('real', 'Grow', [{ name: '', target: '' }, { name: 'NPS', target: '' }]),
    ] }
    expect(serverFieldError(new ApiError(400, 'objectives[0].kpis[0].target is required'), context))
      .toStrictEqual({ key: 'obj:real:kpi:1:target', problem: { code: 'required' } })
    expect(serverFieldError(new ApiError(400, 'Could not save'), context)).toBeNull()
  })
})

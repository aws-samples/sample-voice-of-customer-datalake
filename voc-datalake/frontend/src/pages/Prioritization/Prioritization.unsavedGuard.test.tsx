/**
 * @fileoverview Prioritization score edits under the shared unsaved-changes
 * guard, through the shared contract (3.00.00 R2): a moved slider survives a
 * scores refetch while the dialog is open, Cancel keeps it, and the next leave
 * asks again.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import './prioritization-mock-fixtures'
import { ROW_TITLE, installSingleRow, resetPrioritizationPage } from './prioritization-fixtures'
import { findImpactSlider, renderPrioritizationWithExit } from './prioritization-render-fixtures'
import { expectCancelKeepsDraftGuarded } from '@test/unsavedGuardContract'
import type { QueryClient } from '@tanstack/react-query'
import type { createMemoryRouter } from 'react-router-dom'

beforeEach(() => {
  resetPrioritizationPage()
})

describe('Prioritization — Cancel keeps the draft and stays guarded (R2 contract)', () => {
  it('keeps a moved slider through a refetch while the dialog is open', async () => {
    installSingleRow()
    const mounted: { client?: QueryClient; router?: ReturnType<typeof createMemoryRouter> } = {}
    await expectCancelKeepsDraftGuarded({
      mount: async () => {
        const { queryClient, router } = renderPrioritizationWithExit()
        mounted.client = queryClient
        mounted.router = router
        await screen.findByText(ROW_TITLE)
      },
      edit: async (user) => {
        await user.click(screen.getByText(ROW_TITLE))
        fireEvent.change(await findImpactSlider(), { target: { value: '2' } })
      },
      expectDraft: () => expect(screen.getAllByRole('slider')[0]).toHaveValue('2'),
      leave: async (user) => { await user.click(screen.getByRole('link', { name: 'Leave' })) },
      expectStayed: () => expect(mounted.router?.state.location.pathname).toBe('/'),
      expectLeft: async () => { expect(await screen.findByText('Elsewhere page')).toBeInTheDocument() },
      whileDialogOpen: async () => { await mounted.client?.invalidateQueries() },
    })
  })
})

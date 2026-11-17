/**
 * The save_categories card (the categories-first rule's save): it shows the proposed categories and subcategories
 * editable before Approve, holds Approve while a field is not right or the stored categories are not read, and on
 * Approve adds exactly the edited set after the stored categories through the workspace-scoped categories route
 * (never the deployment's from inside a workspace), then refreshes the categories reads; it saves nothing when the
 * stored categories changed after the card read them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { z } from 'zod'

const fetchApiDoubles = await vi.hoisted(async () => import('@test/fetchApiRoutes'))
/** The categories editor's four calls (api/client.ts): the workspace's two, and the deployment's two, never used here. */
const categoriesApi = vi.hoisted(() => ({
  getCategoriesConfig: vi.fn<() => Promise<unknown>>(),
  saveCategoriesConfig: vi.fn<(config: unknown) => Promise<unknown>>(),
  getDeploymentCategoriesConfig: vi.fn<() => Promise<unknown>>(),
  saveDeploymentCategoriesConfig: vi.fn<(config: unknown) => Promise<unknown>>(),
}))
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return { ...actual, api: { ...actual.api, ...categoriesApi } }
})
vi.mock('../../store/authStore', fetchApiDoubles.authStoreModule)

import { resetExecutions } from './executionStore'
import { CATEGORIES_CHANGED_MESSAGE } from './categoryExecutors'
import { getWriteTool } from './registry'
import { stubElementScrollIntoView } from '../../test/stubScrollTo'
import { setCurrentWorkspace } from '../../workspace/currentWorkspace'
import { ACME } from '../../test/workspaceFixtures'
import { adminFlag, resetFetchApi } from '@test/fetchApiRoutes'
import { approve, outcomeOf, renderApprovalCard, resumedToolMessage } from '@test/approvalCardHarness'
import type { AssistantToolCall } from '../types'

const STORED = { categories: [{ id: 'cat_billing', name: 'billing', description: 'Billing', subcategories: [] }] }
const PROPOSAL = { categories: [
  { label: 'Delivery', product: 'Shop', subcategories: ['Late delivery', 'Damaged parcel'] },
  { label: 'Returns', subcategories: ['Refund delay'] },
] }
const CALL: AssistantToolCall = { id: 'c1', name: 'save_categories', args: PROPOSAL }

const card = (toolCall: AssistantToolCall = CALL) => renderApprovalCard(toolCall, { kind: 'scrapers', path: '/scrapers' })
const approveButton = () => screen.getByRole('button', { name: 'Approve' })
const category = (index: number) => within(screen.getByTestId(`category-${String(index)}`))

function routes(stored: unknown = STORED) {
  categoriesApi.getCategoriesConfig.mockImplementation(() => Promise.resolve(stored))
  categoriesApi.saveCategoriesConfig.mockResolvedValue({ success: true, message: 'Saved' })
}

const SavedSchema = z.object({ categories: z.array(z.looseObject({
  id: z.string(), subcategories: z.array(z.looseObject({ id: z.string() })),
})) })

/** The categories the workspace's save got, with each new entry's fresh id replaced by its prefix. */
function savedBody(): unknown {
  const [config] = categoriesApi.saveCategoriesConfig.mock.calls[0] ?? []
  const { categories } = SavedSchema.parse(config)
  const prefix = (id: string) => id.split('_')[0]
  return categories.map((entry) => ({
    ...entry, id: entry.id === 'cat_billing' ? entry.id : prefix(entry.id),
    subcategories: entry.subcategories.map((sub) => ({ ...sub, id: prefix(sub.id) })),
  }))
}

/** Never the deployment's categories from the card: the current workspace's (outside one, the deployment's too). */
function onlyWorkspaceScope() {
  expect(categoriesApi.getDeploymentCategoriesConfig).not.toHaveBeenCalled()
  expect(categoriesApi.saveDeploymentCategoriesConfig).not.toHaveBeenCalled()
}

beforeEach(() => {
  adminFlag.isAdmin = true
  resetExecutions()
  resetFetchApi()
  vi.clearAllMocks()
  return stubElementScrollIntoView()
})
afterEach(() => setCurrentWorkspace(null))

describe('save_categories card', () => {
  it('is an admin-only card titled with the number of categories', () => {
    const tool = getWriteTool('save_categories')
    expect(tool?.adminOnly).toBe(true)
    expect(tool?.title(PROPOSAL, (key, options) => `${key}:${String(options?.count)}`))
      .toBe('assistantTools:tools.save_categories.titleWith:2')
  })

  it('shows each category editable, with its stored name, and says they are added after the stored ones', async () => {
    routes()
    card()
    expect(await screen.findByText('Categories configured now: 1. These are added after them, and none of them changes.')).toBeInTheDocument()
    const first = category(0)
    expect([
      first.getByLabelText('Label'), first.getByLabelText('Product or area (optional)'),
      first.getByRole('textbox', { name: 'Subcategory 1' }), first.getByRole('textbox', { name: 'Subcategory 2' }),
    ].map((input) => (input instanceof HTMLInputElement ? input.value : null))).toStrictEqual(['Delivery', 'Shop', 'Late delivery', 'Damaged parcel'])
    expect(first.getByText('Stored as delivery')).toBeInTheDocument()
    expect(screen.getByText(/adds them to the deployment’s categories/)).toBeInTheDocument()
  })

  it('adds exactly the edited set after the stored categories, through the workspace scope, and refreshes', async () => {
    routes()
    const { user, onResolve, invalidate } = card()
    await screen.findAllByLabelText('Label')
    const label = category(0).getByLabelText('Label')
    await user.clear(label)
    await user.type(label, 'Shipping')
    await user.click(category(0).getByRole('button', { name: 'Remove the subcategory Damaged parcel' }))
    await user.click(category(1).getByRole('button', { name: 'Add a subcategory' }))
    await user.type(category(1).getByRole('textbox', { name: 'Subcategory 2' }), 'Wrong item')
    await approve(user, onResolve)
    expect(savedBody()).toStrictEqual([
      STORED.categories[0],
      { id: 'cat', name: 'shipping', description: 'Shipping', product: 'Shop',
        subcategories: [{ id: 'sub', name: 'late_delivery', description: 'Late delivery' }] },
      { id: 'cat', name: 'returns', description: 'Returns', subcategories: [
        { id: 'sub', name: 'refund_delay', description: 'Refund delay' }, { id: 'sub', name: 'wrong_item', description: 'Wrong item' },
      ] },
    ])
    onlyWorkspaceScope()
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toContainEqual(['categories-config'])
    expect(resumedToolMessage(onResolve, 'c1')).toMatchObject({
      status: 'executed',
      data: { categories: [
        { name: 'shipping', label: 'Shipping', subcategories: ['late_delivery'] },
        { name: 'returns', label: 'Returns', subcategories: ['refund_delay', 'wrong_item'] },
      ] },
    })
  })

  it('leaves a category out when the person removes it', async () => {
    routes({ categories: [] })
    const { user, onResolve } = card()
    expect(await screen.findByText(/No categories are configured yet/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Leave out Delivery' }))
    await approve(user, onResolve)
    expect(savedBody()).toStrictEqual([
      { id: 'cat', name: 'returns', description: 'Returns', subcategories: [{ id: 'sub', name: 'refund_delay', description: 'Refund delay' }] },
    ])
  })

  it.each([
    ['a label with "#"', 'Bills #1', '1-64 characters, without “#”.'],
    ['two categories with one name', 'returns', 'This name is there twice: keep each name once.'],
    ['a name configured already', 'Billing', 'A category with this name is configured already: leave it out.'],
  ])('holds Approve for %s and says why', async (_what, typed, why) => {
    routes()
    const { user } = card()
    await waitFor(() => expect(approveButton()).toBeEnabled())
    const label = category(0).getByLabelText('Label')
    await user.clear(label)
    await user.type(label, typed)
    expect(await screen.findByText(why)).toBeInTheDocument()
    expect(approveButton()).toBeDisabled()
    expect(screen.getByText('Correct the marked fields to approve.')).toBeInTheDocument()
  })

  it('holds Approve until the stored categories are read, and while they cannot be', async () => {
    categoriesApi.getCategoriesConfig.mockRejectedValue(new Error('API Error: 503'))
    card()
    expect(await screen.findByText(/could not be read, so Approve saves nothing/)).toBeInTheDocument()
    expect(approveButton()).toBeDisabled()
  })

  it('saves nothing when the stored categories changed after the card read them', async () => {
    routes()
    const { user, onResolve } = card()
    await screen.findAllByLabelText('Label')
    routes({ categories: [...STORED.categories, { id: 'cat_other', name: 'other', description: 'Other', subcategories: [] }] })
    await approve(user, onResolve)
    expect(outcomeOf(onResolve)).toStrictEqual({ status: 'failed', error: CATEGORIES_CHANGED_MESSAGE })
    expect(categoriesApi.saveCategoriesConfig).not.toHaveBeenCalled()
  })

  it('inside a workspace, says it adds to the workspace’s categories and links to its settings', async () => {
    setCurrentWorkspace(ACME)
    routes()
    const { user, onResolve } = card()
    expect(await screen.findByText(/adds them to this workspace’s categories/)).toBeInTheDocument()
    await approve(user, onResolve)
    expect(screen.getByRole('link', { name: 'Open Workspace settings → Categories' })).toHaveAttribute('href', '/workspace-settings')
    expect(categoriesApi.saveCategoriesConfig.mock.calls).toHaveLength(1)
    onlyWorkspaceScope()
  })

  it('outside a workspace, links to Administration → Categories', async () => {
    routes()
    const { user, onResolve } = card()
    await screen.findAllByLabelText('Label')
    await approve(user, onResolve)
    expect(screen.getByRole('link', { name: 'Open Administration → Categories' }))
      .toHaveAttribute('href', '/admin/categories')
  })
})

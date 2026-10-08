/**
 * @fileoverview Tests for CategoriesManager component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'

// Mock API before importing component
const mockGetCategoriesConfig = vi.fn<() => Promise<unknown>>()
const mockSaveCategoriesConfig = vi.fn<(config: unknown) => Promise<unknown>>()
const mockGenerateCategories = vi.fn<(desc: string) => Promise<unknown>>()
const mockGetUsers = vi.fn<() => Promise<unknown>>()
const mockFetchApi = vi.fn<(endpoint: string, options?: unknown) => Promise<unknown>>()

vi.mock('../../api/client', () => ({
  api: {
    getCategoriesConfig: () => mockGetCategoriesConfig(),
    saveCategoriesConfig: (config: unknown) => mockSaveCategoriesConfig(config),
    generateCategories: (desc: string) => mockGenerateCategories(desc),
    getUsers: () => mockGetUsers(),
  },
  // The reprocess panel's calls go through fetchApi.
  fetchApi: (endpoint: string, options?: unknown) => mockFetchApi(endpoint, options),
}))

import CategoriesManager from './CategoriesManager'
import { useConfigStore } from '../../store/configStore'

const LATE_DELIVERY = { id: 'sub_1', name: 'late', description: 'Late Delivery' }

/** The single "Delivery" category most scenarios start from, with the given subcategories. */
function deliveryCategory(subcategories: object[] = []) {
  return { id: 'cat_1', name: 'delivery', description: 'Delivery', subcategories }
}

const ADD_CATEGORY_PLACEHOLDER = 'Add new category...'
const ADD_SUBCATEGORY_PLACEHOLDER = 'Add subcategory...'
const COMPANY_PLACEHOLDER = /e\.g\., We are an airline/i

function renderComponent() {
  return renderWithQueryClient(<CategoriesManager />)
}

/** Mount with `categories` from the API and wait until `readyText` is on screen. */
async function renderWithCategories(categories: object[], readyText: string | RegExp): Promise<UserEvent> {
  mockGetCategoriesConfig.mockResolvedValue({ categories })
  renderComponent()
  await screen.findByText(readyText)
  return userEvent.setup()
}

/** Mount with no categories and wait for the add-category input. */
async function renderEmpty(): Promise<UserEvent> {
  mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
  renderComponent()
  await screen.findByPlaceholderText(ADD_CATEGORY_PLACEHOLDER)
  return userEvent.setup()
}

/** Mount with the Delivery category and wait for its row. */
function renderDelivery(subcategories: object[] = []): Promise<UserEvent> {
  return renderWithCategories([deliveryCategory(subcategories)], 'Delivery')
}

/**
 * Expand the Delivery row, then wait for a subcategory label when `subLabel` is
 * given, or for the add-subcategory input otherwise.
 */
async function expandDelivery(user: UserEvent, subLabel?: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Expand Delivery' }))
  if (subLabel === undefined) {
    await screen.findByPlaceholderText(ADD_SUBCATEGORY_PLACEHOLDER)
  } else {
    await screen.findByText(subLabel)
  }
}

/** Open the delete confirmation for the Delivery category. */
async function openDeleteDelivery(user: UserEvent): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Delete Delivery' }))
  await screen.findByText('Delete Category')
}

/** Type into the add-category input and press the Add button. */
async function addCategory(user: UserEvent, text: string): Promise<void> {
  await user.type(screen.getByPlaceholderText(ADD_CATEGORY_PLACEHOLDER), text)
  await user.click(screen.getByRole('button', { name: /add category/i }))
}

/** Describe the company and press Generate. */
async function generateCategories(user: UserEvent, description: string): Promise<void> {
  await user.type(screen.getByPlaceholderText(COMPANY_PLACEHOLDER), description)
  await user.click(screen.getByRole('button', { name: /generate categories/i }))
}

/** Click a row label to enter edit mode and return its input. */
async function startRename(user: UserEvent, label: string): Promise<HTMLElement> {
  await user.click(screen.getByText(label))
  return screen.findByDisplayValue(label)
}

/** Wait until the save mutation was called with `{ categories }` matching `categories`. */
function expectSavedCategories(categories: unknown): Promise<void> {
  return waitFor(() => {
    expect(mockSaveCategoriesConfig).toHaveBeenCalledWith({ categories })
  })
}

/** A save matcher for "some category has a subcategory matching `sub`". */
function containingSubcategory(sub: Record<string, unknown>): unknown {
  const subcategories: unknown = expect.arrayContaining([expect.objectContaining(sub)])
  return expect.arrayContaining([expect.objectContaining({ subcategories })])
}

/** A promise that resolves with `value` after `ms`, for "still in flight" assertions. */
function resolvesAfter(value: unknown, ms = 100) {
  return () => new Promise<unknown>((resolve) => {
    setTimeout(() => resolve(value), ms)
  })
}

describe('CategoriesManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The shared categories query waits for a configured endpoint.
    useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: 'https://api.example.com' } }))
    mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
    mockSaveCategoriesConfig.mockResolvedValue({ success: true })
    mockGenerateCategories.mockResolvedValue({ categories: [] })
    mockGetUsers.mockResolvedValue({ success: true, users: [] })
    mockFetchApi.mockResolvedValue({ job: null })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching categories', () => {
      mockGetCategoriesConfig.mockReturnValue(new Promise(() => {}))

      renderComponent()

      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('displays empty state message when no categories exist', async () => {
      renderComponent()

      await waitFor(() => {
        expect(screen.getByText('No categories configured yet.')).toBeInTheDocument()
      })
    })
  })

  describe('categories display', () => {
    it('displays categories list when data exists', async () => {
      await renderWithCategories([
        { id: 'cat_1', name: 'delivery', description: 'Delivery Issues', subcategories: [] },
        { id: 'cat_2', name: 'quality', description: 'Product Quality', subcategories: [] },
      ], 'Delivery Issues')

      expect(screen.getByText('Product Quality')).toBeInTheDocument()
    })

    it('shows category count in header', async () => {
      await renderWithCategories([
        deliveryCategory(),
        { id: 'cat_2', name: 'quality', description: 'Quality', subcategories: [] },
      ], '2 categories')

      expect(screen.getByText('2 categories')).toBeInTheDocument()
    })

    it('shows subcategory count for each category', async () => {
      await renderDelivery([LATE_DELIVERY, { id: 'sub_2', name: 'damaged', description: 'Damaged Package' }])

      expect(screen.getByText('2 subs')).toBeInTheDocument()
    })
  })

  describe('add category', () => {
    it.each([
      ['adds new category when form is submitted', 'New Category', 'new_category'],
      ['converts category name to lowercase with underscores', 'Customer Support Issues', 'customer_support_issues'],
    ])('%s', async (_title, typed, normalized) => {
      const user = await renderEmpty()

      await addCategory(user, typed)

      await expectSavedCategories(expect.arrayContaining([
        expect.objectContaining({ name: normalized, description: typed }),
      ]))
    })

    it('disables add button when input is empty', async () => {
      await renderEmpty()

      expect(screen.getByRole('button', { name: /add category/i })).toBeDisabled()
    })

    it('adds category when Enter is pressed in input', async () => {
      const user = await renderEmpty()

      await user.type(screen.getByPlaceholderText(ADD_CATEGORY_PLACEHOLDER), 'New Category{Enter}')

      await expectSavedCategories([expect.objectContaining({ name: 'new_category', description: 'New Category' })])
    })

    it('does not add category when input is empty', async () => {
      const user = await renderEmpty()

      await user.type(screen.getByPlaceholderText(ADD_CATEGORY_PLACEHOLDER), '{Enter}')

      expect(mockSaveCategoriesConfig).not.toHaveBeenCalled()
    })
  })

  describe('delete category', () => {
    it('shows confirmation modal when delete is clicked', async () => {
      const user = await renderDelivery()

      await openDeleteDelivery(user)

      expect(screen.getByText(/are you sure you want to delete this category/i)).toBeInTheDocument()
    })

    it('deletes category when confirmed', async () => {
      const user = await renderDelivery()
      await openDeleteDelivery(user)

      await user.click(screen.getByRole('button', { name: /^delete$/i }))

      await expectSavedCategories([])
    })

    it('cancels deletion when cancel is clicked', async () => {
      const user = await renderDelivery()
      await openDeleteDelivery(user)

      await user.click(screen.getByRole('button', { name: /cancel/i }))

      await waitFor(() => {
        expect(screen.queryByText('Delete Category')).not.toBeInTheDocument()
      })
      expect(screen.getByText('Delivery')).toBeInTheDocument()
    })
  })

  describe('expand/collapse', () => {
    it('expands category to show subcategories when clicked', async () => {
      const user = await renderDelivery([LATE_DELIVERY])

      await expandDelivery(user, 'Late Delivery')

      expect(screen.getByRole('button', { name: 'Collapse Delivery' })).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByText('Late Delivery')).toBeInTheDocument()
    })

    it('collapses category when expand button is clicked again', async () => {
      const user = await renderDelivery([LATE_DELIVERY])
      await expandDelivery(user, 'Late Delivery')

      await user.click(screen.getByRole('button', { name: 'Collapse Delivery' }))

      await waitFor(() => {
        expect(screen.queryByText('Late Delivery')).not.toBeInTheDocument()
      })
    })
  })

  describe('AI generation', () => {
    it('shows AI generation section', async () => {
      await renderEmpty()

      expect(screen.getByText('AI Category Suggestions')).toBeInTheDocument()
    })

    it('disables generate button when description is empty', async () => {
      await renderEmpty()

      expect(screen.getByRole('button', { name: /generate categories/i })).toBeDisabled()
    })

    it('calls generate API when button is clicked with description', async () => {
      mockGenerateCategories.mockResolvedValue({
        categories: [{ id: 'gen_1', name: 'generated', description: 'Generated', subcategories: [] }],
      })
      const user = await renderEmpty()

      await generateCategories(user, 'We are an e-commerce company')

      await waitFor(() => {
        expect(mockGenerateCategories).toHaveBeenCalledWith('We are an e-commerce company')
      })
    })

    it('shows error message when generation fails', async () => {
      mockGenerateCategories.mockRejectedValue(new Error('Generation failed'))
      const user = await renderEmpty()

      await generateCategories(user, 'Test company')

      await waitFor(() => {
        expect(screen.getByText(/failed to generate categories/i)).toBeInTheDocument()
      })
    })

    it('shows loading state during generation', async () => {
      mockGenerateCategories.mockImplementation(resolvesAfter({ categories: [] }))
      const user = await renderEmpty()

      await generateCategories(user, 'Test company')

      expect(screen.getByText(/generating/i)).toBeInTheDocument()
    })

    it('saves generated categories automatically', async () => {
      mockGenerateCategories.mockResolvedValue({
        categories: [
          { id: 'gen_1', name: 'generated', description: 'Generated Category', subcategories: [] },
        ],
      })
      const user = await renderEmpty()

      await generateCategories(user, 'Test company')

      await expectSavedCategories(expect.arrayContaining([
        expect.objectContaining({ name: 'generated' }),
      ]))
    })
  })

  describe('save status', () => {
    it('shows success message after saving', async () => {
      const user = await renderEmpty()

      await addCategory(user, 'Test')

      await waitFor(() => {
        expect(screen.getByText('Categories saved successfully')).toBeInTheDocument()
      })
    })

    it('shows saving indicator during save', async () => {
      mockSaveCategoriesConfig.mockImplementation(resolvesAfter({ success: true }))
      const user = await renderEmpty()

      await addCategory(user, 'Test')

      expect(screen.getByText(/saving/i)).toBeInTheDocument()
    })
  })

  describe('edit category', () => {
    it('shows input field when category name is clicked', async () => {
      const user = await renderDelivery()

      expect(await startRename(user, 'Delivery')).toHaveAccessibleName('Rename Delivery')
    })

    it('saves category when Enter is pressed', async () => {
      const user = await renderDelivery()
      const input = await startRename(user, 'Delivery')

      await user.clear(input)
      await user.type(input, 'Updated Delivery{Enter}')

      await expectSavedCategories(expect.arrayContaining([
        expect.objectContaining({ description: 'Updated Delivery' }),
      ]))
    })

    it('cancels edit when Escape is pressed', async () => {
      const user = await renderDelivery()
      const input = await startRename(user, 'Delivery')

      await user.type(input, '{Escape}')

      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
        expect(screen.queryByDisplayValue('Delivery')).not.toBeInTheDocument()
      })
    })

    it('saves category when input loses focus', async () => {
      const user = await renderDelivery()
      const input = await startRename(user, 'Delivery')

      await user.clear(input)
      await user.type(input, 'Updated')
      await user.click(document.body)

      await expectSavedCategories([expect.objectContaining({ name: 'updated', description: 'Updated' })])
    })
  })

  describe('subcategories', () => {
    it('adds subcategory when form is submitted', async () => {
      const user = await renderDelivery()
      await expandDelivery(user)

      await user.type(screen.getByPlaceholderText(ADD_SUBCATEGORY_PLACEHOLDER), 'Late Delivery')
      await user.click(screen.getByRole('button', { name: 'Add subcategory' }))

      await expectSavedCategories(containingSubcategory({ description: 'Late Delivery' }))
    })

    it('adds subcategory when Enter is pressed', async () => {
      const user = await renderDelivery()
      await expandDelivery(user)

      await user.type(screen.getByPlaceholderText(ADD_SUBCATEGORY_PLACEHOLDER), 'Late Delivery{Enter}')

      await expectSavedCategories(containingSubcategory({ name: 'late_delivery', description: 'Late Delivery' }))
    })

    it('converts subcategory name to lowercase with underscores', async () => {
      const user = await renderDelivery()
      await expandDelivery(user)

      await user.type(screen.getByPlaceholderText(ADD_SUBCATEGORY_PLACEHOLDER), 'Very Late Delivery{Enter}')

      await expectSavedCategories(containingSubcategory({
        name: 'very_late_delivery',
        description: 'Very Late Delivery',
      }))
    })

    it('deletes subcategory when delete button is clicked', async () => {
      const user = await renderDelivery([LATE_DELIVERY])
      await expandDelivery(user, 'Late Delivery')

      // Icon-only delete buttons are named after the row they act on
      await user.click(screen.getByRole('button', { name: 'Delete subcategory Late Delivery' }))

      await expectSavedCategories(expect.arrayContaining([
        expect.objectContaining({ subcategories: [] }),
      ]))
    })

    it('edits subcategory when clicked', async () => {
      const user = await renderDelivery([LATE_DELIVERY])
      await expandDelivery(user, 'Late Delivery')

      expect(await startRename(user, 'Late Delivery')).toHaveAccessibleName('Rename Late Delivery')
    })

    it('saves subcategory when input loses focus', async () => {
      const user = await renderDelivery([LATE_DELIVERY])
      await expandDelivery(user, 'Late Delivery')
      const input = await startRename(user, 'Late Delivery')

      await user.clear(input)
      await user.type(input, 'Very Late')
      await user.click(document.body)

      await expectSavedCategories(containingSubcategory({ id: 'sub_1', name: 'very_late', description: 'Very Late' }))
    })

    it('does not add subcategory when input is empty', async () => {
      const user = await renderDelivery()
      await expandDelivery(user)

      // Try to add empty subcategory (input is already empty)
      await user.type(screen.getByPlaceholderText(ADD_SUBCATEGORY_PLACEHOLDER), '{Enter}')

      // Wait a bit to ensure any async calls complete
      await new Promise(resolve => setTimeout(resolve, 50))

      // The empty name is refused before any save is attempted.
      expect(mockSaveCategoriesConfig).not.toHaveBeenCalled()
    })
  })

  describe('name display without description', () => {
    it('shows category name when description is missing', async () => {
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{ id: 'cat_1', name: 'delivery_issues', subcategories: [] }],
      })

      renderComponent()

      expect((await screen.findAllByText('delivery_issues')).length).toBeGreaterThan(0)
    })

    it('shows subcategory name when description is missing', async () => {
      const user = await renderDelivery([{ id: 'sub_1', name: 'late_delivery' }])

      await user.click(screen.getByRole('button', { name: 'Expand Delivery' }))

      expect((await screen.findAllByText('late_delivery', {}, { timeout: 2000 })).length).toBeGreaterThan(0)
    })
  })
})


describe('sparse legacy rows (issue #181)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSaveCategoriesConfig.mockResolvedValue({ success: true })
  })

  it('renders a legacy row without id/subcategories instead of crashing the tab', async () => {
    // Exactly what the wire delivered when Settings → Categories crashed:
    // old DynamoDB rows carry {name, display_name, color} only.
    await renderWithCategories([
      { name: 'app', display_name: 'Mobile App', description: 'App experience', color: '#EC4899' },
    ], 'App experience')

    expect(screen.getByText('0 subs')).toBeInTheDocument()
  })
})

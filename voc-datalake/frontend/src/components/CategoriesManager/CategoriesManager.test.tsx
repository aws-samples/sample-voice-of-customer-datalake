/**
 * @fileoverview Tests for CategoriesManager component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mockGetCategoriesConfig = vi.fn()
const mockSaveCategoriesConfig = vi.fn()
const mockGenerateCategories = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    getCategoriesConfig: () => mockGetCategoriesConfig(),
    saveCategoriesConfig: (config: unknown) => mockSaveCategoriesConfig(config),
    generateCategories: (desc: string) => mockGenerateCategories(desc),
  },
}))

import CategoriesManager from './CategoriesManager'

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  })
}
function renderCM(qc: QueryClient) {
  return render(<QueryClientProvider client={qc}><CategoriesManager /></QueryClientProvider>)
}
/* eslint-disable testing-library/no-node-access */
async function expandCategory(container: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
  const buttons = [...container.querySelectorAll('button')]
  const btn = buttons.find(b => b.querySelector('svg.lucide-chevron-right'))
  expect(btn).toBeInTheDocument()
  await user.click(btn!)
}
async function clickDelete(container: HTMLElement, user: ReturnType<typeof userEvent.setup>) {
  const buttons = [...container.querySelectorAll('button')]
  const btn = buttons.find(b => b.querySelector('svg.lucide-trash-2'))
  expect(btn).toBeInTheDocument()
  await user.click(btn!)
}
/* eslint-enable testing-library/no-node-access */

const SINGLE_CAT = { categories: [{ id: 'cat_1', name: 'delivery', description: 'Delivery', subcategories: [] }] }
const CAT_WITH_SUB = { categories: [{ id: 'cat_1', name: 'delivery', description: 'Delivery', subcategories: [{ id: 'sub_1', name: 'late', description: 'Late Delivery' }] }] }
const CAT_EMPTY_SUBS = { categories: [{ id: 'cat_1', name: 'delivery', description: 'Delivery', subcategories: [] }] }

describe('CategoriesManager', () => {
  let qc: QueryClient
  beforeEach(() => {
    vi.clearAllMocks()
    qc = createQueryClient()
    mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
    mockSaveCategoriesConfig.mockResolvedValue({ success: true })
    mockGenerateCategories.mockResolvedValue({ categories: [] })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching categories', () => {
      mockGetCategoriesConfig.mockReturnValue(new Promise(() => {}))
      const { container } = renderCM(qc)
      // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
      expect(container.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('displays empty state message when no categories exist', async () => {
      renderCM(qc)
      await waitFor(() => { expect(screen.getByText('No categories configured yet.')).toBeInTheDocument() })
    })
  })

  describe('categories display', () => {
    it('displays categories list when data exists', async () => {
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [
          { id: 'cat_1', name: 'delivery', description: 'Delivery Issues', subcategories: [] },
          { id: 'cat_2', name: 'quality', description: 'Product Quality', subcategories: [] },
        ],
      })
      renderCM(qc)
      await waitFor(() => {
        expect(screen.getByText('Delivery Issues')).toBeInTheDocument()
        expect(screen.getByText('Product Quality')).toBeInTheDocument()
      })
    })
    it('shows category count in header', async () => {
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [
          { id: 'cat_1', name: 'delivery', description: 'Delivery', subcategories: [] },
          { id: 'cat_2', name: 'quality', description: 'Quality', subcategories: [] },
        ],
      })
      renderCM(qc)
      await waitFor(() => { expect(screen.getByText('2 categories')).toBeInTheDocument() })
    })
    it('shows subcategory count for each category', async () => {
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{
          id: 'cat_1', name: 'delivery', description: 'Delivery',
          subcategories: [
            { id: 'sub_1', name: 'late', description: 'Late Delivery' },
            { id: 'sub_2', name: 'damaged', description: 'Damaged Package' },
          ],
        }],
      })
      renderCM(qc)
      await waitFor(() => { expect(screen.getByText('2 sub')).toBeInTheDocument() })
    })
  })

  describe('add category', () => {
    it('adds new category when form is submitted', async () => {
      const user = userEvent.setup()
      renderCM(qc)
      await waitFor(() => { expect(screen.getByPlaceholderText('Add new category...')).toBeInTheDocument() })
      await user.type(screen.getByPlaceholderText('Add new category...'), 'New Category')
      await user.click(screen.getByRole('button', { name: /add category/i }))
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalledWith({
          categories: expect.arrayContaining([
            expect.objectContaining({ name: 'new_category', description: 'New Category' }),
          ]),
        })
      })
    })
    it('disables add button when input is empty', async () => {
      renderCM(qc)
      await waitFor(() => { expect(screen.getByRole('button', { name: /add category/i })).toBeDisabled() })
    })
  })

  describe('delete category', () => {
    it('shows confirmation modal when delete is clicked', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue(SINGLE_CAT)
      const { container } = renderCM(qc)
      await waitFor(() => { expect(screen.getByText('Delivery')).toBeInTheDocument() })
      await clickDelete(container, user)
      await waitFor(() => {
        expect(screen.getByText('Delete Category')).toBeInTheDocument()
        expect(screen.getByText(/are you sure you want to delete this category/i)).toBeInTheDocument()
      })
    })
  })

  describe('expand/collapse', () => {
    it('expands category to show subcategories when clicked', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue(CAT_WITH_SUB)
      const { container } = renderCM(qc)
      await waitFor(() => { expect(screen.getByText('Delivery')).toBeInTheDocument() })
      await expandCategory(container, user)
      await waitFor(() => { expect(screen.getByText('Late Delivery')).toBeInTheDocument() })
    })
  })

  describe('AI generation', () => {
    it('shows AI generation section', async () => {
      renderCM(qc)
      await waitFor(() => { expect(screen.getByText('AI Category Suggestions')).toBeInTheDocument() })
    })
    it('disables generate button when description is empty', async () => {
      renderCM(qc)
      await waitFor(() => { expect(screen.getByRole('button', { name: /generate categories/i })).toBeDisabled() })
    })
    it('calls generate API when button is clicked with description', async () => {
      const user = userEvent.setup()
      mockGenerateCategories.mockResolvedValue({
        categories: [{ id: 'gen_1', name: 'generated', description: 'Generated', subcategories: [] }],
      })
      renderCM(qc)
      await waitFor(() => { expect(screen.getByPlaceholderText(/e\.g\., We are an airline/i)).toBeInTheDocument() })
      await user.type(screen.getByPlaceholderText(/e\.g\., We are an airline/i), 'We are an e-commerce company')
      await user.click(screen.getByRole('button', { name: /generate categories/i }))
      await waitFor(() => { expect(mockGenerateCategories).toHaveBeenCalledWith('We are an e-commerce company') })
    })
    it('shows error message when generation fails', async () => {
      const user = userEvent.setup()
      mockGenerateCategories.mockRejectedValue(new Error('Generation failed'))
      renderCM(qc)
      await waitFor(() => { expect(screen.getByPlaceholderText(/e\.g\., We are an airline/i)).toBeInTheDocument() })
      await user.type(screen.getByPlaceholderText(/e\.g\., We are an airline/i), 'Test company')
      await user.click(screen.getByRole('button', { name: /generate categories/i }))
      await waitFor(() => { expect(screen.getByText(/failed to generate categories/i)).toBeInTheDocument() })
    })
  })

  describe('save status', () => {
    it('shows success message after saving', async () => {
      const user = userEvent.setup()
      renderCM(qc)
      await waitFor(() => { expect(screen.getByPlaceholderText('Add new category...')).toBeInTheDocument() })
      await user.type(screen.getByPlaceholderText('Add new category...'), 'Test')
      await user.click(screen.getByRole('button', { name: /add category/i }))
      await waitFor(() => { expect(screen.getByText('Categories saved successfully')).toBeInTheDocument() })
    })
  })

  describe('edit category', () => {
    it('shows input field when category name is clicked', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue(SINGLE_CAT)
      renderCM(qc)
      await waitFor(() => { expect(screen.getByText('Delivery')).toBeInTheDocument() })
      await user.click(screen.getByText('Delivery'))
      await waitFor(() => { expect(screen.getByDisplayValue('Delivery')).toBeInTheDocument() })
    })
    it('saves category when Enter is pressed', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue(SINGLE_CAT)
      renderCM(qc)
      await waitFor(() => { expect(screen.getByText('Delivery')).toBeInTheDocument() })
      await user.click(screen.getByText('Delivery'))
      const input = await screen.findByDisplayValue('Delivery')
      await user.clear(input)
      await user.type(input, 'Updated Delivery{Enter}')
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalledWith({
          categories: expect.arrayContaining([expect.objectContaining({ description: 'Updated Delivery' })]),
        })
      })
    })
    it('cancels edit when Escape is pressed', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue(SINGLE_CAT)
      renderCM(qc)
      await waitFor(() => { expect(screen.getByText('Delivery')).toBeInTheDocument() })
      await user.click(screen.getByText('Delivery'))
      const input = await screen.findByDisplayValue('Delivery')
      await user.type(input, '{Escape}')
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
        expect(screen.queryByDisplayValue('Delivery')).not.toBeInTheDocument()
      })
    })
  })

  describe('subcategories', () => {
    it('adds subcategory when form is submitted', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue(CAT_EMPTY_SUBS)
      const { container } = renderCM(qc)
      await waitFor(() => { expect(screen.getByText('Delivery')).toBeInTheDocument() })
      await expandCategory(container, user)
      await waitFor(() => { expect(screen.getByPlaceholderText('Add subcategory...')).toBeInTheDocument() })
      await user.type(screen.getByPlaceholderText('Add subcategory...'), 'Late Delivery')
      /* eslint-disable testing-library/no-container, testing-library/no-node-access */
      const addSubBtns = [...container.querySelectorAll('.bg-white button')]
      const addSubBtn = addSubBtns.find(b => b.querySelector('svg.lucide-plus'))
      /* eslint-enable testing-library/no-container, testing-library/no-node-access */
      expect(addSubBtn).toBeInTheDocument()
      await user.click(addSubBtn!)
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalledWith({
          categories: expect.arrayContaining([
            expect.objectContaining({
              subcategories: expect.arrayContaining([expect.objectContaining({ description: 'Late Delivery' })]),
            }),
          ]),
        })
      })
    })
    it('adds subcategory when Enter is pressed', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue(CAT_EMPTY_SUBS)
      const { container } = renderCM(qc)
      await waitFor(() => { expect(screen.getByText('Delivery')).toBeInTheDocument() })
      await expandCategory(container, user)
      await waitFor(() => { expect(screen.getByPlaceholderText('Add subcategory...')).toBeInTheDocument() })
      await user.type(screen.getByPlaceholderText('Add subcategory...'), 'Late Delivery{Enter}')
      await waitFor(() => { expect(mockSaveCategoriesConfig).toHaveBeenCalledWith(expect.anything()) })
    })
    it('deletes subcategory when delete button is clicked', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue(CAT_WITH_SUB)
      const { container } = renderCM(qc)
      await waitFor(() => { expect(screen.getByText('Delivery')).toBeInTheDocument() })
      await expandCategory(container, user)
      await waitFor(() => { expect(screen.getByText('Late Delivery')).toBeInTheDocument() })
      /* eslint-disable testing-library/no-container, testing-library/no-node-access */
      const allBtns = [...container.querySelectorAll('button')]
      const subDeleteBtn = allBtns.find(b => {
        const svg = b.querySelector('svg.lucide-trash-2')
        return svg && svg.getAttribute('height') === '12'
      })
      /* eslint-enable testing-library/no-container, testing-library/no-node-access */
      expect(subDeleteBtn).toBeInTheDocument()
      await user.click(subDeleteBtn!)
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalledWith({
          categories: expect.arrayContaining([expect.objectContaining({ subcategories: [] })]),
        })
      })
    })
    it('edits subcategory when clicked', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue(CAT_WITH_SUB)
      const { container } = renderCM(qc)
      await waitFor(() => { expect(screen.getByText('Delivery')).toBeInTheDocument() })
      await expandCategory(container, user)
      await waitFor(() => { expect(screen.getByText('Late Delivery')).toBeInTheDocument() })
      await user.click(screen.getByText('Late Delivery'))
      await waitFor(() => { expect(screen.getByDisplayValue('Late Delivery')).toBeInTheDocument() })
    })
  })

  describe('confirm delete modal', () => {
    it('deletes category when confirmed', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue(SINGLE_CAT)
      const { container } = renderCM(qc)
      await waitFor(() => { expect(screen.getByText('Delivery')).toBeInTheDocument() })
      await clickDelete(container, user)
      await waitFor(() => { expect(screen.getByText('Delete Category')).toBeInTheDocument() })
      await user.click(screen.getByRole('button', { name: /delete/i }))
      await waitFor(() => { expect(mockSaveCategoriesConfig).toHaveBeenCalledWith({ categories: [] }) })
    })
    it('cancels deletion when cancel is clicked', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue(SINGLE_CAT)
      const { container } = renderCM(qc)
      await waitFor(() => { expect(screen.getByText('Delivery')).toBeInTheDocument() })
      await clickDelete(container, user)
      await waitFor(() => { expect(screen.getByText('Delete Category')).toBeInTheDocument() })
      await user.click(screen.getByRole('button', { name: /cancel/i }))
      await waitFor(() => { expect(screen.queryByText('Delete Category')).not.toBeInTheDocument() })
      expect(screen.getByText('Delivery')).toBeInTheDocument()
    })
  })

  describe('add category via Enter key', () => {
    it('adds category when Enter is pressed in input', async () => {
      const user = userEvent.setup()
      renderCM(qc)
      await waitFor(() => { expect(screen.getByPlaceholderText('Add new category...')).toBeInTheDocument() })
      await user.type(screen.getByPlaceholderText('Add new category...'), 'New Category{Enter}')
      await waitFor(() => { expect(mockSaveCategoriesConfig).toHaveBeenCalledWith(expect.anything()) })
    })
  })

  describe('category name display', () => {
    it('shows category name when description is missing', async () => {
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{ id: 'cat_1', name: 'delivery_issues', subcategories: [] }],
      })
      renderCM(qc)
      await waitFor(() => { expect(screen.getAllByText('delivery_issues').length).toBeGreaterThan(0) })
    })
  })

  describe('subcategory name display', () => {
    it('shows subcategory name when description is missing', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{
          id: 'cat_1', name: 'delivery', description: 'Delivery',
          subcategories: [{ id: 'sub_1', name: 'late_delivery' }],
        }],
      })
      const { container } = renderCM(qc)
      await waitFor(() => { expect(screen.getByText('Delivery')).toBeInTheDocument() })
      await expandCategory(container, user)
      await waitFor(() => { expect(screen.getAllByText('late_delivery').length).toBeGreaterThan(0) }, { timeout: 2000 })
    })
  })

  describe('edit category on blur', () => {
    it('saves category when input loses focus', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue(SINGLE_CAT)
      renderCM(qc)
      await waitFor(() => { expect(screen.getByText('Delivery')).toBeInTheDocument() })
      await user.click(screen.getByText('Delivery'))
      const input = await screen.findByDisplayValue('Delivery')
      await user.clear(input)
      await user.type(input, 'Updated')
      await user.click(document.body)
      await waitFor(() => { expect(mockSaveCategoriesConfig).toHaveBeenCalledWith(expect.anything()) })
    })
  })

  describe('edit subcategory on blur', () => {
    it('saves subcategory when input loses focus', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue(CAT_WITH_SUB)
      const { container } = renderCM(qc)
      await waitFor(() => { expect(screen.getByText('Delivery')).toBeInTheDocument() })
      await expandCategory(container, user)
      await waitFor(() => { expect(screen.getByText('Late Delivery')).toBeInTheDocument() })
      await user.click(screen.getByText('Late Delivery'))
      const input = await screen.findByDisplayValue('Late Delivery')
      await user.clear(input)
      await user.type(input, 'Very Late')
      await user.click(document.body)
      await waitFor(() => { expect(mockSaveCategoriesConfig).toHaveBeenCalledWith(expect.anything()) })
    })
  })

  describe('collapse expanded category', () => {
    it('collapses category when expand button is clicked again', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue(CAT_WITH_SUB)
      const { container } = renderCM(qc)
      await waitFor(() => { expect(screen.getByText('Delivery')).toBeInTheDocument() })
      await expandCategory(container, user)
      await waitFor(() => { expect(screen.getByText('Late Delivery')).toBeInTheDocument() })
      /* eslint-disable testing-library/no-container, testing-library/no-node-access */
      const allBtns = [...container.querySelectorAll('button')]
      const collapseBtn = allBtns.find(b => b.querySelector('svg.lucide-chevron-down') || b.querySelector('svg.lucide-chevron-right'))
      /* eslint-enable testing-library/no-container, testing-library/no-node-access */
      expect(collapseBtn).toBeInTheDocument()
      await user.click(collapseBtn!)
      await waitFor(() => { expect(screen.queryByText('Late Delivery')).not.toBeInTheDocument() })
    })
  })

  describe('AI generation loading state', () => {
    it('shows loading state during generation', async () => {
      const user = userEvent.setup()
      mockGenerateCategories.mockImplementation(() => new Promise(resolve => {
        setTimeout(() => resolve({ categories: [] }), 100)
      }))
      renderCM(qc)
      await waitFor(() => { expect(screen.getByPlaceholderText(/e\.g\., We are an airline/i)).toBeInTheDocument() })
      await user.type(screen.getByPlaceholderText(/e\.g\., We are an airline/i), 'Test company')
      await user.click(screen.getByRole('button', { name: /generate categories/i }))
      expect(screen.getByText(/generating/i)).toBeInTheDocument()
    })
  })

  describe('AI generation success', () => {
    it('saves generated categories automatically', async () => {
      const user = userEvent.setup()
      mockGenerateCategories.mockResolvedValue({
        categories: [{ id: 'gen_1', name: 'generated', description: 'Generated Category', subcategories: [] }],
      })
      renderCM(qc)
      await waitFor(() => { expect(screen.getByPlaceholderText(/e\.g\., We are an airline/i)).toBeInTheDocument() })
      await user.type(screen.getByPlaceholderText(/e\.g\., We are an airline/i), 'Test company')
      await user.click(screen.getByRole('button', { name: /generate categories/i }))
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalledWith({
          categories: expect.arrayContaining([expect.objectContaining({ name: 'generated' })]),
        })
      })
    })
  })

  describe('saving status', () => {
    it('shows saving indicator during save', async () => {
      const user = userEvent.setup()
      mockSaveCategoriesConfig.mockImplementation(() => new Promise(resolve => {
        setTimeout(() => resolve({ success: true }), 100)
      }))
      renderCM(qc)
      await waitFor(() => { expect(screen.getByPlaceholderText('Add new category...')).toBeInTheDocument() })
      await user.type(screen.getByPlaceholderText('Add new category...'), 'Test')
      await user.click(screen.getByRole('button', { name: /add category/i }))
      expect(screen.getByText(/saving/i)).toBeInTheDocument()
    })
  })

  describe('empty subcategory input', () => {
    it('does not add subcategory when input is empty', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue(CAT_EMPTY_SUBS)
      const { container } = renderCM(qc)
      await waitFor(() => { expect(screen.getByText('Delivery')).toBeInTheDocument() })
      await expandCategory(container, user)
      await waitFor(() => { expect(screen.getByPlaceholderText('Add subcategory...')).toBeInTheDocument() })
      await user.type(screen.getByPlaceholderText('Add subcategory...'), '{Enter}')
      await new Promise(resolve => setTimeout(resolve, 50))
      const saveCalls = mockSaveCategoriesConfig.mock.calls
      const deliverySaves = saveCalls
        .map(call => call[0]?.categories ?? call[0])
        .filter(Array.isArray)
        .map(cats => (cats as Array<{ id: string; subcategories?: unknown[] }>).find(c => c.id === 'cat_1'))
        .filter(Boolean)
      expect(deliverySaves.every(d => (d?.subcategories?.length ?? 0) === 0)).toBe(true)
    })
  })

  describe('empty category input', () => {
    it('does not add category when input is empty', async () => {
      const user = userEvent.setup()
      renderCM(qc)
      await waitFor(() => { expect(screen.getByPlaceholderText('Add new category...')).toBeInTheDocument() })
      await user.type(screen.getByPlaceholderText('Add new category...'), '{Enter}')
      expect(mockSaveCategoriesConfig).not.toHaveBeenCalled()
    })
  })

  describe('category name normalization', () => {
    it('converts category name to lowercase with underscores', async () => {
      const user = userEvent.setup()
      renderCM(qc)
      await waitFor(() => { expect(screen.getByPlaceholderText('Add new category...')).toBeInTheDocument() })
      await user.type(screen.getByPlaceholderText('Add new category...'), 'Customer Support Issues')
      await user.click(screen.getByRole('button', { name: /add category/i }))
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalledWith({
          categories: expect.arrayContaining([
            expect.objectContaining({ name: 'customer_support_issues', description: 'Customer Support Issues' }),
          ]),
        })
      })
    })
  })

  describe('subcategory name normalization', () => {
    it('converts subcategory name to lowercase with underscores', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue(CAT_EMPTY_SUBS)
      const { container } = renderCM(qc)
      await waitFor(() => { expect(screen.getByText('Delivery')).toBeInTheDocument() })
      await expandCategory(container, user)
      await waitFor(() => { expect(screen.getByPlaceholderText('Add subcategory...')).toBeInTheDocument() })
      await user.type(screen.getByPlaceholderText('Add subcategory...'), 'Very Late Delivery{Enter}')
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalledWith({
          categories: expect.arrayContaining([
            expect.objectContaining({
              subcategories: expect.arrayContaining([
                expect.objectContaining({ name: 'very_late_delivery', description: 'Very Late Delivery' }),
              ]),
            }),
          ]),
        })
      })
    })
  })
})

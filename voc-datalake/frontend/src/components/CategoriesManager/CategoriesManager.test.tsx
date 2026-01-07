/**
 * @fileoverview Tests for CategoriesManager component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

// Mock API before importing component
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

describe('CategoriesManager', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.clearAllMocks()
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
    })
    mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
    mockSaveCategoriesConfig.mockResolvedValue({ success: true })
    mockGenerateCategories.mockResolvedValue({ categories: [] })
  })

  function renderComponent() {
    return render(
      <QueryClientProvider client={queryClient}>
        <CategoriesManager />
      </QueryClientProvider>
    )
  }

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
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [
          { id: 'cat_1', name: 'delivery', description: 'Delivery Issues', subcategories: [] },
          { id: 'cat_2', name: 'quality', description: 'Product Quality', subcategories: [] },
        ],
      })
      
      renderComponent()
      
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
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('2 categories')).toBeInTheDocument()
      })
    })

    it('shows subcategory count for each category', async () => {
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [
          {
            id: 'cat_1',
            name: 'delivery',
            description: 'Delivery',
            subcategories: [
              { id: 'sub_1', name: 'late', description: 'Late Delivery' },
              { id: 'sub_2', name: 'damaged', description: 'Damaged Package' },
            ],
          },
        ],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('2 sub')).toBeInTheDocument()
      })
    })
  })

  describe('add category', () => {
    it('adds new category when form is submitted', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Add new category...')).toBeInTheDocument()
      })
      
      const input = screen.getByPlaceholderText('Add new category...')
      await user.type(input, 'New Category')
      await user.click(screen.getByRole('button', { name: /add category/i }))
      
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalledWith({
          categories: expect.arrayContaining([
            expect.objectContaining({
              name: 'new_category',
              description: 'New Category',
            }),
          ]),
        })
      })
    })

    it('disables add button when input is empty', async () => {
      mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
      
      renderComponent()
      
      await waitFor(() => {
        const addButton = screen.getByRole('button', { name: /add category/i })
        expect(addButton).toBeDisabled()
      })
    })
  })

  describe('delete category', () => {
    it('shows confirmation modal when delete is clicked', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{ id: 'cat_1', name: 'delivery', description: 'Delivery', subcategories: [] }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
      })
      
      const deleteButtons = screen.getAllByRole('button')
      const deleteButton = deleteButtons.find(btn => btn.querySelector('svg.lucide-trash-2'))
      await user.click(deleteButton!)
      
      await waitFor(() => {
        expect(screen.getByText('Delete Category')).toBeInTheDocument()
        expect(screen.getByText(/are you sure you want to delete this category/i)).toBeInTheDocument()
      })
    })
  })

  describe('expand/collapse', () => {
    it('expands category to show subcategories when clicked', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [
          {
            id: 'cat_1',
            name: 'delivery',
            description: 'Delivery',
            subcategories: [{ id: 'sub_1', name: 'late', description: 'Late Delivery' }],
          },
        ],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
      })
      
      // Click expand button - it's a button with ChevronRight icon
      const deliveryRow = screen.getByText('Delivery').closest('div')
      const expandButton = deliveryRow?.querySelector('button')
      if (expandButton) await user.click(expandButton)
      
      await waitFor(() => {
        expect(screen.getByText('Late Delivery')).toBeInTheDocument()
      })
    })
  })

  describe('AI generation', () => {
    it('shows AI generation section', async () => {
      mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('AI Category Suggestions')).toBeInTheDocument()
      })
    })

    it('disables generate button when description is empty', async () => {
      mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
      
      renderComponent()
      
      await waitFor(() => {
        const generateButton = screen.getByRole('button', { name: /generate categories/i })
        expect(generateButton).toBeDisabled()
      })
    })

    it('calls generate API when button is clicked with description', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
      mockGenerateCategories.mockResolvedValue({
        categories: [{ id: 'gen_1', name: 'generated', description: 'Generated', subcategories: [] }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/e\.g\., We are an airline/i)).toBeInTheDocument()
      })
      
      const textarea = screen.getByPlaceholderText(/e\.g\., We are an airline/i)
      await user.type(textarea, 'We are an e-commerce company')
      await user.click(screen.getByRole('button', { name: /generate categories/i }))
      
      await waitFor(() => {
        expect(mockGenerateCategories).toHaveBeenCalledWith('We are an e-commerce company')
      })
    })

    it('shows error message when generation fails', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
      mockGenerateCategories.mockRejectedValue(new Error('Generation failed'))
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/e\.g\., We are an airline/i)).toBeInTheDocument()
      })
      
      const textarea = screen.getByPlaceholderText(/e\.g\., We are an airline/i)
      await user.type(textarea, 'Test company')
      await user.click(screen.getByRole('button', { name: /generate categories/i }))
      
      await waitFor(() => {
        expect(screen.getByText(/failed to generate categories/i)).toBeInTheDocument()
      })
    })
  })

  describe('save status', () => {
    it('shows success message after saving', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
      mockSaveCategoriesConfig.mockResolvedValue({ success: true })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Add new category...')).toBeInTheDocument()
      })
      
      const input = screen.getByPlaceholderText('Add new category...')
      await user.type(input, 'Test')
      await user.click(screen.getByRole('button', { name: /add category/i }))
      
      await waitFor(() => {
        expect(screen.getByText('Categories saved successfully')).toBeInTheDocument()
      })
    })
  })

  describe('edit category', () => {
    it('shows input field when category name is clicked', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{ id: 'cat_1', name: 'delivery', description: 'Delivery', subcategories: [] }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
      })
      
      await user.click(screen.getByText('Delivery'))
      
      await waitFor(() => {
        expect(screen.getByDisplayValue('Delivery')).toBeInTheDocument()
      })
    })

    it('saves category when Enter is pressed', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{ id: 'cat_1', name: 'delivery', description: 'Delivery', subcategories: [] }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
      })
      
      await user.click(screen.getByText('Delivery'))
      
      const input = await screen.findByDisplayValue('Delivery')
      await user.clear(input)
      await user.type(input, 'Updated Delivery{Enter}')
      
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalledWith({
          categories: expect.arrayContaining([
            expect.objectContaining({ description: 'Updated Delivery' }),
          ]),
        })
      })
    })

    it('cancels edit when Escape is pressed', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{ id: 'cat_1', name: 'delivery', description: 'Delivery', subcategories: [] }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
      })
      
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
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{
          id: 'cat_1',
          name: 'delivery',
          description: 'Delivery',
          subcategories: [],
        }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
      })
      
      // Expand category
      const expandButton = screen.getByText('Delivery').closest('div')?.querySelector('button')
      if (expandButton) await user.click(expandButton)
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Add subcategory...')).toBeInTheDocument()
      })
      
      const subInput = screen.getByPlaceholderText('Add subcategory...')
      await user.type(subInput, 'Late Delivery')
      
      // Find and click the add subcategory button (Plus icon)
      const addButtons = screen.getAllByRole('button')
      const addSubButton = addButtons.find(btn => btn.querySelector('svg.lucide-plus') && btn.closest('.bg-white'))
      if (addSubButton) await user.click(addSubButton)
      
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalledWith({
          categories: expect.arrayContaining([
            expect.objectContaining({
              subcategories: expect.arrayContaining([
                expect.objectContaining({ description: 'Late Delivery' }),
              ]),
            }),
          ]),
        })
      })
    })

    it('adds subcategory when Enter is pressed', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{
          id: 'cat_1',
          name: 'delivery',
          description: 'Delivery',
          subcategories: [],
        }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
      })
      
      // Expand category
      const expandButton = screen.getByText('Delivery').closest('div')?.querySelector('button')
      if (expandButton) await user.click(expandButton)
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Add subcategory...')).toBeInTheDocument()
      })
      
      const subInput = screen.getByPlaceholderText('Add subcategory...')
      await user.type(subInput, 'Late Delivery{Enter}')
      
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalled()
      })
    })

    it('deletes subcategory when delete button is clicked', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{
          id: 'cat_1',
          name: 'delivery',
          description: 'Delivery',
          subcategories: [{ id: 'sub_1', name: 'late', description: 'Late Delivery' }],
        }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
      })
      
      // Expand category
      const expandButton = screen.getByText('Delivery').closest('div')?.querySelector('button')
      if (expandButton) await user.click(expandButton)
      
      await waitFor(() => {
        expect(screen.getByText('Late Delivery')).toBeInTheDocument()
      })
      
      // Find delete button for subcategory (smaller trash icon)
      const subRow = screen.getByText('Late Delivery').closest('div')
      const deleteBtn = subRow?.querySelector('button')
      if (deleteBtn) await user.click(deleteBtn)
      
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalledWith({
          categories: expect.arrayContaining([
            expect.objectContaining({
              subcategories: [],
            }),
          ]),
        })
      })
    })

    it('edits subcategory when clicked', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{
          id: 'cat_1',
          name: 'delivery',
          description: 'Delivery',
          subcategories: [{ id: 'sub_1', name: 'late', description: 'Late Delivery' }],
        }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
      })
      
      // Expand category
      const expandButton = screen.getByText('Delivery').closest('div')?.querySelector('button')
      if (expandButton) await user.click(expandButton)
      
      await waitFor(() => {
        expect(screen.getByText('Late Delivery')).toBeInTheDocument()
      })
      
      await user.click(screen.getByText('Late Delivery'))
      
      await waitFor(() => {
        expect(screen.getByDisplayValue('Late Delivery')).toBeInTheDocument()
      })
    })
  })

  describe('confirm delete modal', () => {
    it('deletes category when confirmed', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{ id: 'cat_1', name: 'delivery', description: 'Delivery', subcategories: [] }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
      })
      
      // Click delete button
      const deleteButtons = screen.getAllByRole('button')
      const deleteButton = deleteButtons.find(btn => btn.querySelector('svg.lucide-trash-2'))
      await user.click(deleteButton!)
      
      await waitFor(() => {
        expect(screen.getByText('Delete Category')).toBeInTheDocument()
      })
      
      // Confirm deletion
      await user.click(screen.getByRole('button', { name: /delete/i }))
      
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalledWith({
          categories: [],
        })
      })
    })

    it('cancels deletion when cancel is clicked', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{ id: 'cat_1', name: 'delivery', description: 'Delivery', subcategories: [] }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
      })
      
      // Click delete button
      const deleteButtons = screen.getAllByRole('button')
      const deleteButton = deleteButtons.find(btn => btn.querySelector('svg.lucide-trash-2'))
      await user.click(deleteButton!)
      
      await waitFor(() => {
        expect(screen.getByText('Delete Category')).toBeInTheDocument()
      })
      
      // Cancel deletion
      await user.click(screen.getByRole('button', { name: /cancel/i }))
      
      await waitFor(() => {
        expect(screen.queryByText('Delete Category')).not.toBeInTheDocument()
      })
      
      // Category should still exist
      expect(screen.getByText('Delivery')).toBeInTheDocument()
    })
  })

  describe('add category via Enter key', () => {
    it('adds category when Enter is pressed in input', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Add new category...')).toBeInTheDocument()
      })
      
      const input = screen.getByPlaceholderText('Add new category...')
      await user.type(input, 'New Category{Enter}')
      
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalled()
      })
    })
  })

  describe('category name display', () => {
    it('shows category name when description is missing', async () => {
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{ id: 'cat_1', name: 'delivery_issues', subcategories: [] }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getAllByText('delivery_issues').length).toBeGreaterThan(0)
      })
    })
  })

  describe('subcategory name display', () => {
    it('shows subcategory name when description is missing', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{
          id: 'cat_1',
          name: 'delivery',
          description: 'Delivery',
          subcategories: [{ id: 'sub_1', name: 'late_delivery' }],
        }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
      })
      
      // Expand category by clicking the expand button
      const expandButtons = screen.getAllByRole('button')
      const expandBtn = expandButtons.find(b => b.querySelector('svg.lucide-chevron-right'))
      if (expandBtn) await user.click(expandBtn)
      
      await waitFor(() => {
        expect(screen.getAllByText('late_delivery').length).toBeGreaterThan(0)
      }, { timeout: 2000 })
    })
  })

  describe('edit category on blur', () => {
    it('saves category when input loses focus', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{ id: 'cat_1', name: 'delivery', description: 'Delivery', subcategories: [] }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
      })
      
      await user.click(screen.getByText('Delivery'))
      
      const input = await screen.findByDisplayValue('Delivery')
      await user.clear(input)
      await user.type(input, 'Updated')
      
      // Trigger blur by clicking elsewhere
      await user.click(document.body)
      
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalled()
      })
    })
  })

  describe('edit subcategory on blur', () => {
    it('saves subcategory when input loses focus', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{
          id: 'cat_1',
          name: 'delivery',
          description: 'Delivery',
          subcategories: [{ id: 'sub_1', name: 'late', description: 'Late Delivery' }],
        }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
      })
      
      // Expand category
      const expandButton = screen.getByText('Delivery').closest('div')?.querySelector('button')
      if (expandButton) await user.click(expandButton)
      
      await waitFor(() => {
        expect(screen.getByText('Late Delivery')).toBeInTheDocument()
      })
      
      await user.click(screen.getByText('Late Delivery'))
      
      const input = await screen.findByDisplayValue('Late Delivery')
      await user.clear(input)
      await user.type(input, 'Very Late')
      
      // Trigger blur
      await user.click(document.body)
      
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalled()
      })
    })
  })

  describe('collapse expanded category', () => {
    it('collapses category when expand button is clicked again', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{
          id: 'cat_1',
          name: 'delivery',
          description: 'Delivery',
          subcategories: [{ id: 'sub_1', name: 'late', description: 'Late Delivery' }],
        }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
      })
      
      // Expand category
      const expandButton = screen.getByText('Delivery').closest('div')?.querySelector('button')
      if (expandButton) await user.click(expandButton)
      
      await waitFor(() => {
        expect(screen.getByText('Late Delivery')).toBeInTheDocument()
      })
      
      // Collapse category
      if (expandButton) await user.click(expandButton)
      
      await waitFor(() => {
        expect(screen.queryByText('Late Delivery')).not.toBeInTheDocument()
      })
    })
  })

  describe('AI generation loading state', () => {
    it('shows loading state during generation', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
      
      // Make generation take time
      mockGenerateCategories.mockImplementation(() => new Promise(resolve => {
        setTimeout(() => resolve({ categories: [] }), 100)
      }))
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/e\.g\., We are an airline/i)).toBeInTheDocument()
      })
      
      const textarea = screen.getByPlaceholderText(/e\.g\., We are an airline/i)
      await user.type(textarea, 'Test company')
      await user.click(screen.getByRole('button', { name: /generate categories/i }))
      
      // Should show loading state
      expect(screen.getByText(/generating/i)).toBeInTheDocument()
    })
  })

  describe('AI generation success', () => {
    it('saves generated categories automatically', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
      mockGenerateCategories.mockResolvedValue({
        categories: [
          { id: 'gen_1', name: 'generated', description: 'Generated Category', subcategories: [] },
        ],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/e\.g\., We are an airline/i)).toBeInTheDocument()
      })
      
      const textarea = screen.getByPlaceholderText(/e\.g\., We are an airline/i)
      await user.type(textarea, 'Test company')
      await user.click(screen.getByRole('button', { name: /generate categories/i }))
      
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalledWith({
          categories: expect.arrayContaining([
            expect.objectContaining({ name: 'generated' }),
          ]),
        })
      })
    })
  })

  describe('saving status', () => {
    it('shows saving indicator during save', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
      
      // Make save take time
      mockSaveCategoriesConfig.mockImplementation(() => new Promise(resolve => {
        setTimeout(() => resolve({ success: true }), 100)
      }))
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Add new category...')).toBeInTheDocument()
      })
      
      const input = screen.getByPlaceholderText('Add new category...')
      await user.type(input, 'Test')
      await user.click(screen.getByRole('button', { name: /add category/i }))
      
      // Should show saving state
      expect(screen.getByText(/saving/i)).toBeInTheDocument()
    })
  })

  describe('empty subcategory input', () => {
    it('does not add subcategory when input is empty', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{
          id: 'cat_1',
          name: 'delivery',
          description: 'Delivery',
          subcategories: [],
        }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
      })
      
      // Expand category
      const expandButtons = screen.getAllByRole('button')
      const expandBtn = expandButtons.find(b => b.querySelector('svg.lucide-chevron-right'))
      if (expandBtn) await user.click(expandBtn)
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Add subcategory...')).toBeInTheDocument()
      })
      
      // Get call count before attempting empty submit
      const callsBefore = mockSaveCategoriesConfig.mock.calls.length
      
      // Try to add empty subcategory (input is already empty)
      const subInput = screen.getByPlaceholderText('Add subcategory...')
      await user.type(subInput, '{Enter}')
      
      // Should not have additional calls
      expect(mockSaveCategoriesConfig.mock.calls.length).toBe(callsBefore)
    })
  })

  describe('empty category input', () => {
    it('does not add category when input is empty', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Add new category...')).toBeInTheDocument()
      })
      
      // Try to add empty category
      const input = screen.getByPlaceholderText('Add new category...')
      await user.type(input, '{Enter}')
      
      // Should not call save
      expect(mockSaveCategoriesConfig).not.toHaveBeenCalled()
    })
  })

  describe('category name normalization', () => {
    it('converts category name to lowercase with underscores', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Add new category...')).toBeInTheDocument()
      })
      
      const input = screen.getByPlaceholderText('Add new category...')
      await user.type(input, 'Customer Support Issues')
      await user.click(screen.getByRole('button', { name: /add category/i }))
      
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalledWith({
          categories: expect.arrayContaining([
            expect.objectContaining({
              name: 'customer_support_issues',
              description: 'Customer Support Issues',
            }),
          ]),
        })
      })
    })
  })

  describe('subcategory name normalization', () => {
    it('converts subcategory name to lowercase with underscores', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({
        categories: [{
          id: 'cat_1',
          name: 'delivery',
          description: 'Delivery',
          subcategories: [],
        }],
      })
      
      renderComponent()
      
      await waitFor(() => {
        expect(screen.getByText('Delivery')).toBeInTheDocument()
      })
      
      // Expand category
      const expandButton = screen.getByText('Delivery').closest('div')?.querySelector('button')
      if (expandButton) await user.click(expandButton)
      
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Add subcategory...')).toBeInTheDocument()
      })
      
      const subInput = screen.getByPlaceholderText('Add subcategory...')
      await user.type(subInput, 'Very Late Delivery{Enter}')
      
      await waitFor(() => {
        expect(mockSaveCategoriesConfig).toHaveBeenCalledWith({
          categories: expect.arrayContaining([
            expect.objectContaining({
              subcategories: expect.arrayContaining([
                expect.objectContaining({
                  name: 'very_late_delivery',
                  description: 'Very Late Delivery',
                }),
              ]),
            }),
          ]),
        })
      })
    })
  })
})

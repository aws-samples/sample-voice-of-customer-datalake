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

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('CategoriesManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
    mockSaveCategoriesConfig.mockResolvedValue({ success: true })
    mockGenerateCategories.mockResolvedValue({ categories: [] })
  })

  describe('loading state', () => {
    it('shows loading spinner while fetching categories', () => {
      mockGetCategoriesConfig.mockReturnValue(new Promise(() => {}))
      
      render(<CategoriesManager />, { wrapper: createWrapper() })
      
      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    it('displays empty state message when no categories exist', async () => {
      mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
      
      render(<CategoriesManager />, { wrapper: createWrapper() })
      
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
      
      render(<CategoriesManager />, { wrapper: createWrapper() })
      
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
      
      render(<CategoriesManager />, { wrapper: createWrapper() })
      
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
      
      render(<CategoriesManager />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('2 sub')).toBeInTheDocument()
      })
    })
  })

  describe('add category', () => {
    it('adds new category when form is submitted', async () => {
      const user = userEvent.setup()
      mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
      
      render(<CategoriesManager />, { wrapper: createWrapper() })
      
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
      
      render(<CategoriesManager />, { wrapper: createWrapper() })
      
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
      
      render(<CategoriesManager />, { wrapper: createWrapper() })
      
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
      
      render(<CategoriesManager />, { wrapper: createWrapper() })
      
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
      
      render(<CategoriesManager />, { wrapper: createWrapper() })
      
      await waitFor(() => {
        expect(screen.getByText('AI Category Suggestions')).toBeInTheDocument()
      })
    })

    it('disables generate button when description is empty', async () => {
      mockGetCategoriesConfig.mockResolvedValue({ categories: [] })
      
      render(<CategoriesManager />, { wrapper: createWrapper() })
      
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
      
      render(<CategoriesManager />, { wrapper: createWrapper() })
      
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
      
      render(<CategoriesManager />, { wrapper: createWrapper() })
      
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
      
      render(<CategoriesManager />, { wrapper: createWrapper() })
      
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
})

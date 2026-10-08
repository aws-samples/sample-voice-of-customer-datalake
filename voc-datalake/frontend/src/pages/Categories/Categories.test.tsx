import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { at } from '@test/defined'
import type { UserEvent } from '@testing-library/user-event'
import {
  categoriesApiMocks, clientApiModule, configStoreModule, createQueryWrapper,
  feedbackItem, rechartsStubModule,
} from './categories-fixtures'
import enCommon from '../../../public/locales/en/common.json'
import enCategories from '../../../public/locales/en/categories.json'

// The rating picker, view toggle and sentiment legend are toggle buttons too,
// so "which category is selected" is asked of the distribution card alone.
const distribution = () => within(screen.getByRole('region', { name: 'Category Distribution' }))

// Mock API before importing component
vi.mock('../../api/client', () => clientApiModule())
vi.mock('../../store/configStore', () => configStoreModule())
vi.mock('recharts', () => rechartsStubModule())

import Categories from './Categories'

const mockCategoriesData = {
  categories: {
    delivery: 50,
    customer_support: 30,
    pricing: 20,
  },
}

const mockSentimentData = {
  breakdown: { positive: 60, neutral: 25, negative: 15 },
  percentages: { positive: 60, neutral: 25, negative: 15 },
}

const mockEntitiesData = {
  entities: {
    issues: { 'slow delivery': 20, 'damaged package': 15 },
    categories: { delivery: 50 },
    sources: { webscraper: 40, manual_import: 30 },
  },
}

const mockFeedbackData = { items: [feedbackItem()], count: 1 }

/** Mount the page at `path` (default `/categories`). */
function renderCategories(path = '/categories') {
  render(<Categories />, { wrapper: createQueryWrapper([path]) })
}

/** Mount the page and wait until `text` is on screen. */
async function renderUntilText(text: string, path?: string): Promise<void> {
  renderCategories(path)
  await waitFor(() => {
    expect(screen.getByText(text)).toBeInTheDocument()
  })
}

/** `renderUntilText`, with a user ready to act on the loaded page. */
async function renderUntilTextWithUser(text: string, path?: string): Promise<UserEvent> {
  const user = userEvent.setup()
  await renderUntilText(text, path)
  return user
}

describe('Categories', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    categoriesApiMocks.getCategories.mockResolvedValue(mockCategoriesData)
    categoriesApiMocks.getSentiment.mockResolvedValue(mockSentimentData)
    categoriesApiMocks.getEntities.mockResolvedValue(mockEntitiesData)
    categoriesApiMocks.getFeedback.mockResolvedValue(mockFeedbackData)
    categoriesApiMocks.searchFeedback.mockResolvedValue(mockFeedbackData)
    categoriesApiMocks.getUrgentFeedback.mockResolvedValue(mockFeedbackData)
  })

  describe('loading states', () => {
    it('shows loading spinner while fetching data', () => {
      categoriesApiMocks.getCategories.mockReturnValue(new Promise(() => {}))
      categoriesApiMocks.getSentiment.mockReturnValue(new Promise(() => {}))

      renderCategories()

      expect(document.querySelector('.animate-spin')).toBeInTheDocument()
    })
  })

  describe('load failed vs empty', () => {
    const failed = () => new Error('Failed to fetch')

    it('the feedback list says it could not load, not "No feedback found"', async () => {
      categoriesApiMocks.getFeedback.mockRejectedValue(failed())

      renderCategories()

      const results = within(await screen.findByRole('alert'))
      expect(results.getByText(enCommon.loadFailed.message)).toBeInTheDocument()
      expect(screen.queryByText(enCategories.noFeedbackFound)).not.toBeInTheDocument()
      // The analytics read fine, so its cards still render.
      expect(screen.getByText('50 (50.0%)')).toBeInTheDocument()
    })

    it('failed category/sentiment reads show LoadFailed instead of "no categories" cards', async () => {
      categoriesApiMocks.getCategories.mockRejectedValue(failed())

      renderCategories()

      expect(await screen.findByRole('alert')).toHaveTextContent(enCommon.loadFailed.message)
      expect(screen.queryByText(enCategories.noCategories)).not.toBeInTheDocument()
      expect(screen.queryByRole('region', { name: 'Category Distribution' })).not.toBeInTheDocument()
    })

    it('Try again refetches only the failed read and the page recovers', async () => {
      categoriesApiMocks.getFeedback.mockRejectedValueOnce(failed())
      const user = userEvent.setup()
      renderCategories()

      const alert = await screen.findByRole('alert')
      await user.click(within(alert).getByRole('button', { name: enCommon.loadFailed.retry }))

      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
      expect(categoriesApiMocks.getCategories).toHaveBeenCalledTimes(1)
    })

    it('an empty successful read still says "No feedback found"', async () => {
      categoriesApiMocks.getFeedback.mockResolvedValue({ items: [], count: 0 })

      renderCategories()

      expect(await screen.findByText(enCategories.noFeedbackFound)).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })
  })

  describe('data display', () => {
    it('renders the category distribution with counts and percentages', async () => {
      await renderUntilText('Category Distribution')

      expect(screen.getByText('50 (50.0%)')).toBeInTheDocument() // delivery
      expect(screen.getByText('30 (30.0%)')).toBeInTheDocument() // customer_support
    })

    it('renders sentiment gauge with correct score', async () => {
      // avgSentiment = positive - negative = 60 - 15 = 45
      await renderUntilText('+45')
      expect(screen.getByText('+45')).toBeInTheDocument()
    })

    it('renders word cloud with keywords', async () => {
      await renderUntilText('Trending Keywords')
      expect(screen.getByText('Trending Keywords')).toBeInTheDocument()
    })

    it('does not render the removed duplicate sections (chips card + insights row)', async () => {
      await renderUntilText('Category Distribution')

      expect(screen.queryByText('Select Categories to Explore')).not.toBeInTheDocument()
      expect(screen.queryByText('Top Issue')).not.toBeInTheDocument()
      expect(screen.queryByText('Least Issues')).not.toBeInTheDocument()
    })
  })

  describe('default browse-all view (issue #198 UX rationalization)', () => {
    it('shows the feedback list by default without any selection', async () => {
      await renderUntilText('Feedback Results')

      expect(categoriesApiMocks.getFeedback).toHaveBeenCalledWith({ days: 7, limit: 100, offset: 0 })
    })
  })

  describe('category selection via distribution rows', () => {
    it('narrows the list when a distribution row is clicked and syncs the URL', async () => {
      // 'delivery' also appears as a word-cloud keyword — target the row via
      // its unique count label instead of the ambiguous category name.
      const user = await renderUntilTextWithUser('50 (50.0%)')

      await user.click(screen.getByText('50 (50.0%)'))

      await waitFor(() => {
        expect(categoriesApiMocks.getFeedback).toHaveBeenCalledWith(expect.objectContaining({ category: 'delivery' }))
      })
      expect(distribution().getByRole('button', { pressed: true })).toHaveTextContent('delivery')
    })

    it('pre-selects a category from a ?category= deep-link', async () => {
      renderCategories('/categories?category=delivery')

      await waitFor(() => {
        expect(distribution().getByRole('button', { pressed: true })).toHaveTextContent('delivery')
      })
      await waitFor(() => {
        expect(categoriesApiMocks.getFeedback).toHaveBeenCalledWith(expect.objectContaining({ category: 'delivery' }))
      })
    })
  })

  describe('unified filter bar', () => {
    it('uses server-side search when typing 2+ characters', async () => {
      const user = userEvent.setup()
      renderCategories()

      await waitFor(() => {
        expect(screen.getByPlaceholderText('Search feedback...')).toBeInTheDocument()
      })
      await user.type(screen.getByPlaceholderText('Search feedback...'), 'slow')

      await waitFor(() => {
        expect(categoriesApiMocks.searchFeedback).toHaveBeenCalledWith(expect.objectContaining({ q: 'slow' }))
      })
    })

    it('uses the urgent endpoint when the urgent toggle is enabled', async () => {
      const user = await renderUntilTextWithUser('Urgent only')

      await user.click(screen.getByRole('checkbox'))

      await waitFor(() => {
        expect(categoriesApiMocks.getUrgentFeedback).toHaveBeenCalledWith({ days: 7, limit: 100 })
      })
    })

    it('filters analytics by source when a source is selected', async () => {
      const user = userEvent.setup()
      renderCategories()

      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument()
      })

      await user.selectOptions(screen.getByRole('combobox'), 'webscraper')

      await waitFor(() => {
        expect(categoriesApiMocks.getCategories).toHaveBeenCalledWith({ days: 7 }, 'webscraper', {})
      })
    })

    it('clears all filters back to browse-all', async () => {
      const user = await renderUntilTextWithUser('Clear filters', '/categories?category=delivery')

      await user.click(screen.getByText('Clear filters'))

      await waitFor(() => {
        expect(distribution().queryByRole('button', { pressed: true })).not.toBeInTheDocument()
      })
      // The list stays visible: browse-all is the default state
      expect(screen.getByText('Feedback Results')).toBeInTheDocument()
    })
  })

  describe('keyword click populates search', () => {
    it('runs a server-side search when a trending keyword is clicked', async () => {
      const user = await renderUntilTextWithUser('Trending Keywords')

      // 'delivery' appears both as a distribution row and a keyword — pick the
      // keyword button inside the word cloud via its tooltip title.
      const keywordButton = at(screen.getAllByTitle(/mentions - click to search/), 0)
      const keyword = keywordButton.textContent
      await user.click(keywordButton)

      expect(screen.getByPlaceholderText('Search feedback...')).toHaveValue(keyword)
      await waitFor(() => {
        expect(categoriesApiMocks.searchFeedback).toHaveBeenCalledWith(expect.objectContaining({ q: keyword }))
      })
    })
  })

  describe('CSV export', () => {
    it('revokes the blob object URL after triggering the download', async () => {
      const user = userEvent.setup()
      renderCategories()
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Export as CSV' })).toBeInTheDocument()
      })

      await user.click(screen.getByRole('button', { name: 'Export as CSV' }))

      expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
    })
  })
})

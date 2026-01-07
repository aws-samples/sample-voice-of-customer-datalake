/**
 * @fileoverview Tests for ParsedReviewCard component.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ParsedReviewCard from './ParsedReviewCard'

describe('ParsedReviewCard', () => {
  const defaultReview = {
    text: 'Great product!',
    rating: 5,
    author: 'John Doe',
    date: '2026-01-05',
    title: 'Amazing',
  }

  const mockOnUpdate = vi.fn()
  const mockOnDelete = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('rendering', () => {
    it('displays review text in textarea', () => {
      render(
        <ParsedReviewCard
          review={defaultReview}
          index={0}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      const textarea = screen.getByPlaceholderText('Review text')
      expect(textarea).toHaveValue('Great product!')
    })

    it('displays author in input field', () => {
      render(
        <ParsedReviewCard
          review={defaultReview}
          index={0}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      const authorInput = screen.getByPlaceholderText('Author')
      expect(authorInput).toHaveValue('John Doe')
    })

    it('displays title in input field', () => {
      render(
        <ParsedReviewCard
          review={defaultReview}
          index={0}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      const titleInput = screen.getByPlaceholderText('Review title (optional)')
      expect(titleInput).toHaveValue('Amazing')
    })

    it('displays rating in select dropdown', () => {
      render(
        <ParsedReviewCard
          review={defaultReview}
          index={0}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      const select = screen.getByRole('combobox')
      expect(select).toHaveValue('5')
    })

    it('renders star icons for non-null rating', () => {
      render(
        <ParsedReviewCard
          review={defaultReview}
          index={0}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      // Stars are rendered as SVGs with lucide-star class
      const container = document.querySelector('.flex.items-center.gap-0\\.5')
      expect(container).toBeInTheDocument()
      const stars = container?.querySelectorAll('svg')
      expect(stars?.length).toBe(5)
    })
  })

  describe('editing', () => {
    it('calls onUpdate when text is changed', async () => {
      const user = userEvent.setup()
      render(
        <ParsedReviewCard
          review={defaultReview}
          index={0}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      const textarea = screen.getByPlaceholderText('Review text')
      await user.type(textarea, '!')

      // onUpdate is called for each character typed
      expect(mockOnUpdate).toHaveBeenCalled()
      expect(mockOnUpdate).toHaveBeenLastCalledWith(0, { text: 'Great product!!' })
    })

    it('calls onUpdate when rating is changed', async () => {
      const user = userEvent.setup()
      render(
        <ParsedReviewCard
          review={defaultReview}
          index={0}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      const select = screen.getByRole('combobox')
      await user.selectOptions(select, '3')

      expect(mockOnUpdate).toHaveBeenCalledWith(0, { rating: 3 })
    })

    it('calls onUpdate with null when rating is cleared', async () => {
      const user = userEvent.setup()
      render(
        <ParsedReviewCard
          review={defaultReview}
          index={0}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      const select = screen.getByRole('combobox')
      await user.selectOptions(select, '')

      expect(mockOnUpdate).toHaveBeenCalledWith(0, { rating: null })
    })

    it('calls onUpdate when author is changed', async () => {
      const user = userEvent.setup()
      render(
        <ParsedReviewCard
          review={defaultReview}
          index={0}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      const authorInput = screen.getByPlaceholderText('Author')
      await user.type(authorInput, '!')

      expect(mockOnUpdate).toHaveBeenCalled()
      expect(mockOnUpdate).toHaveBeenLastCalledWith(0, { author: 'John Doe!' })
    })

    it('calls onUpdate when date is changed', async () => {
      const user = userEvent.setup()
      render(
        <ParsedReviewCard
          review={defaultReview}
          index={0}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement
      await user.clear(dateInput)
      await user.type(dateInput, '2026-02-01')

      expect(mockOnUpdate).toHaveBeenCalled()
    })

    it('calls onUpdate when title is changed', async () => {
      const user = userEvent.setup()
      render(
        <ParsedReviewCard
          review={defaultReview}
          index={0}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      const titleInput = screen.getByPlaceholderText('Review title (optional)')
      await user.type(titleInput, '!')

      expect(mockOnUpdate).toHaveBeenCalled()
      expect(mockOnUpdate).toHaveBeenLastCalledWith(0, { title: 'Amazing!' })
    })

    it('calls onUpdate with null when title is cleared', async () => {
      const user = userEvent.setup()
      render(
        <ParsedReviewCard
          review={defaultReview}
          index={0}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      const titleInput = screen.getByPlaceholderText('Review title (optional)')
      await user.clear(titleInput)

      expect(mockOnUpdate).toHaveBeenLastCalledWith(0, { title: null })
    })

    it('calls onUpdate with null when date is cleared', async () => {
      const user = userEvent.setup()
      render(
        <ParsedReviewCard
          review={defaultReview}
          index={0}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement
      await user.clear(dateInput)

      expect(mockOnUpdate).toHaveBeenCalledWith(0, { date: null })
    })
  })

  describe('deletion', () => {
    it('calls onDelete when delete button is clicked', async () => {
      const user = userEvent.setup()
      render(
        <ParsedReviewCard
          review={defaultReview}
          index={2}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      const deleteButton = screen.getByTitle('Delete review')
      await user.click(deleteButton)

      expect(mockOnDelete).toHaveBeenCalledWith(2)
    })
  })

  describe('null values', () => {
    it('handles null rating correctly', () => {
      const reviewWithNullRating = { ...defaultReview, rating: null }
      render(
        <ParsedReviewCard
          review={reviewWithNullRating}
          index={0}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      const select = screen.getByRole('combobox')
      expect(select).toHaveValue('')
    })

    it('handles null author correctly', () => {
      const reviewWithNullAuthor = { ...defaultReview, author: null }
      render(
        <ParsedReviewCard
          review={reviewWithNullAuthor}
          index={0}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      const authorInput = screen.getByPlaceholderText('Author')
      expect(authorInput).toHaveValue('')
    })

    it('handles null title correctly', () => {
      const reviewWithNullTitle = { ...defaultReview, title: null }
      render(
        <ParsedReviewCard
          review={reviewWithNullTitle}
          index={0}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      const titleInput = screen.getByPlaceholderText('Review title (optional)')
      expect(titleInput).toHaveValue('')
    })

    it('does not render stars when rating is null', () => {
      const reviewWithNullRating = { ...defaultReview, rating: null }
      render(
        <ParsedReviewCard
          review={reviewWithNullRating}
          index={0}
          onUpdate={mockOnUpdate}
          onDelete={mockOnDelete}
        />
      )

      // Stars container should not exist when rating is null
      const starsContainer = document.querySelector('.flex.items-center.gap-0\\.5')
      expect(starsContainer).not.toBeInTheDocument()
    })
  })
})

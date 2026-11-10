/**
 * @fileoverview Renders the review modal while the URL carries `?review=` (hooks/useReviewModal).
 * Mounted once, in Layout, AFTER `<AssistantRoot/>` — see ReviewModal for why that order matters.
 * @module components/ReviewModal/ReviewModalHost
 */
import { useReviewModal } from '../../hooks/useReviewModal'
import ReviewModal from './ReviewModal'

export default function ReviewModalHost() {
  const { reviewId, reviewBrand, closeReview } = useReviewModal()
  if (reviewId === null) return null
  return <ReviewModal feedbackId={reviewId} brand={reviewBrand} onClose={closeReview} />
}

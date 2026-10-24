/**
 * @fileoverview The review modal's URL state: `?review=<feedback_id>` opens one of our reviews,
 * `?review=<feedback_id>&reviewBrand=<brand key>` a Radar review, on the CURRENT path (docs/radar.md).
 *
 * Opening PUSHES a history entry marked with {@link REVIEW_STATE}, so Back closes the modal.
 * Closing pops that entry when the modal was opened in-app, and otherwise (a pasted or
 * middle-clicked link, where Back would leave the app) replaces the URL without the params.
 * A similar item inside the modal REPLACES the entry and keeps the mark, so one Back (or the
 * close button) still closes the modal however many reviews were walked through.
 *
 * @module hooks/useReviewModal
 */
import { useCallback, useMemo } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { z } from 'zod'

const REVIEW_PARAM = 'review'
const REVIEW_BRAND_PARAM = 'reviewBrand'

/** The history-state mark of an entry the modal pushed. */
export const REVIEW_STATE: Readonly<{ reviewModal: true }> = { reviewModal: true }

const MAX_ID = 128
/** shared/radar_brands brand-key slug. */
const BRAND_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/u

const pushedStateSchema = z.object({ reviewModal: z.literal(true) })

function cleanId(value: string | null): string | null {
  return value !== null && value !== '' && value.length <= MAX_ID ? value : null
}

function cleanBrand(value: string | null): string | null {
  return value !== null && BRAND_KEY.test(value) ? value : null
}

/** `search` with the review params set (brand only for a Radar review), every other param kept. */
export function reviewSearch(search: string, feedbackId: string, brand?: string): string {
  const params = new URLSearchParams(search)
  params.set(REVIEW_PARAM, feedbackId)
  if (brand === undefined || brand === '') params.delete(REVIEW_BRAND_PARAM)
  else params.set(REVIEW_BRAND_PARAM, brand)
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

/** `search` without the review params. */
function withoutReview(search: string): string {
  const params = new URLSearchParams(search)
  params.delete(REVIEW_PARAM)
  params.delete(REVIEW_BRAND_PARAM)
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

/** The open review in `search`, or nulls. A malformed brand key reads as no review at all. */
export function reviewFromSearch(search: string): { reviewId: string | null; reviewBrand: string | null } {
  const params = new URLSearchParams(search)
  const reviewId = cleanId(params.get(REVIEW_PARAM))
  const rawBrand = params.get(REVIEW_BRAND_PARAM)
  const reviewBrand = cleanBrand(rawBrand)
  if (reviewId === null || (rawBrand !== null && reviewBrand === null)) return { reviewId: null, reviewBrand: null }
  return { reviewId, reviewBrand }
}

export interface ReviewModalState {
  readonly reviewId: string | null
  readonly reviewBrand: string | null
  readonly openReview: (feedbackId: string, brand?: string) => void
  readonly closeReview: () => void
}

export function useReviewModal(): ReviewModalState {
  const location = useLocation()
  const navigate = useNavigate()
  const { reviewId, reviewBrand } = useMemo(() => reviewFromSearch(location.search), [location.search])
  const pushed = pushedStateSchema.safeParse(location.state).success

  const openReview = useCallback((feedbackId: string, brand?: string) => {
    void navigate(
      { pathname: location.pathname, search: reviewSearch(location.search, feedbackId, brand) },
      { state: REVIEW_STATE },
    )
  }, [navigate, location.pathname, location.search])

  const closeReview = useCallback(() => {
    if (pushed) {
      void navigate(-1)
      return
    }
    void navigate({ pathname: location.pathname, search: withoutReview(location.search) }, { replace: true })
  }, [navigate, pushed, location.pathname, location.search])

  return { reviewId, reviewBrand, openReview, closeReview }
}

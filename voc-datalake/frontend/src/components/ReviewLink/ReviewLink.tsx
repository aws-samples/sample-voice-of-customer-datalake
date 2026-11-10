/**
 * @fileoverview A link that opens a review in the review modal on the current page
 * (`?review=<id>[&reviewBrand=<key>]`, hooks/useReviewModal). A real `<Link>`, so
 * middle-click / open-in-new-tab still work: the new tab loads this page with the modal open.
 *
 * @module components/ReviewLink
 */
import { Link, useLocation } from 'react-router-dom'
import type { ComponentPropsWithoutRef } from 'react'
import { REVIEW_STATE, reviewSearch } from '../../hooks/useReviewModal'

type ReviewLinkProps = Omit<ComponentPropsWithoutRef<typeof Link>, 'to' | 'state'> & {
  readonly feedbackId: string
  /** A Radar brand key: opens the Radar review variant. */
  readonly brand?: string
}

export default function ReviewLink({ feedbackId, brand, children, ...rest }: Readonly<ReviewLinkProps>) {
  const location = useLocation()
  return (
    <Link
      {...rest}
      to={{ pathname: location.pathname, search: reviewSearch(location.search, feedbackId, brand) }}
      state={REVIEW_STATE}
    >
      {children}
    </Link>
  )
}

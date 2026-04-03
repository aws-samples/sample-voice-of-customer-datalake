/**
 * @fileoverview Horizontal feedback carousel component.
 *
 * Displays feedback items in a scrollable horizontal carousel:
 * - Navigation arrows for scrolling
 * - Compact feedback cards
 * - Links to feedback detail pages
 *
 * @module components/FeedbackCarousel
 */

import clsx from 'clsx'
import {
  ChevronLeft, ChevronRight, ExternalLink, Star, AlertTriangle,
} from 'lucide-react'
import {
  useState, useRef,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import {
  getSourceIcon, formatSourceName,
} from '../../lib/sourceFormat'
import { formatISODate } from '../../utils/dateUtils'
import SentimentBadge from '../SentimentBadge'
import type { FeedbackItem } from '../../api/types'

interface FeedbackCarouselProps {
  items: FeedbackItem[]
  title?: string
}

export default function FeedbackCarousel({
  items, title,
}: Readonly<FeedbackCarouselProps>) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(items.length > 1)
  const { t } = useTranslation('components')

  const checkScroll = () => {
    if (!scrollRef.current) return
    const {
      scrollLeft, scrollWidth, clientWidth,
    } = scrollRef.current
    setCanScrollLeft(scrollLeft > 0)
    setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 10)
  }

  const scroll = (direction: 'left' | 'right') => {
    if (!scrollRef.current) return
    const cardWidth = 320
    const scrollAmount = direction === 'left' ? -cardWidth : cardWidth
    scrollRef.current.scrollBy({
      left: scrollAmount,
      behavior: 'smooth',
    })
    setTimeout(checkScroll, 300)
  }

  if (items.length === 0) return null

  return (
    <div className="mt-3 w-full max-w-full overflow-hidden">
      {title != null && title !== '' ? <p className="text-xs text-gray-500 font-medium mb-2">{title}</p> : null}

      <div className="relative group w-full max-w-full">
        {/* Left Arrow */}
        {canScrollLeft ? <button
          onClick={() => scroll('left')}
          className="absolute left-0 top-1/2 -translate-y-1/2 z-10 bg-white shadow-lg rounded-full p-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <ChevronLeft size={18} className="text-gray-600" />
        </button> : null}

        {/* Carousel Container */}
        <div
          ref={scrollRef}
          onScroll={checkScroll}
          className="flex gap-3 overflow-x-auto scrollbar-hide scroll-smooth pb-2 w-full max-w-full"
          style={{
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
          }}
        >
          {items.map((feedback) => (
            <div
              key={feedback.feedback_id}
              className={clsx(
                'flex-shrink-0 w-64 sm:w-72 md:w-80 bg-white border rounded-lg p-3 hover:shadow-md transition-shadow',
                feedback.urgency === 'high' && 'border-l-4 border-l-orange-500',
              )}
            >
              {/* Header */}
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{getSourceIcon(feedback.source_platform)}</span>
                  <span className="text-sm font-medium text-gray-700 capitalize">
                    {formatSourceName(feedback.source_platform, t, 'feedbackCarousel.webScraper')}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {feedback.urgency === 'high' && (
                    <span className="badge badge-urgent flex items-center gap-1 text-xs">
                      <AlertTriangle size={10} />
                      {t('feedbackCarousel.urgent')}
                    </span>
                  )}
                  <SentimentBadge sentiment={feedback.sentiment_label} score={feedback.sentiment_score} />
                </div>
              </div>

              {/* Rating */}
              {feedback.rating != null && (
                <div className="flex items-center gap-0.5 mb-2">
                  {Array.from({ length: 5 }, (_, i) => (
                    <Star
                      key={i}
                      size={12}
                      className={i < (feedback.rating ?? 0) ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'}
                    />
                  ))}
                </div>
              )}

              {/* Content */}
              <p className="text-sm text-gray-700 line-clamp-3 mb-2">{feedback.original_text}</p>

              {/* Problem Summary */}
              {feedback.problem_summary != null && feedback.problem_summary !== '' ? <div className="bg-gray-50 rounded p-2 mb-2">
                <p className="text-xs font-medium text-gray-600 line-clamp-2">
                  {t('feedbackCarousel.issue', { summary: feedback.problem_summary })}
                </p>
              </div> : null}

              {/* Tags */}
              <div className="flex flex-wrap gap-1 mb-2">
                <span className="badge bg-blue-100 text-blue-800 text-xs">{feedback.category}</span>
                {feedback.subcategory != null && feedback.subcategory !== '' ? <span className="badge bg-purple-100 text-purple-800 text-xs">{feedback.subcategory}</span> : null}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                <span className="text-xs text-gray-400">
                  {formatISODate(feedback.source_created_at, 'MMM d, h:mm a')}
                </span>
                <div className="flex items-center gap-2">
                  <Link
                    to={`/feedback/${feedback.feedback_id}`}
                    className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                  >
                    {t('feedbackCarousel.viewDetails')}
                  </Link>
                  {feedback.source_url != null && feedback.source_url !== '' ? <a
                    href={feedback.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gray-400 hover:text-gray-600"
                  >
                    <ExternalLink size={12} />
                  </a> : null}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Right Arrow */}
        {canScrollRight ? <button
          onClick={() => scroll('right')}
          className="absolute right-0 top-1/2 -translate-y-1/2 z-10 bg-white shadow-lg rounded-full p-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <ChevronRight size={18} className="text-gray-600" />
        </button> : null}
      </div>
    </div>
  )
}

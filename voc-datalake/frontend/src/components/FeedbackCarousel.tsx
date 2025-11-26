import { useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, ExternalLink, Star, AlertTriangle } from 'lucide-react'
import { format, isValid, parseISO } from 'date-fns'
import type { FeedbackItem } from '../api/client'
import SentimentBadge from './SentimentBadge'
import clsx from 'clsx'

interface FeedbackCarouselProps {
  items: FeedbackItem[]
  title?: string
}

const sourceIcons: Record<string, string> = {
  twitter: '𝕏',
  instagram: '📷',
  facebook: '📘',
  reddit: '🔴',
  trustpilot: '⭐',
  google_reviews: '🔍',
  tavily: '🌐',
  web_scrape: '🌐',
  web_scrape_jsonld: '🌐',
}

function formatSourceName(source: string): string {
  if (source.startsWith('scraper_') || source === 'web_scrape' || source === 'web_scrape_jsonld') {
    return 'Web Scraper'
  }
  return source.replace(/_/g, ' ')
}

function formatDate(dateStr: string | undefined, formatStr: string, fallback = 'N/A'): string {
  if (!dateStr) return fallback
  try {
    const date = parseISO(dateStr)
    return isValid(date) ? format(date, formatStr) : fallback
  } catch {
    return fallback
  }
}

export default function FeedbackCarousel({ items, title }: FeedbackCarouselProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(items.length > 1)

  const checkScroll = () => {
    if (!scrollRef.current) return
    const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current
    setCanScrollLeft(scrollLeft > 0)
    setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 10)
  }

  const scroll = (direction: 'left' | 'right') => {
    if (!scrollRef.current) return
    const cardWidth = 320
    const scrollAmount = direction === 'left' ? -cardWidth : cardWidth
    scrollRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' })
    setTimeout(checkScroll, 300)
  }

  if (items.length === 0) return null

  return (
    <div className="mt-3 w-full max-w-full overflow-hidden">
      {title && (
        <p className="text-xs text-gray-500 font-medium mb-2">{title}</p>
      )}
      
      <div className="relative group w-full max-w-full">
        {/* Left Arrow */}
        {canScrollLeft && (
          <button
            onClick={() => scroll('left')}
            className="absolute left-0 top-1/2 -translate-y-1/2 z-10 bg-white shadow-lg rounded-full p-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <ChevronLeft size={18} className="text-gray-600" />
          </button>
        )}

        {/* Carousel Container */}
        <div
          ref={scrollRef}
          onScroll={checkScroll}
          className="flex gap-3 overflow-x-auto scrollbar-hide scroll-smooth pb-2 w-full max-w-full"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {items.map((feedback) => (
            <div
              key={feedback.feedback_id}
              className={clsx(
                'flex-shrink-0 w-64 sm:w-72 md:w-80 bg-white border rounded-lg p-3 hover:shadow-md transition-shadow',
                feedback.urgency === 'high' && 'border-l-4 border-l-orange-500'
              )}
            >
              {/* Header */}
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{sourceIcons[feedback.source_platform] || '📝'}</span>
                  <span className="text-sm font-medium text-gray-700 capitalize">
                    {formatSourceName(feedback.source_platform)}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {feedback.urgency === 'high' && (
                    <span className="badge badge-urgent flex items-center gap-1 text-xs">
                      <AlertTriangle size={10} />
                      Urgent
                    </span>
                  )}
                  <SentimentBadge sentiment={feedback.sentiment_label} score={feedback.sentiment_score} />
                </div>
              </div>

              {/* Rating */}
              {feedback.rating && (
                <div className="flex items-center gap-0.5 mb-2">
                  {[...Array(5)].map((_, i) => (
                    <Star
                      key={i}
                      size={12}
                      className={i < feedback.rating! ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'}
                    />
                  ))}
                </div>
              )}

              {/* Content */}
              <p className="text-sm text-gray-700 line-clamp-3 mb-2">{feedback.original_text}</p>

              {/* Problem Summary */}
              {feedback.problem_summary && (
                <div className="bg-gray-50 rounded p-2 mb-2">
                  <p className="text-xs font-medium text-gray-600 line-clamp-2">
                    Issue: {feedback.problem_summary}
                  </p>
                </div>
              )}

              {/* Tags */}
              <div className="flex flex-wrap gap-1 mb-2">
                <span className="badge bg-blue-100 text-blue-800 text-xs">{feedback.category}</span>
                {feedback.subcategory && (
                  <span className="badge bg-purple-100 text-purple-800 text-xs">{feedback.subcategory}</span>
                )}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                <span className="text-xs text-gray-400">
                  {formatDate(feedback.source_created_at, 'MMM d, h:mm a')}
                </span>
                <div className="flex items-center gap-2">
                  <Link
                    to={`/feedback/${feedback.feedback_id}`}
                    className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                  >
                    View Details
                  </Link>
                  {feedback.source_url && (
                    <a
                      href={feedback.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gray-400 hover:text-gray-600"
                    >
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Right Arrow */}
        {canScrollRight && (
          <button
            onClick={() => scroll('right')}
            className="absolute right-0 top-1/2 -translate-y-1/2 z-10 bg-white shadow-lg rounded-full p-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <ChevronRight size={18} className="text-gray-600" />
          </button>
        )}
      </div>
    </div>
  )
}

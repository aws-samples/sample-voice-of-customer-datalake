// Shared filter constants for feedback data
export const SOURCES = [
  'webscraper',
  'manual_import',
  's3_import',
]

export const CATEGORIES = [
  'delivery',
  'customer_support',
  'product_quality',
  'pricing',
  'website',
  'app',
  'billing',
  'returns',
  'communication',
  'other',
]

// `as const` so a Sentiment is a literal union: any label map keyed by it has
// to cover every value, making an unlabelled new sentiment a typecheck failure
// rather than a slug leaking into the UI.
export const SENTIMENTS = ['positive', 'negative', 'neutral', 'mixed'] as const

export type Sentiment = (typeof SENTIMENTS)[number]

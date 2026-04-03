export type ViewMode = 'grid' | 'list'
export type SentimentFilter = 'all' | 'positive' | 'negative' | 'neutral' | 'mixed'

export interface CategoryData {
  name: string
  value: number
  color: string
}

export interface SentimentData {
  name: string
  value: number
  color: string
  percentage: number
  [key: string]: string | number
}

export interface WordCloudItem {
  word: string
  count: number
}

export const categoryColors: Record<string, string> = {
  flight_operations: '#ef4444',
  in_flight_experience: '#f97316',
  customer_service: '#eab308',
  baggage_handling: '#22c55e',
  booking_and_check_in: '#3b82f6',
  pricing_and_fees: '#8b5cf6',
  loyalty_program: '#ec4899',
  airport_facilities: '#14b8a6',
  delivery: '#ef4444',
  customer_support: '#f97316',
  product_quality: '#eab308',
  pricing: '#22c55e',
  website: '#3b82f6',
  app: '#8b5cf6',
  billing: '#ec4899',
  returns: '#14b8a6',
  communication: '#6366f1',
  other: '#6b7280',
}

export { sentimentHexColor as getSentimentColor } from '../../lib/sentiment'

export function getSentimentScoreColorClass(score: number): string {
  if (score > 20) return 'text-green-600'
  if (score < -20) return 'text-red-600'
  return 'text-gray-600'
}

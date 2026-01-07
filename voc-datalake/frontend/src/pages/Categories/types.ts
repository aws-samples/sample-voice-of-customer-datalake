import type { FeedbackItem } from '../../api/client'

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

export const sentimentColors: Record<string, string> = {
  positive: '#22c55e',
  neutral: '#6b7280',
  negative: '#ef4444',
  mixed: '#eab308',
}

export function getSentimentScoreColorClass(score: number): string {
  if (score > 20) return 'text-green-600'
  if (score < -20) return 'text-red-600'
  return 'text-gray-600'
}

export function getSentimentColorClass(label: string | undefined): string {
  if (label === 'positive') return 'bg-green-100 text-green-800'
  if (label === 'negative') return 'bg-red-100 text-red-800'
  if (label === 'mixed') return 'bg-yellow-100 text-yellow-800'
  return 'bg-gray-100 text-gray-800'
}

export function getSentimentColor(name: string): string {
  if (name === 'positive') return sentimentColors.positive
  if (name === 'negative') return sentimentColors.negative
  if (name === 'neutral') return sentimentColors.neutral
  if (name === 'mixed') return sentimentColors.mixed
  return '#6b7280'
}

export type { FeedbackItem }

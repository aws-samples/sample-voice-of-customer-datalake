/**
 * @fileoverview Shared sentiment color utilities.
 * @module lib/sentiment
 */

const HEX_COLORS: Record<string, string> = {
  positive: '#22c55e',
  negative: '#ef4444',
  neutral: '#6b7280',
  mixed: '#eab308',
}

/** Returns hex color string for a sentiment label. */
export function sentimentHexColor(label: string | undefined): string {
  return HEX_COLORS[label ?? ''] ?? HEX_COLORS.neutral
}

/** Returns lowercase sentiment label from a numeric score (-1 to 1 scale). */
export function sentimentLabelFromScore(score: number): 'positive' | 'negative' | 'neutral' {
  if (score > 0) return 'positive'
  if (score < -0.3) return 'negative'
  return 'neutral'
}

const TAILWIND_COLORS: Record<string, string> = {
  positive: 'text-green-600 bg-green-50',
  negative: 'text-red-600 bg-red-50',
  mixed: 'text-yellow-600 bg-yellow-50',
  neutral: 'text-gray-600 bg-gray-50',
}

/** Returns Tailwind CSS classes for a sentiment label (text + background). */
export function sentimentTailwindColor(label: string): string {
  return TAILWIND_COLORS[label] ?? TAILWIND_COLORS.neutral
}

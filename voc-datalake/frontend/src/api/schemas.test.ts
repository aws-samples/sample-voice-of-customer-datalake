/**
 * @fileoverview Tests for Zod schemas that validate API responses.
 *
 * These tests ensure that schemas correctly handle DynamoDB Decimal values
 * which Lambda Powertools serializes as strings (e.g. "0.750" instead of 0.75).
 * This was the root cause of the Feedback page showing empty results despite
 * data existing in the backend.
 *
 * @module api/schemas
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { FeedbackItemSchema, MetricsSummarySchema } from './schemas'

describe('FeedbackItemSchema', () => {
  const validFeedbackItem = {
    feedback_id: 'abc123',
    source_id: 'src-1',
    source_platform: 'webscraper',
    source_channel: 'web',
    brand_name: 'TestBrand',
    source_created_at: '2025-03-20T10:00:00Z',
    processed_at: '2025-03-20T10:01:00Z',
    original_text: 'Great product!',
    original_language: 'en',
    category: 'product_quality',
    journey_stage: 'post_purchase',
    sentiment_label: 'positive',
    sentiment_score: 0.85,
    urgency: 'low',
    impact_area: 'product',
  }

  it('parses a valid feedback item with numeric sentiment_score', () => {
    const result = FeedbackItemSchema.parse(validFeedbackItem)
    expect(result.feedback_id).toBe('abc123')
    expect(result.sentiment_score).toBe(0.85)
    expect(typeof result.sentiment_score).toBe('number')
  })

  it('coerces string sentiment_score from DynamoDB Decimal serialization', () => {
    const itemWithStringScore = {
      ...validFeedbackItem,
      sentiment_score: '0.750',
    }
    const result = FeedbackItemSchema.parse(itemWithStringScore)
    expect(result.sentiment_score).toBe(0.75)
    expect(typeof result.sentiment_score).toBe('number')
  })

  it('coerces string rating from DynamoDB Decimal serialization', () => {
    const itemWithStringRating = {
      ...validFeedbackItem,
      rating: '4',
    }
    const result = FeedbackItemSchema.parse(itemWithStringRating)
    expect(result.rating).toBe(4)
    expect(typeof result.rating).toBe('number')
  })

  it('handles missing optional fields with defaults', () => {
    const minimalItem = {
      feedback_id: 'abc123',
      source_platform: 'webscraper',
    }
    const result = FeedbackItemSchema.parse(minimalItem)
    expect(result.source_id).toBe('')
    expect(result.source_channel).toBe('unknown')
    expect(result.sentiment_score).toBe(0)
    expect(result.category).toBe('other')
  })

  it('defaults urgency to low for minimal items', () => {
    const minimalItem = {
      feedback_id: 'abc123',
      source_platform: 'webscraper',
    }
    const result = FeedbackItemSchema.parse(minimalItem)
    expect(result.urgency).toBe('low')
  })

  it('preserves unknown DynamoDB keys via passthrough (pk, sk, gsi fields, ttl)', () => {
    const dynamoDbItem = {
      ...validFeedbackItem,
      pk: 'SOURCE#TestBrand',
      sk: 'FEEDBACK#abc123',
      gsi1pk: 'DATE#2025-03-20',
      gsi1sk: '2025-03-20T10:01:00Z#abc123',
      gsi2pk: 'CATEGORY#product_quality',
      gsi2sk: '0.850#2025-03-20T10:01:00Z',
      gsi3pk: 'URGENCY#low',
      gsi3sk: '2025-03-20T10:01:00Z',
      ttl: 1742515260,
      date: '2025-03-20',
      llm_metadata: { model: 'claude-sonnet-4-5' },
      ingested_at: '2025-03-20T10:00:30Z',
    }
    const result = FeedbackItemSchema.parse(dynamoDbItem)
    expect(result.feedback_id).toBe('abc123')
    expect(result.sentiment_score).toBe(0.85)
  })

  it('parses a realistic DynamoDB response with string Decimals', () => {
    const realisticItem = {
      pk: 'SOURCE#Cisco',
      sk: 'FEEDBACK#def456',
      gsi1pk: 'DATE#2025-03-20',
      gsi1sk: '2025-03-20T10:01:00Z#def456',
      gsi2pk: 'CATEGORY#delivery',
      gsi2sk: '-0.500#2025-03-20T10:01:00Z',
      gsi3pk: 'URGENCY#high',
      gsi3sk: '2025-03-20T10:01:00Z',
      feedback_id: 'def456',
      source_id: 'review-789',
      source_platform: 'webscraper',
      source_channel: 'web',
      brand_name: 'Cisco',
      source_created_at: '2025-03-19T08:00:00Z',
      processed_at: '2025-03-20T10:01:00Z',
      original_text: 'Delivery was very late',
      original_language: 'en',
      category: 'delivery',
      sentiment_label: 'negative',
      sentiment_score: '-0.500',
      urgency: 'high',
      impact_area: 'logistics',
      problem_summary: 'Late delivery',
      date: '2025-03-20',
      ttl: '1742515260',
      rating: '2',
    }
    const result = FeedbackItemSchema.parse(realisticItem)
    expect(result.feedback_id).toBe('def456')
    expect(result.sentiment_score).toBe(-0.5)
    expect(result.rating).toBe(2)
    expect(typeof result.sentiment_score).toBe('number')
  })

  it('coerces rating type in realistic DynamoDB response', () => {
    const result = FeedbackItemSchema.parse({
      feedback_id: 'def456',
      source_platform: 'webscraper',
      rating: '2',
    })
    expect(typeof result.rating).toBe('number')
  })

  it('parses an array of feedback items (simulating API response)', () => {
    const items = [
      { ...validFeedbackItem, feedback_id: '1', sentiment_score: '0.9' },
      { ...validFeedbackItem, feedback_id: '2', sentiment_score: '-0.3' },
      { ...validFeedbackItem, feedback_id: '3', sentiment_score: '0' },
    ]
    const schema = z.object({
      count: z.number(),
      items: z.array(FeedbackItemSchema),
    })
    const result = schema.parse({ count: 3, items })
    expect(result.items).toHaveLength(3)
    expect(result.items[0].sentiment_score).toBe(0.9)
    expect(result.items[1].sentiment_score).toBe(-0.3)
    expect(result.items[2].sentiment_score).toBe(0)
  })
})

describe('MetricsSummarySchema', () => {
  it('parses a valid metrics summary with numeric values', () => {
    const summary = {
      period_days: 7,
      total_feedback: 42,
      avg_sentiment: 0.65,
      urgent_count: 3,
      daily_totals: [{ date: '2025-03-20', count: 10 }],
      daily_sentiment: [{ date: '2025-03-20', avg_sentiment: 0.7, count: 10 }],
    }
    const result = MetricsSummarySchema.parse(summary)
    expect(result.total_feedback).toBe(42)
    expect(typeof result.avg_sentiment).toBe('number')
  })

  it('coerces string counts from DynamoDB Decimal serialization', () => {
    const summary = {
      period_days: 7,
      total_feedback: 42,
      avg_sentiment: 0.65,
      urgent_count: '3',
      daily_totals: [{ date: '2025-03-20', count: '10' }],
      daily_sentiment: [{ date: '2025-03-20', avg_sentiment: '0.700', count: '10' }],
    }
    const result = MetricsSummarySchema.parse(summary)
    expect(result.urgent_count).toBe(3)
    expect(typeof result.urgent_count).toBe('number')
    expect(result.daily_totals[0].count).toBe(10)
    expect(typeof result.daily_totals[0].count).toBe('number')
  })

  it('coerces string sentiment in daily_sentiment from DynamoDB Decimal', () => {
    const summary = {
      period_days: 7,
      total_feedback: 42,
      avg_sentiment: 0.65,
      urgent_count: '3',
      daily_totals: [{ date: '2025-03-20', count: '10' }],
      daily_sentiment: [{ date: '2025-03-20', avg_sentiment: '0.700', count: '10' }],
    }
    const result = MetricsSummarySchema.parse(summary)
    expect(result.daily_sentiment[0].avg_sentiment).toBe(0.7)
    expect(typeof result.daily_sentiment[0].avg_sentiment).toBe('number')
  })
})

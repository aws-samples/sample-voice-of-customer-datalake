/**
 * @fileoverview Shared test fixtures based on real DynamoDB data.
 * These fixtures match the actual data structure from the VoC Data Lake.
 */
import type { FeedbackItem } from '../api/client'

/**
 * Real feedback item structure from DynamoDB voc-feedback table.
 */
export const mockFeedbackItem: FeedbackItem = {
  feedback_id: '0099c016c50bcbb168052aafec6caf95',
  source_id: 'scraper_scraper_1766340982507_dc48e11b45f7500b',
  source_platform: 'webscraper',
  source_channel: 'review',
  source_url: 'https://example.com/reviews/user123',
  brand_name: 'VoC Analytics',
  source_created_at: '2025-12-29T13:17:02+01:00',
  processed_at: '2026-01-05T13:13:03.265251+00:00',
  original_text: 'Avoid like the plague. Yet again our luggage failed to survive transit in Madrid. We reported this on arrival and were categorically told that the luggage was on the next flight. THIS WAS A LIE. It wasn\'t and 3 days later was still in Madrid.',
  original_language: 'en',
  normalized_text: 'Avoid like the plague. Yet again our luggage failed to survive transit in Madrid.',
  rating: 1,
  category: 'baggage',
  subcategory: 'lost_baggage',
  journey_stage: 'support',
  sentiment_label: 'negative',
  sentiment_score: -0.95,
  urgency: 'high',
  impact_area: 'legal',
  problem_summary: 'Luggage lost during transit in Madrid with inadequate compensation',
  problem_root_cause_hypothesis: 'Systemic baggage handling failures at Madrid hub combined with inadequate staff communication protocols.',
  direct_customer_quote: 'Avoid like the plague. Yet again our luggage failed to survive transit in Madrid. THIS WAS A LIE.',
  persona_name: 'Frustrated Traveler',
  persona_type: 'churn_risk',
}

/**
 * Positive feedback item for testing different sentiments.
 */
export const mockPositiveFeedbackItem: FeedbackItem = {
  feedback_id: 'abc123positive',
  source_id: 'manual_12345',
  source_platform: 'manual_import',
  source_channel: 'social',
  source_url: 'https://example.com/feedback/12345',
  brand_name: 'VoC Analytics',
  source_created_at: '2025-12-28T10:00:00+00:00',
  processed_at: '2025-12-28T10:05:00+00:00',
  original_text: 'Amazing customer service! The team went above and beyond to help me. Highly recommend!',
  original_language: 'en',
  rating: 5,
  category: 'customer_service',
  subcategory: 'support_quality',
  journey_stage: 'post_purchase',
  sentiment_label: 'positive',
  sentiment_score: 0.92,
  urgency: 'low',
  impact_area: 'retention',
  problem_summary: undefined,
  direct_customer_quote: 'Amazing customer service! The team went above and beyond to help me.',
  persona_name: 'Loyal Customer',
  persona_type: 'advocate',
}

/**
 * Neutral feedback item.
 */
export const mockNeutralFeedbackItem: FeedbackItem = {
  feedback_id: 'neutral456',
  source_id: 's3_67890',
  source_platform: 's3_import',
  source_channel: 'social',
  brand_name: 'VoC Analytics',
  source_created_at: '2025-12-27T15:30:00+00:00',
  processed_at: '2025-12-27T15:35:00+00:00',
  original_text: 'Product arrived on time. Works as expected.',
  original_language: 'en',
  category: 'delivery',
  subcategory: 'on_time',
  journey_stage: 'delivery',
  sentiment_label: 'neutral',
  sentiment_score: 0.1,
  urgency: 'low',
  impact_area: 'operations',
  persona_name: 'Casual User',
  persona_type: 'standard',
}

/**
 * Array of mock feedback items for list testing.
 */
export const mockFeedbackItems: FeedbackItem[] = [
  mockFeedbackItem,
  mockPositiveFeedbackItem,
  mockNeutralFeedbackItem,
]

/**
 * Mock user data matching Cognito user structure.
 */
export const mockCognitoUser = {
  username: 'test-user-123',
  email: 'test@example.com',
  name: 'Test User',
  status: 'CONFIRMED',
  enabled: true,
  groups: ['viewers'],
  created_at: '2025-01-01T00:00:00Z',
}

/**
 * Mock admin user.
 */
export const mockAdminUser = {
  username: 'admin-user-456',
  email: 'admin@example.com',
  name: 'Admin User',
  status: 'CONFIRMED',
  enabled: true,
  groups: ['admins'],
  created_at: '2025-01-01T00:00:00Z',
}

/**
 * Mock project persona matching DynamoDB structure.
 */
export const mockPersona = {
  persona_id: 'persona_123',
  name: 'Frustrated Traveler',
  tagline: 'Frequent flyer experiencing repeated service failures',
  description: 'A premium customer who travels frequently for business and leisure. Has experienced multiple baggage and service issues.',
  pain_points: [
    'Lost luggage during transit',
    'Poor communication from staff',
    'Inadequate compensation for issues',
  ],
  goals: [
    'Reliable baggage handling',
    'Transparent communication',
    'Fair compensation when issues occur',
  ],
  behaviors: [
    'Books premium cabins',
    'Travels internationally frequently',
    'Active on review platforms',
  ],
  demographics: {
    age_range: '35-50',
    income_level: 'high',
    travel_frequency: 'frequent',
  },
  confidence: 'high',
  quote: 'I just want my luggage to arrive when I do.',
  avatar_url: undefined,
  created_at: '2025-01-01T00:00:00Z',
}

/**
 * Mock project document matching DynamoDB structure.
 */
export const mockDocument = {
  document_id: 'doc_123',
  title: 'Baggage Handling Improvement PRD',
  document_type: 'prd',
  content: '# Baggage Handling Improvement\n\n## Problem Statement\n\nCustomers are experiencing frequent baggage issues...',
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-02T00:00:00Z',
}

/**
 * Mock research document.
 */
export const mockResearchDocument = {
  document_id: 'doc_456',
  title: 'Customer Satisfaction Research',
  document_type: 'research',
  content: '# Customer Satisfaction Research\n\n## Executive Summary\n\nBased on analysis of 500 feedback items...',
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-02T00:00:00Z',
}

/**
 * Mock category configuration.
 */
export const mockCategoriesConfig = {
  categories: [
    {
      id: 'baggage',
      name: 'baggage',
      description: 'Baggage and luggage related issues',
      subcategories: [
        { id: 'lost_baggage', name: 'lost_baggage', description: 'Lost or missing baggage' },
        { id: 'damaged_baggage', name: 'damaged_baggage', description: 'Damaged baggage' },
        { id: 'delayed_baggage', name: 'delayed_baggage', description: 'Delayed baggage delivery' },
      ],
    },
    {
      id: 'customer_service',
      name: 'customer_service',
      description: 'Customer service interactions',
      subcategories: [
        { id: 'support_quality', name: 'support_quality', description: 'Quality of support' },
        { id: 'response_time', name: 'response_time', description: 'Response time' },
      ],
    },
    {
      id: 'delivery',
      name: 'delivery',
      description: 'Delivery and shipping',
      subcategories: [
        { id: 'on_time', name: 'on_time', description: 'On-time delivery' },
        { id: 'late', name: 'late', description: 'Late delivery' },
      ],
    },
  ],
  updated_at: '2025-01-01T00:00:00Z',
}

/**
 * Mock brand settings.
 */
export const mockBrandSettings = {
  brand_name: 'VoC Analytics',
  brand_handles: ['@vocanalytics', '@voc_support'],
  hashtags: ['#VoC', '#CustomerFeedback'],
  urls_to_track: ['https://vocanalytics.com'],
}

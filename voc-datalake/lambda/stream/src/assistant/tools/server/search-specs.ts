/**
 * Bedrock specs for the two search tools (moved here from the removed legacy
 * chat tool list).
 */
import type { Tool } from '@aws-sdk/client-bedrock-runtime';
import { toolSpec } from '../spec.js';
import { ITEM_FILTER_PROPERTIES } from './item-filters.js';

export function searchFeedbackSpec(): Tool {
  return toolSpec(
    'search_feedback',
    'Search and retrieve customer feedback/reviews. Use it when the user asks about customer feedback, reviews, '
      + 'complaints or opinions — not for greetings or general questions. A 32-character hex query looks up one '
      + 'review by id. The window is the page time range.\n\n'
      + 'IMPORTANT for broad questions: to summarize, count, find trends or surface "the most urgent / top / biggest '
      + 'issues", set mode="aggregate" — it returns distribution stats over the ENTIRE match set in ONE call. To rank '
      + 'by urgency use urgency="high" and/or sort_by="urgency"; `query` is a literal substring match against the '
      + 'review text and will NOT find items by urgency level. For exact dataset-wide counts prefer get_metrics.',
    {
      query: {
        type: 'string',
        description: 'Text to find in feedback (e.g. "delivery", "app crash"), or a feedback id for direct lookup.',
      },
      source: { type: 'string', description: 'Source platform filter (e.g. "webscraper", "manual_import").' },
      category: { type: 'string', description: 'Category filter (e.g. "delivery", "customer_support").' },
      sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral', 'mixed'], description: 'Sentiment filter.' },
      urgency: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Urgency filter.' },
      version: {
        type: 'string',
        description: 'Software release filter for GitHub Issues feedback (e.g. "0.4.2"); items without a version never match.',
      },
      ...ITEM_FILTER_PROPERTIES,
      limit: {
        type: 'integer',
        description: 'Max items to return (default 15, max 30). In aggregate mode it only caps the examples.',
      },
      mode: {
        type: 'string',
        enum: ['list', 'aggregate'],
        description: 'list (default) returns items; aggregate returns counts by urgency/sentiment/category/source, '
          + 'average rating and top examples over ALL matches.',
      },
      sort_by: {
        type: 'string',
        enum: ['recent', 'urgency'],
        description: 'recent (default) or urgency (high→medium→low, most negative first).',
      },
    },
  );
}

export function webSearchSpec(): Tool {
  return toolSpec(
    'web_search',
    'Search the public web for current external information: competitor moves, industry news, product releases, '
      + 'market context — anything not in the customer feedback dataset. The user enabled web search for this '
      + 'conversation. Work iteratively: start focused, review, then refine or search another angle; prefer several '
      + 'specific queries over one broad one and do not repeat a query that already answered. Use search_feedback, '
      + 'not this, for the customers\u2019 own feedback. Keep each query under 200 characters. ALWAYS cite the source '
      + 'URLs inline — uncited web claims are not acceptable.',
    {
      query: { type: 'string', maxLength: 200, description: 'Natural-language search query (200 characters max).' },
      max_results: { type: 'integer', minimum: 1, maximum: 10, description: 'How many results (1-10, default 5).' },
    },
    ['query'],
  );
}

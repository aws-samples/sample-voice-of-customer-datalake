/**
 * Mutation-hardening suite for `search-specs.ts`. No spec read the two search
 * tool specs, so a run found every description fragment, property type, enum
 * value and bound the model is given unobserved. Each case pins the exact text
 * and schema the model reads.
 */
import { describe, expect, it } from 'vitest';
import { ITEM_FILTER_PROPERTIES } from './item-filters.js';
import { searchFeedbackSpec, webSearchSpec } from './search-specs.js';

/** `toolSpec.inputSchema.json` of a spec, checked to be an object. */
function inputSchema(spec: ReturnType<typeof searchFeedbackSpec>): Record<string, unknown> {
  const json = spec.toolSpec?.inputSchema?.json;
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new TypeError('no json schema');
  return json;
}

describe('searchFeedbackSpec', () => {
  const spec = searchFeedbackSpec();
  const schema = inputSchema(spec);

  it('names the tool and states when and how to use it', () => {
    expect(spec.toolSpec?.name).toBe('search_feedback');
    expect(spec.toolSpec?.description).toBe(
      'Search and retrieve customer feedback/reviews. Use it when the user asks about customer feedback, reviews, '
      + 'complaints or opinions — not for greetings or general questions. A 32-character hex query looks up one '
      + 'review by id. The window is the page time range.\n\n'
      + 'IMPORTANT for broad questions: to summarize, count, find trends or surface "the most urgent / top / biggest '
      + 'issues", set mode="aggregate" — it returns distribution stats over the ENTIRE match set in ONE call. To rank '
      + 'by urgency use urgency="high" and/or sort_by="urgency"; `query` is a literal substring match against the '
      + 'review text and will NOT find items by urgency level. For exact dataset-wide counts prefer get_metrics.',
    );
  });

  it('takes no required argument and no unknown one', () => {
    expect([schema['type'], schema['required'], schema['additionalProperties']]).toStrictEqual(['object', [], false]);
  });

  it('lists the arguments in order, with the shared item filters after version', () => {
    expect(Object.keys(schema['properties'] ?? {})).toStrictEqual([
      'query', 'source', 'category', 'sentiment', 'urgency', 'version', ...Object.keys(ITEM_FILTER_PROPERTIES), 'limit', 'mode', 'sort_by',
    ]);
    expect(schema['properties']).toMatchObject(ITEM_FILTER_PROPERTIES);
  });

  // [argument, JSON type, enum (or null), description]
  it.each([
    ['query', 'string', null, 'Text to find in feedback (e.g. "delivery", "app crash"), or a feedback id for direct lookup.'],
    ['source', 'string', null, 'Source platform filter (e.g. "webscraper", "manual_import").'],
    ['category', 'string', null, 'Category filter (e.g. "delivery", "customer_support").'],
    ['sentiment', 'string', ['positive', 'negative', 'neutral', 'mixed'], 'Sentiment filter.'],
    ['urgency', 'string', ['high', 'medium', 'low'], 'Urgency filter.'],
    ['version', 'string', null, 'Software release filter for GitHub Issues feedback (e.g. "0.4.2"); items without a version never match.'],
    ['limit', 'integer', null, 'Max items to return (default 15, max 30). In aggregate mode it only caps the examples.'],
    ['mode', 'string', ['list', 'aggregate'],
      'list (default) returns items; aggregate returns counts by urgency/sentiment/category/source, average rating and top examples over ALL matches.'],
    ['sort_by', 'string', ['recent', 'urgency'], 'recent (default) or urgency (high→medium→low, most negative first).'],
  ])('%s is a %s with enum %j', (name, type, values, description) => {
    const expected = values === null ? { type, description } : { type, enum: values, description };
    expect(Reflect.get(Object(schema['properties']), name)).toStrictEqual(expected);
  });
});

describe('webSearchSpec', () => {
  const spec = webSearchSpec();

  it('names the tool and tells the model to iterate and cite', () => {
    expect(spec.toolSpec?.name).toBe('web_search');
    expect(spec.toolSpec?.description).toBe(
      'Search the public web for current external information: competitor moves, industry news, product releases, '
      + 'market context — anything not in the customer feedback dataset. The user enabled web search for this '
      + 'conversation. Work iteratively: start focused, review, then refine or search another angle; prefer several '
      + 'specific queries over one broad one and do not repeat a query that already answered. Use search_feedback, '
      + 'not this, for the customers\u2019 own feedback. Keep each query under 200 characters. ALWAYS cite the source '
      + 'URLs inline — uncited web claims are not acceptable.',
    );
  });

  it('requires a bounded query and bounds the result count', () => {
    expect(inputSchema(spec)).toStrictEqual({
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200, description: 'Natural-language search query (200 characters max).' },
        max_results: { type: 'integer', minimum: 1, maximum: 10, description: 'How many results (1-10, default 5).' },
      },
      required: ['query'],
      additionalProperties: false,
    });
  });
});

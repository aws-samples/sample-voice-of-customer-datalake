// Simple mock server for local development
// Run with: node mock-server.js

import http from 'http';
import { randomBytes } from 'node:crypto';
import { handleConnectRoutes } from './mock-connect.js';
import { handleSourceRoutes } from './mock-sources.js';
import { handleFormRoutes } from './mock-forms.js';
import { handleOnboardingRoutes } from './mock-onboarding.js';
import {
  attributeFilterOf, dimensionsConfig, entityExtras, handleDimensionRoutes, seedDimensionFixtures, sourceProfiles,
} from './mock-dimensions.js';
import { handleProjectActionRoutes } from './mock-project-actions.js';

// Helper: answer with a status and a JSON body (headers set earlier still apply).
function sendJson(res, status, body) {
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

// Helper: ISO timestamp n days in the past.
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const mockFeedback = [
  {
    feedback_id: '1',
    source_platform: 'webscraper',
    source_channel: 'review',
    source_url: 'https://example.com/review/123',
    original_text: 'Really disappointed with the delivery time. Ordered 2 weeks ago and still waiting!',
    rating: null,
    category: 'delivery',
    subcategory: 'late_delivery',
    journey_stage: 'delivery',
    sentiment_label: 'negative',
    sentiment_score: -0.75,
    urgency: 'high',
    impact_area: 'operations',
    problem_summary: 'Customer experiencing significant delivery delay',
    direct_customer_quote: 'Ordered 2 weeks ago and still waiting',
    // Both persona fields, as the real processor writes them. The persona METRICS
    // axis buckets by `persona_type` — a closed enum — because `persona_name` is
    // legitimately null for the anonymous feedback that is most of a real corpus;
    // see the note beside PERSONA_FIELD in lambda/shared/feedback.py.
    persona_name: 'Impatient Shopper',
    persona_type: 'churn_risk',
    // Written today, imported today
    source_created_at: new Date().toISOString(),
    processed_at: new Date().toISOString(),
  },
  {
    feedback_id: '2',
    source_platform: 'manual_import',
    source_channel: 'review',
    original_text: 'Amazing customer service! They resolved my issue within minutes. Highly recommend!',
    rating: 5,
    category: 'customer_support',
    subcategory: 'helpful_agent',
    journey_stage: 'support',
    sentiment_label: 'positive',
    sentiment_score: 0.92,
    urgency: 'low',
    impact_area: 'cx',
    // Real API strips null fields (processor removes None values), so
    // optional fields are omitted rather than null.
    direct_customer_quote: 'resolved my issue within minutes',
    persona_name: 'Satisfied Customer',
    persona_type: 'advocate',
    // Written 3 days ago, imported today
    source_created_at: daysAgo(3),
    processed_at: new Date().toISOString(),
  },
  {
    feedback_id: '3',
    source_platform: 's3_import',
    source_channel: 'post',
    original_text: 'The product quality has really gone downhill. My last 3 orders had defects.',
    rating: null,
    category: 'product_quality',
    subcategory: 'defective',
    journey_stage: 'usage',
    sentiment_label: 'negative',
    sentiment_score: -0.68,
    urgency: 'medium',
    impact_area: 'product',
    problem_summary: 'Multiple defective products received',
    direct_customer_quote: 'last 3 orders had defects',
    persona_name: 'Repeat Customer',
    persona_type: 'existing_customer',
    // Old backfilled review: written ~400 days ago, imported today.
    // Visible under the imported basis, filtered out under the review basis.
    source_created_at: daysAgo(400),
    processed_at: new Date().toISOString(),
  },
];

seedDimensionFixtures(mockFeedback);

/**
 * `source` + `channel` / `dims` / `tag` on top of the date window, as every
 * list / urgent / entities route applies them; `{error}` for a malformed `dims`.
 */
function filterFeedbackRequest(items, searchParams) {
  const filter = attributeFilterOf(searchParams);
  if (filter.error) return { error: filter.error };
  const source = searchParams?.get('source') || '';
  return { items: filterByDateBasis(items, searchParams).filter((f) => (!source || f.source_platform === source) && filter.admits(f)) };
}

const badDims = (error) => ({ __status: 400, body: { success: false, error } });

// Mirrors the real API's date_basis semantics (see metrics_handler.py):
// 'review' filters by source_created_at (when the customer wrote it),
// 'imported' (default) by processed_at (when it entered the data lake).
function filterByDateBasis(items, searchParams) {
  const daysRaw = Number(searchParams?.get('days'));
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 7;
  const basis = searchParams?.get('date_basis') === 'review' ? 'review' : 'imported';
  const cutoff = Date.now() - days * 86400000;
  return items.filter((item) => {
    const dateStr = basis === 'review'
      ? (item.source_created_at ?? item.processed_at)
      : item.processed_at;
    return new Date(dateStr).getTime() >= cutoff;
  });
}

// Mock EventBridge schedule state per source — the record GET /sources/status
// answers (integrations_handler: {enabled, schedule, rule_name, exists} keyed by
// source; a source with no rule is {enabled:false, exists:false}).
const mockSourcesStatus = {
  sources: {
    webscraper: { enabled: true, schedule: 'rate(30 minutes)', rule_name: 'voc-ingest-webscraper-schedule', exists: true },
    app_reviews_ios: { enabled: true, schedule: 'rate(1 hour)', rule_name: 'voc-ingest-app_reviews_ios-schedule', exists: true },
    app_reviews_android: { enabled: false, schedule: 'rate(3 hours)', rule_name: 'voc-ingest-app_reviews_android-schedule', exists: true },
    manual_import: { enabled: false, exists: false },
    s3_import: { enabled: false, exists: false },
  },
};
const DEFAULT_STATUS_SOURCES = ['webscraper', 'manual_import', 's3_import'];

// Per-source persisted last-run records (?run_status=<source> variant of
// GET /sources/status — the aggregates-table SOURCE_RUN# shape). Used by the
// Synthetic Data source card (#146) and GeneratorConfigModal polling.
const mockSourceRunStatuses = {
  synthetic_reviews: {
    source: 'synthetic_reviews',
    execution_id: 'mock-exec-1',
    status: 'completed',
    started_at: '2026-07-15T09:00:00Z',
    completed_at: '2026-07-15T09:01:30Z',
    items_found: 5,
    errors: [],
  },
};

// Mock categories config
// Problem resolution state (issue #66) — mutable so the toggle round-trips.
const mockResolvedProblems = {};

// Per-surface AI model picker state (issue #96) — mutable so selects round-trip.
// Mirrors lambda/shared/model_config.py (source of truth, lockstep-tested there).
const mockModelSurfaces = {};
const mockAvailableModels = [
  { key: 'opus55', id: 'global.anthropic.claude-opus-5-5', label: 'Claude Opus 5.5', description: 'Deepest reasoning — default for prototypes and the agent conductor and reviewer' },
  { key: 'sonnet55', id: 'global.anthropic.claude-sonnet-5-5', label: 'Claude Sonnet 5.5', description: 'Newest Sonnet with a 1M-token context — default for the AI assistant, documents and utilities' },
  { key: 'sonnet5', id: 'global.anthropic.claude-sonnet-5', label: 'Claude Sonnet 5', description: 'Previous-generation Sonnet — strong analysis and generation' },
  { key: 'sonnet46', id: 'global.anthropic.claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Previous-generation Sonnet (4.6) — strong quality, accepts temperature tuning' },
  { key: 'opus5', id: 'global.anthropic.claude-opus-5', label: 'Claude Opus 5', description: 'Previous-generation Opus — also the automatic fallback when Opus 5.5 declines a request' },
  { key: 'opus48', id: 'global.anthropic.claude-opus-4-8', label: 'Claude Opus 4.8', description: 'Previous-generation Opus (4.8) — the automatic fallback when Opus 5 declines a request' },
  { key: 'haiku55', id: 'global.anthropic.claude-haiku-5-5', label: 'Claude Haiku 5.5', description: 'Fastest and cheapest — default for high-volume enrichment and memory' },
  { key: 'haiku45', id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude Haiku 4.5', description: 'Previous-generation Haiku — fast and cheap, accepts temperature tuning' },
];
// Tokens-per-minute quotas per model key (live values seen 2026-10; Opus 4.8 = 0
// on purpose: subscribed but no capacity). The run counter varies the mock latency.
const mockModelQuotaByKey = {
  opus55: 30_000_000, sonnet55: 6_000_000, sonnet5: 6_000_000, sonnet46: 4_000_000,
  opus5: 10_000_000, opus48: 0, haiku55: 10_000_000, haiku45: 8_000_000,
};
let mockModelTestRuns = 0;
function mockModelQuota(model) {
  return {
    name: `Global cross-region model inference tokens per minute for Anthropic ${model.label}`,
    tokens_per_minute: mockModelQuotaByKey[model.key] ?? 0,
  };
}
const mockSurfaceDefaults = {
  chat: 'global.anthropic.claude-sonnet-5-5',
  documents: 'global.anthropic.claude-sonnet-5-5',
  prototype: 'global.anthropic.claude-opus-5-5',
  enrichment: 'global.anthropic.claude-haiku-5-5',
  utility: 'global.anthropic.claude-sonnet-5-5',
  memory: 'global.anthropic.claude-haiku-5-5',
  agent_orchestrator: 'global.anthropic.claude-opus-5-5',
  agent_worker: 'global.anthropic.claude-sonnet-5-5',
  agent_reviewer: 'global.anthropic.claude-opus-5-5',
  agent_persona: 'global.anthropic.claude-sonnet-5-5',
};

// Categories config — real contract shape (id + subcategories, issue #181).
// The last entry is a deliberately sparse legacy row ({name, display_name,
// color} only — what old DynamoDB rows carry) so local dev permanently
// exercises the normalizeCategories() boundary.
const mockCategoriesConfig = {
  categories: [
    {
      id: 'cat_delivery', name: 'delivery', description: 'Shipping and delivery issues',
      product: 'Fulfilment',
      owners: [{ sub: 'sub-viewer-demo', username: 'viewer-demo', email: 'viewer@example.com' }],
      subcategories: [
        { id: 'sub_late_delivery', name: 'late_delivery', description: 'Late deliveries' },
        { id: 'sub_tracking', name: 'tracking', description: 'Tracking visibility' },
      ],
    },
    {
      id: 'cat_customer_support', name: 'customer_support', description: 'Support interactions',
      subcategories: [
        { id: 'sub_response_time', name: 'response_time', description: 'Slow responses' },
      ],
    },
    {
      id: 'cat_product_quality', name: 'product_quality', description: 'Quality concerns',
      subcategories: [],
    },
    { id: 'cat_pricing', name: 'pricing', description: 'Price-related feedback', product: 'Checkout', subcategories: [] },
    { id: 'cat_website', name: 'website', description: 'Website experience', subcategories: [] },
    // Sparse legacy row: no id, no subcategories.
    { name: 'app', display_name: 'Mobile App', description: 'App experience', color: '#EC4899' },
  ],
  updated_at: new Date().toISOString(),
};

// Mock feedback forms — real wire shape (form_id, full FeedbackFormFields).
// form_3 is deliberately sparse (no theme/title/etc.), mirroring records
// persisted before those fields existed, so local dev exercises the
// normalizeFeedbackForms() boundary from issue #171.
// Kiro Light palette only (src/theme/printPalette.ts KIRO_LIGHT_HEX), like the
// real default theme — the old Tailwind blues/greens showed as off-palette
// swatches in the design audit (E2E F7).
const mockFormTheme = (primary) => ({ primary_color: primary, background_color: '#ffffff', text_color: '#19161d', border_radius: '8px' });
const mockFeedbackForms = [
  {
    form_id: 'form_1', name: 'Website Feedback', enabled: true,
    title: 'Share Your Website Feedback', description: 'Tell us about your experience on our site.',
    question: 'How was your experience?', placeholder: 'Tell us about your experience...',
    rating_enabled: true, rating_type: 'stars', rating_max: 5,
    submit_button_text: 'Submit Feedback', success_message: 'Thank you for your feedback!',
    theme: mockFormTheme('#8e48ff'), collect_email: false, collect_name: false, custom_fields: [],
    category: 'website', subcategory: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    // Validates nothing: a standalone website survey. Must stay off every
    // Prioritization row.
    project_id: '', document_id: '',
  },
  {
    form_id: 'form_2', name: 'Post-Purchase Survey', enabled: true,
    title: 'How was your purchase?', description: 'Rate your recent purchase experience.',
    question: 'What could we do better?', placeholder: 'Share any additional feedback...',
    rating_enabled: true, rating_type: 'emoji', rating_max: 5,
    submit_button_text: 'Submit', success_message: 'Thanks for rating your experience!',
    theme: mockFormTheme('#7337d6'), collect_email: true, collect_name: false, custom_fields: [],
    category: 'delivery', subcategory: '', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    // Linked to proj_1's PR/FAQ: its stats appear on that document's row in
    // Prioritization once the row is expanded.
    project_id: 'proj_1', document_id: 'prfaq_1',
  },
  // Sparse legacy record: only identity fields on the wire — no link fields at
  // all, exercising the "persisted before the link existed" path.
  { form_id: 'form_3', name: 'Support Feedback', enabled: false, created_at: new Date().toISOString() },
  // Partial theme: exercises the deep-merge branch (set color survives,
  // missing theme keys default) rather than the fully-missing-theme branch.
  {
    form_id: 'form_4', name: 'Checkout Survey', enabled: true,
    title: 'How was checkout?', theme: { primary_color: '#723acc' },
    created_at: new Date().toISOString(),
    // Deliberately keeps its healthy 4.6 average below: it is the only 4.x card
    // in the /feedback-forms grid, so repurposing it as the null-average case
    // would have cost that grid its "healthy ratings" appearance.
    project_id: '', document_id: '',
  },
  // A second form validating the SAME document as form_2, with a null average in
  // mockFormStats below: one expanded Prioritization row therefore exercises
  // both the several-forms-per-document case and the ratings-disabled rendering.
  {
    form_id: 'form_5', name: 'PR/FAQ Concept Test', enabled: true,
    title: 'Would you use this?', theme: mockFormTheme('#8e48ff'),
    rating_enabled: false,
    created_at: new Date().toISOString(),
    project_id: 'proj_1', document_id: 'prfaq_1',
  },
];
const mockFormStats = {
  form_1: { total_submissions: 234, avg_rating: 4.2, rating_count: 180 },
  form_2: { total_submissions: 567, avg_rating: 3.8, rating_count: 512 },
  form_3: { total_submissions: 89, avg_rating: null, rating_count: 0 },
  form_4: { total_submissions: 41, avg_rating: 4.6, rating_count: 38 },
  form_5: { total_submissions: 27, avg_rating: null, rating_count: 0 },
};

// Mock Cognito users (issue #177) — stateful so create/enable/disable/delete
// reflect in the UI during a dev session. Shape mirrors CognitoUser.
const mockUsers = [
  {
    username: 'admin-demo', email: 'admin@example.com', name: 'Ada Admin',
    given_name: 'Ada', family_name: 'Admin', status: 'CONFIRMED', enabled: true,
    groups: ['admins'], created_at: new Date(Date.now() - 30 * 86400000).toISOString(),
    last_modified: new Date().toISOString(),
  },
  {
    username: 'viewer-demo', email: 'viewer@example.com', name: 'Vic Viewer',
    given_name: 'Vic', family_name: 'Viewer', status: 'CONFIRMED', enabled: true,
    groups: ['users'], created_at: new Date(Date.now() - 10 * 86400000).toISOString(),
    last_modified: new Date().toISOString(),
  },
  {
    // Not a member of any project — the invitable candidate for the sharing dialog.
    username: 'editor-demo', email: 'editor@example.com', name: 'Eddie Editor',
    given_name: 'Eddie', family_name: 'Editor', status: 'CONFIRMED', enabled: true,
    groups: ['users'], created_at: new Date(Date.now() - 5 * 86400000).toISOString(),
    last_modified: new Date().toISOString(),
  },
  {
    username: 'disabled-demo', email: 'disabled@example.com', name: 'Dee Disabled',
    given_name: 'Dee', family_name: 'Disabled', status: 'CONFIRMED', enabled: false,
    groups: ['users'], created_at: new Date(Date.now() - 60 * 86400000).toISOString(),
    last_modified: new Date().toISOString(),
  },
];

// Apply a user-admin mutation (issue #177). Returns { status, payload };
// keeps the dispatch block small and the mutations in one auditable place.
// Error payloads use the `error` key, matching the real API's shape
// ({'success': False, 'error': ...} from lambda/shared/api.py).
function handleUserAction(method, user, action, body) {
  const touch = () => { user.last_modified = new Date().toISOString(); };
  if (method === 'PUT' && action === 'group') {
    const group = body?.group === 'admins' ? 'admins' : 'users';
    user.groups = [group];
    touch();
    return { status: 200, payload: { success: true, message: `Moved ${user.username} to ${group}` } };
  }
  if (method === 'POST' && action === 'reset-password') {
    return { status: 200, payload: { success: true, message: 'Password reset initiated' } };
  }
  if (method === 'PUT' && (action === 'enable' || action === 'disable')) {
    user.enabled = action === 'enable';
    touch();
    const confirmation = { enable: 'User enabled', disable: 'User disabled' };
    return { status: 200, payload: { success: true, message: confirmation[action] } };
  }
  if (method === 'PUT' && !action) {
    const given = typeof body?.given_name === 'string' ? body.given_name : user.given_name;
    const family = typeof body?.family_name === 'string' ? body.family_name : user.family_name;
    user.given_name = given;
    user.family_name = family;
    user.name = [given, family].filter(Boolean).join(' ') || user.username;
    touch();
    return { status: 200, payload: { success: true, message: 'User updated', given_name: given, family_name: family, name: user.name } };
  }
  if (method === 'DELETE' && !action) {
    mockUsers.splice(mockUsers.indexOf(user), 1);
    return { status: 200, payload: { success: true, message: 'User deleted' } };
  }
  return { status: 405, payload: { success: false, error: 'Method not allowed' } };
}

// Mock scrapers — real ScraperConfig shape (issue #169). scraper_2 is
// deliberately sparse (identity fields only), mirroring records persisted
// before newer fields existed, so local dev exercises the normalizeScrapers()
// boundary: base_url '' renders Not configured, frequency 0 renders
// 'Manual only' (never 'undefinedm').
const mockScrapers = [
  {
    id: 'scraper_1', name: 'Product Reviews', enabled: true,
    base_url: 'https://example.com/reviews', urls: ['https://example.com/reviews?sort=recent'],
    frequency_minutes: 30, extraction_method: 'css',
    container_selector: '.review', text_selector: '.review-text',
    rating_selector: '.review-stars@data-rating', author_selector: '.review-author',
    date_selector: '.review-date',
    pagination: { enabled: true, param: 'page', max_pages: 3, start: 1 },
    last_run: new Date().toISOString(), items_found: 42,
  },
  // Sparse legacy record: identity fields only.
  { id: 'scraper_2', name: 'Forum Posts', enabled: false },
];
const mockScraperRuns = {
  scraper_1: {
    scraper_id: 'scraper_1', status: 'completed',
    started_at: new Date(Date.now() - 3600000).toISOString(),
    completed_at: new Date(Date.now() - 3590000).toISOString(),
    pages_scraped: 3, items_found: 42, errors: [],
  },
};

const handlers = {
  // Feedback Forms list
  // `?include=stats` adds every form's card stats (handler list_forms, E2E F11).
  'GET /feedback-forms': (body, query) => {
    if (!(query instanceof URLSearchParams) || query.get('include') !== 'stats') return { forms: mockFeedbackForms };
    const zero = { total_submissions: 0, avg_rating: null, rating_count: 0 };
    const stats = Object.fromEntries(mockFeedbackForms.map((form) => [form.form_id, mockFormStats[form.form_id] ?? zero]));
    return { success: true, forms: mockFeedbackForms, stats };
  },

  // Sources status. With ?run_status=<source> returns the persisted last-run
  // record for that source (backend _get_source_run_status shape) — used by
  // GeneratorConfigModal polling and SyntheticSourceCard (#146).
  'GET /sources/status': (body, query) => {
    const source = query instanceof URLSearchParams ? query.get('run_status') : null;
    if (typeof source === 'string' && source !== '') {
      return mockSourceRunStatuses[source] ?? { source, status: 'never_run' };
    }
    // ?sources=a,b (de-duplicated, order kept) or the backend's three defaults.
    const requested = query instanceof URLSearchParams ? query.get('sources') : null;
    const names = requested
      ? [...new Set(requested.split(',').map((s) => s.trim()).filter(Boolean))]
      : DEFAULT_STATUS_SOURCES;
    return {
      sources: Object.fromEntries(names.map((name) => [name, mockSourcesStatus.sources[name] ?? { enabled: false, exists: false }])),
    };
  },

  // User administration (issue #177) — stateful list; mutations live in the
  // parameterized /users/:username dispatch block.
  // `sub` is what category ownership and access grants are keyed by.
  'GET /users': () => ({ success: true, users: mockUsers.map((u) => ({ ...u, sub: mockSub(u.username) })) }),
  'POST /users': (body) => {
    if (!body || typeof body.username !== 'string' || body.username.trim() === '') {
      return { __status: 400, body: { success: false, error: 'username is required' } };
    }
    if (mockUsers.some(u => u.username === body.username)) {
      return { __status: 409, body: { success: false, error: 'User already exists' } };
    }
    const given = typeof body.given_name === 'string' ? body.given_name : '';
    const family = typeof body.family_name === 'string' ? body.family_name : '';
    const user = {
      username: body.username,
      email: typeof body.email === 'string' ? body.email : '',
      name: [given, family].filter(Boolean).join(' ') || body.username,
      given_name: given, family_name: family,
      status: 'FORCE_CHANGE_PASSWORD', enabled: true,
      groups: [body.group === 'admins' ? 'admins' : 'users'],
      created_at: new Date().toISOString(), last_modified: new Date().toISOString(),
    };
    mockUsers.push(user);
    return { success: true, user };
  },

  // Settings - Categories
  // GET/PUT /settings/categories are stateful — see handleCategoryRoutes.

  // Settings - Per-surface AI model picker (issue #96)
  'GET /settings/model': () => ({
    available_models: mockAvailableModels,
    surfaces: Object.entries(mockSurfaceDefaults).map(([key, defaultId]) => ({
      key,
      default_id: defaultId,
      selected: mockModelSurfaces[key] ?? null,
    })),
    model_id: null,
  }),
  'PUT /settings/model': (body) => {
    const surface = body?.surface;
    const modelId = body?.model_id ?? null;
    if (!surface || !(surface in mockSurfaceDefaults)) {
      return { __status: 400, body: { success: false, error: 'surface must be a known picker surface' } };
    }
    if (modelId !== null && !mockAvailableModels.some((m) => m.id === modelId)) {
      return { __status: 400, body: { success: false, error: 'model_id must be null or allowlisted' } };
    }
    if (modelId === null) {
      delete mockModelSurfaces[surface];
    } else {
      mockModelSurfaces[surface] = modelId;
    }
    return { success: true, surface, model_id: modelId };
  },
  // Model test + capacity (shared/model_capacity.py). Opus 4.8 is the deliberate
  // zero-quota model so local dev always shows the "No capacity — wait" state.
  'POST /settings/model/test': (body) => {
    const model = mockAvailableModels.find((m) => m.id === body?.model_id);
    if (!model) {
      return { __status: 400, body: { success: false, message: 'model_id must be one of the allowlisted models' } };
    }
    const quota = mockModelQuota(model);
    const noCapacity = quota.tokens_per_minute === 0;
    mockModelTestRuns += 1;
    return {
      model_id: model.id,
      invoked_id: model.id,
      status: noCapacity ? 'no_capacity' : 'available',
      ok: !noCapacity,
      latency_ms: noCapacity ? null : 300 + (mockModelTestRuns % 7) * 90,
      message: noCapacity
        ? 'The token quota for this model is 0 in this account; nothing to do but wait. (ThrottlingException)'
        : 'The model answered.',
      quota,
      checked_at: new Date().toISOString(),
    };
  },
  'GET /settings/model/capacity': () => ({
    models: mockAvailableModels.map((m) => ({ model_id: m.id, label: m.label, quota: mockModelQuota(m) })),
  }),

  'GET /settings/resolved-problems': () => ({ resolved: mockResolvedProblems }),
  'PUT /settings/resolved-problems': (body) => {
    if (!body || typeof body.key !== 'string' || body.key.trim() === '' || typeof body.resolved !== 'boolean') {
      // Mirror the real handler's 400 contract so local dev doesn't mask
      // client bugs behind a 200.
      return { __status: 400, body: { success: false, message: 'key and resolved are required' } };
    }
    if (body.resolved) {
      mockResolvedProblems[body.key] = { resolved_at: new Date().toISOString() };
    } else {
      delete mockResolvedProblems[body.key];
    }
    return { success: true, key: body.key, resolved: body.resolved };
  },

  // Data Explorer
  'GET /data-explorer/stats': () => ({ total_files: 1247, total_size_mb: 156.3, sources: 3 }),

  // Scrapers
  'GET /scrapers': () => ({ scrapers: mockScrapers }),
  'POST /scrapers': (body) => ({ success: true, scraper: { id: 'scraper_' + Date.now(), ...body } }),

  'GET /feedback': (_body, searchParams) => {
    const { items, error } = filterFeedbackRequest(mockFeedback, searchParams);
    if (error) return badDims(error);
    return { count: items.length, total: items.length, offset: 0, limit: 50, is_partial_window: false, items };
  },
  'GET /feedback/urgent': (_body, searchParams) => {
    const { items: candidates, error } = filterFeedbackRequest(mockFeedback, searchParams);
    if (error) return badDims(error);
    const items = candidates.filter(f => f.urgency === 'high');
    return { count: items.length, items };
  },
  'GET /feedback/entities': (_body, searchParams) => {
    const { items, error } = filterFeedbackRequest(mockFeedback, searchParams);
    if (error) return badDims(error);
    const countBy = (getKey) => items.reduce((acc, item) => {
      const key = getKey(item);
      if (key) acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return {
      period_days: Number(searchParams?.get('days')) || 7,
      feedback_count: items.length,
      entities: {
        keywords: {},
        categories: countBy(i => i.category),
        issues: countBy(i => i.problem_summary),
        // The ARCHETYPE, matching `shared/feedback.py::persona_bucket`: both of the
        // real route's branches bucket by `persona_type`, and an item with none
        // counts as `unknown` rather than being dropped, so the persona map sums to
        // `feedback_count`.
        //
        // 🔑 THIS COPY IS DELIBERATELY NOT PINNED, and may be edited freely. The
        // Python side declares the field, the empty value and the archetype enum once
        // in `shared/feedback.py` and forbids either Lambda from spelling them inline,
        // because a drift there is a WRONG NUMBER served to a caller. A Node dev stub
        // serves no production traffic, so a drift here costs a confusing afternoon —
        // not a wrong answer — and it cannot import from `lambda/shared/`. The trade
        // is that this file has to be followed by hand when the axis moves, which is
        // what happened to it: it bucketed on `persona_name` for one round, so local
        // dev was written against a value space production had stopped producing.
        //
        // The one thing it does NOT reproduce is the enum closure — an out-of-contract
        // `persona_type` gets its own bucket here and would be counted as `unknown` by
        // the real route. Every fixture above uses a declared archetype, so the two
        // agree in practice; if a fixture ever needs an out-of-contract value, add the
        // membership test rather than leaving the stub disagreeing.
        personas: countBy(i => i.persona_type || 'unknown'),
        sources: countBy(i => i.source_platform),
      },
      // channels, top-50 tags, {dimension: {value: n}} (the KVD contract additions).
      ...entityExtras(items),
    };
  },
  'GET /metrics/summary': () => ({
    period_days: 7,
    total_feedback: 1247,
    avg_sentiment: 0.12,
    urgent_count: 23,
    daily_totals: Array.from({ length: 7 }, (_, i) => ({
      date: new Date(Date.now() - i * 86400000).toISOString().split('T')[0],
      count: Math.floor(Math.random() * 200) + 100,
    })).reverse(),
    daily_sentiment: Array.from({ length: 7 }, (_, i) => ({
      date: new Date(Date.now() - i * 86400000).toISOString().split('T')[0],
      avg_sentiment: (Math.random() - 0.3) * 0.5,
      count: Math.floor(Math.random() * 200) + 100,
    })).reverse(),
  }),
  'GET /metrics/sentiment': () => ({
    period_days: 7,
    total: 1247,
    breakdown: { positive: 523, neutral: 387, negative: 298, mixed: 39 },
    percentages: { positive: 41.9, neutral: 31.0, negative: 23.9, mixed: 3.1 },
  }),
  'GET /metrics/categories': () => ({
    period_days: 7,
    categories: {
      delivery: 312,
      customer_support: 245,
      product_quality: 198,
      pricing: 156,
      website: 134,
      app: 89,
      billing: 67,
      returns: 46,
    },
  }),
  'GET /metrics/sources': () => ({
    period_days: 7,
    sources: {
      webscraper: 523,
      manual_import: 412,
      s3_import: 312,
      github_issues: 64,
    },
  }),
  // GitHub Issues per release / label (lambda/api/github_metrics.py). One row is
  // deliberately sparse (no sentiment, no lists) so the Zod normalizer in
  // api/githubMetricsSchema.ts stays exercised in dev.
  'GET /metrics/github': (_body, searchParams) => {
    const repo = searchParams?.get('repo') || ''
    const all = !repo
    return {
      period_days: 7,
      is_partial: false,
      total: all ? 64 : 9,
      repos: ['kirodotdev/Kiro', 'kirodotdev/KiroCrew'],
      versions: [
        { version: '0.4.1', count: 18, weight: 41, avg_sentiment: -0.21, negative: 9, issues: 11, comments: 7,
          top_complaints: [{ name: 'performance', count: 5 }], top_errors: [{ name: 'typeerror: cannot read properties of undefined (reading <str>)', count: 4 }] },
        { version: '0.4.2', count: 25, weight: 60, avg_sentiment: -0.34, negative: 14, issues: 13, comments: 12,
          top_complaints: [{ name: 'reliability', count: 8 }, { name: 'performance', count: 3 }],
          top_errors: [{ name: 'error: econnreset while streaming chat response', count: 6 }] },
        { version: '0.5.0', count: all ? 12 : 9, weight: 15, negative: 3, issues: 8, comments: 4 },
      ],
      unversioned: { count: 9, weight: 12, avg_sentiment: 0.05, negative: 2 },
      labels: [
        { label: 'bug', count: 38, weight: 92, avg_sentiment: -0.41, negative: 22, open: 27 },
        { label: 'area: chat', count: 21, weight: 50, avg_sentiment: -0.3, negative: 11, open: 15 },
        { label: 'feature-request', count: 12, weight: 31, avg_sentiment: 0.22, negative: 1, open: 10 },
        { label: 'regression' },
      ],
      latest_version: '0.5.0',
      previous_version: '0.4.2',
      new_in_latest: {
        errors: [{ name: 'panic: spec runner exited with code <n>', count: 3 }],
        categories: [],
        components: [{ name: 'spec runner', count: 4 }],
      },
    }
  },
  'GET /metrics/personas': () => ({
    period_days: 7,
    // The closed archetype enum the real route now returns
    // (`existing_customer|prospect|churn_risk|advocate|unknown`), not free-text
    // names — a stub returning names would have the dashboard developed against a
    // value space production no longer produces.
    personas: {
      existing_customer: 234,
      churn_risk: 198,
      prospect: 167,
      advocate: 145,
      unknown: 123,
    },
  }),
  'POST /chat': () => ({
    response: `I analyzed your feedback data. Here's what I found:\n\n• Total feedback: 1,247 items\n• Average sentiment: 0.12 (slightly positive)\n• Top category: Delivery (25%)\n• Urgent items: 23 requiring attention\n\nWould you like me to dive deeper into any specific area?`,
    sources: mockFeedback.slice(0, 2),
  }),
  'GET /projects': (_body, params) => (params?.has('ids') ? mockProjectDetailBatch(params.get('ids')) : {
    // Derived from the detail fixtures — one source of truth, so list and
    // detail can't drift when someone edits a project. Filtered and decorated
    // like the real API: only projects the caller can view, with the computed
    // sharing fields (legacy fixtures pass through bare — see mockProjectSharing).
    projects: Object.values(mockProjectDetails)
      .filter((detail) => projectAccess(detail.project.project_id).can_view)
      .map((detail) => decorateProject(detail.project)),
  }),
  'POST /projects': (body) => {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return { __status: 400, body: { success: false, error: 'name is required' } };
    const visibility = body.visibility === undefined ? 'private' : body.visibility;
    if (!MOCK_VISIBILITIES.has(visibility)) {
      return { __status: 400, body: { success: false, error: "visibility must be 'public' or 'private'" } };
    }
    // The real shape (shared/ids.py): a UTC second stamp and 8 random hex, so two
    // creates in the same instant get different ids here too.
    const id = `proj_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}_${randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    mockProjectDetails[id] = {
      project: {
        project_id: id, name, description: typeof body.description === 'string' ? body.description : '',
        status: 'active', created_at: now, updated_at: now, persona_count: 0, document_count: 0,
        ...(body.filters ? { filters: body.filters } : {}),
      },
      personas: [],
      documents: [],
    };
    mockProjectSharing[id] = {
      owner_sub: MOCK_CALLER.sub, owner_username: MOCK_CALLER.username, owner_email: MOCK_CALLER.email,
      visibility, members: {},
    };
    return { success: true, project: decorateProject(mockProjectDetails[id].project) };
  },
  // Prioritization (rows / caller's ballots / team aggregates) — stateful, see
  // the "Prioritization + voting sessions" block below for the fixtures.
  'GET /projects/prioritization': () => prioritizationRead(),
  // The real handler refuses PUT since per-reviewer ballots (a whole-map write
  // has no honest meaning); mirror that so a stray caller fails loudly in dev.
  'PUT /projects/prioritization': () => ({
    __status: 400, body: { success: false, error: 'Use PATCH to save your own ballot' },
  }),
  'PATCH /projects/prioritization': (body) => patchCallerBallots(body),
  'POST /projects/prioritization/rows': (body) => ensureDefaultRow(body),
  'POST /projects/prioritization/rows/compose': (body) => composeRow(body),

  // Brand settings (settings_handler.py) — stateful so Settings round-trips.
  'GET /settings/brand': () => ({ ...mockBrandSettings }),
  'PUT /settings/brand': (body) => {
    const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);
    mockBrandSettings.brand_name = typeof body?.brand_name === 'string' ? body.brand_name : '';
    mockBrandSettings.brand_handles = strings(body?.brand_handles);
    mockBrandSettings.hashtags = strings(body?.hashtags);
    mockBrandSettings.urls_to_track = strings(body?.urls_to_track);
    return { success: true, message: 'Brand settings saved', settings: { ...mockBrandSettings } };
  },

  // Voting sessions — facilitator create (Cognito on the real API).
  'POST /voting-sessions': (body) => createVotingSession(body),
};

// ── Brand settings ─────────────────────────────────────────────────────────
const mockBrandSettings = {
  brand_name: 'Acme Outfitters',
  brand_handles: ['@acmeoutfitters', '@acme_help'],
  hashtags: ['#acmeoutfitters'],
  urls_to_track: ['https://example.com/reviews'],
};

// ── App-review configs (integrations_handler.py, APP_CONFIG_PLUGINS) ──────
// Values are strings on the wire (the configs live as JSON in a secret and the
// frontend types them Record<string, string>). One app per platform plus one
// disabled Android app, so the Scrapers app cards show both states.
const APP_CONFIG_PLUGINS = new Set(['app_reviews_ios', 'app_reviews_android']);
const mockAppConfigs = {
  app_reviews_ios: [
    { id: 'ios01abc', app_name: 'Acme Shop', app_id: '585629514', sort_by: 'most_recent', max_reviews_per_run: '500', frequency_minutes: '60', enabled: 'true' },
  ],
  app_reviews_android: [
    { id: 'and01abc', app_name: 'Acme Shop', package_name: 'com.example.acmeshop', sort_by: 'most_recent', max_reviews_per_run: '500', frequency_minutes: '180', enabled: 'true' },
    { id: 'and02def', app_name: 'Acme Rewards', package_name: 'com.example.acmerewards', sort_by: 'newest', max_reviews_per_run: '200', frequency_minutes: '0', enabled: 'false' },
  ],
};

// ── Prioritization + voting sessions (projects_handler.py, ballots_handler.py)
// Rows are keyed by ROW id; a project's default row id is derived
// (`row_<project>_default`). Ballots: the caller's own (`callerBallots`) plus
// anonymous/other reviewers (`otherBallots`), both feeding the team aggregate.
const SCORE_AXES = ['impact', 'time_to_market', 'confidence', 'strategic_fit'];
const COMPOSITE_WEIGHTS = { impact: 0.4, time_to_market: 0.3, strategic_fit: 0.2, confidence: 0.1 };
const SCORABLE_DOC_TYPES = new Set(['prd', 'prfaq']);
const defaultRowId = (projectId) => `row_${projectId}_default`;
const mockPrioritizationRows = {
  row_proj_1_default: {
    row_id: 'row_proj_1_default', project_id: 'proj_1', document_ids: ['prfaq_1'],
    prototype_id: '', is_default: true, created_at: daysAgo(6),
  },
};
const callerBallots = {}; // rowId -> partial ballot
// Two teammates already scored proj_1's row, so the team columns have data
// (and the row is frozen, as a balloted row is on the real API).
const otherBallots = {
  row_proj_1_default: [
    { impact: 5, time_to_market: 3, confidence: 4, strategic_fit: 4, notes: 'Top churn driver in Q1.' },
    { impact: 4, time_to_market: 2, confidence: 3, strategic_fit: 5, notes: '' },
  ],
};

const isVote = (b) => SCORE_AXES.some((axis) => typeof b?.[axis] === 'number');
const isFullyScored = (b) => SCORE_AXES.every((axis) => typeof b?.[axis] === 'number');
const composite = (b) => SCORE_AXES.reduce((sum, axis) => sum + (b[axis] ?? 0) * COMPOSITE_WEIGHTS[axis], 0);
const round2 = (n) => Math.round(n * 100) / 100;

function rowBallots(rowId) {
  const own = callerBallots[rowId];
  return [...(otherBallots[rowId] ?? []), ...(own ? [own] : [])];
}

function rowPayload(row) {
  return { ...row, is_frozen: rowBallots(row.row_id).some(isVote) };
}

function aggregateFor(rowId) {
  const votes = rowBallots(rowId).filter(isVote);
  if (votes.length === 0) return null;
  const means = Object.fromEntries(SCORE_AXES.map((axis) => {
    const scored = votes.filter((v) => typeof v[axis] === 'number').map((v) => v[axis]);
    return [axis, scored.length ? round2(scored.reduce((a, b) => a + b, 0) / scored.length) : 0];
  }));
  const comparable = votes.filter(isFullyScored).map(composite);
  return {
    ...means,
    reviewer_count: votes.length,
    score_spread: comparable.length > 1 ? round2(Math.max(...comparable) - Math.min(...comparable)) : 0,
  };
}

function prioritizationRead() {
  const rows = Object.fromEntries(Object.values(mockPrioritizationRows).map((row) => [row.row_id, rowPayload(row)]));
  const scores = Object.fromEntries(Object.entries(callerBallots).map(([rowId, b]) => [rowId, {
    row_id: rowId,
    ...Object.fromEntries(SCORE_AXES.map((axis) => [axis, b[axis] ?? 0])),
    notes: b.notes ?? '',
  }]));
  const aggregates = Object.fromEntries(Object.keys(mockPrioritizationRows)
    .map((rowId) => [rowId, aggregateFor(rowId)])
    .filter(([, agg]) => agg !== null));
  return { rows, scores, aggregates };
}

/** Validate one ballot's axes/notes like ballots_handler: ints 0..5, notes ≤ 2000. */
function readBallotFields(entry) {
  const out = {};
  for (const axis of SCORE_AXES) {
    if (entry?.[axis] === undefined) continue;
    const v = entry[axis];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 5) return { error: `${axis} must be a number from 0 to 5` };
    out[axis] = v;
  }
  if (entry?.notes !== undefined) {
    if (typeof entry.notes !== 'string' || entry.notes.length > 2000) return { error: 'notes must be a string of at most 2000 characters' };
    out.notes = entry.notes;
  }
  return { fields: out };
}

function patchCallerBallots(body) {
  const scores = body?.scores;
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
    return { __status: 400, body: { success: false, error: 'scores must be an object keyed by row id' } };
  }
  let updated = 0;
  for (const [rowId, entry] of Object.entries(scores)) {
    if (!mockPrioritizationRows[rowId]) {
      return { __status: 404, body: { success: false, error: `Row ${rowId} not found` } };
    }
    const parsed = readBallotFields(entry);
    if (parsed.error) return { __status: 400, body: { success: false, error: parsed.error } };
    if (Object.keys(parsed.fields).length === 0) continue; // legal no-op, not counted
    callerBallots[rowId] = { ...(callerBallots[rowId] ?? {}), ...parsed.fields };
    updated += 1;
  }
  return { success: true, updated_count: updated };
}

/** Latest PRD and latest PR/FAQ of a project — `_default_row_composition`. */
function scorableDocuments(projectId) {
  return (mockProjectDetails[projectId]?.documents ?? []).filter((d) => SCORABLE_DOC_TYPES.has(d.document_type));
}

function ensureDefaultRow(body) {
  const projectId = body?.project_id;
  if (typeof projectId !== 'string' || projectId === '' || projectId.includes('#')) {
    return { __status: 400, body: { success: false, error: 'project_id is required' } };
  }
  if (!mockProjectDetails[projectId]) {
    return { __status: 404, body: { success: false, error: `Project ${projectId} not found` } };
  }
  const rowId = defaultRowId(projectId);
  if (mockPrioritizationRows[rowId]) {
    return { success: true, created: false, row: rowPayload(mockPrioritizationRows[rowId]) };
  }
  const newest = {};
  for (const doc of scorableDocuments(projectId)) {
    const incumbent = newest[doc.document_type];
    if (!incumbent || String(doc.created_at) > String(incumbent.created_at)) newest[doc.document_type] = doc;
  }
  const documentIds = Object.values(newest).map((d) => d.document_id);
  if (documentIds.length === 0) {
    return { __status: 400, body: { success: false, error: 'This project has no PRD or PR/FAQ to score, so it has no prioritization row' } };
  }
  return storeNewRow({ rowId, projectId, documentIds, isDefault: true });
}

/** Store a freshly composed prioritization row and answer as the create routes do. */
function storeNewRow({ rowId, projectId, documentIds, isDefault }) {
  const row = { row_id: rowId, project_id: projectId, document_ids: documentIds, prototype_id: '', is_default: isDefault, created_at: new Date().toISOString() };
  mockPrioritizationRows[rowId] = row;
  return { success: true, created: true, row: rowPayload(row) };
}

/** Validate a {project_id, document_ids} composition against the project's scorable docs. */
function readComposition(body) {
  const projectId = body?.project_id;
  const ids = body?.document_ids;
  if (typeof projectId !== 'string' || !mockProjectDetails[projectId]) {
    return { status: 404, error: 'Project not found' };
  }
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
    return { status: 400, error: 'document_ids must be a non-empty list of document ids' };
  }
  const scorable = new Set(scorableDocuments(projectId).map((d) => d.document_id));
  if (ids.some((id) => !scorable.has(id))) {
    return { status: 404, error: 'A document id is not a scorable document of this project' };
  }
  return { projectId, documentIds: [...new Set(ids)] };
}

function composeRow(body) {
  const parsed = readComposition(body);
  if (parsed.error) return { __status: parsed.status, body: { success: false, error: parsed.error } };
  const projectRows = Object.values(mockPrioritizationRows).filter((r) => r.project_id === parsed.projectId);
  if (projectRows.length >= 10) {
    return { __status: 409, body: { success: false, error: 'This project already has the maximum number of rows' } };
  }
  return storeNewRow({ rowId: nextMockId('row'), projectId: parsed.projectId, documentIds: parsed.documentIds, isDefault: false });
}

function recomposeRow(rowId, body) {
  const row = mockPrioritizationRows[rowId];
  const parsed = readComposition(body);
  if (parsed.error) return { status: parsed.status, payload: { success: false, error: parsed.error } };
  if (!row || row.project_id !== parsed.projectId || rowPayload(row).is_frozen) {
    return { status: 409, payload: { success: false, error: 'This row has ballots or no longer exists; reload to see the current rows' } };
  }
  row.document_ids = parsed.documentIds;
  return { status: 200, payload: { success: true, created: false, row: rowPayload(row) } };
}

function deleteRow(rowId) {
  if (!mockPrioritizationRows[rowId]) {
    return { status: 404, payload: { success: false, error: 'Row not found' } };
  }
  const ballotsDeleted = rowBallots(rowId).length;
  delete mockPrioritizationRows[rowId];
  delete callerBallots[rowId];
  delete otherBallots[rowId];
  return { status: 200, payload: { success: true, ballots_deleted: ballotsDeleted } };
}

// Voting sessions. 'demo' is an open room on proj_1's row (the URL the crawl
// and validation tracks open at /vote/demo); 'closed-demo' is a closed one so
// the ballot page's "this session is closed" state is reachable locally.
const DEFAULT_BALLOT_CAP = 40;
const MAX_BALLOT_CAP = 200;
const mockVotingSessions = {
  demo: {
    session_id: 'demo', row_id: 'row_proj_1_default', row_title: 'Proactive Delivery Updates',
    status: 'open', ballot_cap: DEFAULT_BALLOT_CAP, ballot_count: 0, ballot_ids: [],
    created_at: daysAgo(0), expires_at: new Date(Date.now() + 8 * 3600000).toISOString(), closed_at: '',
  },
  'closed-demo': {
    session_id: 'closed-demo', row_id: 'row_proj_1_default', row_title: 'Proactive Delivery Updates',
    status: 'closed', ballot_cap: DEFAULT_BALLOT_CAP, ballot_count: 12, ballot_ids: [],
    created_at: daysAgo(2), expires_at: daysAgo(1), closed_at: daysAgo(2),
  },
};
const anonymousBallots = {}; // ballot_id -> { sessionId, ballot }

function sessionState(session) {
  if (session.status !== 'open') return 'closed';
  return new Date(session.expires_at).getTime() <= Date.now() ? 'expired' : 'open';
}

function sessionPayload(session) {
  const { ballot_ids: _ids, ...rest } = session;
  return { ...rest, state: sessionState(session) };
}

function createVotingSession(body) {
  const rowId = body?.row_id;
  if (typeof rowId !== 'string' || !mockPrioritizationRows[rowId]) {
    return { __status: 404, body: { success: false, error: 'Row not found' } };
  }
  const minutes = 240;
  const cap = Number.isInteger(body?.ballot_cap) ? Math.min(Math.max(body.ballot_cap, 1), MAX_BALLOT_CAP) : DEFAULT_BALLOT_CAP;
  const sessionId = nextMockId('vs');
  const session = {
    session_id: sessionId, row_id: rowId,
    row_title: typeof body?.row_title === 'string' ? body.row_title.slice(0, 200) : '',
    status: 'open', ballot_cap: cap, ballot_count: 0, ballot_ids: [],
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + minutes * 60000).toISOString(), closed_at: '',
  };
  mockVotingSessions[sessionId] = session;
  return { success: true, session: sessionPayload(session) };
}

const BALLOT_REFUSAL_STATUS = { not_found: 404, closed: 409, expired: 409, cap_reached: 429, invalid: 400 };
const ballotRefusal = (reason, error) => ({
  status: BALLOT_REFUSAL_STATUS[reason],
  payload: { success: false, reason, error },
});

function submitAnonymousBallot(session, body) {
  if (!session) return ballotRefusal('not_found', 'This voting session does not exist');
  const state = sessionState(session);
  if (state !== 'open') return ballotRefusal(state, `This voting session is ${state}`);
  const parsed = readBallotFields(body);
  if (parsed.error) return ballotRefusal('invalid', parsed.error);
  if (!isVote(parsed.fields)) return ballotRefusal('invalid', 'Score at least one axis');
  const displayName = typeof body?.display_name === 'string' ? body.display_name.trim().slice(0, 60) : '';
  const ballot = { ...parsed.fields, ...(displayName ? { display_name: displayName } : {}) };
  // A device correcting its own vote on THIS session: overwrite, no cap slot.
  const priorId = typeof body?.ballot_id === 'string' ? body.ballot_id : '';
  const prior = anonymousBallots[priorId];
  const rowList = otherBallots[session.row_id] ?? (otherBallots[session.row_id] = []);
  if (prior && prior.sessionId === session.session_id) {
    rowList[rowList.indexOf(prior.ballot)] = ballot;
    prior.ballot = ballot;
    return { status: 200, payload: { success: true, ballot_id: priorId, corrected: true, row_title: session.row_title } };
  }
  if (session.ballot_count >= session.ballot_cap) {
    return ballotRefusal('cap_reached', 'This voting session has reached its ballot limit');
  }
  const ballotId = nextMockId('ballot');
  anonymousBallots[ballotId] = { sessionId: session.session_id, ballot };
  rowList.push(ballot);
  session.ballot_count += 1;
  return { status: 200, payload: { success: true, ballot_id: ballotId, corrected: false, row_title: session.row_title } };
}

/** Parameterized prioritization-row, voting-session and app-config routes.
 * Returns true when it handled (or is handling) the request. */
// Routes that live in their own modules. Each handler claims ONLY the routes it
// owns (returns false otherwise) and gets the shared fixtures it needs passed
// in, so the modules never import from this file (it has no exports).
function handleDomainModules(req, res, url) {
  const send = (status, payload) => sendJson(res, status, payload);
  const shared = {
    collectJson, nextMockId, mockFeedback, mockSourcesStatus, mockSourceRunStatuses,
    mockScrapers, mockScraperRuns, mockCategoriesConfig,
    mockFeedbackForms, mockFormStats, mockProjectDetails, mockProductJobs,
    attributeFilterOf, sourceProfiles, dimensionsConfig,
  };
  return handleDimensionRoutes(req, res, url, send, shared)
    || handleSourceRoutes(req, res, url, send, shared)
    || handleFormRoutes(req, res, url, send, shared)
    || handleProjectActionRoutes(req, res, url, send, shared)
    || handleOnboardingRoutes(req, res, url, send, shared);
}

function handleParameterizedExtras(req, res, url) {
  const send = (status, payload) => sendJson(res, status, payload);
  return handleRowRoutes(req, res, url, send)
    || handleVotingSessionRoutes(req, res, url, send)
    || handleAppConfigRoutes(req, res, url, send)
    || handleCategoryRoutes(req, res, url, send)
    || handleMemoryContextRoutes(req, res, url, send)
    || handleAgentsWorkflowsRoutes(req, res, url, send)
    || handleConnectRoutes(req, res, url, send, collectJson);
}

// ── Categories: config (with product/owners), access grants, reprocess jobs,
//    per-review category changes. Stateful for the life of the process. ──────
//
// The mock caller is an admin, so GET /feedback/access answers "all". Start the
// server with MOCK_RESTRICT_CATEGORIES=delivery,pricing to exercise a
// restricted caller (filters hide the rest; changes outside it answer 404).
const MOCK_RESTRICTED = (process.env.MOCK_RESTRICT_CATEGORIES || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const mockCategoryAccess = new Map(); // username → {categories: ['*'] | [names], updated_at}; absent = all
const mockReprocessJobs = [];         // newest last
const MOCK_REPROCESS_TOTAL = 120;     // reviews the fake job "scans"
const MOCK_REPROCESS_STEP = 30;       // advanced per poll
// The real per-job ceiling is 50 000 scanned reviews (MAX_REPROCESS_ITEMS in
// shared/reprocess_jobs.py). Start the mock with MOCK_REPROCESS_CEILING=60 to
// see a job finish as 'completed' with stopped_at_ceiling.
const MOCK_REPROCESS_CEILING = Number(process.env.MOCK_REPROCESS_CEILING) || 50000;

const callerAdmits = (name) => MOCK_RESTRICTED.length === 0 || MOCK_RESTRICTED.includes(name);
const configuredCategory = (name) => mockCategoriesConfig.categories.find((c) => c.name === name);

function validateCategoriesConfig(categories) {
  if (!Array.isArray(categories) || categories.length > 50) return 'At most 50 categories';
  const names = new Set();
  for (const c of categories) {
    if (!c || typeof c.name !== 'string' || c.name === '' || c.name.length > 64) return 'Invalid category name';
    if (names.has(c.name)) return `Duplicate category name: ${c.name}`;
    names.add(c.name);
    if (c.product !== undefined && (typeof c.product !== 'string' || c.product.length > 120)) return 'Invalid product';
    if (c.owners !== undefined && (!Array.isArray(c.owners) || c.owners.length > 20)) return 'At most 20 owners';
  }
  return null;
}

/** One poll advances a live job: queued → running → … → completed. */
function advanceReprocessJob(job) {
  if (job.status === 'queued') job.status = 'running';
  else if (job.status === 'running') {
    job.scanned = Math.min(MOCK_REPROCESS_TOTAL, MOCK_REPROCESS_CEILING, job.scanned + MOCK_REPROCESS_STEP);
    job.updated = Math.round(job.scanned * 0.4);
    job.skipped_manual = job.include_manual ? 0 : 1;
    job.unchanged = job.scanned - job.updated - job.skipped_manual;
    if (job.scanned >= MOCK_REPROCESS_TOTAL || job.scanned >= MOCK_REPROCESS_CEILING) {
      job.stopped_at_ceiling = job.scanned < MOCK_REPROCESS_TOTAL;
      job.status = 'completed';
      job.finished_at = new Date().toISOString();
    }
  }
  job.updated_at = new Date().toISOString();
  return job;
}

function startReprocessJob(body) {
  if (mockReprocessJobs.some((j) => j.status === 'queued' || j.status === 'running')) {
    return [409, { success: false, error: 'A reprocess job is already running' }];
  }
  const mode = body?.mode;
  const days = body?.days;
  if (!['processed', 'raw', 'dimensions'].includes(mode) || !Number.isInteger(days) || days < 0 || days > 9999) {
    return [400, { success: false, error: 'mode must be processed|raw|dimensions and days 0–9999' }];
  }
  const now = new Date().toISOString();
  const job = {
    job_id: `rp_${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
    status: 'queued', mode, days, include_manual: body.include_manual === true,
    scanned: 0, updated: 0, unchanged: 0, skipped_manual: 0, failed: 0, stopped_at_ceiling: false,
    started_by: MOCK_CALLER.username, created_at: now, updated_at: now,
  };
  mockReprocessJobs.push(job);
  return [202, { job }];
}

function handleReprocessRoutes(req, url, body) {
  const match = url.pathname.match(/^\/settings\/categories\/reprocess(?:\/([^/]+)(\/cancel)?)?$/);
  if (!match) return null;
  const [, jobId, cancel] = match;
  if (!jobId && req.method === 'POST') return startReprocessJob(body);
  if (!jobId && req.method === 'GET') {
    const latest = mockReprocessJobs.at(-1);
    return [200, { job: latest ? advanceReprocessJob(latest) : null }];
  }
  const job = mockReprocessJobs.find((j) => j.job_id === jobId);
  if (!job) return [404, { success: false, error: 'Job not found' }];
  if (cancel && req.method === 'POST') {
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'cancelled';
      job.finished_at = job.updated_at = new Date().toISOString();
    }
    return [200, { job }];
  }
  if (!cancel && req.method === 'GET') return [200, { job: advanceReprocessJob(job) }];
  return [405, { success: false, error: 'Method not allowed' }];
}

function changeFeedbackCategory(id, body) {
  const item = mockFeedback.find((f) => f.feedback_id === id);
  if (!item || !callerAdmits(item.category)) return [404, { success: false, error: 'Not found' }];
  const target = typeof body?.category === 'string' ? configuredCategory(body.category) : undefined;
  if (!target || !callerAdmits(target.name)) return [400, { success: false, error: 'Unknown category' }];
  const subcategory = typeof body.subcategory === 'string' && body.subcategory !== '' ? body.subcategory : undefined;
  if (subcategory && !(target.subcategories || []).some((s) => s.name === subcategory)) {
    return [400, { success: false, error: 'Unknown subcategory' }];
  }
  // No `by_sub`: the real API stores it but never returns it (shared/category_override.py).
  item.category_override = {
    previous_category: item.category, previous_subcategory: item.subcategory,
    by_username: MOCK_CALLER.username, at: new Date().toISOString(),
  };
  item.category = target.name;
  if (subcategory) item.subcategory = subcategory; else delete item.subcategory;
  item.category_source = 'manual';
  const { feedback_id, category, category_source, category_override } = item;
  return [200, { success: true, feedback: { feedback_id, category, subcategory: item.subcategory, category_source, category_override } }];
}

function handleUserAccessRoutes(req, url, body) {
  const match = url.pathname.match(/^\/users\/([^/]+)\/category-access$/);
  if (!match) return null;
  const username = decodeURIComponent(match[1]);
  if (!mockUsers.some((u) => u.username === username)) return [404, { success: false, error: 'User not found' }];
  if (req.method === 'GET') return [200, userAccessResponse(username, mockCategoryAccess.get(username))];
  if (req.method !== 'PUT') return [405, { success: false, error: 'Method not allowed' }];
  const categories = body?.categories;
  const valid = Array.isArray(categories) && categories.length > 0
    && (categories.length === 1 && categories[0] === '*' || categories.every((c) => configuredCategory(c)));
  if (!valid) return [400, { success: false, error: "categories must be ['*'] or configured names" }];
  const sources = body.sources;
  const profileIds = new Set(sourceProfiles().map((p) => p.id));
  const validSources = sources === undefined || sources === null || (Array.isArray(sources)
    && (sources.length === 1 && sources[0] === '*' || sources.every((id) => profileIds.has(id))));
  if (!validSources) return [400, { success: false, error: "sources must be ['*'] or configured source profile ids" }];
  // Omitted sources = unchanged (the contract), so the stored list survives a categories-only PUT;
  // null clears it back to the default rule.
  const previous = mockCategoryAccess.get(username)?.sources;
  const kept = sources === undefined ? previous : sources ?? undefined;
  const grant = { categories, ...(kept === undefined ? {} : { sources: kept }), updated_at: new Date().toISOString() };
  mockCategoryAccess.set(username, grant);
  return [200, userAccessResponse(username, grant)];
}

/** Mirrors users_handler._access_response: no row (or '*') reads as every category. */
function userAccessResponse(username, grant) {
  const stored = grant?.categories;
  const sub = mockSub(username);
  return {
    success: true,
    username,
    all: stored === undefined || stored.includes('*'),
    categories: stored ?? ['*'],
    // null = the default rule (every source that is not restricted), like users_handler.
    sources: grant?.sources ?? null,
    owned_categories: mockCategoriesConfig.categories
      .filter((c) => (c.owners || []).some((o) => o.sub === sub)).map((c) => c.name).sort(),
    updated_at: grant?.updated_at ?? null,
  };
}

/** Synchronous routes of this block; null when the path is not one of them. */
function routeCategoryRequest(req, url, body) {
  const key = `${req.method} ${url.pathname}`;
  if (key === 'GET /feedback/access') {
    const categoryScope = MOCK_RESTRICTED.length === 0 ? { all: true, categories: [] } : { all: false, categories: [...MOCK_RESTRICTED].sort() };
    // The mock caller is an admin: every source, restricted ones included.
    return [200, { ...categoryScope, sources_all: true, sources: [], source_rule: 'all', sources_denied: [] }];
  }
  if (key === 'GET /settings/categories') return [200, mockCategoriesConfig];
  if (key === 'PUT /settings/categories') {
    const error = validateCategoriesConfig(body?.categories);
    if (error) return [400, { success: false, error }];
    mockCategoriesConfig.categories = body.categories;
    mockCategoriesConfig.updated_at = new Date().toISOString();
    return [200, { success: true, message: `Saved ${body.categories.length} categories` }];
  }
  const changeMatch = url.pathname.match(/^\/feedback\/([^/]+)\/category$/);
  if (changeMatch && req.method === 'PUT') return changeFeedbackCategory(decodeURIComponent(changeMatch[1]), body);
  return handleReprocessRoutes(req, url, body) ?? handleUserAccessRoutes(req, url, body);
}

const CATEGORY_ROUTE = /^\/(feedback\/access|feedback\/[^/]+\/category|settings\/categories(\/reprocess.*)?|users\/[^/]+\/category-access)$/;

function handleCategoryRoutes(req, res, url, send) {
  if (!CATEGORY_ROUTE.test(url.pathname)) return false;
  collectJson(req, res, (body) => {
    const result = routeCategoryRequest(req, url, body) ?? [405, { success: false, error: 'Method not allowed' }];
    send(result[0], result[1]);
  });
  return true;
}

function handleRowRoutes(req, res, url, send) {
  const rowMatch = url.pathname.match(/^\/projects\/prioritization\/rows\/([^/]+)$/);
  if (rowMatch && rowMatch[1] !== 'compose' && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const rowId = decodeURIComponent(rowMatch[1]);
    if (req.method === 'DELETE') {
      const result = deleteRow(rowId);
      send(result.status, result.payload);
    } else {
      collectJson(req, res, (body) => {
        const result = recomposeRow(rowId, body);
        send(result.status, result.payload);
      });
    }
    return true;
  }
  return false;
}

function handleVotingSessionRoutes(req, res, url, send) {
  const sessionMatch = url.pathname.match(/^\/voting-sessions\/([^/]+)(?:\/(config|submit|close))?$/);
  if (sessionMatch) {
    const session = mockVotingSessions[decodeURIComponent(sessionMatch[1])];
    const action = sessionMatch[2];
    if (req.method === 'GET' && action === 'config') {
      // PUBLIC projection: no cap, no count, no creator. Unknown → open:false.
      send(200, {
        success: true,
        session: session
          ? { open: sessionState(session) === 'open', reason: sessionState(session) === 'open' ? null : sessionState(session), row_title: session.row_title }
          : { open: false, reason: 'not_found', row_title: '' },
      });
    } else if (req.method === 'POST' && action === 'submit') {
      collectJson(req, res, (body) => {
        const result = submitAnonymousBallot(session, body);
        send(result.status, result.payload);
      });
    } else if (req.method === 'POST' && action === 'close') {
      if (!session) {
        send(404, { success: false, error: 'Voting session not found' });
      } else {
        if (session.status === 'open') {
          session.status = 'closed';
          session.closed_at = new Date().toISOString();
        }
        send(200, { success: true, session: sessionPayload(session) });
      }
    } else if (req.method === 'GET' && !action) {
      if (session) send(200, { success: true, session: sessionPayload(session) });
      else send(404, { success: false, error: 'Voting session not found' });
    } else {
      send(405, { success: false, error: 'Method not allowed' });
    }
    return true;
  }
  return false;
}

function handleAppConfigRoutes(req, res, url, send) {
  const appsMatch = url.pathname.match(/^\/integrations\/([^/]+)\/apps(?:\/([^/]+))?$/);
  if (appsMatch) {
    const source = appsMatch[1];
    const appId = appsMatch[2] ? decodeURIComponent(appsMatch[2]) : null;
    if (!APP_CONFIG_PLUGINS.has(source)) {
      send(400, { success: false, error: `Source ${source} does not support multiple app configs` });
      return true;
    }
    const apps = mockAppConfigs[source];
    if (req.method === 'GET' && !appId) {
      send(200, { apps });
    } else if (req.method === 'POST' && !appId) {
      collectJson(req, res, (body) => {
        const app = body?.app;
        if (!app || typeof app !== 'object' || Array.isArray(app)) {
          send(400, { success: false, error: 'No app config provided' });
          return;
        }
        if (typeof app.app_name !== 'string' || app.app_name.trim() === '') {
          send(400, { success: false, error: 'app_name is required' });
          return;
        }
        // String values only, matching the wire type.
        const clean = Object.fromEntries(Object.entries(app).filter(([, v]) => typeof v === 'string'));
        if (!clean.id) clean.id = nextMockId('app').slice(-8);
        const index = apps.findIndex((a) => a.id === clean.id);
        if (index >= 0) apps[index] = clean;
        else apps.push(clean);
        send(200, { success: true, app: clean });
      });
    } else if (req.method === 'DELETE' && appId) {
      mockAppConfigs[source] = apps.filter((a) => a.id !== appId);
      send(200, { success: true });
    } else {
      send(405, { success: false, error: 'Method not allowed' });
    }
    return true;
  }

  return false;
}

// Project detail fixtures for /projects/:id — shape mirrors ProjectDetail
// ({ project, personas, documents }) so the Project Detail page works
// against the mock in local dev. Timestamps are frozen at server start on
// purpose: stable fixtures beat fake freshness for a mock.
const mockProjectDetails = {
  proj_1: {
    project: { project_id: 'proj_1', name: 'Q1 Product Improvements', description: 'Customer-driven improvements', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), persona_count: 2, document_count: 2 },
    personas: [
      {
        persona_id: 'persona_1',
        name: 'Deadline-Driven Dana',
        tagline: 'Orders late, expects miracles',
        created_at: new Date().toISOString(),
        confidence: 'high',
        feedback_count: 14,
        goals: ['Get orders delivered before the promised date', 'Track packages without contacting support'],
        frustrations: ['Late deliveries with no proactive updates', 'Support wait times'],
        quote: 'If the app just told me the truth about delivery dates, I would stop refreshing it every hour.',
      },
      {
        persona_id: 'persona_2',
        name: 'Value-Hunter Victor',
        tagline: 'Compares every price twice',
        created_at: new Date().toISOString(),
        confidence: 'medium',
        feedback_count: 9,
        goals: ['Find the best price without coupons breaking at checkout'],
        frustrations: ['Prices changing between cart and checkout'],
        quote: 'I do not mind paying, I mind being surprised.',
      },
    ],
    documents: [
      {
        document_id: 'research_1',
        document_type: 'research',
        title: 'Delivery Pain Points Analysis',
        question: 'What are the main delivery-related pain points?',
        content: '# Research Report: Delivery Pain Points\n\n## Executive Summary\nCustomers consistently report late deliveries and poor tracking visibility as their top frustrations.\n\n## Key Findings\n1. **Late deliveries** dominate negative feedback (62% of delivery mentions).\n2. **Tracking opacity** amplifies frustration more than lateness itself.\n\n## Recommendations\n- Proactive delay notifications\n- Honest delivery estimates at checkout',
        feedback_count: 23,
        created_at: new Date().toISOString(),
      },
      {
        document_id: 'prfaq_1',
        document_type: 'prfaq',
        title: 'Proactive Delivery Updates',
        feature_idea: 'Proactive delivery delay notifications',
        content: '# PR/FAQ: Proactive Delivery Updates\n\n## Press Release\nToday we announced proactive delivery updates: customers are notified the moment a delay is detected, with an honest new estimate.\n\n## Customer FAQ\n**Q: Will I be spammed with notifications?**\nA: No — you are only notified when the estimate actually changes.\n\n## Internal FAQ\n**Q: What is the hardest technical dependency?**\nA: Carrier webhook latency and estimate recalculation.',
        created_at: new Date().toISOString(),
      },
    ],
  },
  proj_2: {
    project: { project_id: 'proj_2', name: 'Mobile App Redesign', description: 'UX improvements based on feedback', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), persona_count: 1, document_count: 1 },
    personas: [
      {
        persona_id: 'persona_3',
        name: 'On-the-Go Grace',
        tagline: 'Thumb-first, patience-last',
        created_at: new Date().toISOString(),
        confidence: 'medium',
        feedback_count: 7,
        goals: ['Reorder in under 30 seconds'],
        frustrations: ['App logs her out weekly', 'Checkout buttons below the fold'],
        quote: 'Every extra tap is a reason to use the website of your competitor.',
      },
    ],
    documents: [
      {
        document_id: 'research_2',
        document_type: 'research',
        title: 'Mobile Checkout Friction',
        question: 'Where do mobile users abandon checkout?',
        content: '# Research Report: Mobile Checkout Friction\n\n## Executive Summary\nSession-loss on login and below-the-fold CTAs drive most abandonment mentions.',
        feedback_count: 11,
        created_at: new Date().toISOString(),
      },
    ],
  },
  proj_3: {
    project: { project_id: 'proj_3', name: 'Pricing Experiments', description: 'Shared with the whole workspace', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), persona_count: 0, document_count: 0 },
    personas: [],
    documents: [],
  },
};

// ── Per-project permissions (mirrors lambda/shared/project_access.py) ──────
// The mock caller is always admin-demo (an `admins` group member). Stored
// sharing META lives beside the fixtures rather than inside them, because the
// real API never returns these attributes — it returns COMPUTED fields
// (visibility, owner, access, member_count, members[]). proj_2 has NO entry on
// purpose: it is the legacy-shaped record (written before permissions existed)
// that keeps the frontend's lenient normalizers exercised — it renders as
// public with the fail-closed default access (no delete, read-only banner).
const mockSub = (username) => `sub-${username}`;
const MOCK_CALLER = { sub: mockSub('admin-demo'), username: 'admin-demo', email: 'admin@example.com', isAdmin: true };
const MOCK_VISIBILITIES = new Set(['public', 'private']);
const MOCK_MEMBER_ROLES = new Set(['viewer', 'editor']);
const MOCK_MAX_PROJECT_MEMBERS = 100;
const ROLE_LEVEL = { viewer: 1, editor: 2, owner: 3, admin: 3 };

const mockProjectSharing = {
  // Private, owned by the caller, with viewer-demo invited as a viewer.
  proj_1: {
    owner_sub: MOCK_CALLER.sub, owner_username: 'admin-demo', owner_email: 'admin@example.com',
    visibility: 'private',
    members: {
      [mockSub('viewer-demo')]: {
        role: 'viewer', username: 'viewer-demo', email: 'viewer@example.com',
        added_by: MOCK_CALLER.sub, added_at: new Date(Date.now() - 2 * 86400000).toISOString(),
      },
    },
  },
  // Public, owned by someone else — the caller reaches it as workspace admin.
  proj_3: {
    owner_sub: mockSub('viewer-demo'), owner_username: 'viewer-demo', owner_email: 'viewer@example.com',
    visibility: 'public',
    members: {},
  },
};

/** The stored META for a project, materialising a legacy record on first write. */
function sharingMeta(projectId, { create = false } = {}) {
  if (!mockProjectSharing[projectId] && create) {
    mockProjectSharing[projectId] = { visibility: 'public', members: {} };
  }
  return mockProjectSharing[projectId];
}

/** Effective role of MOCK_CALLER — same precedence as project_access._base_role. */
function callerRole(meta) {
  if (!meta) return MOCK_CALLER.isAdmin ? 'admin' : 'editor'; // legacy = public
  if (meta.owner_sub && meta.owner_sub === MOCK_CALLER.sub) return 'owner';
  if (MOCK_CALLER.isAdmin) return 'admin';
  if ((meta.visibility || 'public') === 'public') return 'editor';
  return meta.members?.[MOCK_CALLER.sub]?.role ?? null;
}

function projectAccess(projectId) {
  const role = callerRole(mockProjectSharing[projectId]);
  const level = role ? ROLE_LEVEL[role] : 0;
  return { role, can_view: level >= 1, can_edit: level >= 2, can_manage: level >= 3 };
}

function publicOwner(meta) {
  return meta?.owner_sub ? { sub: meta.owner_sub, username: meta.owner_username || '', email: meta.owner_email || '' } : null;
}

function publicMembers(meta) {
  return Object.entries(meta?.members ?? {}).map(([sub, entry]) => ({ sub, ...entry }));
}

/** A project as list/get/create return it. Legacy fixtures pass through bare. */
function decorateProject(project, { withMembers = false } = {}) {
  const meta = mockProjectSharing[project.project_id];
  if (!meta) return project;
  return {
    ...project,
    visibility: meta.visibility,
    owner: publicOwner(meta),
    access: projectAccess(project.project_id),
    member_count: Object.keys(meta.members).length,
    ...(withMembers ? { members: publicMembers(meta) } : {}),
  };
}

/** Enabled mock users as the candidates/resolution endpoints see them. */
function mockDirectory() {
  return mockUsers.filter((u) => u.enabled).map((u) => ({
    sub: mockSub(u.username), username: u.username, email: u.email, name: u.name,
  }));
}

const reply = (status, payload) => ({ status, payload });
const notFound = () => reply(404, { success: false, error: 'Project not found' });
const forbidden = (what) => reply(403, { success: false, error: `You do not have permission to ${what} this project` });
const invalidRole = () => reply(400, { success: false, error: "role must be 'viewer' or 'editor'" });

/** The reply a project write gets before its body runs: 404 without view, 403 without edit, null when allowed. */
/** GET /projects?ids=… (projects.get_project_details): the viewable ones, no personas.
 *  Missing and unviewable ids are simply absent, like the real API; same 400s. */
const MOCK_MAX_PROJECT_DETAIL_BATCH = 200;
function mockProjectDetailBatch(rawIds) {
  const ids = [...new Set(String(rawIds ?? '').split(',').map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > MOCK_MAX_PROJECT_DETAIL_BATCH) {
    return { __status: 400, body: { success: false, error: `ids must list between 1 and ${MOCK_MAX_PROJECT_DETAIL_BATCH} project ids` } };
  }
  if (!ids.every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id))) {
    return { __status: 400, body: { success: false, error: 'ids contains an invalid project id' } };
  }
  const details = ids
    .filter((id) => mockProjectDetails[id] && projectAccess(id).can_view)
    .map((id) => ({ project: decorateProject(mockProjectDetails[id].project), documents: mockProjectDetails[id].documents }));
  return { details };
}

function editGate(projectId) {
  if (!mockProjectDetails[projectId]) return notFound();
  const access = projectAccess(projectId);
  if (!access.can_view) return notFound();
  return access.can_edit ? null : forbidden('edit');
}

/** projects._validated_name / _validated_description: the PUT /projects/{id} 400s. */
function projectUpdateError(body) {
  if (body && 'name' in body && (typeof body.name !== 'string' || body.name.trim() === '')) {
    return 'Project name must be a non-empty string';
  }
  if (body && 'description' in body && typeof body.description !== 'string') {
    return 'Project description must be a string';
  }
  return null;
}

/**
 * PUT/DELETE /projects/{id} and every sharing route. Returns { status, payload }
 * or null when the path is not one of these. A caller without view gets 404,
 * like the real API (no existence leak).
 */
function handleProjectSharing(method, projectId, rest, body, params) {
  if (!mockProjectDetails[projectId]) return notFound();
  const access = projectAccess(projectId);
  if (!access.can_view) return notFound();
  const route = `${method} ${rest.join('/')}`;

  if (route === 'PUT ') {
    if (!access.can_edit) return forbidden('edit');
    const invalid = projectUpdateError(body);
    if (invalid) return reply(400, { success: false, error: invalid });
    const project = mockProjectDetails[projectId].project;
    for (const field of ['name', 'description', 'filters', 'status']) {
      if (body && field in body) project[field] = field === 'name' ? body.name.trim() : body[field];
    }
    project.updated_at = new Date().toISOString();
    return reply(200, { success: true });
  }
  if (route === 'DELETE ') {
    if (!access.can_manage) return forbidden('manage');
    delete mockProjectDetails[projectId];
    delete mockProjectSharing[projectId];
    return reply(200, { success: true });
  }
  if (route === 'GET members') {
    const meta = mockProjectSharing[projectId];
    return reply(200, {
      visibility: meta?.visibility ?? 'public', owner: publicOwner(meta), members: publicMembers(meta), access,
    });
  }

  // Leaving is the one write a non-manager may make: removing themselves.
  const isSelfLeave = method === 'DELETE' && rest[0] === 'members' && decodeURIComponent(rest[1] ?? '') === MOCK_CALLER.sub;
  if (!access.can_manage && !isSelfLeave) return forbidden('manage');
  const meta = sharingMeta(projectId, { create: true });

  if (route === 'PUT visibility') {
    if (!MOCK_VISIBILITIES.has(body?.visibility)) return reply(400, { success: false, error: "visibility must be 'public' or 'private'" });
    meta.visibility = body.visibility;
    return reply(200, { success: true, visibility: meta.visibility });
  }
  if (route === 'GET members/candidates') {
    const q = (params.get('q') ?? '').trim().toLowerCase();
    if (!q || q.length > 64 || /["\\]/.test(q)) return reply(400, { success: false, error: 'Invalid query' });
    const users = mockDirectory()
      .filter((u) => u.username.toLowerCase().startsWith(q) || u.email.toLowerCase().startsWith(q))
      .filter((u) => u.sub !== meta.owner_sub && !meta.members[u.sub])
      .slice(0, 20);
    return reply(200, { users });
  }
  if (route === 'POST members') {
    if (!MOCK_MEMBER_ROLES.has(body?.role)) return invalidRole();
    const user = mockDirectory().find((u) => u.sub === body?.sub);
    if (!user) return reply(404, { success: false, error: 'User not found' });
    if (user.sub === meta.owner_sub || meta.members[user.sub]) return reply(409, { success: false, error: 'User already has access' });
    if (Object.keys(meta.members).length >= MOCK_MAX_PROJECT_MEMBERS) return reply(400, { success: false, error: 'Member limit reached' });
    meta.members[user.sub] = {
      role: body.role, username: user.username, email: user.email, added_by: MOCK_CALLER.sub, added_at: new Date().toISOString(),
    };
    return reply(200, { success: true, member: { sub: user.sub, ...meta.members[user.sub] } });
  }
  if (rest[0] === 'members' && rest.length === 2) {
    const sub = decodeURIComponent(rest[1]);
    const member = meta.members[sub];
    if (!member) return reply(404, { success: false, error: 'Member not found' });
    if (method === 'PUT') {
      if (!MOCK_MEMBER_ROLES.has(body?.role)) return invalidRole();
      member.role = body.role;
      return reply(200, { success: true, member: { sub, ...member } });
    }
    if (method === 'DELETE') {
      delete meta.members[sub];
      return reply(200, { success: true });
    }
  }
  if (route === 'POST owner') {
    const user = meta.members[body?.sub]
      ? { sub: body.sub, ...meta.members[body.sub] }
      : mockDirectory().find((u) => u.sub === body?.sub);
    if (!user) return reply(404, { success: false, error: 'User not found' });
    const previous = publicOwner(meta);
    delete meta.members[user.sub];
    if (previous && previous.sub !== user.sub) {
      meta.members[previous.sub] = {
        role: 'editor', username: previous.username, email: previous.email, added_by: MOCK_CALLER.sub, added_at: new Date().toISOString(),
      };
    }
    Object.assign(meta, { owner_sub: user.sub, owner_username: user.username, owner_email: user.email });
    return reply(200, { success: true, owner: publicOwner(meta) });
  }
  return null;
}

// ── Product tab state (issue #179) ─────────────────────────────────────────
// Stateful per-project product context, docs, and report jobs so the whole
// Product tab (form persistence, interview, uploads, report generation) is
// exercisable against the mock.

const emptyProductContext = () => ({
  product_name: '', one_liner: '', target_users: '', problem_solved: '',
  current_state: '', key_features: '', differentiators: '',
  known_limitations: '', non_goals: '', success_metrics: '', free_form_notes: '',
});
const mockProductContexts = {}; // projectId -> ProductContext
const mockProductDocs = {};     // projectId -> ProductDoc[]
const mockProductJobs = {};     // jobId -> { projectId, job, polls, documentAppended }
// Monotonic suffix so ids can't collide within one millisecond.
let mockIdCounter = 0;
const nextMockId = (prefix) => `${prefix}_${Date.now()}_${++mockIdCounter}`;

function getProductContext(projectId) {
  if (!mockProductContexts[projectId]) {
    mockProductContexts[projectId] = emptyProductContext();
  }
  return mockProductContexts[projectId];
}

// Scripted interview: each turn stores the user's answer into the first
// unfilled field (in this order) and asks the next question — so the
// "I'll fill the form on the left as you answer" behavior is demonstrable
// locally. current_state is a select, so the script skips it.
const INTERVIEW_SCRIPT = [
  ['product_name', 'Got it. What would be a good one-liner for it?'],
  ['one_liner', 'Who are the target users?'],
  ['target_users', 'What problem does it solve for them?'],
  ['problem_solved', 'What are its key features?'],
  ['key_features', 'What differentiates it from alternatives?'],
  ['differentiators', 'Thanks — the essentials are filled in. Anything else you add now lands in free-form notes.'],
];

function applyInterviewTurn(projectId, message) {
  const context = getProductContext(projectId);
  const nextEntry = INTERVIEW_SCRIPT.find(([field]) => context[field] === '');
  if (nextEntry) {
    const [field, question] = nextEntry;
    context[field] = message;
    return { assistant_message: question, applied_patch: { [field]: message }, context };
  }
  const notes = context.free_form_notes === '' ? message : `${context.free_form_notes}\n${message}`;
  context.free_form_notes = notes;
  return {
    assistant_message: 'Noted — added to free-form notes.',
    applied_patch: { free_form_notes: notes },
    context,
  };
}

function buildProductReportDocument(projectId) {
  const context = getProductContext(projectId);
  const name = context.product_name || 'Unnamed product';
  return {
    document_id: nextMockId('product_report'),
    document_type: 'product_report',
    title: `Product / Service Report: ${name}`,
    content: `# Product / Service Report\n\n## ${name}\n\n${context.one_liner || '_No one-liner captured._'}\n\n## Target users\n${context.target_users || '_Not captured._'}\n\n## Problem solved\n${context.problem_solved || '_Not captured._'}\n\n## Key features\n${context.key_features || '_Not captured._'}\n\n## Differentiators\n${context.differentiators || '_Not captured._'}`,
    created_at: new Date().toISOString(),
  };
}

// Advance a mock product-report job on each poll: running on the first
// poll, completed afterwards — completion appends the generated document
// to the project detail fixtures exactly once, so it shows up in the
// Documents tab like the real flow.
function pollProductJob(entry) {
  entry.polls += 1;
  if (entry.polls === 1) {
    entry.job.status = 'running';
    entry.job.progress = 50;
    entry.job.current_step = 'Synthesizing report';
  } else {
    entry.job.status = 'completed';
    entry.job.progress = 100;
    entry.job.completed_at = entry.job.completed_at || new Date().toISOString();
    if (!entry.documentAppended) {
      const doc = buildProductReportDocument(entry.projectId);
      mockProjectDetails[entry.projectId].documents.push(doc);
      mockProjectDetails[entry.projectId].project.document_count += 1;
      entry.job.result = { document_id: doc.document_id, title: doc.title };
      entry.documentAppended = true;
    }
  }
  entry.job.updated_at = new Date().toISOString();
  return entry.job;
}

/** Collect and JSON-parse a request body, replying 400 on malformed JSON.
 * An aborted request ends the response instead of leaving it hanging. */
function collectJson(req, res, onBody) {
  let raw = '';
  req.on('data', chunk => raw += chunk);
  req.on('error', () => {
    sendJson(res, 400, { success: false, error: 'Request aborted' });
  });
  req.on('end', () => {
    if (!raw) {
      onBody(null);
      return;
    }
    try {
      onBody(JSON.parse(raw));
    } catch {
      sendJson(res, 400, { success: false, error: 'Invalid JSON body' });
    }
  });
}

// ── Unified AI assistant ─────────────────────────────────────────────────────
// `POST /chat/stream` speaks AG-UI 1.0 over SSE (one `data: <json>\n\n` frame
// per event), scripted but in the order the stream Lambda emits them: run start,
// assistant.context, a server tool round with its TOOL_CALL_RESULT, a streamed
// answer, sources, run end. On a project page a message asking to
// edit/update/create/rename something proposes a CLIENT tool and ends the run
// with an approval interrupt; the resume run (tool outcomes + `resume`) answers
// by acknowledging what the SPA reported. Never claims a write it was not told
// was executed — same rule the real system prompt imposes.

const ASSISTANT_PACKS = {
  project: ['core', 'project'], prioritization: ['core', 'prioritization'], scrapers: ['core', 'scrapers'],
  'feedback-forms': ['core', 'forms'], settings: ['core', 'settings'],
};
const ASSISTANT_MODEL = mockSurfaceDefaults.chat;
const WRITE_INTENT = /\b(edit|update|create|rename|change|write|draft)\b/i;
const SSE_FRAME_DELAY_MS = 25;

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('\n');
}

function lastUserText(messages) {
  const user = [...messages].reverse().find((m) => m && m.role === 'user');
  return user ? textOfContent(user.content) : '';
}

/** The tool messages after the newest user message — the outcomes of a resume run. */
const TOOL_OUTCOME_STATUSES = new Set(['executed', 'failed', 'declined']);

/** Approval outcomes in the resumed tail — only `tool` messages whose JSON is a contract outcome (read results can carry their own `status`). */
function resumeOutcomes(messages) {
  const lastUser = messages.reduce((found, m, i) => (m && m.role === 'user' ? i : found), -1);
  return messages.slice(lastUser + 1).filter((m) => m && m.role === 'tool').flatMap((m) => {
    try {
      const parsed = JSON.parse(textOfContent(m.content));
      return parsed && TOOL_OUTCOME_STATUSES.has(parsed.status) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

function chunkText(text, size = 18) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function textEvents(messageId, text) {
  return [
    { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
    ...chunkText(text).map((delta) => ({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta })),
    { type: 'TEXT_MESSAGE_END', messageId },
  ];
}

function toolCallEvents(toolCallId, toolCallName, parentMessageId, args) {
  return [
    { type: 'TOOL_CALL_START', toolCallId, toolCallName, parentMessageId },
    { type: 'TOOL_CALL_ARGS', toolCallId, delta: JSON.stringify(args) },
    { type: 'TOOL_CALL_END', toolCallId },
  ];
}

/** The write a project-page request proposes: create_document for "create/write/draft", else update_project. */
function proposedWrite(projectId, message) {
  if (/\b(create|write|draft)\b/i.test(message)) {
    const args = { project_id: projectId, title: 'Assistant summary', content: '# Summary\n\nDelivery delays dominate negative feedback this week.' };
    return { name: 'create_document', args, summary: `Create document 'Assistant summary' in project ${projectId}.` };
  }
  const name = `${mockProjectDetails[projectId]?.project.name ?? 'Project'} (updated)`;
  return { name: 'update_project', args: { project_id: projectId, name }, summary: `Update project ${projectId}: name → '${name}'.` };
}

function firstRunEvents(page, message, ids) {
  const projectId = page.kind === 'project' && typeof page.projectId === 'string' ? page.projectId : undefined;
  // Like the real `get_project` tool: the project as GET /projects/{id}
  // returns it, including `access{role, can_view, can_edit, can_manage}`.
  const lookup = projectId
    ? { name: 'get_project', args: { project_id: projectId }, result: JSON.stringify(mockProjectDetails[projectId] ? decorateProject(mockProjectDetails[projectId].project) : { error: 'not found' }) }
    : { name: 'search_feedback', args: { query: message.slice(0, 80) }, result: `Found ${mockFeedback.length} matching feedback items (mock).` };
  const events = [
    ...toolCallEvents(ids.lookupCall, lookup.name, ids.turn1, lookup.args),
    { type: 'TOOL_CALL_RESULT', messageId: ids.lookupResult, toolCallId: ids.lookupCall, content: lookup.result, role: 'tool' },
  ];
  if (projectId && WRITE_INTENT.test(message)) {
    const write = proposedWrite(projectId, message);
    return {
      events: [
        ...events,
        ...textEvents(ids.turn2, 'I can make that change once you approve it.'),
        // Opaque signed-thinking stand-in; the SPA must send it back unchanged.
        { type: 'REASONING_ENCRYPTED_VALUE', subtype: 'message', entityId: ids.turn2, encryptedValue: Buffer.from('mock-thinking').toString('base64') },
        ...toolCallEvents(ids.writeCall, write.name, ids.turn2, write.args),
      ],
      outcome: {
        type: 'interrupt',
        interrupts: [{
          id: `approval:${ids.writeCall}`, reason: 'tool_approval', toolCallId: ids.writeCall, message: write.summary,
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          metadata: { toolName: write.name, risk: 'write', projectId },
        }],
      },
    };
  }
  const answer = projectId
    ? `Here is the project "${mockProjectDetails[projectId]?.project.name ?? projectId}". It has 2 personas and 2 documents; delivery speed is the recurring theme.`
    : 'Delivery delays are the most common complaint (mock data), followed by product quality. Customer support is praised.';
  return {
    events: [
      ...events,
      ...textEvents(ids.turn2, answer),
      { type: 'CUSTOM', name: 'assistant.sources', value: { feedback: mockFeedback.slice(0, 2).map((f) => ({ feedback_id: f.feedback_id, text: f.original_text, source_platform: f.source_platform, sentiment_label: f.sentiment_label })), web: [] } },
    ],
    outcome: { type: 'success' },
  };
}

function resumeRunEvents(outcomes, ids) {
  const lines = outcomes.map((o) => {
    if (o.status === 'executed') return `Done — ${(o.summary ?? 'the change was applied').replace(/\.+$/, '')}.`;
    if (o.status === 'failed') return `That did not go through: ${o.error ?? 'unknown error'}. Nothing was changed.`;
    return 'Understood — I left it unchanged.';
  });
  return { events: textEvents(ids.turn1, lines.join('\n')), outcome: { type: 'success' } };
}

function writeSseEvents(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const queue = [...events];
  let closed = false;
  res.on('close', () => { closed = true; }); // the SPA aborted (Stop button / unmount)
  const next = () => {
    const event = queue.shift();
    if (closed) return;
    if (!event) {
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    setTimeout(next, SSE_FRAME_DELAY_MS);
  };
  next();
}

function handleAssistantStream(body, res) {
  const input = body && typeof body === 'object' ? body : {};
  const threadId = typeof input.threadId === 'string' ? input.threadId : nextMockId('thread');
  const runId = typeof input.runId === 'string' ? input.runId : nextMockId('run');
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const page = input.forwardedProps && typeof input.forwardedProps.page === 'object' && input.forwardedProps.page
    ? input.forwardedProps.page
    : { kind: 'other', path: '/' };
  const ids = {
    turn1: nextMockId('msg'), turn2: nextMockId('msg'), lookupCall: nextMockId('tooluse'),
    lookupResult: nextMockId('msg'), writeCall: nextMockId('tooluse'),
  };
  const head = [
    { type: 'RUN_STARTED', threadId, runId, protocolVersion: '1.0' },
    { type: 'CUSTOM', name: 'assistant.context', value: { page, packs: ASSISTANT_PACKS[page.kind] ?? ['core', 'insights'], model: ASSISTANT_MODEL, webSearch: false } },
  ];
  if (!messages.some((m) => m && m.role === 'user')) {
    writeSseEvents(res, [...head, { type: 'RUN_ERROR', message: 'The run must contain a user message', code: 'VALIDATION_ERROR' }]);
    return;
  }
  const outcomes = Array.isArray(input.resume) && input.resume.length > 0 ? resumeOutcomes(messages) : [];
  const { events, outcome } = outcomes.length > 0
    ? resumeRunEvents(outcomes, ids)
    : firstRunEvents(page, lastUserText(messages), ids);
  const usage = [{ provider: 'anthropic', model: ASSISTANT_MODEL, inputTokens: 1200, outputTokens: 80, totalTokens: 1280, cachedInputTokens: 900, cacheWriteInputTokens: 0 }];
  writeSseEvents(res, [...head, ...events, { type: 'RUN_FINISHED', threadId, runId, outcome, usage }]);
}

// Assistant sessions (`/chat/conversations/{_list|id}`), in memory, per the
// ChatApi contract in lambda/api/chat_handler.py. The seed is deliberately
// sparse/legacy-shaped (no messageCount/createdAt, one malformed message, one
// legacy `chat` record the SPA must filter out) so the Zod session boundary
// stays exercised — don't "fix" it.
const MOCK_SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MOCK_SESSION_MAX_BYTES = 350_000;
const mockAssistantSessions = {
  seed_sparse: {
    id: 'seed_sparse', kind: 'assistant', title: 'Why are deliveries late?',
    messages: [
      { id: 'u1', role: 'user', content: 'Why are deliveries late?' },
      { id: 'a1', role: 'assistant', content: 'Most late-delivery complaints mention the last-mile carrier (mock).' },
      { role: 'assistant' },
    ],
    page: null, updatedAt: daysAgo(1),
  },
  legacy_chat: { id: 'legacy_chat', kind: 'chat', title: 'Old chat page conversation', messages: [], updatedAt: daysAgo(2) },
};

function sessionSummary(record) {
  const summary = { id: record.id, title: record.title, kind: record.kind, updatedAt: record.updatedAt };
  // Records saved through the API carry the full summary; seeded rows stay sparse on purpose.
  if (record.createdAt) Object.assign(summary, { createdAt: record.createdAt, messageCount: record.messages.length });
  return summary;
}

function sessionDetail(record) {
  return {
    id: record.id, title: record.title, kind: record.kind, messages: record.messages,
    page: record.page ?? null, pendingInterrupts: record.pendingInterrupts ?? [],
    createdAt: record.createdAt ?? null, updatedAt: record.updatedAt,
    // Server-side run state (the stream Lambda's save); the mock never streams server-side.
    runStatus: record.runStatus ?? null, runId: record.runId ?? null, revision: record.revision ?? 0,
  };
}

function saveAssistantSession(proxy, body) {
  if (!body || typeof body !== 'object') return { status: 400, payload: { success: false, message: 'Request body must be a JSON object' } };
  if (body.kind !== 'assistant') return { status: 400, payload: { success: false, message: "kind must be 'assistant'" } };
  if (typeof body.id !== 'string' || !MOCK_SESSION_ID.test(body.id) || body.id !== proxy) {
    return { status: 400, payload: { success: false, message: 'id must match the path and ^[A-Za-z0-9_-]{1,64}$' } };
  }
  if (JSON.stringify(body).length > MOCK_SESSION_MAX_BYTES) {
    return { status: 413, payload: { success: false, message: 'Conversation is too large to save; start a new conversation' } };
  }
  const now = new Date().toISOString();
  const existing = mockAssistantSessions[body.id];
  // chat_handler: a save never overwrites a newer server revision.
  if ((existing?.revision ?? 0) > (Number.isInteger(body.baseRevision) ? body.baseRevision : 0)) {
    return { status: 409, payload: { success: false, message: 'The conversation has a newer saved revision; reload it first' } };
  }
  mockAssistantSessions[body.id] = {
    id: body.id, kind: 'assistant',
    title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'New conversation',
    messages: Array.isArray(body.messages) ? body.messages : [],
    page: body.page && typeof body.page === 'object' ? body.page : null,
    pendingInterrupts: Array.isArray(body.pendingInterrupts) ? body.pendingInterrupts : [],
    createdAt: existing?.createdAt ?? (typeof body.createdAt === 'string' ? body.createdAt : now),
    updatedAt: now,
    revision: existing?.revision ?? 0,
  };
  return { status: 200, payload: { success: true, id: body.id, updatedAt: now, revision: existing?.revision ?? 0 } };
}

function handleAssistantSessions(req, res, proxy, searchParams) {
  if (req.method === 'GET' && proxy === '_list') {
    const kind = searchParams.get('kind');
    const records = Object.values(mockAssistantSessions).filter((r) => !kind || r.kind === kind);
    records.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    sendJson(res, 200, { conversations: records.map(sessionSummary) });
    return;
  }
  if (req.method === 'GET') {
    const record = mockAssistantSessions[proxy];
    res.writeHead(record ? 200 : 404);
    res.end(JSON.stringify(record ? sessionDetail(record) : { success: false, message: `Conversation ${proxy} not found` }));
    return;
  }
  if (req.method === 'POST') {
    collectJson(req, res, (body) => {
      const result = saveAssistantSession(proxy, body);
      res.writeHead(result.status);
      res.end(JSON.stringify(result.payload));
    });
    return;
  }
  if (req.method === 'DELETE') {
    delete mockAssistantSessions[proxy];
    sendJson(res, 200, { success: true });
    return;
  }
  sendJson(res, 405, { success: false, error: 'Method not allowed' });
}

// --- memory & company context mocks ---
// Company context, my context, design system, user flags and memory. Stateful
// for the life of the process, in the real wire shapes. The mock caller is
// `admin-demo` (an admin AND memory reviewer). A deliberately sparse legacy
// memory row (no supporters/sources/retention) keeps the Zod normalizers
// exercised. Start with MOCK_MEMORY_NON_CURATOR=1 to see the non-curator UI
// (GET /memory/review answers 403, company adds land as `proposed`).
const MOCK_MEMORY_CALLER = 'admin-demo';
const MOCK_MEMORY_CURATOR = process.env.MOCK_MEMORY_NON_CURATOR !== '1';
const mockUserFlags = new Map([['admin-demo', { fallback_owner: true, memory_reviewer: true }]]);
const userFlagsOf = (username) => ({ fallback_owner: false, memory_reviewer: false, ...mockUserFlags.get(username) });

let mockCompanyContext = {
  vision: '## Where we are going\n\nBe the **most trusted** place to buy everyday essentials — fast delivery, fair prices, zero surprises.',
  objectives: [
    { id: 'obj_delivery', title: 'Cut late deliveries in half', description: 'Late deliveries are the top complaint category.', horizon: 'quarter' },
    { id: 'obj_nps', title: 'NPS above 50', description: '', horizon: 'date', due: '2027-06-30' },
    { id: 'obj_trust', title: 'Be the most trusted brand in the category', description: 'Long-term.', horizon: 'long' },
  ],
  updated_at: daysAgo(2),
  updated_by_username: 'admin-demo',
};
let mockMyContext = {
  objectives: [
    { id: 'pobj_1', title: 'Ship the returns redesign', description: 'Returns friction shows up in reviews weekly.', due: '2026-12-15', kpis: [{ name: 'Return-related complaints', target: '-30', unit: '%' }] },
  ],
};
const mockDesignSystem = {
  tokens: {
    colors: [{ name: 'primary', value: '#8e48ff' }, { name: 'surface', value: '#19161d' }, { name: 'not-a-color', value: 'brand purple' }],
    typography: [{ role: 'body', family: 'Space Grotesk', size: '14px', weight: 400 }, { role: 'heading', family: 'Space Grotesk', size: '24px', weight: '700' }],
    spacing: [{ name: 'md', value: '16px' }],
    radius: [{ name: 'card', value: '12px' }],
  },
  guidelines: '- One primary action per screen\n- Never use red for anything but errors',
  references: [
    { id: 'ref_figma', kind: 'figma', title: 'Checkout redesign', url: 'https://www.figma.com/file/example', status: 'ready', extracted_summary: 'Purple primary, generous whitespace, 12px radius cards, Space Grotesk throughout.' },
    { id: 'ref_shot', kind: 'screenshot', title: 'Current home page', s3_key: 'company-context/design/ref_shot.png', status: 'processing' },
    // Wire shape of a failed fetch (design_references.record_outcome): status 'error' + a user-safe reason.
    { id: 'ref_github', kind: 'github', title: 'Design tokens repo', url: 'https://github.com/example/design-tokens', status: 'error', error: 'GitHub could not find it (or the token cannot see it)' },
  ],
  integrations: { figma: false, github: true },
  updated_at: daysAgo(5),
};

const MOCK_MEMORY_NOW = new Date().toISOString();
const mockMemories = [
  { memory_id: 'mem_c1', scope: 'company', status: 'active', kind: 'customer', statement: 'Customers compare delivery promises across retailers before checkout.', categories: ['delivery'], confidence: 0.9, source_kind: 'extracted', supporters: 4, sources: [{ type: 'session', ref: 'sess_1', at: daysAgo(3) }], created_at: daysAgo(20), last_reinforced_at: daysAgo(3), retention: 'decay', conflicts_with: [], tombstoned: false },
  { memory_id: 'mem_c2', scope: 'company', status: 'active', kind: 'product', statement: 'Express shipping is available in all regions.', categories: [], confidence: 1, source_kind: 'user_explicit', supporters: 6, sources: [], created_at: daysAgo(60), retention: 'long_term', conflicts_with: ['mem_c3'], tombstoned: false },
  { memory_id: 'mem_c3', scope: 'company', status: 'conflict', kind: 'product', statement: 'Express shipping is not offered in the northern region any more.', categories: ['delivery'], confidence: 0.85, source_kind: 'extracted', supporters: 2, sources: [{ type: 'session', ref: 'sess_9', at: daysAgo(1) }], created_at: daysAgo(1), retention: 'decay', conflicts_with: ['mem_c2'], tombstoned: false },
  { memory_id: 'mem_c4', scope: 'company', status: 'proposed', kind: 'strategy', statement: 'Prioritise fixes that reduce support contacts.', categories: [], confidence: 0.82, source_kind: 'agent', supporters: 1, sources: [{ type: 'agent_run', ref: 'ar_1', at: daysAgo(2) }], created_at: daysAgo(2), retention: 'decay', conflicts_with: [], tombstoned: false },
  // Sparse legacy row: only identity + statement.
  { memory_id: 'mem_c5', scope: 'company', statement: 'Packaging feedback spikes after holidays.' },
  { memory_id: 'mem_p1', scope: 'personal', owner: MOCK_MEMORY_CALLER, status: 'active', kind: 'working_style', statement: 'Prefers short answers with a bullet summary.', categories: [], confidence: 1, source_kind: 'user_explicit', supporters: 1, sources: [], created_at: daysAgo(10), retention: 'long_term', conflicts_with: [], tombstoned: false },
  { memory_id: 'mem_p2', scope: 'personal', owner: MOCK_MEMORY_CALLER, status: 'archived', kind: 'objective', statement: 'Focus on the Q3 returns project.', categories: [], confidence: 0.9, source_kind: 'extracted', supporters: 1, sources: [], created_at: daysAgo(120), retention: 'dated', expires_at: daysAgo(5), conflicts_with: [], tombstoned: true },
];
const mockMemoryConfirmed = new Set(); // memory ids the caller already +1'd
const mockMemoryImports = new Map();   // import_id → {record, polls}

function publicMemory({ owner, ...memory }) {
  return memory;
}

function visibleMemories(scope) {
  return mockMemories.filter((m) => m.scope === scope && (scope === 'company' || m.owner === MOCK_MEMORY_CALLER));
}

const MEMORY_PAGE_SIZE = 5;

function listMockMemories(params) {
  const scope = params.get('scope') === 'personal' ? 'personal' : 'company';
  const q = (params.get('q') || '').toLowerCase();
  const status = params.get('status');
  const kind = params.get('kind');
  const matches = visibleMemories(scope).filter((m) =>
    (!q || m.statement.toLowerCase().includes(q))
    && (!status || (m.status ?? 'active') === status)
    && (!kind || (m.kind ?? 'other') === kind));
  const start = Number(params.get('cursor') || 0);
  const page = matches.slice(start, start + MEMORY_PAGE_SIZE);
  const next = start + MEMORY_PAGE_SIZE < matches.length ? String(start + MEMORY_PAGE_SIZE) : undefined;
  return [200, { items: page.map(publicMemory), ...(next ? { next_cursor: next } : {}) }];
}

function canWriteMemory(memory) {
  return memory.scope === 'personal' ? memory.owner === MOCK_MEMORY_CALLER : MOCK_MEMORY_CURATOR;
}

function addMockMemory(body) {
  const statement = typeof body?.statement === 'string' ? body.statement.trim() : '';
  if (!statement || statement.length > 500) return [400, { success: false, error: 'statement must be 1–500 characters' }];
  const scope = body.scope === 'company' ? 'company' : 'personal';
  const memory = {
    memory_id: nextMockId('mem'), scope, owner: scope === 'personal' ? MOCK_MEMORY_CALLER : undefined,
    status: scope === 'company' && !MOCK_MEMORY_CURATOR ? 'proposed' : 'active',
    kind: body.kind || 'other', statement, categories: [], confidence: 1, source_kind: 'user_explicit',
    supporters: 1, sources: [], created_at: new Date().toISOString(), retention: body.retention || 'decay',
    ...(body.expires_at ? { expires_at: body.expires_at } : {}), conflicts_with: [], tombstoned: false,
  };
  mockMemories.unshift(memory);
  return [201, { memory: publicMemory(memory) }];
}

function mockMemoryAction(memory, action) {
  if (action === 'confirm') {
    if (!mockMemoryConfirmed.has(memory.memory_id)) {
      mockMemoryConfirmed.add(memory.memory_id);
      memory.supporters = (memory.supporters ?? 0) + 1;
    }
    memory.last_reinforced_at = new Date().toISOString();
    return [200, { memory: publicMemory(memory) }];
  }
  if (!canWriteMemory(memory)) return [403, { success: false, error: 'Not allowed' }];
  if (action === 'forget') Object.assign(memory, { status: 'archived', tombstoned: true });
  if (action === 'restore') Object.assign(memory, { status: 'active', tombstoned: false });
  return [200, { memory: publicMemory(memory) }];
}

function mergeMockMemories(body) {
  const ids = Array.isArray(body?.ids) ? body.ids : [];
  const items = mockMemories.filter((m) => ids.includes(m.memory_id));
  if (items.length < 2 || !body.statement) return [400, { success: false, error: 'ids (2+) and statement required' }];
  if (!items.every(canWriteMemory)) return [403, { success: false, error: 'Not allowed' }];
  items.forEach((m) => Object.assign(m, { status: 'archived' }));
  const merged = { ...items[0], memory_id: nextMockId('mem'), statement: body.statement, status: 'active', supporters: items.reduce((n, m) => n + (m.supporters ?? 1), 0), source_kind: 'user_explicit', conflicts_with: [], created_at: new Date().toISOString() };
  mockMemories.unshift(merged);
  return [200, { memory: publicMemory(merged) }];
}

function mockReviewEntries() {
  const byId = new Map(mockMemories.map((m) => [m.memory_id, m]));
  return mockMemories
    .filter((m) => m.scope === 'company' && (m.status === 'proposed' || m.status === 'conflict'))
    .map((m) => {
      const conflicts = (m.conflicts_with || []).map((id) => byId.get(id)).filter(Boolean).map(publicMemory);
      const supportedMore = conflicts[0] && (conflicts[0].supporters ?? 0) > (m.supporters ?? 0);
      // memory_handler._review_entry's wire shape: {memory, linked, suggestion}, the
      // suggestion naming its winner (memory_policy.suggest_resolution).
      return {
        memory: publicMemory(m),
        linked: conflicts,
        suggestion: conflicts.length
          ? (supportedMore
            ? { action: 'keep', winner_id: conflicts[0].memory_id, reason: 'More people support the existing memory; the new claim may be regional.' }
            : { action: 'keep', winner_id: m.memory_id, reason: 'The new claim is better supported.' })
          : { action: 'keep', winner_id: m.memory_id, reason: 'No conflicting memory; accepting makes it live.' },
      };
    });
}

function resolveMockMemory(memory, body) {
  const action = body?.action;
  const other = mockMemories.find((m) => (memory.conflicts_with || []).includes(m.memory_id));
  const settle = (m) => Object.assign(m, { status: 'active', conflicts_with: [] });
  // As memory_handler.resolve_review: keep → winner_id wins (default: this one);
  // replace → THIS one wins (optionally reworded); the losers are archived.
  const keep = (winner) => {
    const loser = winner === memory ? other : memory;
    settle(winner);
    if (loser) loser.status = 'archived';
  };
  if (action === 'keep_both') { settle(memory); if (other) settle(other); }
  else if (action === 'keep') {
    const winner = !body.winner_id || body.winner_id === memory.memory_id ? memory : (other?.memory_id === body.winner_id ? other : null);
    if (!winner) return [400, { success: false, error: 'winner_id must be this memory or one it conflicts with' }];
    keep(winner);
  }
  else if (action === 'replace') { if (body.statement) memory.statement = body.statement; keep(memory); }
  else if (action === 'merge' && body.statement) { settle(memory); memory.statement = body.statement; if (other) other.status = 'archived'; }
  else return [400, { success: false, error: 'Unknown resolution' }];
  return [200, { success: true }];
}

function createMockMemoryImport(body) {
  const content = typeof body?.content === 'string' ? body.content : '';
  if (!body?.title || !content.trim() || content.length > 200000) return [400, { success: false, error: 'title and content (≤ 200k chars) required' }];
  const importId = nextMockId('imp');
  mockMemoryImports.set(importId, { polls: 0, record: { import_id: importId, title: body.title, ...(body.url ? { url: body.url } : {}), status: 'queued', created_at: new Date().toISOString(), memories_created: 0 } });
  return [202, { import_id: importId }];
}

function pollMockMemoryImport(importId) {
  const entry = mockMemoryImports.get(importId);
  if (!entry) return [404, { success: false, error: 'Import not found' }];
  entry.polls += 1;
  if (entry.polls === 1) entry.record.status = 'processing';
  if (entry.polls >= 3 && entry.record.status === 'processing') {
    Object.assign(entry.record, { status: 'completed', memories_created: 2 });
    mockMemories.unshift({ memory_id: nextMockId('mem'), scope: 'company', status: 'active', kind: 'customer', statement: `Learned from "${entry.record.title}": shoppers want clearer delivery dates.`, categories: [], confidence: 0.86, source_kind: 'import', supporters: 1, sources: [{ type: 'import', ref: importId, at: new Date().toISOString() }], created_at: new Date().toISOString(), retention: 'decay', conflicts_with: [], tombstoned: false });
  }
  return [200, entry.record];
}

function routeMemoryItem(req, url, body) {
  const match = url.pathname.match(/^\/memory\/([^/]+)(?:\/(confirm|forget|restore))?$/);
  if (!match) return null;
  const memory = mockMemories.find((m) => m.memory_id === decodeURIComponent(match[1]));
  if (!memory || (memory.scope === 'personal' && memory.owner !== MOCK_MEMORY_CALLER)) return [404, { success: false, error: 'Memory not found' }];
  if (req.method === 'POST' && match[2]) return mockMemoryAction(memory, match[2]);
  if (req.method === 'PUT' && !match[2]) {
    if (!canWriteMemory(memory)) return [403, { success: false, error: 'Not allowed' }];
    if (typeof body?.statement === 'string' && body.statement.trim()) memory.statement = body.statement.trim();
    if (body?.kind) memory.kind = body.kind;
    return [200, { memory: publicMemory(memory) }];
  }
  return [405, { success: false, error: 'Method not allowed' }];
}

function routeMemory(req, url, body) {
  const key = `${req.method} ${url.pathname}`;
  if (key === 'GET /memory') return listMockMemories(url.searchParams);
  if (key === 'POST /memory') return addMockMemory(body);
  if (key === 'POST /memory/merge') return mergeMockMemories(body);
  const curatorOnly = url.pathname.startsWith('/memory/review') || url.pathname.startsWith('/memory/imports');
  if (curatorOnly && !MOCK_MEMORY_CURATOR) return [403, { success: false, error: 'Admins and memory reviewers only' }];
  if (key === 'GET /memory/review') return [200, { items: mockReviewEntries() }];
  const resolveMatch = url.pathname.match(/^\/memory\/review\/([^/]+)\/resolve$/);
  if (resolveMatch && req.method === 'POST') {
    const memory = mockMemories.find((m) => m.memory_id === decodeURIComponent(resolveMatch[1]));
    return memory ? resolveMockMemory(memory, body) : [404, { success: false, error: 'Memory not found' }];
  }
  if (key === 'POST /memory/imports') return createMockMemoryImport(body);
  const importMatch = url.pathname.match(/^\/memory\/imports\/([^/]+)$/);
  if (importMatch && req.method === 'GET') return pollMockMemoryImport(decodeURIComponent(importMatch[1]));
  return routeMemoryItem(req, url, body);
}

function saveCompanyContext(body) {
  const vision = typeof body?.vision === 'string' ? body.vision : '';
  const objectives = Array.isArray(body?.objectives) ? body.objectives : null;
  if (vision.length > 20000 || !objectives || objectives.length > 50) return [400, { success: false, error: 'vision ≤ 20k chars, ≤ 50 objectives' }];
  mockCompanyContext = { vision, objectives, updated_at: new Date().toISOString(), updated_by_username: MOCK_MEMORY_CALLER };
  return [200, mockCompanyContext];
}

function addDesignReference(req, body) {
  const kind = body?.kind;
  if (!['screenshot', 'html', 'figma', 'github'].includes(kind) || !body.title) return [400, { success: false, error: 'kind and title required' }];
  const isUpload = kind === 'screenshot' || kind === 'html';
  if (!isUpload && !/^https:\/\//.test(body.url || '')) return [400, { success: false, error: 'https url required' }];
  const reference = { id: nextMockId('ref'), kind, title: body.title, ...(isUpload ? { s3_key: `company-context/design/${kind}` } : { url: body.url }), status: isUpload ? 'pending' : 'processing' };
  mockDesignSystem.references.push(reference);
  return [201, { reference, ...(isUpload ? { upload: { url: `http://${req.headers.host}/mock-design-upload/ref/${reference.id}`, headers: { 'Content-Type': body.content_type || 'application/octet-stream' } } } : {}) }];
}

function routeDesignReference(req, url) {
  const match = url.pathname.match(/^\/settings\/design-system\/references\/([^/]+)(\/refresh)?$/);
  if (!match) return null;
  const reference = mockDesignSystem.references.find((r) => r.id === decodeURIComponent(match[1]));
  if (!reference) return [404, { success: false, error: 'Reference not found' }];
  if (req.method === 'DELETE' && !match[2]) { reference.status = 'archived'; return [200, { reference }]; }
  if (req.method === 'POST' && match[2]) {
    Object.assign(reference, { status: 'ready', extracted_summary: `Refreshed ${new Date().toLocaleTimeString()}: tokens and layout re-read.` });
    return [200, { reference }];
  }
  return [405, { success: false, error: 'Method not allowed' }];
}

function routeDesignSystem(req, url, body) {
  const key = `${req.method} ${url.pathname}`;
  if (key === 'GET /settings/design-system') return [200, mockDesignSystem];
  if (key === 'PUT /settings/design-system') {
    if (body?.tokens) mockDesignSystem.tokens = body.tokens;
    if (typeof body?.guidelines === 'string') mockDesignSystem.guidelines = body.guidelines;
    mockDesignSystem.updated_at = new Date().toISOString();
    return [200, mockDesignSystem];
  }
  if (key === 'POST /settings/design-system/references') return addDesignReference(req, body);
  if (key === 'POST /settings/design-system/logo') {
    return [200, { upload: { url: `http://${req.headers.host}/mock-design-upload/logo/current`, headers: { 'Content-Type': body?.content_type || 'image/png' } } }];
  }
  if (key === 'PUT /settings/design-system/integrations') {
    // Write-only: tokens are dropped on the floor; only "configured" is kept.
    if (body?.figma_token) mockDesignSystem.integrations.figma = true;
    if (body?.github_token) mockDesignSystem.integrations.github = true;
    return [200, { integrations: mockDesignSystem.integrations }];
  }
  return routeDesignReference(req, url);
}

function routeContextAndFlags(req, url, body) {
  const key = `${req.method} ${url.pathname}`;
  if (key === 'GET /settings/company-context') return [200, mockCompanyContext];
  if (key === 'PUT /settings/company-context') return saveCompanyContext(body);
  if (key === 'GET /settings/my-context') return [200, mockMyContext];
  if (key === 'PUT /settings/my-context') {
    if (!Array.isArray(body?.objectives)) return [400, { success: false, error: 'objectives required' }];
    mockMyContext = { objectives: body.objectives };
    return [200, mockMyContext];
  }
  if (key === 'GET /users') {
    const listed = handlers['GET /users']();
    return [200, { ...listed, users: listed.users.map((u) => ({ ...u, flags: userFlagsOf(u.username) })) }];
  }
  const flagsMatch = url.pathname.match(/^\/users\/([^/]+)\/flags$/);
  if (flagsMatch && req.method === 'PUT') return setMockUserFlags(decodeURIComponent(flagsMatch[1]), body);
  if (url.pathname.startsWith('/settings/design-system')) return routeDesignSystem(req, url, body);
  return url.pathname.startsWith('/memory') ? routeMemory(req, url, body) : null;
}

function setMockUserFlags(username, body) {
  const user = mockUsers.find((u) => u.username === username);
  if (!user) return [404, { success: false, error: 'User not found' }];
  const next = userFlagsOf(username);
  if (typeof body?.memory_reviewer === 'boolean') next.memory_reviewer = body.memory_reviewer;
  if (typeof body?.fallback_owner === 'boolean') {
    if (body.fallback_owner && !user.groups.includes('admins')) return [400, { success: false, error: 'Only admins may be the fallback owner' }];
    // At most one fallback owner: setting it clears whoever had it.
    if (body.fallback_owner) for (const [name, flags] of mockUserFlags) mockUserFlags.set(name, { ...flags, fallback_owner: false });
    next.fallback_owner = body.fallback_owner;
  }
  mockUserFlags.set(username, next);
  return [200, { success: true, username, flags: next }];
}

const MEMORY_CONTEXT_ROUTE = /^\/(settings\/(company-context|my-context|design-system(\/.*)?)|memory(\/.*)?|users|users\/[^/]+\/flags)$/;

function handleMemoryContextRoutes(req, res, url, send) {
  const uploadMatch = url.pathname.match(/^\/mock-design-upload\/(ref|logo)\/([^/]+)$/);
  if (uploadMatch && req.method === 'PUT') {
    req.on('data', () => {});
    req.on('end', () => {
      if (uploadMatch[1] === 'logo') mockDesignSystem.logo_url = '/kiro-ghost.svg';
      const reference = mockDesignSystem.references.find((r) => r.id === uploadMatch[2]);
      if (reference) Object.assign(reference, { status: 'ready', extracted_summary: 'Uploaded in the mock: dark surfaces, purple accent.' });
      send(200, { success: true });
    });
    return true;
  }
  if (!MEMORY_CONTEXT_ROUTE.test(url.pathname)) return false;
  if (url.pathname === '/users' && req.method !== 'GET') return false;
  collectJson(req, res, (body) => {
    const result = routeContextAndFlags(req, url, body) ?? [405, { success: false, error: 'Method not allowed' }];
    send(result[0], result[1]);
  });
  return true;
}
// --- end memory & company context mocks ---

// --- agents & workflows mocks ---
// Autonomous agents, the workflow library (with revisions) and agent runs, in
// the agents_handler.py wire shapes. Stateful for the life of the process. The
// caller is `admin-demo` (MOCK_CALLER); start with MOCK_AGENTS_NON_ADMIN=1 to
// see the read-only UI (every write answers 403). The sparse legacy agent
// (no stats/budget/models/personas/output) keeps the Zod normalizers exercised
// — don't "fix" it. A run advances ONE workflow step per events poll and
// completes after its last step, so the run timeline can be watched live.
const MOCK_AGENTS_ADMIN = process.env.MOCK_AGENTS_NON_ADMIN !== '1';
const AGENTS_FORBIDDEN = [403, { success: false, error: 'Admin access required' }];
const AGENT_NOT_FOUND = [404, { success: false, error: 'Agent not found' }];
const RUN_NOT_FOUND = [404, { success: false, error: 'Run not found' }];
const WORKFLOW_NOT_FOUND = [404, { success: false, error: 'Workflow not found' }];
const AGENT_EDITABLE_FIELDS = ['name', 'description', 'enabled', 'owner_sub', 'scope', 'instructions', 'personas', 'triggers', 'models', 'output', 'workflow_id', 'budget'];
const WORKFLOW_NODE_TYPES = new Set([
  'start', 'aggregate_reviews', 'select_or_create_project', 'select_personas', 'generate_personas',
  'deep_research', 'write_prfaq', 'write_prd', 'persona_review', 'revise_document', 'build_prototype',
  'collect_prototype_feedback', 'revise_prototype', 'final_review', 'duplicate_document', 'handoff', 'custom_llm', 'end',
]);
const WORKFLOW_ELEMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const WORKFLOW_MAX_NODES = 60;
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running']);

const mockHex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const mockRunId = (at = Date.now()) => `ar_${at.toString(16).padStart(12, '0')}${mockHex(4)}`;
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const slugifyWorkflow = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workflow';

// ── Workflow definitions ──
const wfNode = (id, type, title, [column, row], data = {}) => ({ id, type, position: { x: column * 280, y: row * 140 }, data: { title, params: {}, ...data } });
const wfEdge = (source, target, label) => ({ id: `e_${source}__${target}`, source, target, ...(label ? { label } : {}) });

function defaultWorkflowDefinition() {
  return {
    schema: 'voc-workflow/1',
    name: 'Reviews → Prototype',
    description: 'Aggregate the reviews in scope, choose or create the project, pick personas, write a PR/FAQ until the personas agree, build a prototype, review it with the personas, then a final review and hand-off.',
    nodes: [
      wfNode('start', 'start', 'Start', [1, 0]),
      wfNode('aggregate', 'aggregate_reviews', 'Aggregate reviews in scope', [1, 1], { role: 'worker', instructions: 'Group the reviews since the last run into the top problems. Cite review ids.' }),
      wfNode('project', 'select_or_create_project', 'Choose or create the project', [1, 2], { role: 'orchestrator' }),
      wfNode('personas', 'select_personas', 'Select personas', [1, 3], { role: 'orchestrator' }),
      wfNode('prfaq', 'write_prfaq', 'Write the PR/FAQ', [1, 4], { role: 'worker' }),
      wfNode('prfaq_review', 'persona_review', 'Persona review of the PR/FAQ', [1, 5], { role: 'persona', params: { target: 'prfaq' } }),
      wfNode('prfaq_revise', 'revise_document', 'Revise the PR/FAQ', [2, 5], { role: 'worker', params: { target: 'prfaq' } }),
      wfNode('prototype', 'build_prototype', 'Build the prototype', [1, 6], { role: 'worker', instructions: "Follow the company design system's tokens and guidelines." }),
      wfNode('prototype_review', 'persona_review', 'Persona review of the prototype', [1, 7], { role: 'persona', params: { target: 'prototype' } }),
      wfNode('final_review', 'final_review', 'Final review', [1, 8], { role: 'reviewer' }),
      wfNode('handoff', 'handoff', 'Hand off to the owner', [1, 9], { role: 'orchestrator' }),
      wfNode('end', 'end', 'Done', [1, 10], { params: { status: 'completed' } }),
    ],
    edges: [
      wfEdge('start', 'aggregate'), wfEdge('aggregate', 'project'), wfEdge('project', 'personas'),
      wfEdge('personas', 'prfaq'), wfEdge('prfaq', 'prfaq_review'),
      wfEdge('prfaq_review', 'prfaq_revise', 'not_agreed'), wfEdge('prfaq_revise', 'prfaq_review'),
      wfEdge('prfaq_review', 'prototype', 'agreed'), wfEdge('prototype', 'prototype_review'),
      wfEdge('prototype_review', 'final_review', 'agreed'), wfEdge('final_review', 'handoff', 'pass'),
      wfEdge('handoff', 'end'),
    ],
    loops: [{ node_ids: ['prfaq_review', 'prfaq_revise'], until: 'persona_agreement', max_rounds: 3 }],
  };
}

/** A library workflow derived from the template: PR/FAQ only, no prototype. */
function fastWorkflowDefinition(maxRounds) {
  const base = defaultWorkflowDefinition();
  const dropped = new Set(['prototype', 'prototype_review']);
  return {
    ...base,
    name: 'Reviews → PR/FAQ (fast)',
    description: 'The template without the prototype: PR/FAQ until the personas agree, then hand-off.',
    nodes: base.nodes.filter((n) => !dropped.has(n.id)),
    edges: [
      ...base.edges.filter((e) => !dropped.has(e.source) && !dropped.has(e.target)),
      wfEdge('prfaq_review', 'final_review', 'agreed'),
    ],
    loops: [{ ...base.loops[0], max_rounds: maxRounds }],
  };
}

function checkWorkflowShape(def, add) {
  if (def.schema !== 'voc-workflow/1') add("schema must be 'voc-workflow/1'");
  if (typeof def.name !== 'string' || !def.name.trim() || def.name.length > 120) add('name must be 1–120 characters');
  if (!Array.isArray(def.nodes) || def.nodes.length === 0) { add('nodes must be a non-empty list'); return null; }
  if (def.nodes.length > WORKFLOW_MAX_NODES) add(`a workflow can have at most ${WORKFLOW_MAX_NODES} steps`);
  if (!Array.isArray(def.edges)) add('edges must be a list');
  if (def.loops !== undefined && !Array.isArray(def.loops)) add('loops must be a list');
  const types = new Map();
  for (const node of def.nodes) {
    if (!isPlainObject(node) || typeof node.id !== 'string' || !WORKFLOW_ELEMENT_ID.test(node.id)) { add('every step needs an id of 1-64 letters, digits, "_" or "-"'); continue; }
    if (types.has(node.id)) add('two steps share this id', node.id);
    if (!WORKFLOW_NODE_TYPES.has(node.type)) add(`unknown step type '${String(node.type)}'`, node.id);
    if (!isPlainObject(node.data) || typeof node.data.title !== 'string' || !node.data.title.trim()) add('every step needs a title', node.id);
    types.set(node.id, node.type);
  }
  return types;
}

function reachFrom(startIds, adjacency) {
  const seen = new Set(startIds);
  const queue = [...startIds];
  while (queue.length) for (const next of adjacency.get(queue.shift()) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  return seen;
}

function checkWorkflowGraph(def, types, add) {
  const forward = new Map([...types.keys()].map((id) => [id, []]));
  const backward = new Map([...types.keys()].map((id) => [id, []]));
  for (const edge of def.edges) {
    if (!isPlainObject(edge) || !types.has(edge.source) || !types.has(edge.target)) { add('edge connects a step that does not exist', types.has(edge?.source) ? edge.source : undefined); continue; }
    if (types.get(edge.source) === 'end') add('an end step cannot have outgoing arrows', edge.source);
    if (types.get(edge.target) === 'start') add('the start step cannot have incoming arrows', edge.target);
    if ((edge.label === 'pass' || edge.label === 'fail') && types.get(edge.source) === 'custom_llm') {
      add(`a custom step reports no pass/fail verdict, so its arrows cannot be '${edge.label}' — use a plain arrow`, edge.source);
    }
    forward.get(edge.source).push(edge.target);
    backward.get(edge.target).push(edge.source);
  }
  const starts = [...types].filter(([, type]) => type === 'start').map(([id]) => id);
  const ends = [...types].filter(([, type]) => type === 'end').map(([id]) => id);
  if (starts.length !== 1) add('a workflow needs exactly one start step');
  if (ends.length === 0) add('a workflow needs at least one end step');
  if (starts.length !== 1 || ends.length === 0) return;
  const reachable = reachFrom(starts, forward);
  const reachesEnd = reachFrom(ends, backward);
  for (const id of types.keys()) {
    if (!reachable.has(id)) add('this step is not connected to the start', id);
    else if (!reachesEnd.has(id)) add('this step has no path to an end step', id);
  }
}

function checkWorkflowLoops(def, types, add) {
  (def.loops ?? []).forEach((loop, index) => {
    if (!isPlainObject(loop)) { add(`loop ${index + 1} must be an object`); return; }
    if (!Number.isInteger(loop.max_rounds) || loop.max_rounds < 1 || loop.max_rounds > 5) add(`loop ${index + 1}: max_rounds must be a whole number from 1 to 5`);
    if (!['persona_agreement', 'review_pass'].includes(loop.until)) add(`loop ${index + 1}: until must be persona_agreement or review_pass`);
    const members = Array.isArray(loop.node_ids) ? loop.node_ids : [];
    if (members.length === 0) add(`loop ${index + 1} lists no steps`);
    for (const id of members) if (!types.has(id)) add(`loop ${index + 1} lists a step that does not exist`);
  });
}

/** The basic `POST /workflows/validate` rules → [{message, node_id?}]. */
function validateWorkflowDefinition(def) {
  const errors = [];
  const add = (message, nodeId) => errors.push({ message, ...(nodeId ? { node_id: nodeId } : {}) });
  if (!isPlainObject(def)) return [{ message: 'definition must be a JSON object' }];
  const types = checkWorkflowShape(def, add);
  if (!types || errors.length) return errors;
  checkWorkflowGraph(def, types, add);
  checkWorkflowLoops(def, types, add);
  return errors;
}

// ── Workflow library: id → {meta, revisions: [{revision, saved_at, saved_by_username, definition}]} ──
const mockWorkflows = new Map();

function storeMockWorkflow(workflowId, definition, { derivedFrom = null, builtin = false, at = new Date().toISOString() } = {}) {
  const entry = { workflow_id: workflowId, slug: slugifyWorkflow(definition.name), derived_from: derivedFrom, builtin, created_at: builtin ? null : at, revisions: [] };
  entry.revisions.push({ revision: 1, saved_at: builtin ? null : at, saved_by_username: builtin ? null : MOCK_CALLER.username, definition: structuredClone(definition) });
  mockWorkflows.set(workflowId, entry);
  return entry;
}

const currentRevision = (entry) => entry.revisions.at(-1);

function workflowView(entry, { withDefinition = true } = {}) {
  const current = currentRevision(entry);
  return {
    workflow_id: entry.workflow_id, slug: entry.slug, name: current.definition.name,
    description: current.definition.description ?? '', revision: current.revision,
    derived_from: entry.derived_from, builtin: entry.builtin, created_at: entry.created_at,
    updated_at: current.saved_at, updated_by_username: current.saved_by_username,
    status: entry.archived ? 'archived' : 'active',
    ...(withDefinition ? { definition: structuredClone(current.definition) } : {}),
  };
}

storeMockWorkflow('wf_default', defaultWorkflowDefinition(), { builtin: true });
{
  const fast = storeMockWorkflow('wf_3b9e1c0d7a42', fastWorkflowDefinition(2), { derivedFrom: 'wf_default', at: daysAgo(9) });
  fast.revisions.push({ revision: 2, saved_at: daysAgo(2), saved_by_username: 'admin-demo', definition: fastWorkflowDefinition(3) });
}

// ── Agents ──
const emptyAgentStats = () => ({
  runs_total: 0, runs_completed: 0, runs_failed: 0, runs_cancelled: 0, runs_needs_human: 0,
  last_run_at: null, last_run_id: null, last_run_status: null, active_run_id: null,
  scheduled_runs_today: 0, model_calls_this_month: 0, last_skip_reason: null,
});
const defaultAgentFields = () => ({
  description: '', enabled: false, owner_sub: null, scope: { all: true, categories: [], subcategories: [] },
  instructions: '', personas: { fixed: [], allow_generate: true }, triggers: [],
  models: { orchestrator: null, worker: null, reviewer: null, persona: null }, output: { visibility: 'private' },
  workflow_id: 'wf_default', budget: { max_scheduled_runs_per_day: 2, max_model_calls_per_run: 150, monthly_call_cap: 5000 },
});

const mockAgents = new Map([
  {
    ...defaultAgentFields(), agent_id: 'ag_5d1e0c9a7b3f', name: 'Delivery pain → prototype',
    description: 'Turns new late-delivery complaints into a PR/FAQ and a clickable prototype.', enabled: true,
    owner_sub: MOCK_CALLER.sub, scope: { all: false, categories: ['delivery'], subcategories: [{ category: 'delivery', name: 'late_delivery' }] },
    instructions: 'Focus on the delivery promise shown at checkout. Prefer small, shippable fixes.',
    personas: { fixed: [{ project_id: 'proj_1', persona_id: 'persona_1' }], allow_generate: true },
    triggers: [{ kind: 'new_reviews', min_new: 25, cooldown_hours: 12 }, { kind: 'schedule', every: '24h', timezone: 'Europe/Berlin' }],
    output: { visibility: 'public' }, status: 'active', created_by: MOCK_CALLER.sub, created_at: daysAgo(14), updated_at: daysAgo(3),
    stats: { ...emptyAgentStats(), runs_total: 2, runs_completed: 1, runs_failed: 1, last_run_at: daysAgo(1), last_run_status: 'completed', scheduled_runs_today: 1, model_calls_this_month: 212 },
  },
  {
    ...defaultAgentFields(), agent_id: 'ag_8a2f4b6c1d0e', name: 'Pricing threshold watch',
    description: 'Writes a PR/FAQ when pricing complaints pile up in a subcategory.',
    scope: { all: false, categories: ['pricing'], subcategories: [] },
    triggers: [{ kind: 'threshold', count: 10, per: 'subcategory', window_days: 7 }],
    workflow_id: 'wf_3b9e1c0d7a42', budget: { max_scheduled_runs_per_day: 1, max_model_calls_per_run: 80, monthly_call_cap: null },
    status: 'active', created_by: MOCK_CALLER.sub, created_at: daysAgo(30), updated_at: daysAgo(30),
    stats: { ...emptyAgentStats(), last_skip_reason: 'disabled' },
  },
  // Sparse legacy row: no stats, budget, models, personas, output or timestamps.
  { agent_id: 'ag_c0ffee123456', name: 'Legacy packaging agent', enabled: false, scope: { all: true }, triggers: [{ kind: 'schedule', every: '12h' }], workflow_id: 'wf_default' },
].map((agent) => [agent.agent_id, agent]));

const agentView = (agent) => structuredClone(agent);

function agentFieldsError(body) {
  if (!isPlainObject(body)) return 'Request body must be a JSON object';
  const unknown = Object.keys(body).filter((key) => !AGENT_EDITABLE_FIELDS.includes(key));
  if (unknown.length) return `Unknown fields: ${unknown.join(', ')}`;
  if ('name' in body && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80)) return 'name must be 1–80 characters';
  if ('workflow_id' in body && body.workflow_id !== null && !mockWorkflows.has(body.workflow_id)) return 'workflow_id does not name a workflow';
  return null;
}

function createMockAgent(body) {
  if (!MOCK_AGENTS_ADMIN) return AGENTS_FORBIDDEN;
  const error = agentFieldsError(body) ?? (typeof body?.name === 'string' ? null : 'name is required');
  if (error) return [400, { success: false, error }];
  const stamp = new Date().toISOString();
  const agent = {
    ...defaultAgentFields(), ...body, enabled: false, workflow_id: body.workflow_id ?? 'wf_default',
    agent_id: `ag_${mockHex(12)}`, name: body.name.trim(), status: 'active',
    created_by: MOCK_CALLER.sub, created_at: stamp, updated_at: stamp, stats: emptyAgentStats(),
  };
  mockAgents.set(agent.agent_id, agent);
  return [201, { agent: agentView(agent) }];
}

function listMockAgents(params) {
  const includeArchived = params.get('include_archived') === 'true';
  if (includeArchived && !MOCK_AGENTS_ADMIN) return AGENTS_FORBIDDEN;
  const items = [...mockAgents.values()]
    .filter((agent) => includeArchived || agent.status !== 'archived')
    .sort((a, b) => String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase()))
    .map(agentView);
  return [200, { items, count: items.length }];
}

function routeAgentItem(req, agent, action, body) {
  if (req.method === 'GET' && !action) return [200, { agent: agentView(agent) }];
  if (!MOCK_AGENTS_ADMIN) return AGENTS_FORBIDDEN;
  const stamp = new Date().toISOString();
  if (req.method === 'DELETE' && !action) {
    Object.assign(agent, { status: 'archived', enabled: false, updated_at: stamp });
    return [200, { agent: agentView(agent) }];
  }
  if (agent.status === 'archived') return AGENT_NOT_FOUND;
  if (req.method === 'PUT' && !action) {
    const error = agentFieldsError(body);
    if (error) return [400, { success: false, error }];
    Object.assign(agent, body, { updated_at: stamp });
    return [200, { agent: agentView(agent) }];
  }
  if (req.method === 'POST' && (action === 'enable' || action === 'disable')) {
    Object.assign(agent, { enabled: action === 'enable', updated_at: stamp });
    return [200, { agent: agentView(agent) }];
  }
  if (req.method === 'POST' && action === 'run') return startMockRun(agent);
  return [405, { success: false, error: 'Method not allowed' }];
}

// ── Runs: a scripted journal, released one workflow step per events poll ──
const mockAgentRuns = new Map(); // run_id → run (+ internal _events, _steps, _cursor)
const RUN_VIEW_KEYS = ['run_id', 'agent_id', 'status', 'trigger', 'trigger_detail', 'started_at', 'finished_at', 'project_id', 'current_node_id', 'model_calls', 'error', 'workflow_id', 'workflow_revision', 'review_window'];
const runView = (run) => Object.fromEntries(RUN_VIEW_KEYS.map((key) => [key, run[key] ?? null]));
const STEP_CALLS = { orchestrator: 1, worker: 3, reviewer: 2, persona: 4 };
const ARTIFACT_DOCS = { write_prfaq: 'prfaq_1', revise_document: 'prfaq_1', write_prd: 'prd_agent_1', build_prototype: 'prototype_agent_1', revise_prototype: 'prototype_agent_1' };

/** The events one node contributes: started, its verdict/artifact/decision, finished. */
function scriptStep(node, verdict) {
  const role = node.data?.role ?? 'system';
  const base = { node_id: node.id, role };
  const title = node.data?.title || node.type;
  const middle = [];
  if (node.type === 'persona_review') {
    middle.push({ ...base, kind: 'verdict', summary: verdict === 'agreed' ? 'Personas agree: mean 4.3/5, no blocking objections' : 'Personas not agreed yet: mean 3.1/5, 1 blocking objection (delivery date still unclear)' });
  } else if (ARTIFACT_DOCS[node.type]) {
    middle.push({ ...base, kind: 'artifact', summary: `${title}: saved to "Q1 Product Improvements"`, ref: { project_id: 'proj_1', document_id: ARTIFACT_DOCS[node.type] } });
  } else if (node.type === 'select_or_create_project') {
    middle.push({ ...base, kind: 'decision', summary: 'Reusing "Q1 Product Improvements": its purpose covers delivery promises', ref: { project_id: 'proj_1' } });
  } else if (node.type === 'aggregate_reviews') {
    middle.push({ ...base, kind: 'message', summary: '38 new reviews in scope; top problem: late deliveries without notice (17 reviews)' });
  }
  return {
    node_id: node.id, calls: STEP_CALLS[node.data?.role] ?? 0,
    events: [{ ...base, kind: 'node_started', summary: `Started: ${title}` }, ...middle, { ...base, kind: 'node_finished', summary: `Finished: ${title}` }],
  };
}

/** Walk start → end along pass/agreed/unlabelled arrows; a persona review with a
 * not_agreed arrow disagrees once, runs the revision, then agrees. */
function buildRunScript(definition) {
  const nodes = new Map(definition.nodes.map((n) => [n.id, n]));
  const steps = [];
  const visited = new Set();
  let node = definition.nodes.find((n) => n.type === 'start');
  while (node && steps.length < 120) {
    const outgoing = definition.edges.filter((e) => e.source === node.id);
    const retry = outgoing.find((e) => e.label === 'not_agreed' && nodes.has(e.target));
    if (node.type === 'persona_review' && retry) {
      steps.push(scriptStep(node, 'not_agreed'), scriptStep(nodes.get(retry.target)));
    }
    steps.push(scriptStep(node, 'agreed'));
    visited.add(node.id);
    const next = outgoing.find((e) => e.label !== 'not_agreed' && e.label !== 'fail' && !visited.has(e.target));
    node = next ? nodes.get(next.target) : null;
  }
  return steps;
}

const activeRunOf = (agentId) => [...mockAgentRuns.values()].find((r) => r.agent_id === agentId && ACTIVE_RUN_STATUSES.has(r.status));

function noteRunOnAgent(run) {
  const agent = mockAgents.get(run.agent_id);
  if (!agent?.stats) return; // the sparse legacy row stays sparse
  const stats = agent.stats;
  const active = ACTIVE_RUN_STATUSES.has(run.status);
  Object.assign(stats, { last_run_id: run.run_id, last_run_status: run.status, active_run_id: active ? run.run_id : null });
  if (!active && run.status !== 'needs_human') stats[`runs_${run.status}`] = (stats[`runs_${run.status}`] ?? 0) + 1;
}

function newMockRun(agent, workflow, { trigger = 'manual', at = new Date().toISOString() } = {}) {
  const run = {
    run_id: mockRunId(Date.parse(at)), agent_id: agent.agent_id, status: 'queued', trigger, trigger_detail: {},
    started_at: at, finished_at: null, project_id: null, current_node_id: null, model_calls: 0, error: null,
    workflow_id: workflow.workflow_id, workflow_revision: currentRevision(workflow).revision,
    review_window: { since: daysAgo(7), until: at },
    _events: [], _steps: buildRunScript(currentRevision(workflow).definition), _cursor: 0,
  };
  mockAgentRuns.set(run.run_id, run);
  return run;
}

function appendRunEvent(run, event) {
  run._events.push({ seq: run._events.length + 1, at: new Date().toISOString(), ...event });
}

function finishMockRun(run, status, error) {
  Object.assign(run, { status, finished_at: new Date().toISOString(), ...(error ? { error } : {}) });
  noteRunOnAgent(run);
}

/** Release the next scripted step; the run completes after its last one. */
function advanceMockRun(run) {
  if (!ACTIVE_RUN_STATUSES.has(run.status)) return;
  run.status = 'running';
  const step = run._steps[run._cursor];
  if (step) {
    run._cursor += 1;
    step.events.forEach((event) => appendRunEvent(run, event));
    run.current_node_id = step.node_id;
    run.model_calls += step.calls;
    if (step.events.some((e) => e.ref?.project_id)) run.project_id = 'proj_1';
  }
  if (run._cursor >= run._steps.length) finishMockRun(run, 'completed');
  else noteRunOnAgent(run);
}

function startMockRun(agent) {
  const workflow = mockWorkflows.get(agent.workflow_id || 'wf_default');
  if (!workflow) return [409, { success: false, error: "The agent's workflow no longer exists; choose another workflow" }];
  if (activeRunOf(agent.agent_id)) return [409, { success: false, error: 'This agent already has a run in progress' }];
  const run = newMockRun(agent, workflow);
  if (agent.stats) Object.assign(agent.stats, { runs_total: agent.stats.runs_total + 1, last_run_at: run.started_at });
  noteRunOnAgent(run);
  return [202, { run: runView(run) }];
}

// History for ag_5d1e0c9a7b3f: one completed run (yesterday), one failed (3 days ago).
{
  const agent = mockAgents.get('ag_5d1e0c9a7b3f');
  const failed = newMockRun(agent, mockWorkflows.get('wf_default'), { trigger: 'new_reviews', at: daysAgo(3) });
  for (let i = 0; i < 8; i += 1) advanceMockRun(failed);
  appendRunEvent(failed, { kind: 'node_failed', node_id: 'prototype', role: 'worker', summary: 'Build the prototype: model call budget exhausted (150 calls)' });
  Object.assign(failed, { status: 'failed', finished_at: daysAgo(3), error: 'Model call budget exhausted (150 calls)', model_calls: 150 });
  const completed = newMockRun(agent, mockWorkflows.get('wf_default'), { trigger: 'schedule', at: daysAgo(1) });
  while (completed.status !== 'completed') advanceMockRun(completed);
  completed.finished_at = daysAgo(0.95);
  Object.assign(agent.stats, { active_run_id: null, last_run_id: completed.run_id, last_run_status: 'completed', runs_total: 2, runs_completed: 1, runs_failed: 1 });
}

function routeAgentRuns(req, url, agent, rest) {
  const [runId, sub] = rest;
  if (!runId) {
    if (req.method !== 'GET') return [405, { success: false, error: 'Method not allowed' }];
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50);
    const start = Number(url.searchParams.get('cursor') || 0);
    const runs = [...mockAgentRuns.values()].filter((r) => r.agent_id === agent.agent_id).sort((a, b) => b.started_at.localeCompare(a.started_at));
    const next = start + limit < runs.length ? String(start + limit) : null;
    return [200, { items: runs.slice(start, start + limit).map(runView), next_cursor: next }];
  }
  const run = mockAgentRuns.get(runId);
  if (!run || run.agent_id !== agent.agent_id) return RUN_NOT_FOUND;
  if (req.method === 'GET' && !sub) return [200, { run: runView(run) }];
  if (req.method === 'GET' && sub === 'events') {
    advanceMockRun(run);
    const after = Math.max(Number(url.searchParams.get('after')) || 0, 0);
    const items = run._events.filter((e) => e.seq > after).slice(0, 200);
    return [200, { items, next_after: items.length ? items.at(-1).seq : after }];
  }
  if (req.method === 'POST' && sub === 'cancel') {
    if (!MOCK_AGENTS_ADMIN) return AGENTS_FORBIDDEN;
    if (!ACTIVE_RUN_STATUSES.has(run.status)) return [409, { success: false, error: 'This run has already finished' }];
    finishMockRun(run, 'cancelled');
    appendRunEvent(run, { kind: 'decision', role: 'system', summary: 'Run cancelled by an admin' });
    return [200, { run: runView(run) }];
  }
  return [405, { success: false, error: 'Method not allowed' }];
}

function routeAgents(req, url, body) {
  const [, agentId, action, ...rest] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (!agentId) {
    if (req.method === 'GET') return listMockAgents(url.searchParams);
    if (req.method === 'POST') return createMockAgent(body);
    return [405, { success: false, error: 'Method not allowed' }];
  }
  const agent = mockAgents.get(agentId);
  const hidden = !agent || (agent.status === 'archived' && !MOCK_AGENTS_ADMIN);
  if (hidden) return AGENT_NOT_FOUND;
  if (action === 'runs') return routeAgentRuns(req, url, agent, rest);
  if (rest.length || (action && !['enable', 'disable', 'run'].includes(action))) return [404, { success: false, error: 'Not found' }];
  return routeAgentItem(req, agent, action, body);
}

// ── Workflow routes ──
function createMockWorkflowFrom(definition, derivedFrom) {
  if (!MOCK_AGENTS_ADMIN) return AGENTS_FORBIDDEN;
  const errors = validateWorkflowDefinition(definition);
  if (errors.length) return [400, { success: false, error: 'The workflow is not valid', valid: false, errors }];
  const entry = storeMockWorkflow(`wf_${mockHex(12)}`, definition, { derivedFrom });
  return [201, { workflow: workflowView(entry) }];
}

function saveMockWorkflow(entry, body) {
  if (!MOCK_AGENTS_ADMIN) return AGENTS_FORBIDDEN;
  const expected = body?.expected_revision;
  if (!Number.isInteger(expected) || expected < 1) return [400, { success: false, error: 'expected_revision must be the revision you edited (a whole number ≥ 1)' }];
  const errors = validateWorkflowDefinition(body.definition);
  if (errors.length) return [400, { success: false, error: 'The workflow is not valid', valid: false, errors }];
  if (entry.builtin) return [409, { success: false, error: 'The built-in workflow is read-only; duplicate it to edit' }];
  if (expected !== currentRevision(entry).revision) return [409, { success: false, error: 'The workflow was changed by someone else; reload and retry' }];
  entry.revisions.push({ revision: expected + 1, saved_at: new Date().toISOString(), saved_by_username: MOCK_CALLER.username, definition: structuredClone(body.definition) });
  entry.slug = slugifyWorkflow(body.definition.name);
  return [200, { workflow: workflowView(entry) }];
}

/** archive_workflow: soft, admin-only, idempotent; refused for the built-in and while an active agent runs it. */
function archiveMockWorkflow(entry) {
  if (!MOCK_AGENTS_ADMIN) return AGENTS_FORBIDDEN;
  if (entry.builtin) return [409, { success: false, error: 'The built-in workflow cannot be archived' }];
  const users = [...mockAgents.values()]
    .filter((agent) => agent.workflow_id === entry.workflow_id && agent.status !== 'archived')
    .map((agent) => agent.name).sort();
  if (users.length) return [409, { success: false, error: `The workflow is used by ${users.join(', ')}; archive those agents or change their workflow first` }];
  entry.archived = true;
  return [200, { workflow: workflowView(entry, { withDefinition: false }) }];
}

function routeWorkflowItem(req, entry, action, body) {
  const key = `${req.method} ${action ?? ''}`;
  if (key === 'DELETE ') return archiveMockWorkflow(entry);
  // An archived workflow is read-only, and readable only by an admin.
  if (entry.archived && (req.method !== 'GET' || !MOCK_AGENTS_ADMIN)) return WORKFLOW_NOT_FOUND;
  if (key === 'GET ') {
    const revisions = [...entry.revisions].reverse().map(({ revision, saved_at, saved_by_username }) => ({ revision, saved_at, saved_by_username }));
    return [200, { workflow: workflowView(entry), revisions }];
  }
  if (key === 'PUT ') return saveMockWorkflow(entry, body);
  if (key === 'POST duplicate') {
    const definition = structuredClone(currentRevision(entry).definition);
    definition.name = typeof body?.name === 'string' ? body.name : `${definition.name} (copy)`.slice(0, 120);
    return createMockWorkflowFrom(definition, entry.workflow_id);
  }
  if (key === 'GET export') {
    const current = currentRevision(entry);
    return [200, { ...structuredClone(current.definition), exported_from: { workflow_id: entry.workflow_id, revision: current.revision, slug: entry.slug } }];
  }
  return [405, { success: false, error: 'Method not allowed' }];
}

function routeWorkflows(req, url, body) {
  const [, workflowId, action, ...rest] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (!workflowId) {
    if (req.method === 'POST') return createMockWorkflowFrom(body?.definition, null);
    if (req.method !== 'GET') return [405, { success: false, error: 'Method not allowed' }];
    const includeArchived = url.searchParams.get('include_archived') === 'true';
    if (includeArchived && !MOCK_AGENTS_ADMIN) return AGENTS_FORBIDDEN;
    const [builtin, ...stored] = [...mockWorkflows.values()].filter((entry) => includeArchived || !entry.archived);
    stored.sort((a, b) => currentRevision(a).definition.name.toLowerCase().localeCompare(currentRevision(b).definition.name.toLowerCase()));
    const items = [builtin, ...stored].map((entry) => workflowView(entry, { withDefinition: false }));
    return [200, { items, count: items.length }];
  }
  if (req.method === 'POST' && workflowId === 'validate' && !action) {
    const errors = validateWorkflowDefinition(body?.definition);
    return [200, { valid: errors.length === 0, errors }];
  }
  if (req.method === 'POST' && workflowId === 'import' && !action) {
    const raw = body?.definition;
    const origin = isPlainObject(raw) && isPlainObject(raw.exported_from) ? raw.exported_from.workflow_id : null;
    const definition = isPlainObject(raw) ? Object.fromEntries(Object.entries(raw).filter(([k]) => k !== 'exported_from')) : raw;
    return createMockWorkflowFrom(definition, typeof origin === 'string' && WORKFLOW_ELEMENT_ID.test(origin) ? origin : null);
  }
  const entry = mockWorkflows.get(workflowId);
  if (!entry) return WORKFLOW_NOT_FOUND;
  if (rest.length) return [404, { success: false, error: 'Not found' }];
  return routeWorkflowItem(req, entry, action, body);
}

const AGENTS_WORKFLOWS_ROUTE = /^\/(agents|workflows)(\/.*)?$/;

function handleAgentsWorkflowsRoutes(req, res, url, send) {
  const match = url.pathname.match(AGENTS_WORKFLOWS_ROUTE);
  if (!match) return false;
  collectJson(req, res, (body) => {
    const result = match[1] === 'agents' ? routeAgents(req, url, body) : routeWorkflows(req, url, body);
    send(result[0], result[1]);
  });
  return true;
}
// --- end agents & workflows mocks ---

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // PATCH is used by prioritization ballots and row edits; without it the
  // browser's preflight rejects them before they reach this server.
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;

  // Domain modules (mock-sources.js, mock-forms.js, mock-project-actions.js, mock-onboarding.js)
  // run first and claim ONLY the routes they own, so nothing below changes.
  if (handleDomainModules(req, res, url)) return;

  // Similar feedback — same envelope as metrics_handler's /feedback/{id}/similar.
  const similarMatch = url.pathname.match(/^\/feedback\/([^/]+)\/similar$/);
  if (req.method === 'GET' && similarMatch) {
    const limit = Number(url.searchParams.get('limit')) || 8;
    const items = mockFeedback.filter(f => f.feedback_id !== similarMatch[1]).slice(0, limit);
    sendJson(res, 200, { source_feedback_id: similarMatch[1], count: items.length, items });
    return;
  }

  // Unified AI assistant: AG-UI SSE stream and per-user sessions.
  if (key === 'POST /chat/stream') {
    collectJson(req, res, (body) => handleAssistantStream(body, res));
    return;
  }
  const sessionMatch = url.pathname.match(/^\/chat\/conversations\/([^/]+)$/);
  if (sessionMatch) {
    handleAssistantSessions(req, res, decodeURIComponent(sessionMatch[1]), url.searchParams);
    return;
  }

  // Handle feedback by ID
  if (req.method === 'GET' && url.pathname.startsWith('/feedback/') && url.pathname !== '/feedback/urgent' && url.pathname !== '/feedback/entities' && url.pathname !== '/feedback/access') {
    const id = url.pathname.split('/')[2];
    const item = mockFeedback.find(f => f.feedback_id === id);
    if (item) {
      sendJson(res, 200, item);
    } else {
      sendJson(res, 404, { error: 'Not found' });
    }
    return;
  }

  // Handle scraper status by ID — real RunStatus shape (issue #169):
  // pages_scraped/items_found/errors, 'never_run' for scrapers without runs.
  if (req.method === 'GET' && url.pathname.match(/^\/scrapers\/[^/]+\/status$/)) {
    const id = url.pathname.split('/')[2];
    const run = mockScraperRuns[id];
    res.writeHead(200);
    res.end(JSON.stringify(run ?? {
      scraper_id: id, status: 'never_run', pages_scraped: 0, items_found: 0, errors: [],
    }));
    return;
  }

  // Handle project detail by ID. Exact-key routes win: anything present in
  // the handlers table (e.g. 'GET /projects/prioritization', or any future
  // /projects/... exact route) must never be shadowed by the id pattern.
  const projectDetailMatch = url.pathname.match(/^\/projects\/([^/]+)$/);
  // `create_document`, one of the writes the scripted assistant proposes,
  // mutates the in-memory project so an approved action shows up on the page,
  // as it would against the real API — and goes through the same per-project
  // gate (no view → 404, no edit → 403). `update_project` is the gated
  // `PUT /projects/{id}` of handleProjectSharing below.
  const withEditableProject = (projectId, onFound) => collectJson(req, res, (rawBody) => {
    const detail = mockProjectDetails[projectId];
    const gate = editGate(projectId);
    if (gate) {
      res.writeHead(gate.status);
      res.end(JSON.stringify(gate.payload));
      return;
    }
    sendJson(res, 200, onFound(detail, rawBody ?? {}));
  });
  const projectDocumentsMatch = url.pathname.match(/^\/projects\/([^/]+)\/documents$/);
  if (req.method === 'POST' && projectDocumentsMatch && !(key in handlers)) {
    withEditableProject(projectDocumentsMatch[1], (detail, body) => {
      const document = {
        document_id: `doc_${Date.now()}`,
        document_type: 'custom',
        title: typeof body.title === 'string' ? body.title : 'Untitled',
        content: typeof body.content === 'string' ? body.content : '',
        created_at: new Date().toISOString(),
      };
      detail.documents.push(document);
      detail.project.document_count = detail.documents.length;
      return { success: true, document_id: document.document_id, document };
    });
    return;
  }
  if (req.method === 'GET' && projectDetailMatch && !(key in handlers)) {
    const projectId = projectDetailMatch[1];
    const detail = mockProjectDetails[projectId];
    if (detail && projectAccess(projectId).can_view) {
      sendJson(res, 200, { ...detail, project: decorateProject(detail.project, { withMembers: true }) });
    } else {
      sendJson(res, 404, { error: 'Project not found' });
    }
    return;
  }

  // PUT/DELETE /projects/{id} and the sharing routes (visibility, members,
  // owner). Same exact-key precedence: 'PUT /projects/prioritization' must
  // never be read as an update of a project called "prioritization".
  const sharingMatch = url.pathname.match(/^\/projects\/([^/]+)(?:\/((?:visibility|members|owner)(?:\/.*)?))?$/);
  const isProjectWrite = sharingMatch && !sharingMatch[2] && (req.method === 'PUT' || req.method === 'DELETE');
  if (sharingMatch && (isProjectWrite || sharingMatch[2]) && !(key in handlers)) {
    collectJson(req, res, (body) => {
      const rest = sharingMatch[2] ? sharingMatch[2].split('/') : [];
      const result = handleProjectSharing(req.method, sharingMatch[1], rest, body, url.searchParams)
        ?? reply(404, { error: 'Not found' });
      res.writeHead(result.status);
      res.end(JSON.stringify(result.payload));
    });
    return;
  }

  // Project jobs polling (research/persona generation) — none running
  // locally. Same exact-key precedence rule as above, and unknown project
  // ids 404 like the real API instead of masking bad-id bugs with an
  // empty list.
  // Single-job polling for product-report jobs (issue #179). Every other job
  // flow (personas, documents, research, prototypes) is owned by
  // mock-project-actions.js, which claims its own job ids before this runs.
  const jobStatusMatch = url.pathname.match(/^\/projects\/([^/]+)\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && jobStatusMatch) {
    const entry = mockProductJobs[jobStatusMatch[2]];
    if (!entry || entry.projectId !== jobStatusMatch[1]) {
      sendJson(res, 404, { success: false, error: 'Job not found' });
      return;
    }
    sendJson(res, 200, pollProductJob(entry));
    return;
  }

  // Product context: load / per-field persist / interview (issue #179).
  const productContextMatch = url.pathname.match(/^\/projects\/([^/]+)\/product-context(\/interview)?$/);
  if (productContextMatch) {
    const projectId = productContextMatch[1];
    const isInterview = productContextMatch[2] === '/interview';
    if (!mockProjectDetails[projectId]) {
      sendJson(res, 404, { success: false, error: 'Project not found' });
      return;
    }
    if (req.method === 'GET' && !isInterview) {
      sendJson(res, 200, { context: getProductContext(projectId) });
      return;
    }
    if (req.method === 'PUT' && !isInterview) {
      collectJson(req, res, (body) => {
        const context = getProductContext(projectId);
        // Allowlist assignment: only known context fields, string values —
        // keeps the mock contract-faithful and immune to __proto__ keys.
        for (const field of Object.keys(emptyProductContext())) {
          if (body && typeof body[field] === 'string') {
            context[field] = body[field];
          }
        }
        sendJson(res, 200, { context });
      });
      return;
    }
    if (req.method === 'POST' && isInterview) {
      collectJson(req, res, (body) => {
        if (!body || typeof body.message !== 'string' || body.message.trim() === '') {
          sendJson(res, 400, { success: false, error: 'message is required' });
          return;
        }
        sendJson(res, 200, applyInterviewTurn(projectId, body.message.trim()));
      });
      return;
    }
    sendJson(res, 405, { success: false, error: 'Method not allowed' });
    return;
  }

  // Product docs: list / presigned upload / delete (issue #179). The
  // "presigned URL" points back at this mock (/mock-upload/...), where the
  // PUT flips the doc from pending to ready.
  const productDocsMatch = url.pathname.match(/^\/projects\/([^/]+)\/product-docs(?:\/([^/]+))?$/);
  if (productDocsMatch) {
    const projectId = productDocsMatch[1];
    const docSegment = productDocsMatch[2];
    if (!mockProjectDetails[projectId]) {
      sendJson(res, 404, { success: false, error: 'Project not found' });
      return;
    }
    const docs = mockProductDocs[projectId] ?? (mockProductDocs[projectId] = []);
    if (req.method === 'GET' && !docSegment) {
      sendJson(res, 200, { docs });
      return;
    }
    if (req.method === 'POST' && docSegment === 'upload-url') {
      collectJson(req, res, (body) => {
        if (!body || typeof body.filename !== 'string' || body.filename === '') {
          sendJson(res, 400, { success: false, error: 'filename is required' });
          return;
        }
        const docId = nextMockId('doc');
        docs.push({
          doc_id: docId, filename: body.filename,
          content_type: typeof body.content_type === 'string' ? body.content_type : 'application/octet-stream',
          size_bytes: Number.isFinite(body.size_bytes) ? body.size_bytes : 0,
          status: 'pending', error: null, extracted_chars: 0,
          created_at: new Date().toISOString(),
        });
        res.writeHead(200);
        res.end(JSON.stringify({
          doc_id: docId,
          presigned_url: `http://${req.headers.host}/mock-upload/${projectId}/${docId}`,
          headers: { 'Content-Type': typeof body.content_type === 'string' ? body.content_type : 'application/octet-stream' },
        }));
      });
      return;
    }
    if (req.method === 'DELETE' && docSegment) {
      const index = docs.findIndex(d => d.doc_id === docSegment);
      if (index === -1) {
        sendJson(res, 404, { success: false, error: 'Document not found' });
        return;
      }
      docs.splice(index, 1);
      sendJson(res, 200, { success: true });
      return;
    }
    sendJson(res, 405, { success: false, error: 'Method not allowed' });
    return;
  }

  // Mock "S3" upload target for the presigned PUT: drain the bytes and flip
  // the doc to ready, mimicking the extract pipeline.
  const mockUploadMatch = url.pathname.match(/^\/mock-upload\/([^/]+)\/([^/]+)$/);
  if (req.method === 'PUT' && mockUploadMatch) {
    const doc = (mockProductDocs[mockUploadMatch[1]] ?? []).find(d => d.doc_id === mockUploadMatch[2]);
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; });
    req.on('end', () => {
      if (!doc) {
        sendJson(res, 404, { success: false, error: 'Upload target not found' });
        return;
      }
      doc.status = 'ready';
      doc.extracted_chars = bytes; // bytes ≈ chars is close enough for a mock
      sendJson(res, 200, { success: true });
    });
    return;
  }

  // Kick off a product report job (issue #179); completion is driven by the
  // single-job poll route above.
  const productReportMatch = url.pathname.match(/^\/projects\/([^/]+)\/product-report$/);
  if (req.method === 'POST' && productReportMatch) {
    const projectId = productReportMatch[1];
    if (!mockProjectDetails[projectId]) {
      sendJson(res, 404, { success: false, error: 'Project not found' });
      return;
    }
    const jobId = nextMockId('job');
    mockProductJobs[jobId] = {
      projectId,
      polls: 0,
      documentAppended: false,
      job: {
        success: true, job_id: jobId, job_type: 'generate_product_report',
        status: 'pending', progress: 0, created_at: new Date().toISOString(),
      },
    };
    res.writeHead(200);
    // status mirrors the stored job so poll traces read consistently.
    res.end(JSON.stringify({ success: true, job_id: jobId, status: 'pending', message: 'Report generation started' }));
    return;
  }

  // Handle feedback form stats by ID
  if (req.method === 'GET' && url.pathname.match(/^\/feedback-forms\/[^/]+\/stats$/)) {
    const formId = url.pathname.split('/')[2];
    const stats = mockFormStats[formId];
    if (stats) {
      sendJson(res, 200, { success: true, form_id: formId, stats });
    } else {
      // Honest 404 for unknown forms so dev doesn't mask client bugs.
      sendJson(res, 404, { success: false, error: 'Form not found' });
    }
    return;
  }

  // User admin by username (issue #177). Exact-key routes ('GET /users',
  // 'POST /users') win; unknown usernames 404 like the real API.
  const userMatch = url.pathname.match(/^\/users\/([^/]+)(?:\/(group|reset-password|enable|disable))?$/);
  if (userMatch && !(key in handlers)) {
    const username = decodeURIComponent(userMatch[1]);
    const action = userMatch[2];
    let rawBody = '';
    req.on('data', chunk => rawBody += chunk);
    req.on('end', () => {
      const user = mockUsers.find(u => u.username === username);
      if (!user) {
        sendJson(res, 404, { success: false, error: 'User not found' });
        return;
      }
      let parsedBody = null;
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          sendJson(res, 400, { success: false, error: 'Invalid JSON body' });
          return;
        }
      }
      const result = handleUserAction(req.method, user, action, parsedBody);
      res.writeHead(result.status);
      res.end(JSON.stringify(result.payload));
    });
    return;
  }

  if (handleParameterizedExtras(req, res, url)) return;

  const handler = handlers[key];
  if (handler) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      // Guard against malformed JSON bodies so a bad request can't crash
      // the dev server (an uncaught throw here kills the process).
      let parsedBody = null;
      if (body) {
        try {
          parsedBody = JSON.parse(body);
        } catch {
          sendJson(res, 400, { success: false, error: 'Invalid JSON body' });
          return;
        }
      }
      const result = handler(parsedBody, url.searchParams);
      // Handlers may signal a non-200 status (matching the real API's error
      // contract) by returning { __status, body }.
      if (result && typeof result.__status === 'number') {
        res.writeHead(result.__status);
        res.end(JSON.stringify(result.body));
        return;
      }
      sendJson(res, 200, result);
    });
  } else {
    sendJson(res, 404, { error: 'Not found' });
  }
});

const PORT = Number(process.env.PORT) || 3001;
server.listen(PORT, () => {
  console.log(`Mock API server running at http://localhost:${PORT}`);
  console.log('Use this URL in the frontend Settings page');
});

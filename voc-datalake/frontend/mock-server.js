// Simple mock server for local development
// Run with: node mock-server.js

import http from 'http';

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
    persona_name: 'Impatient Shopper',
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
    // Old backfilled review: written ~400 days ago, imported today.
    // Visible under the imported basis, filtered out under the review basis.
    source_created_at: daysAgo(400),
    processed_at: new Date().toISOString(),
  },
];

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

// Mock feedback form config (in-memory)
let feedbackFormConfig = {
  enabled: true,
  title: 'Share Your Feedback',
  description: 'We value your opinion. Help us improve by sharing your experience.',
  question: 'How was your experience?',
  placeholder: 'Tell us what you liked or what we could do better...',
  rating_enabled: true,
  rating_type: 'emoji',
  rating_max: 5,
  submit_button_text: 'Submit',
  success_message: 'Thank you for your feedback! 🎉',
  theme: {
    primary_color: '#3B82F6',
    background_color: '#FFFFFF',
    text_color: '#1F2937',
    border_radius: '12px'
  },
  collect_email: false,
  collect_name: false,
  custom_fields: [],
  brand_name: 'Demo Brand',
};

// Mock sources status
const mockSourcesStatus = {
  sources: [
    { source: 'webscraper', enabled: true, last_run: new Date().toISOString(), status: 'success', schedule: 'rate(5 minutes)' },
    { source: 'manual_import', enabled: true, last_run: new Date().toISOString(), status: 'success', schedule: 'manual' },
    { source: 's3_import', enabled: true, last_run: new Date().toISOString(), status: 'success', schedule: 'event-driven' },
  ]
};

// Mock categories config
// Problem resolution state (issue #66) — mutable so the toggle round-trips.
const mockResolvedProblems = {};

const mockCategoriesConfig = {
  categories: [
    { name: 'delivery', display_name: 'Delivery', description: 'Shipping and delivery issues', color: '#EF4444' },
    { name: 'customer_support', display_name: 'Customer Support', description: 'Support interactions', color: '#3B82F6' },
    { name: 'product_quality', display_name: 'Product Quality', description: 'Quality concerns', color: '#F59E0B' },
    { name: 'pricing', display_name: 'Pricing', description: 'Price-related feedback', color: '#10B981' },
    { name: 'website', display_name: 'Website', description: 'Website experience', color: '#8B5CF6' },
    { name: 'app', display_name: 'Mobile App', description: 'App experience', color: '#EC4899' },
  ]
};

// Mock feedback forms
const mockFeedbackForms = [
  { id: 'form_1', name: 'Website Feedback', enabled: true, submissions: 234, created_at: new Date().toISOString() },
  { id: 'form_2', name: 'Post-Purchase Survey', enabled: true, submissions: 567, created_at: new Date().toISOString() },
  { id: 'form_3', name: 'Support Feedback', enabled: false, submissions: 89, created_at: new Date().toISOString() },
];

// Mock scrapers
const mockScrapers = [
  { id: 'scraper_1', name: 'Product Reviews', url: 'https://example.com/reviews', enabled: true, schedule: 'rate(30 minutes)', last_run: new Date().toISOString(), status: 'success' },
  { id: 'scraper_2', name: 'Forum Posts', url: 'https://forum.example.com', enabled: false, schedule: 'rate(1 hour)', last_run: null, status: 'disabled' },
];

// Mock S3 data explorer
const mockBuckets = [
  { name: 'raw-data', region: 'us-west-2' },
  { name: 'processed-data', region: 'us-west-2' },
];

const mockS3Files = {
  'raw-data': {
    folders: ['webscraper/', 'manual_import/', 's3_import/'],
    files: []
  }
};

const handlers = {
  // Feedback Form endpoints
  'GET /feedback-form/config': () => ({ success: true, config: feedbackFormConfig }),
  'PUT /feedback-form/config': (body) => {
    feedbackFormConfig = { ...feedbackFormConfig, ...body };
    return { success: true, message: 'Configuration saved' };
  },
  'POST /feedback-form/submit': (body) => {
    console.log('📝 Feedback submitted:', body);
    return { success: true, feedback_id: 'mock_' + Date.now(), message: feedbackFormConfig.success_message };
  },
  'GET /feedback-form/embed': () => ({
    success: true,
    script_embed: '<!-- Mock embed code -->',
    iframe_embed: '<!-- Mock iframe code -->'
  }),

  // Feedback Forms list
  'GET /feedback-forms': () => ({ forms: mockFeedbackForms }),

  // Sources status
  'GET /sources/status': () => mockSourcesStatus,

  // Settings - Categories
  'GET /settings/categories': () => mockCategoriesConfig,
  'PUT /settings/categories': () => ({ success: true, message: 'Categories saved' }),
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
  'GET /data-explorer/buckets': () => ({ buckets: mockBuckets }),
  'GET /data-explorer/s3': () => mockS3Files['raw-data'],
  'GET /data-explorer/stats': () => ({ total_files: 1247, total_size_mb: 156.3, sources: 3 }),

  // Scrapers
  'GET /scrapers': () => ({ scrapers: mockScrapers }),
  'POST /scrapers': (body) => ({ success: true, scraper: { id: 'scraper_' + Date.now(), ...body } }),

  'GET /feedback': (_body, searchParams) => {
    const items = filterByDateBasis(mockFeedback, searchParams);
    return { count: items.length, total: items.length, offset: 0, limit: 50, is_partial_window: false, items };
  },
  'GET /feedback/urgent': (_body, searchParams) => {
    const items = filterByDateBasis(mockFeedback, searchParams).filter(f => f.urgency === 'high');
    return { count: items.length, items };
  },
  'GET /feedback/entities': (_body, searchParams) => {
    const items = filterByDateBasis(mockFeedback, searchParams);
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
        personas: countBy(i => i.persona_name),
        sources: countBy(i => i.source_platform),
      },
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
    },
  }),
  'GET /metrics/personas': () => ({
    period_days: 7,
    personas: {
      'Impatient Shopper': 234,
      'Price-Sensitive Buyer': 198,
      'Quality Seeker': 167,
      'First-Time Customer': 145,
      'Loyal Customer': 123,
    },
  }),
  'POST /chat': () => ({
    response: `I analyzed your feedback data. Here's what I found:\n\n• Total feedback: 1,247 items\n• Average sentiment: 0.12 (slightly positive)\n• Top category: Delivery (25%)\n• Urgent items: 23 requiring attention\n\nWould you like me to dive deeper into any specific area?`,
    sources: mockFeedback.slice(0, 2),
  }),
  'GET /projects': () => ({
    projects: [
      { project_id: 'proj_1', name: 'Q1 Product Improvements', description: 'Customer-driven improvements', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), persona_count: 3, document_count: 2 },
      { project_id: 'proj_2', name: 'Mobile App Redesign', description: 'UX improvements based on feedback', status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), persona_count: 2, document_count: 1 },
    ]
  }),
  'GET /projects/prioritization': () => ({
    scores: {}
  }),
  'PUT /projects/prioritization': () => ({
    success: true
  }),
};

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
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = `${req.method} ${url.pathname}`;

  // Handle feedback by ID
  if (req.method === 'GET' && url.pathname.startsWith('/feedback/') && url.pathname !== '/feedback/urgent' && url.pathname !== '/feedback/entities') {
    const id = url.pathname.split('/')[2];
    const item = mockFeedback.find(f => f.feedback_id === id);
    if (item) {
      res.writeHead(200);
      res.end(JSON.stringify(item));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    }
    return;
  }

  // Handle scraper status by ID
  if (req.method === 'GET' && url.pathname.match(/^\/scrapers\/[^/]+\/status$/)) {
    const id = url.pathname.split('/')[2];
    const scraper = mockScrapers.find(s => s.id === id);
    res.writeHead(200);
    res.end(JSON.stringify({
      id,
      status: scraper ? scraper.status : 'unknown',
      last_run: scraper ? scraper.last_run : null,
      items_scraped: Math.floor(Math.random() * 50) + 10,
      errors: 0
    }));
    return;
  }

  // Handle project detail by ID. Exact-key routes win: anything present in
  // the handlers table (e.g. 'GET /projects/prioritization', or any future
  // /projects/... exact route) must never be shadowed by the id pattern.
  if (req.method === 'GET' && url.pathname.match(/^\/projects\/[^/]+$/) && !(key in handlers)) {
    const id = url.pathname.split('/')[2];
    const detail = mockProjectDetails[id];
    if (detail) {
      res.writeHead(200);
      res.end(JSON.stringify(detail));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Project not found' }));
    }
    return;
  }

  // Project jobs polling (research/persona generation) — none running
  // locally. Same exact-key precedence rule as above.
  if (req.method === 'GET' && url.pathname.match(/^\/projects\/[^/]+\/jobs$/) && !(key in handlers)) {
    res.writeHead(200);
    res.end(JSON.stringify({ jobs: [] }));
    return;
  }

  // Handle data-explorer/s3 with query params
  if (req.method === 'GET' && url.pathname === '/data-explorer/s3') {
    const bucket = url.searchParams.get('bucket') || 'raw-data';
    const prefix = url.searchParams.get('prefix') || '';
    res.writeHead(200);
    res.end(JSON.stringify({
      bucket,
      prefix,
      folders: prefix ? [] : ['webscraper/', 'manual_import/', 's3_import/'],
      files: prefix ? [
        { key: `${prefix}item1.json`, size: 1234, last_modified: new Date().toISOString() },
        { key: `${prefix}item2.json`, size: 2345, last_modified: new Date().toISOString() },
      ] : []
    }));
    return;
  }

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
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
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
      res.writeHead(200);
      res.end(JSON.stringify(result));
    });
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

const PORT = Number(process.env.PORT) || 3001;
server.listen(PORT, () => {
  console.log(`Mock API server running at http://localhost:${PORT}`);
  console.log('Use this URL in the frontend Settings page');
});

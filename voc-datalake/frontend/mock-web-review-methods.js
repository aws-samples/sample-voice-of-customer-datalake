// Learned review-site methods mock (docs/web-reviews.md → Learning which method works; lambda/api/
// integrations_handler.py, lambda/shared/web_review_methods.py): GET /integrations/{source}/methods lists what the
// mock workspace's Automatic review pages learned per site, DELETE /integrations/{source}/methods/{domain} clears a
// site's record (Re-check methods) and answers whether there was one. web_reviews only (any other source is the
// API's 400). GET /scrapers/review-methods answers the same list (the scrapers API's copy, which the assistant's
// list_review_site_methods tool reads). Seeded with one learned site and one no method has read, matching the review page cards' seeded runs
// in mock-server.js. Stateful for the life of the mock process. Wired into mock-server.js by handleDomainModules.

const SOURCE = 'web_reviews';
const METHODS_PATH = /^\/integrations\/([^/]+)\/methods(?:\/([^/]+))?$/;
const SCRAPERS_COPY_PATH = '/scrapers/review-methods';

const records = [
  {
    domain: 'trustpilot.com', best_method: 'browser', learned_at: '2026-10-01T09:00:00Z', browser_recheck_due_at: null,
    methods: { browser: { last_outcome: 'readable', last_at: '2026-10-14T08:57:40Z', successes: 3, failures: 0, last_reviews: 40 } },
  },
  {
    domain: 'yelp.com', best_method: 'none', learned_at: null, browser_recheck_due_at: null,
    methods: {
      browser: { last_outcome: 'blocked:DataDome', last_at: '2026-10-14T09:00:20Z', successes: 0, failures: 1, last_reviews: 0 },
      bedrock_web_search: { last_outcome: 'error', last_at: '2026-10-14T09:00:40Z', successes: 0, failures: 1, last_reviews: 0 },
      agentcore_web_search: { last_outcome: 'no_reviews', last_at: '2026-10-14T09:01:05Z', successes: 0, failures: 1, last_reviews: 0 },
    },
  },
];

export function handleWebReviewMethodRoutes(req, _res, url, send) {
  // The scrapers API's copy of the list (the assistant's list_review_site_methods tool reads it): the same records.
  if (url.pathname === SCRAPERS_COPY_PATH) {
    if (req.method === 'GET') send(200, { methods: records });
    else send(405, { success: false, error: 'Method not allowed' });
    return true;
  }
  const match = METHODS_PATH.exec(url.pathname);
  if (!match) return false;
  const [, source, rawDomain] = match;
  if (source !== SOURCE) {
    send(400, { success: false, error: `Source ${source} does not learn review methods` });
  } else if (req.method === 'GET' && rawDomain === undefined) {
    send(200, { methods: records });
  } else if (req.method === 'DELETE' && rawDomain !== undefined) {
    const domain = decodeURIComponent(rawDomain).toLowerCase();
    const index = records.findIndex((record) => record.domain === domain);
    if (index >= 0) records.splice(index, 1);
    send(200, { success: true, domain, cleared: index >= 0 });
  } else {
    send(405, { success: false, error: 'Method not allowed' });
  }
  return true;
}

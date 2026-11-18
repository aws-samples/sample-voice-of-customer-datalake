/**
 * The two context flags of the browser the Web Reviews ingestor drives (lib/stacks/ingestion-browser.ts,
 * docs/web-reviews.md → Blocked sites, Sessions and profiles). Both on by default, both read strictly: anything but
 * `true` or `false` fails the synth, whether or not a browser plugin is enabled.
 *
 * - `-c webReviewsBotAuth=false`: no custom browser; the ingestor keeps the AWS-managed `aws.browser.v1`, which does
 *   not sign its requests (Web Bot Auth), as before 7.41.00.
 * - `-c webReviewsBrowserProfile=false`: no browser profile; every run starts with no cookies or local storage.
 */
import type { Construct } from 'constructs';

import { booleanContextFlag } from './context-flag';

const WEB_REVIEWS_BOT_AUTH_CONTEXT_KEY = 'webReviewsBotAuth';
const WEB_REVIEWS_BROWSER_PROFILE_CONTEXT_KEY = 'webReviewsBrowserProfile';

/** Whether the ingestor's browser signs its requests (`-c webReviewsBotAuth=true|false`, on by default). */
export function webReviewsBotAuth(scope: Construct): boolean {
  return booleanContextFlag(scope.node.tryGetContext(WEB_REVIEWS_BOT_AUTH_CONTEXT_KEY), WEB_REVIEWS_BOT_AUTH_CONTEXT_KEY,
    true, 'Use -c webReviewsBotAuth=true|false.');
}

/** Whether the ingestor's sessions keep a browser profile across runs (`-c webReviewsBrowserProfile=true|false`, on). */
export function webReviewsBrowserProfile(scope: Construct): boolean {
  return booleanContextFlag(scope.node.tryGetContext(WEB_REVIEWS_BROWSER_PROFILE_CONTEXT_KEY),
    WEB_REVIEWS_BROWSER_PROFILE_CONTEXT_KEY, true, 'Use -c webReviewsBrowserProfile=true|false.');
}

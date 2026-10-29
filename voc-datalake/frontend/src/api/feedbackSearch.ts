/**
 * @fileoverview The feedback search route's term rule, shared by every search box.
 * @module api/feedbackSearch
 */

/**
 * The shortest (trimmed) term `GET /feedback/search` accepts; shorter is a 400.
 * `SEARCH_QUERY_MIN_LENGTH` in lambda/shared/api.py (pinned by lambda/shared/test/test_search_minimum_lockstep.py).
 */
export const FEEDBACK_SEARCH_MIN_CHARS = 2

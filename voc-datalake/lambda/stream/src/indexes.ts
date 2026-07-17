/**
 * DynamoDB GSI names used by the streaming Lambda — TypeScript mirror of the
 * single source of truth (issue #213).
 *
 * The indexes are defined in lib/stacks/core-stack.ts; a guard test
 * (src/indexes.test.ts) parses the CDK stack source and asserts these values
 * exist there, so a rename fails CI instead of the live API. The Python
 * handlers have their own mirror (lambda/shared/indexes.py) with a stricter
 * full-set guard.
 */

export const FEEDBACK_BY_DATE_INDEX = 'gsi1-by-date'
export const FEEDBACK_BY_ID_INDEX = 'gsi4-by-feedback-id'

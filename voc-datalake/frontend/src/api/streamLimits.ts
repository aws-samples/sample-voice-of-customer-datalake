/**
 * @fileoverview Client-side mirror of the streaming chat request limits.
 *
 * These values MUST equal the ones the stream Lambda enforces in
 * `voc-datalake/lambda/stream/src/schema.ts`. They cannot be imported: the stream
 * Lambda is a separate npm package with its own tsconfig, bundled by esbuild, and
 * the frontend build does not reach into it. So they are duplicated deliberately
 * and pinned by `streamLimits.lockstep.test.ts`, which reads the schema source and
 * fails if the two drift — the same approach as
 * `lambda/api/test/test_feedback_page_limit_lockstep.py`.
 *
 * Why mirror them at all: a bound enforced only server-side turns into an opaque
 * `Stream error: 400` with no field named and no translated message. Knowing the
 * limit here lets the UI stop the user before sending, which is the difference
 * between a validation message and an apparent outage.
 *
 * @module api/streamLimits
 */

/** Longest `message` the stream Lambda accepts. */
export const MAX_CHAT_MESSAGE_LENGTH = 8000

/**
 * Longest `selected_personas` / `selected_documents` arrays the stream Lambda
 * accepts. Reachable in one keystroke: `@all` in project chat expands to every
 * persona on the project, and persona import appends without replacing, so a
 * project can hold more than this.
 */
export const MAX_SELECTED_PERSONAS = 20
export const MAX_SELECTED_DOCUMENTS = 20

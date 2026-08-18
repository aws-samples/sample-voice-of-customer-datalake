/**
 * @fileoverview The two input bounds the anonymous ballot page shares with the
 * API, in their own module.
 *
 * Separate from the components so that
 * `lambda/api/test/test_anon_ballot_key_lockstep.py` can read one small file:
 * the API REFUSES a note past its bound rather than truncating it, and the public
 * ballot page has no way to explain a 400 it did not anticipate. A bound enforced
 * on one side only turns a refusal into a Submit button that appears to do
 * nothing, in front of a room.
 *
 * The note bound is the SAME number the signed-in save path uses
 * (`MAX_NOTE_LENGTH` in `prioritizationUtils`, `MAX_BALLOT_NOTE_LEN` in
 * `projects_handler`), because both write the same `notes` attribute on the same
 * kind of record and it is read back on the same page. Duplicated here rather
 * than imported from `prioritizationUtils` deliberately: that module pulls in the
 * whole prioritization page's utilities — zod schemas, sorting, the aggregate
 * normalizer — and this page is opened on a phone over a conference network,
 * where a chunk it does not need is a cost with no benefit. The lockstep test is
 * what keeps the copies honest.
 *
 * @module pages/Vote/ballotBounds
 */

/**
 * The longest note a ballot may carry, in code points.
 *
 * Mirrors `MAX_BALLOT_NOTE_LEN` in `lambda/api/ballots_handler.py`, which refuses
 * a longer one.
 */
export const MAX_BALLOT_NOTE_LENGTH = 2000

/**
 * The longest optional display name, in code points.
 *
 * Mirrors `MAX_DISPLAY_NAME_LEN` in `lambda/api/ballots_handler.py` — which
 * TRUNCATES rather than refuses, because a name is not a justification and a
 * silently shortened one costs nothing a submitter needs. The page bounds the
 * input anyway, so nobody types 200 characters into a field that keeps 60.
 */
export const MAX_BALLOT_DISPLAY_NAME_LENGTH = 60

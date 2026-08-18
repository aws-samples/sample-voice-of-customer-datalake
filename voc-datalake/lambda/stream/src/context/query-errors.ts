/**
 * Query-error vocabulary shared by the context builders.
 *
 * Neither builder owns this judgement. Both fan out over many partitions of one
 * table or index, and both have to decide the same thing: whether a failure is
 * one partition's bad luck or the whole read failing sixteen times over. Keeping
 * the set here rather than in whichever builder happened to need it first
 * follows src/indexes.ts, the existing home for vocabulary that is shared rather
 * than one module's business.
 */

// Error names that fail identically for every partition of the same table or
// index — a missing grant, an absent table, a malformed request. Retrying the
// remaining partitions just repeats the failure N times, and reporting it N
// times says nothing the first line did. Two consequences follow for any
// consumer: report one of these ONCE for the turn, and treat the numbers it
// leaves behind as unmeasured rather than as zero.
export const PERSISTENT_QUERY_ERRORS = new Set([
  'AccessDeniedException',
  'ResourceNotFoundException',
  'ValidationException',
]);

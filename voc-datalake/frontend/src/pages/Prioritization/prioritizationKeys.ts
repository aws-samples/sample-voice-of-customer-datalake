/**
 * @fileoverview The prioritization read's query key, shared by the page (which reads and
 * invalidates it on a save) and the room-vote panel (which invalidates it when a ballot
 * lands or the vote ends). No imports, so neither side pulls in the other's code.
 * @module pages/Prioritization/prioritizationKeys
 */

/** `GET /projects/prioritization` — the caller's own scores and the team aggregates. */
export const PRIORITIZATION_SCORES_KEY = ['prioritization-scores'] as const

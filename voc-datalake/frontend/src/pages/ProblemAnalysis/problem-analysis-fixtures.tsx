/**
 * @fileoverview Shared test support for the `src/pages/ProblemAnalysis` specs.
 *
 * Deliberately imports NO component or hook from this directory: the module
 * factories below are called from hoisted `vi.mock(...)` blocks, and a module
 * that both feeds those factories and imports a consumer of the mocked module
 * cannot finish evaluating. Specs must import this file BEFORE the module under
 * test. Render helpers that need the row components live in
 * `problem-row-fixtures.tsx`.
 */
import { expect, vi } from 'vitest'
// Fixture files compile under the app tsconfig (test files and `src/test/setup.ts`
// are excluded from it), so the jest-dom matcher types must be brought in here for
// the `expect*` helpers below. The runtime registration this also performs is the
// same one `src/test/setup.ts` already did.
import '@testing-library/jest-dom/vitest'
import { act, waitFor } from '@testing-library/react'
import type { FeedbackItem } from '../../api/types'
import type { ProblemGroup, SubcategoryGroup } from './problemResolution'

// ---------------------------------------------------------------------------
// Data builders
// ---------------------------------------------------------------------------

/** A fully-typed processed review in the `delivery / shipping_speed` bucket. */
export function makeFeedbackItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    feedback_id: 'f1',
    source_platform: 'webscraper',
    brand_name: 'TestBrand',
    original_text: 'The delivery was very slow',
    category: 'delivery',
    subcategory: 'shipping_speed',
    problem_summary: 'Slow delivery times',
    sentiment_score: -0.5,
    sentiment_label: 'negative',
    urgency: 'high',
    source_created_at: '2025-01-01',
    processed_at: '2025-01-01',
    original_language: 'en',
    source_id: 's1',
    source_channel: 'social',
    journey_stage: 'post_purchase',
    impact_area: 'delivery',
    ...overrides,
  }
}

/** The second review of every row fixture: a medium-urgency manual import a day later. */
function makeSecondFeedbackItem(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return makeFeedbackItem({
    feedback_id: 'f2',
    source_platform: 'manual_import',
    original_text: 'Shipping took forever',
    problem_summary: 'Delivery too slow',
    sentiment_score: -0.6,
    urgency: 'medium',
    source_created_at: '2025-01-02',
    processed_at: '2025-01-02',
    source_id: 's2',
    source_channel: 'review',
    ...overrides,
  })
}

/** The "Slow delivery times" group: two similar reviews, one urgent, with a root cause. */
export function makeProblemGroup(overrides: Partial<ProblemGroup> = {}): ProblemGroup {
  return {
    problem: 'Slow delivery times',
    similarProblems: ['Delivery too slow', 'Shipping delays'],
    rootCause: 'Logistics bottleneck in warehouse',
    items: [makeFeedbackItem(), makeSecondFeedbackItem()],
    avgSentiment: -0.55,
    urgentCount: 1,
    ...overrides,
  }
}

/** The `shipping_speed` subcategory: an urgent "Slow delivery times" and a non-urgent "Package damaged". */
export const SHIPPING_SPEED_SUBCATEGORY: SubcategoryGroup = {
  subcategory: 'shipping_speed',
  problems: [
    makeProblemGroup({
      similarProblems: [],
      rootCause: 'Logistics issues',
      items: [makeFeedbackItem({ original_text: 'Delivery was slow' })],
      avgSentiment: -0.5,
    }),
    makeProblemGroup({
      problem: 'Package damaged',
      similarProblems: [],
      rootCause: null,
      items: [
        makeSecondFeedbackItem({
          original_text: 'Package arrived damaged',
          problem_summary: 'Package damaged',
          sentiment_score: -0.7,
        }),
      ],
      avgSentiment: -0.7,
      urgentCount: 0,
    }),
  ],
  totalItems: 2,
  urgentCount: 1,
}

// ---------------------------------------------------------------------------
// Module factories for `vi.mock`
// ---------------------------------------------------------------------------

/** A stub whose return is `unknown` so the module factory below is not "unsafe any". */
const apiStub = () => vi.fn<(...args: unknown[]) => unknown>()

/** One `vi.fn()` per `api.*` member the page and its resolution hook call. */
export const problemAnalysisApiMocks = {
  getFeedback: apiStub(),
  getEntities: apiStub(),
  getResolvedProblems: apiStub(),
  setProblemResolved: apiStub(),
}

/** Module factory for `vi.mock('../../api/client', () => clientApiModule())`. */
export function clientApiModule() {
  return {
    api: {
      getFeedback: (params: unknown) => problemAnalysisApiMocks.getFeedback(params),
      getEntities: (params: unknown) => problemAnalysisApiMocks.getEntities(params),
      getResolvedProblems: () => problemAnalysisApiMocks.getResolvedProblems(),
      setProblemResolved: (key: string, resolved: boolean) =>
        problemAnalysisApiMocks.setProblemResolved(key, resolved),
    },
    getDateRangeParams: () => ({ days: 7 }),
  }
}

// ---------------------------------------------------------------------------
// Resolution-toggle helpers (useProblemResolution)
// ---------------------------------------------------------------------------

/** The resolve/unresolve call's result shape. */
interface ToggleOutcome {
  success: boolean
}

/** A promise the test resolves or rejects manually, to hold a mutation in flight. */
interface Deferred<T> {
  promise: Promise<T>
  holder: { resolve: (value: T) => void; reject: (reason: Error) => void }
}

function deferred<T>(): Deferred<T> {
  const holder: Deferred<T>['holder'] = {
    resolve: () => undefined,
    reject: () => undefined,
  }
  const promise = new Promise<T>((resolve, reject) => {
    holder.resolve = resolve
    holder.reject = reject
  })
  return { promise, holder }
}

/** Holds EVERY `setProblemResolved` call in flight on one deferred promise. */
export function holdToggle(): Deferred<ToggleOutcome> {
  const held = deferred<ToggleOutcome>()
  problemAnalysisApiMocks.setProblemResolved.mockReturnValue(held.promise)
  return held
}

/** Holds the next two `setProblemResolved` calls on their own deferred promises, in order. */
export function holdTwoToggles(): [Deferred<ToggleOutcome>, Deferred<ToggleOutcome>] {
  const first = deferred<ToggleOutcome>()
  const second = deferred<ToggleOutcome>()
  problemAnalysisApiMocks.setProblemResolved
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
  return [first, second]
}

/** The part of `useProblemResolution`'s state the toggle helpers drive. */
interface ResolutionHookResult {
  current: {
    pendingKeys: ReadonlySet<string>
    toggleResolved: (key: string, resolved: boolean) => void
  }
}

/** Toggles `key` and waits until the hook reports it as pending. */
export async function toggleAndExpectPending(
  result: ResolutionHookResult,
  key: string,
  resolved = true,
) {
  act(() => result.current.toggleResolved(key, resolved))
  await waitFor(() => expect(result.current.pendingKeys.has(key)).toBe(true))
}

/** Waits until no key is pending any more. */
export async function expectNoPendingKeys(result: ResolutionHookResult) {
  await waitFor(() => expect(result.current.pendingKeys.size).toBe(0))
}

/**
 * The calendar window the wizard's source list counts over.
 *
 * The list used to be fixed at the last 30 days, so a deployment whose newest
 * feedback is older showed no real sources (the defaults stood in) even when the
 * user picked "Last year" or "All time" and generation would find thousands of
 * items. It now follows the window the generator samples from: the date walk in
 * `lambda/shared/feedback.py` (`sample_walk_days`) covers the selected days, or
 * MAX_SAMPLE_WALK_DAYS for all time (0), capped at that same bound. A source the
 * list offers is therefore one generation can actually read.
 *
 * `MAX_SAMPLE_WALK_DAYS` is pinned to Python's by
 * lambda/shared/test/test_lookback_window_lockstep.py.
 */
const MAX_SAMPLE_WALK_DAYS = 400

export function sourceListDays(days: number): number {
  return days <= 0 ? MAX_SAMPLE_WALK_DAYS : Math.min(days, MAX_SAMPLE_WALK_DAYS)
}

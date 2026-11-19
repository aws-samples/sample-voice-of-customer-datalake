/**
 * @fileoverview The body of a spec's `vi.mock` of the forms API: the real module, with `overrides` (the spec's
 * hoisted fakes) on `feedbackFormsV2Api`. Used as
 * `vi.mock('../../../api/feedbackFormsV2Api', async (importOriginal) => (await import('../test/formsApiMock')).formsApiWith(importOriginal, api))`.
 *
 * @module pages/FeedbackForms/test/formsApiMock
 */
type FormsApiModule = typeof import('../../../api/feedbackFormsV2Api')

export async function formsApiWith(importOriginal: <T>() => Promise<T>, overrides: object): Promise<FormsApiModule> {
  const real = await importOriginal<FormsApiModule>()
  return { ...real, feedbackFormsV2Api: { ...real.feedbackFormsV2Api, ...overrides } }
}

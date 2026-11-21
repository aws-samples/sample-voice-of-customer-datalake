/**
 * @fileoverview The form's test token as the builder knows it (D2), shared by the Test, Share and Hidden fields
 * tabs: the one `POST …/test-link` answers while the saved form's test link is on (no form answer carries the token:
 * the record's `settings.test` says only whether one was issued), replaced in the page's cache by the one "Reset
 * test link" made since. Read once per form while the page is open (a save that turns the link on reads it then).
 *
 * Reading it through `…/test-link` sends the stored settings back unchanged (`link_enabled`, `record`), so it changes
 * nothing; a form that has no token yet gets one (the server issues it on that first call). Only an admin may: for
 * anyone else the read is refused and there is no test link to show.
 *
 * @module pages/FeedbackForms/tabs/testToken
 */
import { useQuery } from '@tanstack/react-query'
import { feedbackFormsV2Api } from '../../../api/feedbackFormsV2Api'
import { useDraft } from '../builder/formDraftContext'
import { useBuilderUi } from '../builder/builderUi'

/** Where the page keeps the form's test token. */
export const testTokenKey = (formId: string) => ['feedback-forms', formId, 'test-token'] as const

/** The recent test responses the Test tab polls (Delete all reads them again). */
export const recentTestResponsesKey = (formId: string) => ['feedback-forms', formId, 'test-responses'] as const

/** The test token as the page knows it: `loading` while it is being read (so "no test link yet" is never shown, nor
 * offered to be made, for a form whose token is only on its way). */
export interface TestTokenState {
  readonly token: string | null
  readonly loading: boolean
}

/** The form's test token, or the one a reset made since; null for a new form, one whose saved link was never on while
 * the page was open, or a non-admin. */
export function useTestToken(): string | null {
  return useTestTokenState().token
}

/** {@link useTestToken}, and whether it is still being read. */
export function useTestTokenState(): TestTokenState {
  const { baseline } = useDraft()
  const { formId } = useBuilderUi()
  const saved = baseline?.settings.test
  const linkOn = saved?.link_enabled === true
  const { data, isLoading } = useQuery({
    queryKey: testTokenKey(formId ?? ''),
    queryFn: async () => {
      if (formId === null || saved === undefined) return ''
      return (await feedbackFormsV2Api.issueTestLink(formId, { link_enabled: true, record: saved.record })).token
    },
    enabled: formId !== null && linkOn,
    staleTime: Infinity,
    retry: false,
  })
  return { token: data === undefined || data === '' ? null : data, loading: isLoading }
}

/** The stored form's test settings (what the builder loaded), which a test-link call sends back unchanged: the saved
 * link turns on, off or records otherwise only on Save. */
export function useStoredTestSettings(): { link_enabled: boolean; record: 'tag' | 'drop' } {
  const saved = useDraft().baseline?.settings.test
  return { link_enabled: saved?.link_enabled === true, record: saved?.record ?? 'tag' }
}

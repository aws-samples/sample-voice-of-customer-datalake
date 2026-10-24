/**
 * @fileoverview `forwardedProps` for a run: the page the user is on, the global
 * time range / date basis, the UI language and the web-search opt-in.
 *
 * Validated against the contract schema before it leaves the SPA, so a page
 * context that would be rejected server-side (an over-long title, say) is
 * trimmed here instead of turning into an opaque RUN_ERROR.
 *
 * @module assistant/agui/forwardedProps
 */
import { ALL_TIME_CUSTOM_DAYS, MAX_CUSTOM_DAYS } from '../../api/baseUrl'
import { getDateRangeParams } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { forwardedPropsSchema, pageContextSchema } from '../contract'
import type { ForwardedProps, PageContext } from '../contract'

const MAX_TITLE = 120
const MAX_PATH = 200
const MAX_LANGUAGE = 16

/** Clamp free-text page fields to the contract bounds. */
function clampPageContext(page: PageContext): PageContext {
  const clamped: PageContext = {
    ...page,
    path: page.path.slice(0, MAX_PATH),
    ...(page.title !== undefined ? { title: page.title.slice(0, MAX_TITLE) } : {}),
  }
  const parsed = pageContextSchema.safeParse(clamped)
  return parsed.success ? parsed.data : { kind: 'other', path: clamped.path }
}

export interface ForwardedPropsInput {
  page: PageContext
  language: string | undefined
  useWebSearch: boolean
}

export function buildForwardedProps({ page, language, useWebSearch }: ForwardedPropsInput): ForwardedProps {
  const { timeRange, customDays, dateBasis } = useConfigStore.getState()
  const range = getDateRangeParams(timeRange, customDays, dateBasis)
  const candidate: ForwardedProps = {
    page: clampPageContext(page),
    ...(range.days !== undefined ? { days: Math.min(MAX_CUSTOM_DAYS, Math.max(ALL_TIME_CUSTOM_DAYS, range.days)) } : {}),
    dateBasis: range.date_basis ?? 'imported',
    ...(language !== undefined && language !== '' ? { responseLanguage: language.slice(0, MAX_LANGUAGE) } : {}),
    ...(useWebSearch ? { useWebSearch: true } : {}),
  }
  const parsed = forwardedPropsSchema.safeParse(candidate)
  return parsed.success ? parsed.data : { page: candidate.page }
}

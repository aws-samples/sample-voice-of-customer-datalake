/**
 * @fileoverview `forwardedProps` for a run: the page the user is on, the global
 * time range / date basis, the UI language, the web-search opt-in and the
 * personas / documents the message mentions (`@`, `#`; project pages only) and, on `/chat`, the
 * filter panel's scope (a floor the stream's feedback tools cannot widen).
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
import { chatScopeSchema, forwardedPropsSchema, mentionsSchema, pageContextSchema } from '../contract'
import type { ChatScope, ForwardedProps, Mentions, PageContext } from '../contract'

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
  /** The personas / documents mentioned in this message (project pages only). */
  mentions?: Mentions
  /** The /chat filter panel's scope (chatScopeStore); sent from the chat page only. */
  scope?: ChatScope
}

/** The scope only travels from `/chat`, and only when it passes the contract. */
function scopeFor(page: PageContext, scope: ChatScope | undefined): { scope?: ChatScope } {
  if (scope === undefined || page.kind !== 'chat') return {}
  const parsed = chatScopeSchema.safeParse(scope)
  return parsed.success ? { scope: parsed.data } : {}
}

/** Mentions only travel from a project page, and only when they pass the contract. */
function mentionsFor(page: PageContext, mentions: Mentions | undefined): { mentions?: Mentions } {
  if (mentions === undefined || page.kind !== 'project' || page.projectId === undefined) return {}
  const parsed = mentionsSchema.safeParse(mentions)
  if (!parsed.success || (parsed.data.personas === undefined && parsed.data.documents === undefined)) return {}
  return { mentions: parsed.data }
}

export function buildForwardedProps({ page, language, useWebSearch, mentions, scope }: ForwardedPropsInput): ForwardedProps {
  const { timeRange, customDays, dateBasis } = useConfigStore.getState()
  const range = getDateRangeParams(timeRange, customDays, dateBasis)
  const clampedPage = clampPageContext(page)
  const candidate: ForwardedProps = {
    page: clampedPage,
    ...mentionsFor(clampedPage, mentions),
    ...scopeFor(clampedPage, scope),
    ...(range.days !== undefined ? { days: Math.min(MAX_CUSTOM_DAYS, Math.max(ALL_TIME_CUSTOM_DAYS, range.days)) } : {}),
    dateBasis: range.date_basis ?? 'imported',
    ...(language !== undefined && language !== '' ? { responseLanguage: language.slice(0, MAX_LANGUAGE) } : {}),
    ...(useWebSearch ? { useWebSearch: true } : {}),
  }
  const parsed = forwardedPropsSchema.safeParse(candidate)
  return parsed.success ? parsed.data : { page: candidate.page }
}

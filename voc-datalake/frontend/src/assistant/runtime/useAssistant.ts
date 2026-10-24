/**
 * @fileoverview React binding for the assistant runtime: the current thread,
 * the run environment (page, language, web search) and bound actions.
 *
 * @module assistant/runtime/useAssistant
 */
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { isWebSearchAvailable } from '../../runtimeConfig'
import { usePageContext } from '../page/usePageContext'
import { useAssistantUiStore, useThreadStore } from '../store/assistantStore'
import {
  newThread, openSession, resolveApproval, sendMessage, stopRun,
} from './runtime'
import type { ContentPart } from '@ag-ui/core'
import type { ApprovalResolution } from '../types'
import type { RunEnvironment } from './runtime'

/** The run environment for the current route: page, UI language, web search. */
export function useRunEnvironment(): RunEnvironment {
  const page = usePageContext()
  const { i18n } = useTranslation()
  const webSearchToggle = useAssistantUiStore((s) => s.useWebSearch)
  const webSearchAvailable = isWebSearchAvailable()
  return useMemo(() => ({
    page,
    language: i18n.language,
    useWebSearch: webSearchAvailable && webSearchToggle,
  }), [page, i18n.language, webSearchAvailable, webSearchToggle])
}

export function useAssistant() {
  const env = useRunEnvironment()
  const { page } = env
  const thread = useThreadStore((s) => s.thread)
  const threadId = thread.threadId
  const webSearchAvailable = isWebSearchAvailable()

  // Bound to the thread in view WHEN RENDERED: a send, stop or approval that
  // completes after the user switched conversations still lands on its own thread.
  const send = useCallback((content: string | ContentPart[]) => sendMessage(content, env, threadId), [env, threadId])
  const stop = useCallback(() => stopRun(env.page, threadId), [env, threadId])
  const resolve = useCallback((resolution: ApprovalResolution) => resolveApproval(resolution, env, threadId), [env, threadId])
  const open = useCallback((id: string) => openSession(id, env), [env])

  return {
    thread, page, env, webSearchAvailable, send, stop, resolve, open, newThread,
  }
}

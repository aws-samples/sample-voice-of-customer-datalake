/**
 * @fileoverview The Product tab interview chat that drafts the product context.
 * @module pages/ProjectDetail/ProductInterviewChat
 */

import { MessageSquare, Send, Loader2, AlertTriangle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { projectsApi } from '../../api/projectsApi'
import { buildHistory, MAX_INTERVIEW_HISTORY_ENTRIES } from '../../constants/chat'
import type { ProductContext } from '../../api/projectTypes'
import type { TFunction } from 'i18next'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'

/**
 * Whether an interview turn changed any field. Typed wider than the response type on
 * purpose: the turn response is not validated, and a turn that changed nothing may
 * omit the patch or send null.
 */
function patchChangedSomething(
  patch: Partial<ProductContext> | null | undefined,
): patch is Partial<ProductContext> {
  return patch !== null && patch !== undefined && Object.keys(patch).length > 0
}

// `failed` is display-only: buildHistory copies just role + content, so it never reaches the API.
interface ChatTurn { role: 'user' | 'assistant'; content: string; failed?: boolean }

export function InterviewChat({
  projectId, language, onPatch, t,
}: {
  readonly projectId: string
  readonly language: string
  readonly onPatch: (patch: Partial<ProductContext>, fresh: ProductContext) => void
  readonly t: TFunction<'projectDetail'>
}) {
  const [history, setHistory] = useState<ChatTurn[]>([{
    role: 'assistant',
    content: t('product.interview.greeting'),
  }])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // When the language flips after mount, refresh the greeting (only if
  // nothing else has been said). Render-phase adjustment keyed on the
  // language prop replaces the previous setState-in-effect sync on t.
  const [prevLanguage, setPrevLanguage] = useState(language)
  if (prevLanguage !== language) {
    setPrevLanguage(language)
    if (history.length === 1) {
      setHistory([{ role: 'assistant', content: t('product.interview.greeting') }])
    }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [history])

  const decode = useCallback((message: string) => {
    if (message === '__captured__') return t('product.interview.captured')
    if (message === '__elaborate__') return t('product.interview.elaborate')
    return message
  }, [t])

  const send = useCallback(async () => {
    const message = input.trim()
    if (!message || busy) return
    setInput('')
    setBusy(true)
    const nextHistory: ChatTurn[] = [...history, { role: 'user', content: message }]
    setHistory(nextHistory)
    try {
      const r = await projectsApi.productContextInterview(projectId, {
        message,
        // Prior turns only: the server appends `message` itself, so sending
        // nextHistory here would repeat it and produce two user turns in a
        // row.  buildHistory also drops the assistant-only greeting, which
        // Bedrock rejects as a leading non-user turn.
        //
        // On turn 1 that leaves this empty, which is intended rather than
        // incidental: `interview_turn`
        // (`voc-datalake/lambda/api/product_context.py`) rebuilds the full
        // interview instructions plus `CURRENT CONTEXT` into its system prompt
        // on *every* turn, so the model is told what it is interviewing for and
        // which fields are still empty without needing the greeting in history.
        // The greeting only ever restated that standing instruction.
        history: buildHistory(history, MAX_INTERVIEW_HISTORY_ENTRIES),
        response_language: language,
      })
      setHistory([...nextHistory, { role: 'assistant', content: decode(r.assistant_message) }])
      if (patchChangedSomething(r.applied_patch)) {
        onPatch(r.applied_patch, r.context)
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Interview failed'
      setHistory([...nextHistory, { role: 'assistant', content: msg, failed: true }])
    } finally {
      setBusy(false)
    }
  }, [input, busy, history, projectId, onPatch, language, decode])

  return (
    <div className="bg-card border rounded-xl p-4 flex flex-col" style={{ height: 480 }}>
      <div className="flex items-center gap-2 mb-3">
        <MessageSquare size={16} className="text-accent" />
        <h3 className="text-sm font-semibold">{t('product.interview.heading')}</h3>
        <span className="text-xs text-muted">— {t('product.interview.hint')}</span>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-3 pr-1">
        {history.map((m, i) => (
          <div key={i} className={`text-sm ${m.role === 'user' ? 'text-right' : ''}`}>
            <div className={`inline-block max-w-[90%] rounded-lg px-3 py-2 whitespace-pre-wrap ${
              m.role === 'user' ? 'bg-accent text-accent-fg' : 'bg-bg-hover text-text-strong'
            }`}>
              {m.failed === true && <AlertTriangle size={14} className="inline mr-1.5 -mt-0.5 text-danger" aria-hidden="true" />}
              {m.content}
            </div>
          </div>
        ))}
        {busy && (
          <div className="text-xs text-muted inline-flex items-center gap-1">
            <Loader2 size={12} className="animate-spin" /> {t('product.interview.thinking')}
          </div>
        )}
      </div>
      <StickyActionBar variant="inline" className="mt-3 flex gap-2 py-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
          disabled={busy}
          placeholder={t('product.interview.placeholder')}
          className="input flex-1"
        />
        <button
          onClick={send}
          disabled={busy || !input.trim()}
          aria-label={t('product.interview.send')}
          className="btn btn-primary text-sm"
        >
          <Send size={14} />
        </button>
      </StickyActionBar>
    </div>
  )
}

// ── Generate report ─────────────────────────────────────────────────────────

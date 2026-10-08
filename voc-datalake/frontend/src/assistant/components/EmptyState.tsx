/**
 * @fileoverview Empty thread: the idle Kiro ghost, a greeting and suggested
 * prompts for the page kind.
 *
 * @module assistant/components/EmptyState
 */
import { useTranslation } from 'react-i18next'
import { GhostIdle } from '../../components/KiroGhost/GhostPoses'
import type { PageKind } from '../contract'

/** Page kinds with their own suggestion set; the rest use `default`. */
const SUGGESTION_GROUPS: Partial<Record<PageKind, string>> = {
  project: 'project',
  'feedback-forms': 'forms',
  prioritization: 'prioritization',
  scrapers: 'scrapers',
  settings: 'settings',
  problems: 'problems',
  feedback: 'feedback',
}

const SUGGESTION_COUNT = 3

function suggestionGroup(kind: PageKind): string {
  return SUGGESTION_GROUPS[kind] ?? 'default'
}

export default function EmptyState({ kind, onPick }: Readonly<{ kind: PageKind; onPick: (prompt: string) => void }>) {
  const { t } = useTranslation('assistant')
  const group = suggestionGroup(kind)
  const prompts = Array.from({ length: SUGGESTION_COUNT }, (_, i) => t(`suggestions.${group}.${i + 1}`))
  return (
    <div className="flex flex-col items-center px-2 py-6 text-center animate-rise">
      <GhostIdle className="mb-3 h-14 w-14 text-aim" />
      <p className="text-sm font-semibold tracking-tight text-text-strong">{t('empty.title')}</p>
      <p className="mb-4 text-[12px] text-muted">{t('empty.subtitle')}</p>
      <ul className="w-full space-y-1.5">
        {prompts.map((prompt) => (
          <li key={prompt}>
            <button
              type="button"
              onClick={() => onPick(prompt)}
              className="w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-left text-[13px] text-text transition-colors hover:border-border-strong hover:bg-bg-hover active:scale-[0.97]"
            >
              {prompt}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

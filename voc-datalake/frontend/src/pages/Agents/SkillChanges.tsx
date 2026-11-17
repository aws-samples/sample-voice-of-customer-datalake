/**
 * @fileoverview What a skill version changes beside its instructions, from the server's diff (skills/views.py): the
 * examples added and removed, the tools its policy adds and drops (or reorders), and the model and harness when they
 * move. The instructions themselves are compared as the document reads (DocumentSurface's compare mode); these are
 * not text, so they are listed. Each change says "Added" or "Removed" in words, never by colour alone.
 *
 * @module pages/Agents/SkillChanges
 */
import { useTranslation } from 'react-i18next'
import { sideChangesEmpty } from './skillsView'
import type { SkillDiff } from '../../api/engineeringSkillsApi'

function Change({ op, children }: Readonly<{ op: '+' | '-'; children: string }>) {
  const { t } = useTranslation('agents')
  const added = op === '+'
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className={added ? 'badge badge-ok' : 'badge badge-danger'}>{added ? t('skills.diff.added') : t('skills.diff.removed')}</span>
      {' '}
      <span className="min-w-0 break-words [overflow-wrap:anywhere]">{children}</span>
    </li>
  )
}

/** A model or harness that moved: from what (or nothing, for a first version) to what. */
function Moved({ name, moved }: Readonly<{ name: 'model' | 'harness'; moved: readonly [string, string] | null }>) {
  const { t } = useTranslation('agents')
  if (moved === null) return null
  const from = moved[0] === '' ? t('skills.diff.nothing') : moved[0]
  return <p className="text-sm break-all">{t(`skills.diff.${name}`, { from, to: moved[1] })}</p>
}

export function SkillChanges({ diff }: Readonly<{ diff: SkillDiff }>) {
  const { t } = useTranslation('agents')
  if (sideChangesEmpty(diff)) return <p className="text-sm text-muted">{t('skills.changes.none')}</p>
  const tools = [...diff.tools_added.map((name) => ['+', name] as const), ...diff.tools_removed.map((name) => ['-', name] as const)]
  return (
    <section aria-label={t('skills.changes.title')} className="space-y-3">
      {diff.examples.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-[12px] font-semibold text-muted">{t('skills.diff.examples')}</h4>
          <ul className="space-y-1">
            {diff.examples.map(([op, example]) => (
              <Change key={`${op}-${example.situation}-${example.action}`} op={op}>
                {t('skills.diff.example', { situation: example.situation, action: example.action })}
              </Change>
            ))}
          </ul>
        </div>
      )}
      {(tools.length > 0 || diff.tools_reordered) && (
        <div className="space-y-1">
          <h4 className="text-[12px] font-semibold text-muted">{t('skills.diff.tools')}</h4>
          <ul className="space-y-1">{tools.map(([op, name]) => <Change key={`${op}-${name}`} op={op}>{name}</Change>)}</ul>
          {diff.tools_reordered && <p className="text-sm">{t('skills.diff.reordered')}</p>}
        </div>
      )}
      <Moved name="model" moved={diff.model} />
      <Moved name="harness" moved={diff.harness} />
    </section>
  )
}

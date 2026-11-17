/**
 * @fileoverview A proposal's examples, edited as a list (SkillProposeSheet.tsx): each a situation ("When") and what to
 * do ("Do"), at most 20, each half at most 2,000 characters (skills/model.py). Plain fields: an example is data the
 * compile writes under `## Examples`, never Markdown typed here.
 *
 * @module pages/Agents/SkillExamplesField
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { SKILL_LIMITS } from './documents/skillDocument'
import type { SkillExample } from './documents/skillDocument'

/** An example as the list edits it: with a key of its own (its text changes as it is typed). */
export interface EditedExample extends SkillExample { readonly key: number }

function ExampleRow({ example, index, onChange, onRemove }: Readonly<{
  example: EditedExample; index: number; onChange: (next: EditedExample) => void; onRemove: () => void
}>) {
  const { t } = useTranslation('agents')
  const id = useId()
  return (
    <li className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-semibold text-muted">{t('skills.propose.exampleN', { n: index + 1 })}</p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRemove}
          aria-label={t('skills.propose.removeExample', { n: index + 1 })}>
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
      <label htmlFor={`${id}-when`} className="block text-[12px] text-muted">{t('skills.document.situation')}</label>
      <textarea id={`${id}-when`} className="input w-full" rows={2} maxLength={SKILL_LIMITS.maxExampleChars} value={example.situation}
        onChange={(event) => onChange({ ...example, situation: event.target.value })} />
      <label htmlFor={`${id}-do`} className="block text-[12px] text-muted">{t('skills.document.action')}</label>
      <textarea id={`${id}-do`} className="input w-full" rows={2} maxLength={SKILL_LIMITS.maxExampleChars} value={example.action}
        onChange={(event) => onChange({ ...example, action: event.target.value })} />
    </li>
  )
}

export function SkillExamplesField({ examples, onChange, nextKey }: Readonly<{
  examples: readonly EditedExample[]; onChange: (next: readonly EditedExample[]) => void; nextKey: () => number
}>) {
  const { t } = useTranslation('agents')
  const fullId = useId()
  const full = examples.length >= SKILL_LIMITS.maxExamples
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold text-text-strong">{t('skills.propose.examples')}</legend>
      {examples.length === 0 && <p className="text-sm text-muted">{t('skills.document.noExamples')}</p>}
      <ol className="space-y-2">
        {examples.map((example, index) => (
          <ExampleRow key={example.key} example={example} index={index}
            onChange={(next) => onChange(examples.map((each) => (each.key === next.key ? next : each)))}
            onRemove={() => onChange(examples.filter((each) => each.key !== example.key))} />
        ))}
      </ol>
      {/* (aria-disabled, not disabled: the button stays focusable and its reason reaches a keyboard user) */}
      <button type="button" className="btn btn-secondary btn-sm" aria-disabled={full} aria-describedby={full ? fullId : undefined}
        onClick={() => { if (!full) onChange([...examples, { key: nextKey(), situation: '', action: '' }]) }}>
        <Plus size={14} aria-hidden="true" />{t('skills.propose.addExample')}
      </button>
      {full && <p id={fullId} className="text-[12px] text-muted">{t('skills.propose.examplesFull', { max: SKILL_LIMITS.maxExamples })}</p>}
    </fieldset>
  )
}

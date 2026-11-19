/**
 * @fileoverview The declared hidden fields (UX §6): ID, label, what fills them ("link · SDK") and what Results does
 * with them (a filter and a column; an asterisk and the dimension's name when the id is a configured dimension's
 * key, D5), each with ⋯ Rename and Delete….
 *
 * @module pages/FeedbackForms/tabs/hidden/HiddenFieldsTable
 */
import { useTranslation } from 'react-i18next'
import { PencilLine, Trash2 } from 'lucide-react'
import ActionsMenu from '../../ui/ActionsMenu'
import type { HiddenField } from '../../model/formsV2'
import HiddenFieldEditor from './HiddenFieldEditor'

export interface HiddenRowsProps {
  readonly fields: readonly HiddenField[]
  /** A configured dimension's label by its key (D5). */
  readonly dimensions: ReadonlyMap<string, string>
  /** The field being renamed (its id), if any. */
  readonly renaming: string | null
  readonly locked: boolean
  readonly onRename: (id: string | null) => void
  readonly onRenamed: (from: string, field: HiddenField) => void
  readonly onDelete: (id: string) => void
}

function InResults({ id, dimensions }: Readonly<{ id: string; dimensions: ReadonlyMap<string, string> }>) {
  const { t } = useTranslation('feedbackForms')
  const dimension = dimensions.get(id)
  return <>{dimension === undefined ? t('hidden.inResults') : t('hidden.inResultsDimension', { name: dimension })}</>
}

export default function HiddenFieldsTable({ fields, dimensions, renaming, locked, onRename, onRenamed, onDelete }: HiddenRowsProps) {
  const { t } = useTranslation('feedbackForms')
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-bg-accent text-left text-[11px] font-semibold uppercase tracking-[.04em] text-muted-strong">
          <tr>
            <th scope="col" className="px-3 py-2">{t('hidden.columns.id')}</th>
            <th scope="col" className="px-3 py-2">{t('hidden.columns.label')}</th>
            <th scope="col" className="px-3 py-2">{t('hidden.columns.filledBy')}</th>
            <th scope="col" className="px-3 py-2">{t('hidden.columns.inResults')}</th>
            <th scope="col" className="px-3 py-2"><span className="sr-only">{t('hidden.columns.actions')}</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {fields.map((field) => (renaming === field.id ? (
            <tr key={field.id}>
              <td colSpan={5} className="p-2">
                <HiddenFieldEditor initial={field} locked={locked} onCancel={() => onRename(null)}
                  taken={new Set(fields.filter((other) => other.id !== field.id).map((other) => other.id))}
                  onDone={(next) => onRenamed(field.id, next)} />
              </td>
            </tr>
          ) : (
            <tr key={field.id}>
              <td className="px-3 py-2 font-mono text-[12px] text-text-strong">{field.id}</td>
              <td className="px-3 py-2 text-text">{field.label ?? ''}</td>
              <td className="px-3 py-2 text-muted">{t('hidden.filledBy')}</td>
              <td className="px-3 py-2 text-muted"><InResults id={field.id} dimensions={dimensions} /></td>
              <td className="px-3 py-2 text-right">
                <ActionsMenu label={t('hidden.actions', { id: field.id })} items={[
                  { label: t('hidden.rename'), icon: PencilLine, onSelect: () => onRename(field.id) },
                  { label: t('hidden.delete'), icon: Trash2, danger: true, onSelect: () => onDelete(field.id) },
                ]} />
              </td>
            </tr>
          )))}
        </tbody>
      </table>
    </div>
  )
}

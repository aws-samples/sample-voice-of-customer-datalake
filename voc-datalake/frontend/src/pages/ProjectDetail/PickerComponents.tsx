/**
 * Shared picker UI components used by AutoseedCard and AutoseedContent.
 */
import {
  ChevronDown, ChevronRight,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface PickerSectionProps {
  readonly title: string
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly allSelected: boolean
  readonly onToggleAll: (select: boolean) => void
  readonly children: React.ReactNode
}

export function PickerSection({
  title, expanded, onToggle, allSelected, onToggleAll, children,
}: PickerSectionProps) {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="border rounded-lg mb-3">
      <div className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-gray-700 rounded-t-lg">
        <button
          type="button"
          onClick={onToggle}
          className="flex items-center gap-2 hover:text-gray-900"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {title}
        </button>
        <button
          type="button"
          className="text-xs text-indigo-600 hover:text-indigo-800"
          onClick={() => onToggleAll(!allSelected)}
        >
          {allSelected ? t('autoseed.deselectAll') : t('autoseed.selectAll')}
        </button>
      </div>
      {expanded ? <div className="px-3 pb-2 max-h-48 overflow-y-auto">
        {children}
      </div> : null}
    </div>
  )
}

interface CheckboxItemProps {
  readonly id: string
  readonly label: string
  readonly sublabel?: string
  readonly checked: boolean
  readonly onChange: () => void
}

export function CheckboxItem({
  id, label, sublabel, checked, onChange,
}: CheckboxItemProps) {
  return (
    <label htmlFor={`cb-${id}`} className="flex items-center gap-2 py-1 cursor-pointer hover:bg-gray-50 rounded px-1">
      <input
        id={`cb-${id}`}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
      />
      <span className="text-sm text-gray-800 truncate">{label}</span>
      {sublabel != null && sublabel !== '' ? <span className="text-xs text-gray-400 truncate">({sublabel})</span> : null}
    </label>
  )
}

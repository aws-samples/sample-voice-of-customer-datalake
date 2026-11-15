/**
 * @fileoverview A document section's New as a menu (the PRD and PR/FAQ sections): "Blank" (an empty canvas, named
 * in place) or "With the wizard" (the guided flow). A WAI-ARIA menu button (components/ProfileMenu/useMenuButton):
 * Enter, Space or the arrows open it, arrows / Home / End move, Escape closes it with focus back on New. Each item
 * says what it does under its label (its description).
 *
 * @module pages/ProjectDetail/SectionNewMenu
 */
import { ChevronDown, Plus } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { useMenuButton } from '../../components/ProfileMenu/useMenuButton'
import type { LucideIcon } from 'lucide-react'

/** One way to start a document of the section. */
export interface SectionNewChoice {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly icon: LucideIcon
  readonly onSelect: () => void
}

interface SectionNewMenuProps {
  /** The button's name ("New PRD"); its text is "New". */
  readonly label: string
  readonly choices: readonly SectionNewChoice[]
  readonly disabled?: boolean
  readonly describedBy?: string
}

export default function SectionNewMenu({ label, choices, disabled, describedBy }: SectionNewMenuProps) {
  const { t } = useTranslation('projectDetail')
  const { open, buttonRef, menuRef, toggle, close, onButtonKeyDown, onMenuKeyDown } = useMenuButton()
  const menuId = useId()
  const triggerId = useId()
  return (
    <div className="relative ml-auto flex-shrink-0">
      <button ref={buttonRef} id={triggerId} type="button" className="btn btn-secondary btn-sm" aria-label={label}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        aria-describedby={describedBy} disabled={disabled} onClick={toggle} onKeyDown={onButtonKeyDown}>
        <Plus size={14} aria-hidden />{t('documents.sections.new')}<ChevronDown size={12} aria-hidden />
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} role="menu" aria-labelledby={triggerId} aria-orientation="vertical"
          onKeyDown={onMenuKeyDown} className="menu absolute right-0 top-full z-30 mt-1 w-64 max-w-[calc(100vw-2rem)]">
          {choices.map((choice) => <ChoiceItem key={choice.id} choice={choice} onDone={() => close(true)} />)}
        </div>
      ) : null}
    </div>
  )
}

function ChoiceItem({ choice, onDone }: Readonly<{ choice: SectionNewChoice; onDone: () => void }>) {
  const labelId = useId()
  const descriptionId = useId()
  const Icon = choice.icon
  return (
    // Named by its label alone; the line under it is its description.
    <button type="button" role="menuitem" aria-labelledby={labelId} aria-describedby={descriptionId}
      className="menu-item items-start py-2"
      onClick={() => {
        onDone()
        choice.onSelect()
      }}>
      <Icon size={16} className="mt-0.5 flex-shrink-0" aria-hidden />
      <span className="min-w-0">
        <span id={labelId} className="block font-medium">{choice.label}</span>
        <span id={descriptionId} className="block text-xs text-muted">{choice.description}</span>
      </span>
    </button>
  )
}

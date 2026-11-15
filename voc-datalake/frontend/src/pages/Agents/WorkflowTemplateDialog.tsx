/**
 * @fileoverview "Start from a template" in the workflow library: the six default engineering flows, each with its
 * description. Choosing one opens the editor on an unsaved copy (`WorkflowTemplatePage`); nothing is created until
 * the person saves it there.
 *
 * @module pages/Agents/WorkflowTemplateDialog
 */
import { useId } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import DialogClose from '../../components/DialogClose/DialogClose'
import ModalShell from '../../components/ModalShell/ModalShell'
import { ENGINEERING_TEMPLATES } from '../../api/engineeringTemplates'
import { workflowTemplatePath } from './workflowPaths'

export function WorkflowTemplateDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const { t } = useTranslation('agents')
  const titleId = useId()
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-lg max-h-[90vh]">
      <div className="dialog-header justify-between">
        <div className="min-w-0">
          <h2 id={titleId} className="dialog-title">{t('library.templatesTitle')}</h2>
          <p className="dialog-description">{t('library.templatesHint')}</p>
        </div>
        <DialogClose onClick={onClose} />
      </div>
      <div className="dialog-body overflow-y-auto">
        <ul className="space-y-2" aria-labelledby={titleId}>
          {ENGINEERING_TEMPLATES.map((template) => {
            const nameId = `${titleId}-${template.templateId}`
            const descriptionId = `${nameId}-description`
            return (
              <li key={template.templateId}>
                {/* Named by the flow's name, described by its one line (not one long name). */}
                <Link to={workflowTemplatePath(template.templateId)} aria-labelledby={nameId} aria-describedby={descriptionId}
                  className="card flex items-center gap-3 p-3 hover:bg-bg-hover focus-ring">
                  <span className="min-w-0 flex-1">
                    <span id={nameId} className="block text-sm font-medium text-text-strong">{t(template.nameKey)}</span>
                    <span id={descriptionId} className="block text-[12px] text-muted">{t(template.descriptionKey)}</span>
                  </span>
                  <ChevronRight size={16} className="text-muted shrink-0" aria-hidden="true" />
                </Link>
              </li>
            )
          })}
        </ul>
      </div>
      <div className="dialog-footer">
        <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
      </div>
    </ModalShell>
  )
}

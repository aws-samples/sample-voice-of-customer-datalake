/**
 * Template Wizard Component for creating new feedback forms
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, User } from 'lucide-react'
import type { FeedbackForm } from '../../api/types'
import clsx from 'clsx'
import { formTemplates } from './formTemplates'
import ModalShell from '../../components/ModalShell/ModalShell'
import DialogClose from '../../components/DialogClose/DialogClose'

interface TemplateWizardProps {
  readonly onSelect: (config: Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'>) => void
  readonly onCancel: () => void
}

export default function TemplateWizard({ onSelect, onCancel }: TemplateWizardProps) {
  const { t } = useTranslation('feedbackForms')
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null)
  const [collectPII, setCollectPII] = useState<'none' | 'name' | 'email' | 'both'>('none')
  // Generated rather than a module-level constant: a fixed id would collide if the
  // wizard were ever mounted twice, which silently mis-points aria-labelledby at
  // the first instance's heading.
  const titleId = useId()

  const handleContinue = () => {
    const template = formTemplates.find((tpl) => tpl.id === selectedTemplate)
    if (!template) return

    const config = {
      ...template.config,
      theme: { ...template.config.theme },
      custom_fields: [...template.config.custom_fields],
      collect_name: collectPII === 'name' || collectPII === 'both',
      collect_email: collectPII === 'email' || collectPII === 'both',
    }

    onSelect(config)
  }

  const piiOptions = [
    { id: 'none', label: t('wizard.anonymous'), desc: t('wizard.anonymousDesc') },
    { id: 'name', label: t('wizard.nameOnly'), desc: t('wizard.nameOnlyDesc') },
    { id: 'email', label: t('wizard.emailOnly'), desc: t('wizard.emailOnlyDesc') },
    { id: 'both', label: t('wizard.nameAndEmail'), desc: t('wizard.nameAndEmailDesc') },
  ] as const

  return (
    <ModalShell
      isOpen
      onClose={onCancel}
      ariaLabelledBy={titleId}
      panelClassName="max-w-3xl max-h-[90vh]"
    >
      <div className="dialog-header justify-between">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="dialog-title">{t('wizard.title')}</h2>
          <p className="dialog-description">{t('wizard.subtitle')}</p>
        </div>
        <DialogClose onClick={onCancel} className="flex-shrink-0" />
      </div>

      <div className="dialog-body">
        <div className="grid grid-cols-1 xs:grid-cols-2 md:grid-cols-3 gap-2 sm:gap-3 mb-6">
          {formTemplates.map((template) => {
            const Icon = template.icon
            const isSelected = selectedTemplate === template.id
            return (
              <button
                key={template.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setSelectedTemplate(template.id)}
                className={clsx(
                  'p-3 sm:p-4 rounded-lg border-2 text-left transition-all hover:shadow-md focus-ring',
                  isSelected ? 'border-accent bg-accent-subtle shadow-md' : 'border-border bg-bg-elevated hover:border-border-strong'
                )}
              >
                <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center mb-2 sm:mb-3 bg-accent-subtle">
                  <Icon size={18} className="text-accent-text sm:hidden" aria-hidden="true" />
                  <Icon size={20} className="text-accent-text hidden sm:block" aria-hidden="true" />
                </div>
                <h3 className="font-medium text-text-strong mb-1 text-sm sm:text-base">{template.name}</h3>
                <p className={clsx('text-xs line-clamp-2', isSelected ? 'text-text' : 'text-muted')}>{template.description}</p>
              </button>
            )
          })}
        </div>

        {selectedTemplate && (
          <div className="bg-bg-accent rounded-lg p-3 sm:p-4 border border-border">
            <h3 className="text-sm font-semibold tracking-tight text-text-strong mb-1 flex items-center gap-2">
              <User size={16} aria-hidden="true" />
              {t('wizard.contactInfoTitle')}
            </h3>
            <p className="text-xs sm:text-sm text-muted mb-3">{t('wizard.contactInfoDescription')}</p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              {piiOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={collectPII === option.id}
                  onClick={() => setCollectPII(option.id)}
                  className={clsx(
                    'p-2 sm:p-3 rounded-lg border-2 text-left transition-all focus-ring',
                    collectPII === option.id ? 'border-accent bg-accent-subtle' : 'border-border bg-bg-elevated hover:border-border-strong'
                  )}
                >
                  <p className="font-medium text-xs sm:text-sm text-text-strong">{option.label}</p>
                  <p className={clsx('text-xs hidden sm:block', collectPII === option.id ? 'text-text' : 'text-muted')}>{option.desc}</p>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="dialog-footer flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <p className="text-xs sm:text-sm text-muted text-center sm:text-left">
          {selectedTemplate
            ? t('wizard.selectedTemplate', { name: formTemplates.find((tpl) => tpl.id === selectedTemplate)?.name ?? '' })
            : t('wizard.selectPrompt')}
        </p>
        <div className="flex gap-2 sm:gap-3">
          <button onClick={onCancel} className="btn btn-secondary flex-1 sm:flex-none">{t('wizard.cancel')}</button>
          <button
            onClick={handleContinue}
            disabled={!selectedTemplate}
            className="btn btn-primary flex-1 sm:flex-none"
          >
            {t('wizard.continue')}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

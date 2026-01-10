/**
 * Template Wizard Component for creating new feedback forms
 */
import { useState } from 'react'
import { X, ArrowRight, User } from 'lucide-react'
import type { FeedbackForm } from '../../api/client'
import clsx from 'clsx'
import { formTemplates } from './formTemplates'

interface TemplateWizardProps {
  readonly onSelect: (config: Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'>) => void
  readonly onCancel: () => void
}

export default function TemplateWizard({ onSelect, onCancel }: TemplateWizardProps) {
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null)
  const [collectPII, setCollectPII] = useState<'none' | 'name' | 'email' | 'both'>('none')

  const handleContinue = () => {
    const template = formTemplates.find(t => t.id === selectedTemplate)
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
    { id: 'none', label: 'Anonymous', desc: 'No PII collected' },
    { id: 'name', label: 'Name Only', desc: 'Collect name' },
    { id: 'email', label: 'Email Only', desc: 'Collect email' },
    { id: 'both', label: 'Name & Email', desc: 'Full contact info' },
  ] as const

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-3 sm:p-4 border-b">
          <div className="min-w-0 flex-1">
            <h2 className="text-base sm:text-lg font-semibold">Create New Form</h2>
            <p className="text-xs sm:text-sm text-gray-500">Choose a template to get started</p>
          </div>
          <button onClick={onCancel} className="p-2 hover:bg-gray-100 rounded-lg flex-shrink-0 ml-2">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-3 sm:p-4">
          <div className="grid grid-cols-1 xs:grid-cols-2 md:grid-cols-3 gap-2 sm:gap-3 mb-6">
            {formTemplates.map((template) => {
              const Icon = template.icon
              const isSelected = selectedTemplate === template.id
              return (
                <button
                  key={template.id}
                  onClick={() => setSelectedTemplate(template.id)}
                  className={clsx(
                    'p-3 sm:p-4 rounded-xl border-2 text-left transition-all hover:shadow-md',
                    isSelected ? 'border-blue-500 bg-blue-50 shadow-md' : 'border-gray-200 hover:border-gray-300'
                  )}
                >
                  <div className={clsx('w-8 h-8 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center mb-2 sm:mb-3', template.color)}>
                    <Icon size={18} className="text-white sm:hidden" />
                    <Icon size={20} className="text-white hidden sm:block" />
                  </div>
                  <h3 className="font-medium text-gray-900 mb-1 text-sm sm:text-base">{template.name}</h3>
                  <p className="text-xs text-gray-500 line-clamp-2">{template.description}</p>
                </button>
              )
            })}
          </div>

          {selectedTemplate && (
            <div className="bg-gray-50 rounded-xl p-3 sm:p-4 border border-gray-200">
              <h4 className="font-medium text-gray-900 mb-2 sm:mb-3 flex items-center gap-2 text-sm sm:text-base">
                <User size={16} />
                Contact Information Collection
              </h4>
              <p className="text-xs sm:text-sm text-gray-600 mb-3 sm:mb-4">
                Choose what personal information to collect from respondents.
              </p>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                {piiOptions.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => setCollectPII(option.id)}
                    className={clsx(
                      'p-2 sm:p-3 rounded-lg border-2 text-left transition-all',
                      collectPII === option.id ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
                    )}
                  >
                    <p className="font-medium text-xs sm:text-sm text-gray-900">{option.label}</p>
                    <p className="text-xs text-gray-500 hidden sm:block">{option.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-3 sm:p-4 border-t bg-gray-50">
          <p className="text-xs sm:text-sm text-gray-500 text-center sm:text-left">
            {selectedTemplate ? `Selected: ${formTemplates.find(t => t.id === selectedTemplate)?.name}` : 'Select a template to continue'}
          </p>
          <div className="flex gap-2 sm:gap-3">
            <button onClick={onCancel} className="btn btn-secondary flex-1 sm:flex-none">Cancel</button>
            <button
              onClick={handleContinue}
              disabled={!selectedTemplate}
              className="btn btn-primary flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed flex-1 sm:flex-none"
            >
              Continue
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

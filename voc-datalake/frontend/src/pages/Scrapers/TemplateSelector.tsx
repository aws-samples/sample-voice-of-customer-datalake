/**
 * @fileoverview Template selector modal component.
 * @module pages/Scrapers/TemplateSelector
 */

import { useQuery } from '@tanstack/react-query'
import { Loader2, FileJson } from 'lucide-react'
import { api } from '../../api/client'
import type { ScraperTemplate } from '../../api/client'
import clsx from 'clsx'

interface TemplateSelectorProps {
  readonly onSelect: (template: ScraperTemplate) => void
  readonly onClose: () => void
}

export default function TemplateSelector({ onSelect, onClose }: TemplateSelectorProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['scraper-templates'],
    queryFn: api.getScraperTemplates,
  })

  const templates = data?.templates ?? []

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[95vh] sm:max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-3 sm:p-4 border-b flex items-center justify-between">
          <h3 className="font-semibold text-base sm:text-lg">Choose a Template</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-2xl">&times;</button>
        </div>

        <div className="p-3 sm:p-4 overflow-y-auto flex-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="animate-spin h-8 w-8 text-blue-500" />
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
              {templates.map(template => (
                <button
                  key={template.id}
                  onClick={() => onSelect(template)}
                  className={clsx(
                    'p-3 sm:p-4 border-2 rounded-lg text-left transition-all hover:border-blue-400 hover:bg-blue-50',
                    template.extraction_method === 'jsonld' ? 'border-green-200 bg-green-50/30' : 'border-gray-200'
                  )}
                >
                  <div className="flex items-center gap-2 sm:gap-3 mb-2">
                    <span className="text-xl sm:text-2xl">{template.icon}</span>
                    <div>
                      <div className="font-medium text-sm sm:text-base">{template.name}</div>
                      {template.extraction_method === 'jsonld' && (
                        <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-1.5 py-0.5 rounded">
                          <FileJson size={10} /> JSON-LD
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-xs sm:text-sm text-gray-600">{template.description}</p>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="p-3 sm:p-4 border-t">
          <button onClick={onClose} className="btn btn-secondary w-full text-sm">Cancel</button>
        </div>
      </div>
    </div>
  )
}

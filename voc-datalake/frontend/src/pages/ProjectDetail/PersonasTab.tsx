/**
 * PersonasTab - Personas list and detail view
 */
import { Users, Sparkles, Upload } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import type { ProjectPersona } from '../../api/client'
import PersonaAvatar from './PersonaAvatar'
import PersonaDetailView from './PersonaDetailView'
import type { NoteItem } from './types'

interface PersonasTabProps {
  readonly personas: ProjectPersona[]
  readonly selectedPersona: ProjectPersona | null
  readonly onSelectPersona: (persona: ProjectPersona) => void
  readonly onEditPersona: () => void
  readonly onDeletePersona: () => void
  readonly onSaveNotes: (notes: NoteItem[]) => void
  readonly onGeneratePersonas: () => void
  readonly onImportPersona: () => void
  readonly isDeleting: boolean
  readonly isSavingNotes: boolean
}

export default function PersonasTab({
  personas,
  selectedPersona,
  onSelectPersona,
  onEditPersona,
  onDeletePersona,
  onSaveNotes,
  onGeneratePersonas,
  onImportPersona,
  isDeleting,
  isSavingNotes,
}: PersonasTabProps) {
  const { t } = useTranslation('projectDetail')

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-end gap-2">
        <button 
          onClick={onImportPersona} 
          className="flex items-center justify-center gap-2 px-4 py-2 border border-purple-300 text-purple-600 rounded-lg hover:bg-purple-50 text-sm"
        >
          <Upload size={16} />{t('personas.importPersona')}
        </button>
        <button 
          onClick={onGeneratePersonas} 
          className="flex items-center justify-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm"
        >
          <Sparkles size={16} />{t('personas.generatePersonas')}
        </button>
      </div>
      
      {personas.length === 0 ? (
        <EmptyPersonasState onGenerate={onGeneratePersonas} />
      ) : (
        <div className="flex flex-col lg:grid lg:grid-cols-3 gap-4 lg:gap-6">
          {/* Persona List */}
          <div className="flex lg:flex-col gap-3 overflow-x-auto lg:overflow-x-visible pb-2 lg:pb-0 -mx-4 px-4 lg:mx-0 lg:px-0">
            {personas.map((p) => (
              <button 
                key={p.persona_id} 
                onClick={() => onSelectPersona(p)}
                className={clsx(
                  'flex-shrink-0 w-48 lg:w-full text-left p-3 lg:p-4 rounded-lg border transition-colors', 
                  selectedPersona?.persona_id === p.persona_id 
                    ? 'bg-purple-50 border-purple-300' 
                    : 'bg-white hover:border-purple-200'
                )}
              >
                <div className="flex items-center gap-3">
                  <PersonaAvatar persona={p} size="sm" />
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium truncate text-sm lg:text-base">@{p.name}</h4>
                    <p className="text-xs text-gray-500 truncate">{p.tagline}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
          
          {/* Persona Detail */}
          <div className="lg:col-span-2 bg-white rounded-xl border overflow-hidden">
            {selectedPersona ? (
              <PersonaDetailView
                persona={selectedPersona}
                onEdit={onEditPersona}
                onDelete={onDeletePersona}
                onSaveNotes={onSaveNotes}
                isDeleting={isDeleting}
                isSavingNotes={isSavingNotes}
              />
            ) : (
              <div className="flex items-center justify-center h-full min-h-[500px] text-gray-400">
                {t('personas.selectToView')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyPersonasState({ onGenerate }: { readonly onGenerate: () => void }) {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="text-center py-12 bg-white rounded-xl border">
      <Users size={48} className="mx-auto text-gray-300 mb-4" />
      <h3 className="text-lg font-medium mb-2">{t('personas.noPersonasYet')}</h3>
      <p className="text-gray-500 mb-4">{t('personas.generateFromFeedback')}</p>
      <button onClick={onGenerate} className="px-4 py-2 bg-purple-600 text-white rounded-lg">
        <Sparkles size={16} className="inline mr-2" />{t('overview.generate')}
      </button>
    </div>
  )
}

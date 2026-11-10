/**
 * The persona writes behind the shared persona UI (edit, delete, import, research
 * notes), for a project or the company library (`PersonaScope`). Moved out of
 * useProjectData when the company library started using them (5.60).
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { personaScopeApi, personaScopeJobsKey, personaScopeKey } from './personaScope'
import type { PersonaScope } from './personaScope'
import type { NoteItem } from './types'
import type { PersonaImportBody } from '../../api/companyPersonasApi'
import type { ProjectPersona } from '../../api/projectTypes'

interface UsePersonaMutationsProps {
  scope: PersonaScope
  selectedPersona: ProjectPersona | null
  editingPersona: ProjectPersona | null
  setEditingPersona: (p: ProjectPersona | null) => void
  setSelectedPersona: (p: ProjectPersona | null) => void
}

export function usePersonaMutations({
  scope,
  selectedPersona,
  editingPersona,
  setEditingPersona,
  setSelectedPersona,
}: UsePersonaMutationsProps) {
  const queryClient = useQueryClient()
  const api = personaScopeApi(scope)
  const refreshPersonas = () => void queryClient.invalidateQueries({ queryKey: personaScopeKey(scope) })

  const updatePersonaMut = useMutation({
    mutationFn: (data: {
      personaId: string;
      updates: Partial<ProjectPersona>
    }) =>
      api.updatePersona(data.personaId, data.updates),
    onSuccess: (_data, variables) => {
      refreshPersonas()
      if (editingPersona?.persona_id === variables.personaId) {
        setEditingPersona(null)
        setSelectedPersona(null)
      }
    },
  })

  const deletePersonaMut = useMutation({
    mutationFn: (personaId: string) => api.deletePersona(personaId),
    onSuccess: () => {
      refreshPersonas()
      setSelectedPersona(null)
    },
  })

  const importPersonaMut = useMutation({
    mutationFn: (data: PersonaImportBody) => api.importPersona(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: personaScopeJobsKey(scope) })
    },
  })

  // Save research notes
  const saveNotes = (notes: NoteItem[]): void => {
    if (!selectedPersona) return
    updatePersonaMut.mutate({
      personaId: selectedPersona.persona_id,
      updates: { research_notes: notes },
    })
  }

  // Save the edit modal's persona; the promise lets the editor's unsaved-changes guard wait (E2E F6).
  const saveEditingPersona = async (): Promise<void> => {
    if (editingPersona) await updatePersonaMut.mutateAsync({ personaId: editingPersona.persona_id, updates: editingPersona })
  }

  return {
    updatePersonaMut,
    deletePersonaMut,
    importPersonaMut,
    saveNotes,
    saveEditingPersona,
  }
}

/**
 * Zustand store for project-scoped chat messages.
 * Persists messages per project so they survive tab switches.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface ProjectChatMessage {
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  attachments?: Array<{
    name: string;
    media_type: string;
    data: string
  }>
  documentChanges?: Array<{
    document_id: string;
    title: string;
    action: 'updated' | 'created';
    summary: string
  }>
  activePersona?: {
    name: string;
    avatar_url?: string
  }
}

interface ProjectChatState {
  /** Map of projectId → messages */
  messagesByProject: Record<string, ProjectChatMessage[]>

  getMessages: (projectId: string) => ProjectChatMessage[]
  setMessages: (projectId: string, messages: ProjectChatMessage[]) => void
  addMessage: (projectId: string, message: ProjectChatMessage) => void
  addMessages: (projectId: string, messages: ProjectChatMessage[]) => void
  clearMessages: (projectId: string) => void
}

export const useProjectChatStore = create<ProjectChatState>()(
  persist(
    (set, get) => ({
      messagesByProject: {},

      getMessages: (projectId) => get().messagesByProject[projectId] ?? [],

      setMessages: (projectId, messages) =>
        set((state) => ({
          messagesByProject: {
            ...state.messagesByProject,
            [projectId]: messages,
          },
        })),

      addMessage: (projectId, message) =>
        set((state) => ({
          messagesByProject: {
            ...state.messagesByProject,
            [projectId]: [...(state.messagesByProject[projectId] ?? []), message],
          },
        })),

      addMessages: (projectId, messages) =>
        set((state) => ({
          messagesByProject: {
            ...state.messagesByProject,
            [projectId]: [...(state.messagesByProject[projectId] ?? []), ...messages],
          },
        })),

      clearMessages: (projectId) =>
        set((state) => ({
          messagesByProject: {
            ...state.messagesByProject,
            [projectId]: [],
          },
        })),
    }),
    {
      name: 'voc-project-chat',
      // Don't persist attachment data (base64) — too large for localStorage
      partialize: (state) => ({
        messagesByProject: Object.fromEntries(
          Object.entries(state.messagesByProject).map(([pid, msgs]) => [
            pid,
            msgs.map(({
              role, content, thinking, documentChanges, activePersona,
            }) => ({
              role,
              content,
              thinking,
              documentChanges,
              activePersona,
            })),
          ]),
        ),
      }),
    },
  ),
)

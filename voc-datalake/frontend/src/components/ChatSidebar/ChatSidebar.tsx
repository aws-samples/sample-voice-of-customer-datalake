/**
 * @fileoverview Chat conversation sidebar component.
 *
 * Features:
 * - List of saved conversations
 * - Create new conversation
 * - Rename and delete conversations
 * - Clear all conversations
 * - Mobile-responsive with overlay support
 *
 * @module components/ChatSidebar
 */

import clsx from 'clsx'
import {
  format, isValid,
} from 'date-fns'
import {
  Plus, MessageSquare, Trash2, Edit2, Check, X, History,
} from 'lucide-react'
import {
  useState, useRef, useEffect,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chatStore'

const formatDate = (date: Date) => {
  const d = new Date(date)
  if (!isValid(d)) return ''
  return format(d, 'MMM d, h:mm a')
}

interface ChatSidebarProps { onClose?: () => void }

export default function ChatSidebar({ onClose }: Readonly<ChatSidebarProps>) {
  const { t } = useTranslation('chat')
  const {
    conversations,
    activeConversationId,
    createConversation,
    deleteConversation,
    setActiveConversation,
    updateConversationTitle,
    clearAllConversations,
  } = useChatStore()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId != null && editingId !== '' && editInputRef.current) {
      editInputRef.current.focus()
    }
  }, [editingId])

  const handleNewChat = () => {
    createConversation()
    onClose?.()
  }

  const handleEdit = (id: string, currentTitle: string) => {
    setEditingId(id)
    setEditTitle(currentTitle)
  }

  const handleSaveEdit = (id: string) => {
    if (editTitle.trim() !== '') {
      updateConversationTitle(id, editTitle.trim())
    }
    setEditingId(null)
    setEditTitle('')
  }

  const handleCancelEdit = () => {
    setEditingId(null)
    setEditTitle('')
  }

  const handleSelectConversation = (id: string) => {
    setActiveConversation(id)
    onClose?.()
  }

  return (
    <div className="w-full sm:w-64 md:w-56 h-full flex-shrink-0 bg-gray-50 border-r border-gray-100 flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-gray-200">
        <button
          onClick={handleNewChat}
          className="w-full btn btn-primary flex items-center justify-center gap-2 py-2.5 sm:py-2"
        >
          <Plus size={18} />
          {t('sidebar.newChat')}
        </button>
      </div>

      {/* Conversation List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {conversations.length === 0 ? (
          <div className="text-center py-8 text-gray-400">
            <History size={32} className="mx-auto mb-2 opacity-50" />
            <p className="text-sm">{t('sidebar.noConversations')}</p>
          </div>
        ) : (
          conversations.map((conv) => (
            <div
              key={conv.id}
              data-testid={`conversation-item-${conv.id}`}
              className={clsx(
                'group rounded-lg p-2.5 sm:p-2 transition-colors w-full',
                activeConversationId === conv.id
                  ? 'bg-blue-100 border border-blue-200'
                  : 'hover:bg-gray-100 active:bg-gray-100',
              )}
            >
              {editingId === conv.id ? (
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="flex-1 min-w-0 text-sm px-2 py-1.5 sm:py-1 border rounded"
                    ref={editInputRef}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveEdit(conv.id)
                      if (e.key === 'Escape') handleCancelEdit()
                    }}
                  />
                  <button
                    onClick={() => handleSaveEdit(conv.id)}
                    className="p-1.5 sm:p-1 text-green-600 hover:bg-green-100 rounded flex-shrink-0"
                  >
                    <Check size={14} />
                  </button>
                  <button
                    onClick={() => handleCancelEdit()}
                    className="p-1.5 sm:p-1 text-gray-500 hover:bg-gray-200 rounded flex-shrink-0"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="w-full text-left cursor-pointer bg-transparent border-none p-0"
                    onClick={() => handleSelectConversation(conv.id)}
                  >
                    <div className="flex items-start gap-2">
                      <MessageSquare size={16} className="text-gray-400 mt-0.5 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">
                          {conv.title}
                        </p>
                        <p className="text-xs text-gray-400 truncate">
                          {t('sidebar.messagesCount', { count: conv.messages.length })} • {formatDate(conv.updatedAt)}
                        </p>
                      </div>
                    </div>
                  </button>
                  {/* Actions - always visible to avoid layout shift on hover */}
                  <div className="flex items-center gap-1 mt-2 sm:mt-1 justify-end">
                    <button
                      onClick={() => handleEdit(conv.id, conv.title)}
                      className="p-2 sm:p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-200 rounded"
                    >
                      <Edit2 size={16} className="sm:hidden" />
                      <Edit2 size={12} className="hidden sm:block" />
                    </button>
                    <button
                      onClick={() => deleteConversation(conv.id)}
                      className="p-2 sm:p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
                    >
                      <Trash2 size={16} className="sm:hidden" />
                      <Trash2 size={12} className="hidden sm:block" />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      {conversations.length > 0 && (
        <div className="p-3 sm:p-2 border-t border-gray-200">
          <button
            onClick={clearAllConversations}
            className="w-full text-xs text-gray-400 hover:text-red-500 py-2 sm:py-1"
          >
            {t('sidebar.clearAll')}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * @fileoverview `/chat` — the unified assistant as a full page.
 *
 * Fills the whole content area: the conversation sidebar on the left (open
 * conversations, which can run side by side, plus the saved history) and the
 * chat on the right. Same assistant and same in-memory conversations as the
 * floating panel (which hides itself on this route), so a conversation started
 * in the bubble continues here and vice versa.
 *
 * The page's <h1> is visually hidden — the panel header already shows the
 * title — so the page still has the one level-one heading every route has
 * (axe page-has-heading-one, design audit D-STRUCT).
 *
 * @module pages/Chat
 */
import { useTranslation } from 'react-i18next'
import AssistantPanel from '../../assistant/components/AssistantPanel'

export default function Chat() {
  const { t } = useTranslation('common')
  return (
    <div className="flex h-full min-h-0 flex-col">
      <h1 className="sr-only">{t('nav.aiChat')}</h1>
      <AssistantPanel variant="page" />
    </div>
  )
}

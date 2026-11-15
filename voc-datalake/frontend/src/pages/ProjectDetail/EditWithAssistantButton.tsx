/**
 * **Edit with the assistant** in a prototype preview's header (docs/prototype-builder.md, part 2), for
 * editors only (the caller renders it for them). It opens this app's one assistant panel on a new
 * conversation with a starter prefilled and nothing sent; the open prototype is in the panel's context
 * (the page context's `documentId`, the chip "Editing: <title>"), so the assistant can propose a draft
 * revision through its approval card. The draft then shows in this pane's draft banner.
 *
 * @module pages/ProjectDetail/EditWithAssistantButton
 */
import { Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { openAssistant } from '../../assistant/store/openAssistant'

export default function EditWithAssistantButton() {
  const { t } = useTranslation('projectDetail')
  return (
    <button type="button" className="btn btn-secondary btn-sm"
      onClick={() => { openAssistant({ prompt: t('documents.prototype.assistant.prompt') }) }}>
      <Sparkles size={12} aria-hidden /> {t('documents.prototype.assistant.button')}
    </button>
  )
}

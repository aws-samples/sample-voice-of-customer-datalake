/**
 * @fileoverview Feedback detail page showing single feedback item.
 *
 * Features:
 * - Full feedback details with metadata
 * - Similar feedback items tab
 *
 * The content is `FeedbackDetailContent`, which the review modal (components/ReviewModal)
 * renders too; the page adds the Back control. Back returns where the reader came from when
 * they arrived inside the app (history back), else it opens Categories (a shared or typed
 * link has no in-app page to go back to).
 *
 * @module pages/FeedbackDetail
 */

import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import FeedbackDetailContent from './FeedbackDetailContent'

const BACK_CLASS = 'btn btn-ghost btn-sm -ml-2 self-start'

/** React Router's key of the entry the app was opened on; any other key means an in-app navigation. */
const FIRST_ENTRY_KEY = 'default'

function BackControl() {
  const { t } = useTranslation('feedbackDetail')
  const navigate = useNavigate()
  const location = useLocation()
  if (location.key === FIRST_ENTRY_KEY) {
    return (
      <Link to="/categories" className={BACK_CLASS}>
        <ArrowLeft size={16} aria-hidden="true" />
        {t('backToFeedback')}
      </Link>
    )
  }
  return (
    <button type="button" onClick={() => { void navigate(-1) }} className={BACK_CLASS}>
      <ArrowLeft size={16} aria-hidden="true" />
      {t('back')}
    </button>
  )
}

export default function FeedbackDetail() {
  const { id } = useParams<{ id: string }>()
  return (
    <div className="max-w-4xl mx-auto space-y-4 sm:space-y-6 flex flex-col">
      <FeedbackDetailContent key={id} id={id ?? ''} variant="page" back={<BackControl />} />
    </div>
  )
}

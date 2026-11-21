/**
 * @fileoverview The In-app micro-feedback template (7.66.00, docs/micro-feedback.md): feedback about THIS app, from the
 * thumbs it shows after its key actions (components/MicroFeedback). An administrator picks a form made from it on
 * Administration → General → In-app feedback; the control answers it on its public submit route.
 *
 * Its shape is what the control sends and what the server checks a chosen form for (lambda/shared/app_feedback.py
 * `form_problems`): `q_verdict` a single choice `up` | `down`, never a rating, so it moves no average; `q_missing` an
 * open text; the hidden fields `action`, `page`, `app_version` and `workspace_role` (ids only, never who answered);
 * and the tag `voc_app`, which keeps its responses out of the dashboards (tenet 1: they are about the tool, not about
 * the customer's product). Its ids are stable (`version` 1).
 * @module pages/FeedbackForms/templates/appTemplates
 */
import { ThumbsUp } from 'lucide-react'
import type { TemplateFlow } from './templateKit'
import { openText, single } from './templateKit'

const microFeedback: TemplateFlow = {
  id: 'app_micro_feedback', version: 1, group: 'app', icon: ThumbsUp, runs: ['in_app'], welcome: false,
  hidden: [{ id: 'action', labelled: true }, { id: 'page', labelled: true }, { id: 'app_version', labelled: true },
    { id: 'workspace_role', labelled: true }],
  questions: [
    single('q_verdict', ['up', 'down'], { display: 'chips' }),
    openText('q_missing', { required: false, max: 500 }),
  ],
  endings: ['end_thanks'],
  tags: ['voc_app'],
}

export const APP_TEMPLATES: readonly TemplateFlow[] = [microFeedback]

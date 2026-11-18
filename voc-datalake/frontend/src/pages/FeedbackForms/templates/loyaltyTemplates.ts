/**
 * @fileoverview The Loyalty templates (UX §2.4 1–3): NPS, support satisfaction (CSAT) and customer effort (CES).
 * @module pages/FeedbackForms/templates/loyaltyTemplates
 */
import { Gauge, SlidersHorizontal, Smile } from 'lucide-react'
import type { TemplateFlow } from './templateKit'
import { consent, contact, multi, openText, otherwise, score, single, jumpWhen } from './templateKit'

const nps: TemplateFlow = {
  id: 'nps', group: 'loyalty', icon: Gauge, runs: ['in_app', 'link', 'embed'], welcome: false,
  hidden: [{ id: 'user_id' }, { id: 'plan' }],
  questions: [
    score('nps', 'q_nps', [jumpWhen('lte', 6, 'q_detractor_reason'), jumpWhen('gte', 9, 'q_promoter_value')]),
    openText('q_passive_improve', { required: false, logic: otherwise('q_follow_up_ok', true) }),
    single('q_detractor_reason', ['price', 'missing_features', 'hard_to_use', 'reliability', 'support'], { display: 'list', shuffle: 'all', other: true }),
    openText('q_detractor_fix', { required: false, logic: otherwise('q_follow_up_ok', true) }),
    multi('q_promoter_value', ['ease', 'features', 'reliability', 'support', 'value'], { display: 'list', max: 2, other: true }),
    consent('q_follow_up_ok', [jumpWhen('equals', false, 'end_thanks')]),
    contact('q_contact', ['name', 'email'], ['email'], otherwise('end_contact')),
  ],
  endings: ['end_thanks', 'end_contact'],
}

const csatSupport: TemplateFlow = {
  id: 'csat_support', group: 'loyalty', icon: Smile, runs: ['link', 'embed', 'in_app'], welcome: false,
  hidden: [{ id: 'ticket_id' }, { id: 'channel' }],
  questions: [
    score('csat', 'q_csat', [jumpWhen('gte', 4, 'q_resolved')]),
    multi('q_what_wrong', ['slow', 'not_solved', 'unclear', 'passed_around', 'tone'], { display: 'list', other: true }),
    single('q_resolved', ['yes', 'partly', 'no'], { display: 'chips' }),
    openText('q_comment', { required: false }),
  ],
  endings: ['end_thanks'],
}

const ces: TemplateFlow = {
  id: 'ces', group: 'loyalty', icon: SlidersHorizontal, runs: ['in_app', 'link'], welcome: false,
  hidden: [{ id: 'task' }, { id: 'screen' }],
  questions: [
    score('ces', 'q_ces', [jumpWhen('gte', 5, 'q_easier')]),
    single('q_obstacle', ['start', 'steps', 'labels', 'errors', 'slow'], { display: 'list', other: true }),
    openText('q_easier', { required: false }),
  ],
  endings: ['end_thanks'],
}

export const LOYALTY_TEMPLATES: readonly TemplateFlow[] = [nps, csatSupport, ces]

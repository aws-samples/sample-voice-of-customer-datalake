/**
 * @fileoverview The Events template (7.63.00): feedback after a workshop or an event. Its question ids are stable (its
 * `version` 1), so every form made from it can be compared with the others (Results → Report → Compare); the customer,
 * the event, its date and the presenter come in the link as hidden fields, and the welcome recalls the event.
 * @module pages/FeedbackForms/templates/eventTemplates
 */
import { Presentation } from 'lucide-react'
import type { TemplateFlow } from './templateKit'
import { matrix, multi, openText, rating, ratingWithWhy, score, single } from './templateKit'

const workshop: TemplateFlow = {
  id: 'workshop', version: 1, group: 'events', icon: Presentation, runs: ['link', 'embed'], welcome: true,
  hidden: [{ id: 'customer', labelled: true }, { id: 'event', labelled: true }, { id: 'event_date', labelled: true },
    { id: 'presenter', labelled: true }],
  questions: [
    single('q_role', ['product', 'engineering', 'qa', 'scrum_master', 'design', 'ops', 'leadership'], { display: 'list', other: true }),
    single('q_familiarity', ['not', 'somewhat', 'very'], { display: 'chips' }),
    rating('q_value', 'star', 5),
    matrix('q_phases', ['introduction', 'demo', 'hands_on', 'wrap_up'],
      [['needs_improvement', 1], ['satisfactory', 2], ['very_effective', 3], ['exceptional', 4]]),
    ...ratingWithWhy('q_tooling', 'q_content'),
    ...ratingWithWhy('q_content', 'q_presenter'),
    ...ratingWithWhy('q_presenter', 'q_nps'),
    score('nps', 'q_nps'),
    openText('q_nps_reason', { required: false }),
    single('q_apply', ['definitely', 'probably', 'not_sure', 'unlikely'], { display: 'list' }),
    multi('q_barriers', ['time', 'tool_access', 'skills', 'team_buy_in', 'security'], { display: 'list', other: true, none: true, required: false }),
    openText('q_takeaway', { required: false }),
    openText('q_improve', { required: false }),
  ],
  endings: ['end_thanks'],
}

export const EVENT_TEMPLATES: readonly TemplateFlow[] = [workshop]

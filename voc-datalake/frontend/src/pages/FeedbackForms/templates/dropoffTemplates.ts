/**
 * @fileoverview The Drop-offs templates (UX §2.4 4–6): cancellation / churn, switching back to the old interface
 * (a customer pilot's case), and checkout or signup abandonment.
 * @module pages/FeedbackForms/templates/dropoffTemplates
 */
import { History, LogOut, ShoppingCart } from 'lucide-react'
import type { TemplateFlow } from './templateKit'
import { multi, openText, otherwise, single, jumpWhen, followUp } from './templateKit'

const churn: TemplateFlow = {
  id: 'churn', group: 'dropoffs', icon: LogOut, runs: ['in_app', 'link'], welcome: false,
  hidden: [{ id: 'user_id' }, { id: 'plan' }],
  questions: [
    single('q_reason', ['too_expensive', 'missing_features', 'hard_to_use', 'switching_product', 'not_needed', 'technical_issues'], {
      // (7 rows would make Auto a dropdown; reasons read better in full)
      display: 'list', shuffle: 'all', other: true,
      logic: [
        jumpWhen('equals', 'too_expensive', 'q_price'), jumpWhen('equals', 'missing_features', 'q_missing_feature'),
        jumpWhen('equals', 'hard_to_use', 'q_hard_part'), jumpWhen('equals', 'switching_product', 'q_competitor'),
        jumpWhen('equals', 'technical_issues', 'q_technical'), ...otherwise('q_follow_up_ok'),
      ],
    }),
    single('q_price', ['lower_price', 'smaller_plan', 'annual_discount', 'pause'], { display: 'list', other: true, logic: otherwise('q_follow_up_ok') }),
    openText('q_missing_feature', { long: false, max: 200, logic: otherwise('q_follow_up_ok') }),
    openText('q_hard_part', { logic: otherwise('q_follow_up_ok') }),
    openText('q_competitor', { long: false, required: false, logic: otherwise('q_follow_up_ok', true) }),
    openText('q_technical'),
    ...followUp('end_bye'),
  ],
  endings: ['end_bye', 'end_contact'],
}

const oldUi: TemplateFlow = {
  id: 'old_ui', group: 'dropoffs', icon: History, runs: ['in_app', 'link'], welcome: false,
  hidden: [{ id: 'user_id', labelled: true }, { id: 'app_version', labelled: true }, { id: 'screen', labelled: true }],
  questions: [
    multi('q_why', ['cant_find', 'slower_work', 'missing_function', 'errors', 'slow_loading', 'layout', 'prefer_known'], {
      display: 'list', shuffle: 'all', min: 1, max: 3, other: true,
      logic: [jumpWhen('includes_any', ['missing_function'], 'q_missing_function'), ...otherwise('q_task')],
    }),
    openText('q_missing_function', { long: false, max: 300 }),
    openText('q_task', { long: false, required: false }),
    single('q_return', ['yes_soon', 'when_fixed', 'not_sure', 'no'], { display: 'list' }),
    openText('q_comment', { required: false }),
  ],
  endings: ['end_thanks'],
}

const abandonment: TemplateFlow = {
  id: 'abandonment', group: 'dropoffs', icon: ShoppingCart, runs: ['embed', 'link', 'in_app'], welcome: false,
  hidden: [{ id: 'step' }, { id: 'plan' }],
  questions: [
    single('q_stopped', ['price', 'payment', 'account', 'too_long', 'trust', 'technical', 'just_looking'], {
      display: 'list', shuffle: 'except_last', other: true,
      logic: [jumpWhen('equals', 'payment', 'q_payment'), jumpWhen('equals', 'technical', 'q_technical'), ...otherwise('q_come_back')],
    }),
    single('q_payment', ['card', 'bank_transfer', 'paypal', 'wallet', 'invoice'], { display: 'list', other: true, logic: otherwise('q_come_back') }),
    openText('q_technical'),
    single('q_come_back', ['yes', 'maybe', 'no'], { display: 'chips' }),
  ],
  endings: ['end_thanks'],
}

export const DROPOFF_TEMPLATES: readonly TemplateFlow[] = [churn, oldUi, abandonment]

/**
 * @fileoverview The Product templates (UX §2.4 7–10), Onboarding (11) and Blank (12).
 * @module pages/FeedbackForms/templates/productTemplates
 */
import { Bug, FileText, Lightbulb, Rocket, Star, Target } from 'lucide-react'
import type { TemplateFlow } from './templateKit'
import { multi, openText, otherwise, rating, single, jumpWhen, followUp } from './templateKit'

const pmf: TemplateFlow = {
  id: 'pmf', group: 'product', icon: Target, runs: ['in_app', 'link'], welcome: false,
  hidden: [{ id: 'user_id' }, { id: 'plan' }],
  questions: [
    single('q_disappointment', ['very', 'somewhat', 'not'], { display: 'list', logic: [jumpWhen('equals', 'not', 'q_improve')] }),
    openText('q_main_benefit'),
    openText('q_ideal_user', { long: false, required: false }),
    openText('q_improve', { required: false }),
    single('q_role', ['manager', 'specialist', 'executive', 'it', 'consultant'], { required: false, other: true }),
  ],
  endings: ['end_thanks'],
}

const featureRequest: TemplateFlow = {
  id: 'feature_request', group: 'product', icon: Lightbulb, runs: ['embed', 'in_app', 'link'], welcome: false,
  hidden: [{ id: 'user_id' }, { id: 'screen' }, { id: 'app_version' }],
  questions: [
    single('q_kind', ['idea', 'problem', 'praise', 'question'], {
      display: 'chips',
      logic: [jumpWhen('equals', 'problem', 'q_problem'), jumpWhen('equals', 'praise', 'q_praise'), jumpWhen('equals', 'question', 'q_question')],
    }),
    openText('q_idea'),
    single('q_idea_importance', ['nice', 'important', 'blocking'], { display: 'list', logic: otherwise('q_follow_up_ok') }),
    openText('q_problem', { logic: otherwise('q_follow_up_ok') }),
    openText('q_praise', { logic: otherwise('q_follow_up_ok') }),
    openText('q_question'),
    ...followUp('end_thanks'),
  ],
  endings: ['end_thanks', 'end_contact'],
}

const featureSatisfaction: TemplateFlow = {
  id: 'feature_satisfaction', group: 'product', icon: Star, runs: ['in_app'], welcome: false,
  hidden: [{ id: 'feature' }, { id: 'app_version' }],
  questions: [
    rating('q_rating', 'star', 5, [jumpWhen('gte', 4, 'q_frequency')]),
    multi('q_better', ['faster', 'clearer', 'more_options', 'fewer_steps', 'fix'], { display: 'list', other: true }),
    single('q_frequency', ['daily', 'weekly', 'monthly', 'rarely', 'first_time'], { display: 'list' }),
    openText('q_comment', { required: false }),
  ],
  endings: ['end_thanks'],
}

const bugReport: TemplateFlow = {
  id: 'bug_report', group: 'product', icon: Bug, runs: ['embed', 'in_app', 'link'], welcome: false,
  hidden: [{ id: 'user_id' }, { id: 'app_version' }, { id: 'screen' }],
  questions: [
    openText('q_what_happened'),
    openText('q_steps', { required: false }),
    openText('q_expected', { required: false }),
    single('q_frequency', ['every_time', 'sometimes', 'once'], { display: 'chips' }),
    single('q_impact', ['blocked', 'workaround', 'minor'], { display: 'list' }),
    ...followUp('end_thanks', ['email']),
  ],
  endings: ['end_thanks', 'end_contact'],
}

const onboarding: TemplateFlow = {
  id: 'onboarding', group: 'onboarding', icon: Rocket, runs: ['in_app', 'embed'], welcome: true,
  hidden: [{ id: 'user_id' }, { id: 'plan' }, { id: 'signup_source' }],
  questions: [
    single('q_role', ['management', 'finance', 'sales', 'operations', 'it'], { other: true }),
    // (an ordered list, best picked from a menu)
    single('q_company_size', ['size_1', 'size_2_10', 'size_11_50', 'size_51_250', 'size_251_1000', 'size_1000_plus'], { display: 'dropdown' }),
    multi('q_first_goal', ['import', 'invite', 'reports', 'connect', 'explore'], { display: 'list', max: 2, none: true }),
    single('q_experience', ['daily', 'some', 'no'], { display: 'chips', logic: [jumpWhen('equals', 'no', 'end_newcomer')] }),
  ],
  endings: ['end_thanks', 'end_newcomer'],
}

const blank: TemplateFlow = {
  id: 'blank', group: 'blank', icon: FileText, runs: ['link', 'embed', 'in_app'], welcome: false,
  hidden: [],
  questions: [openText('q_feedback')],
  endings: ['end_thanks'],
}

export const PRODUCT_TEMPLATES: readonly TemplateFlow[] = [pmf, featureRequest, featureSatisfaction, bugReport]
export const ONBOARDING_TEMPLATES: readonly TemplateFlow[] = [onboarding]
export const BLANK_TEMPLATES: readonly TemplateFlow[] = [blank]

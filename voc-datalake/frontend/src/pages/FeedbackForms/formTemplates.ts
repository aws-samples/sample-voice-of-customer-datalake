/**
 * Form templates for common CX research types
 */
import { Gauge, Star, MessageSquare, ClipboardList, ThumbsUp, FileText } from 'lucide-react'
import type { FeedbackForm } from '../../api/types'
import { KIRO_LIGHT_HEX } from '../../theme/printPalette'

export type FormTemplate = {
  id: string
  name: string
  description: string
  icon: React.ElementType
  config: Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'>
}

type TemplateConfig = FormTemplate['config']

/** The per-template copy: everything a template says that its siblings do not. */
type TemplateCopy = Omit<
  TemplateConfig,
  'theme' | 'collect_email' | 'collect_name' | 'custom_fields' | 'category' | 'subcategory'
>

/**
 * Assemble a template config from its copy plus the two theme values that vary
 * (accent colour and corner radius). Every other field is identical across the
 * built-in templates. Returns a fresh object each call so no two templates share
 * a `custom_fields` array.
 */
function templateConfig(copy: TemplateCopy, primaryColor: string, borderRadius: string): TemplateConfig {
  return {
    ...copy,
    // Kiro Light palette (E2E F6). Each primary keeps a white label at AA
    // (≥ 4.5:1); the customer can still set any colour in the editor.
    theme: { primary_color: primaryColor, background_color: KIRO_LIGHT_HEX.bg, text_color: KIRO_LIGHT_HEX.textStrong, border_radius: borderRadius },
    collect_email: false,
    collect_name: false,
    custom_fields: [],
    category: '',
    subcategory: '',
  }
}

export const formTemplates: FormTemplate[] = [
  {
    id: 'nps',
    name: 'NPS Survey',
    description: 'Net Promoter Score - measure customer loyalty with the classic 0-10 scale',
    icon: Gauge,
    config: templateConfig({
      name: 'NPS Survey',
      enabled: false,
      title: 'How likely are you to recommend us?',
      description: 'On a scale of 0-10, how likely are you to recommend our product/service to a friend or colleague?',
      question: 'What is the primary reason for your score?',
      placeholder: 'Tell us more about your experience...',
      rating_enabled: true,
      rating_type: 'numeric',
      rating_max: 10,
      submit_button_text: 'Submit',
      success_message: 'Thank you for your feedback! Your response helps us improve.',
    }, KIRO_LIGHT_HEX.accent, '12px'),
  },
  {
    id: 'csat',
    name: 'CSAT Survey',
    description: 'Customer Satisfaction - quick satisfaction rating after interactions',
    icon: ThumbsUp,
    config: templateConfig({
      name: 'CSAT Survey',
      enabled: false,
      title: 'How satisfied are you?',
      description: 'Please rate your satisfaction with your recent experience.',
      question: 'What could we do better?',
      placeholder: 'Share any additional feedback...',
      rating_enabled: true,
      rating_type: 'emoji',
      rating_max: 5,
      submit_button_text: 'Submit Feedback',
      success_message: 'Thanks for rating your experience!',
    }, KIRO_LIGHT_HEX.ok, '8px'),
  },
  {
    id: 'product-feedback',
    name: 'Product Feedback',
    description: 'Collect detailed product feedback with star ratings',
    icon: Star,
    config: templateConfig({
      name: 'Product Feedback',
      enabled: false,
      title: 'Share Your Product Feedback',
      description: 'Help us improve by sharing your thoughts on our product.',
      question: 'What do you think about our product?',
      placeholder: 'Tell us what you like, dislike, or would like to see improved...',
      rating_enabled: true,
      rating_type: 'stars',
      rating_max: 5,
      submit_button_text: 'Submit Feedback',
      success_message: 'Thank you! Your feedback helps us build better products.',
    }, KIRO_LIGHT_HEX.warn, '8px'),
  },
  {
    id: 'general-feedback',
    name: 'General Feedback',
    description: 'Open-ended feedback form for any purpose',
    icon: MessageSquare,
    config: templateConfig({
      name: 'General Feedback',
      enabled: false,
      title: 'We\'d Love Your Feedback',
      description: 'Your opinion matters to us. Share your thoughts, suggestions, or concerns.',
      question: 'What would you like to tell us?',
      placeholder: 'Type your feedback here...',
      rating_enabled: false,
      rating_type: 'stars',
      rating_max: 5,
      submit_button_text: 'Send Feedback',
      success_message: 'Thank you for sharing your thoughts with us!',
    }, KIRO_LIGHT_HEX.aim, '8px'),
  },
  {
    id: 'experience-survey',
    name: 'Experience Survey',
    description: 'Multi-question survey about customer experience',
    icon: ClipboardList,
    config: templateConfig({
      name: 'Experience Survey',
      enabled: false,
      title: 'Tell Us About Your Experience',
      description: 'Help us understand your journey with us better.',
      question: 'How would you describe your overall experience?',
      placeholder: 'Share details about what went well and what could be improved...',
      rating_enabled: true,
      rating_type: 'stars',
      rating_max: 5,
      submit_button_text: 'Complete Survey',
      success_message: 'Survey completed! Thank you for your valuable input.',
    }, KIRO_LIGHT_HEX.info, '10px'),
  },
  {
    id: 'blank',
    name: 'Blank Form',
    description: 'Start from scratch with a blank template',
    icon: FileText,
    config: templateConfig({
      name: 'New Feedback Form',
      enabled: false,
      title: 'Share Your Feedback',
      description: 'We value your opinion. Please share your experience with us.',
      question: 'How was your experience?',
      placeholder: 'Tell us about your experience...',
      rating_enabled: true,
      rating_type: 'stars',
      rating_max: 5,
      submit_button_text: 'Submit Feedback',
      success_message: 'Thank you for your feedback!',
    }, KIRO_LIGHT_HEX.accent, '8px'),
  },
]

const blankTemplate = formTemplates.find(t => t.id === 'blank')
if (!blankTemplate) {
  throw new Error('Blank template not found in formTemplates')
}
export const defaultFormConfig = blankTemplate.config

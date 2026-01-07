/**
 * Form templates for common CX research types
 */
import { Gauge, Star, MessageSquare, ClipboardList, ThumbsUp, FileText } from 'lucide-react'
import type { FeedbackForm } from '../../api/client'

export type FormTemplate = {
  id: string
  name: string
  description: string
  icon: React.ElementType
  color: string
  config: Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'>
}

export const formTemplates: FormTemplate[] = [
  {
    id: 'nps',
    name: 'NPS Survey',
    description: 'Net Promoter Score - measure customer loyalty with the classic 0-10 scale',
    icon: Gauge,
    color: 'bg-purple-500',
    config: {
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
      theme: { primary_color: '#8B5CF6', background_color: '#FFFFFF', text_color: '#1F2937', border_radius: '12px' },
      collect_email: false,
      collect_name: false,
      custom_fields: [],
      category: '',
      subcategory: '',
    }
  },
  {
    id: 'csat',
    name: 'CSAT Survey',
    description: 'Customer Satisfaction - quick satisfaction rating after interactions',
    icon: ThumbsUp,
    color: 'bg-green-500',
    config: {
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
      theme: { primary_color: '#22C55E', background_color: '#FFFFFF', text_color: '#1F2937', border_radius: '8px' },
      collect_email: false,
      collect_name: false,
      custom_fields: [],
      category: '',
      subcategory: '',
    }
  },
  {
    id: 'product-feedback',
    name: 'Product Feedback',
    description: 'Collect detailed product feedback with star ratings',
    icon: Star,
    color: 'bg-yellow-500',
    config: {
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
      theme: { primary_color: '#EAB308', background_color: '#FFFFFF', text_color: '#1F2937', border_radius: '8px' },
      collect_email: false,
      collect_name: false,
      custom_fields: [],
      category: '',
      subcategory: '',
    }
  },
  {
    id: 'general-feedback',
    name: 'General Feedback',
    description: 'Open-ended feedback form for any purpose',
    icon: MessageSquare,
    color: 'bg-blue-500',
    config: {
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
      theme: { primary_color: '#3B82F6', background_color: '#FFFFFF', text_color: '#1F2937', border_radius: '8px' },
      collect_email: false,
      collect_name: false,
      custom_fields: [],
      category: '',
      subcategory: '',
    }
  },
  {
    id: 'experience-survey',
    name: 'Experience Survey',
    description: 'Multi-question survey about customer experience',
    icon: ClipboardList,
    color: 'bg-indigo-500',
    config: {
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
      theme: { primary_color: '#6366F1', background_color: '#FFFFFF', text_color: '#1F2937', border_radius: '10px' },
      collect_email: false,
      collect_name: false,
      custom_fields: [],
      category: '',
      subcategory: '',
    }
  },
  {
    id: 'blank',
    name: 'Blank Form',
    description: 'Start from scratch with a blank template',
    icon: FileText,
    color: 'bg-gray-500',
    config: {
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
      theme: { primary_color: '#3B82F6', background_color: '#FFFFFF', text_color: '#1F2937', border_radius: '8px' },
      collect_email: false,
      collect_name: false,
      custom_fields: [],
      category: '',
      subcategory: '',
    }
  },
]

const blankTemplate = formTemplates.find(t => t.id === 'blank')
if (!blankTemplate) {
  throw new Error('Blank template not found in formTemplates')
}
export const defaultFormConfig = blankTemplate.config

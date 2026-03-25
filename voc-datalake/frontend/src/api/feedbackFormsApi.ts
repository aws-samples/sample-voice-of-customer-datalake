// Feedback Forms API - extracted from client.ts for code splitting
import { fetchApi } from './client'
import type { FeedbackFormConfig, FeedbackForm } from './types'

export const feedbackFormsApi = {
  // Legacy single form
  getFeedbackFormConfig: () => fetchApi<{ success: boolean; config: FeedbackFormConfig }>('/feedback-form/config'),

  saveFeedbackFormConfig: (config: FeedbackFormConfig) =>
    fetchApi<{ success: boolean; message: string }>('/feedback-form/config', {
      method: 'PUT',
      body: JSON.stringify(config)
    }),

  submitFeedbackForm: (data: { text: string; rating?: number; email?: string; name?: string; page_url?: string; custom_fields?: Record<string, string> }) =>
    fetchApi<{ success: boolean; feedback_id?: string; message: string }>('/feedback-form/submit', {
      method: 'POST',
      body: JSON.stringify(data)
    }),

  getFeedbackFormEmbed: (apiEndpoint: string) =>
    fetchApi<{ success: boolean; script_embed: string; iframe_embed: string }>(`/feedback-form/embed?api_endpoint=${encodeURIComponent(apiEndpoint)}`),

  // Multiple forms management
  getFeedbackForms: () => fetchApi<{ success: boolean; forms: FeedbackForm[] }>('/feedback-forms'),

  getFeedbackForm: (formId: string) => fetchApi<{ success: boolean; form: FeedbackForm }>(`/feedback-forms/${formId}`),

  createFeedbackForm: (form: Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'>) =>
    fetchApi<{ success: boolean; form: FeedbackForm }>('/feedback-forms', {
      method: 'POST',
      body: JSON.stringify(form)
    }),

  updateFeedbackForm: (formId: string, form: Partial<FeedbackForm>) =>
    fetchApi<{ success: boolean; form: FeedbackForm }>(`/feedback-forms/${formId}`, {
      method: 'PUT',
      body: JSON.stringify(form)
    }),

  deleteFeedbackForm: (formId: string) =>
    fetchApi<{ success: boolean }>(`/feedback-forms/${formId}`, { method: 'DELETE' }),

  getFeedbackFormStats: (formId: string) =>
    fetchApi<{ success: boolean; form_id: string; stats: { total_submissions: number; avg_rating: number | null; rating_count: number } }>(`/feedback-forms/${formId}/stats`),

  getFeedbackFormSubmissions: (formId: string, limit?: number) => {
    const params = new URLSearchParams()
    if (limit) params.set('limit', String(limit))
    return fetchApi<{
      success: boolean
      form_id: string
      stats: { total_submissions: number; avg_rating: number | null; rating_count: number }
      submissions: Array<{
        feedback_id: string
        original_text: string
        rating: number | null
        sentiment_label: string
        sentiment_score: number
        category: string
        created_at: string
        persona_name: string
      }>
    }>(`/feedback-forms/${formId}/submissions?${params}`)
  },
}

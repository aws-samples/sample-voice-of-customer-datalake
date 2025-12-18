import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { 
  Plus, Trash2, Copy, Check, Loader2, Eye, Code, Palette, Settings2, 
  ExternalLink, ToggleLeft, ToggleRight, Edit2, Save, X, ArrowRight,
  Gauge, Star, MessageSquare, ClipboardList, ThumbsUp, FileText, User, Mail
} from 'lucide-react'
import { api } from '../api/client'
import type { FeedbackForm } from '../api/client'
import { useConfigStore } from '../store/configStore'
import clsx from 'clsx'
import ConfirmModal from '../components/ConfirmModal'

// Form templates for common CX research types
type FormTemplate = {
  id: string
  name: string
  description: string
  icon: React.ElementType
  color: string
  config: Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'>
}

const formTemplates: FormTemplate[] = [
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

const defaultFormConfig: Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'> = formTemplates.find(t => t.id === 'blank')!.config


// Template Wizard Component
function TemplateWizard({ onSelect, onCancel }: {
  onSelect: (config: Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'>) => void
  onCancel: () => void
}) {
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null)
  const [collectPII, setCollectPII] = useState<'none' | 'name' | 'email' | 'both'>('none')

  const handleContinue = () => {
    const template = formTemplates.find(t => t.id === selectedTemplate)
    if (!template) return

    const config = { ...template.config }
    
    // Apply PII settings
    if (collectPII === 'name' || collectPII === 'both') {
      config.collect_name = true
    }
    if (collectPII === 'email' || collectPII === 'both') {
      config.collect_email = true
    }

    onSelect(config)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-semibold">Create New Form</h2>
            <p className="text-sm text-gray-500">Choose a template to get started</p>
          </div>
          <button onClick={onCancel} className="p-2 hover:bg-gray-100 rounded-lg">
            <X size={20} />
          </button>
        </div>

        {/* Template Grid */}
        <div className="flex-1 overflow-auto p-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
            {formTemplates.map((template) => {
              const Icon = template.icon
              const isSelected = selectedTemplate === template.id
              return (
                <button
                  key={template.id}
                  onClick={() => setSelectedTemplate(template.id)}
                  className={clsx(
                    'p-4 rounded-xl border-2 text-left transition-all hover:shadow-md',
                    isSelected 
                      ? 'border-blue-500 bg-blue-50 shadow-md' 
                      : 'border-gray-200 hover:border-gray-300'
                  )}
                >
                  <div className={clsx('w-10 h-10 rounded-lg flex items-center justify-center mb-3', template.color)}>
                    <Icon size={20} className="text-white" />
                  </div>
                  <h3 className="font-medium text-gray-900 mb-1">{template.name}</h3>
                  <p className="text-xs text-gray-500 line-clamp-2">{template.description}</p>
                </button>
              )
            })}
          </div>

          {/* PII Options */}
          {selectedTemplate && (
            <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
              <h4 className="font-medium text-gray-900 mb-3 flex items-center gap-2">
                <User size={16} />
                Contact Information Collection
              </h4>
              <p className="text-sm text-gray-600 mb-4">
                Choose what personal information to collect from respondents.
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {[
                  { id: 'none', label: 'Anonymous', desc: 'No PII collected', icon: null },
                  { id: 'name', label: 'Name Only', desc: 'Collect name', icon: User },
                  { id: 'email', label: 'Email Only', desc: 'Collect email', icon: Mail },
                  { id: 'both', label: 'Name & Email', desc: 'Full contact info', icon: User },
                ].map((option) => (
                  <button
                    key={option.id}
                    onClick={() => setCollectPII(option.id as typeof collectPII)}
                    className={clsx(
                      'p-3 rounded-lg border-2 text-left transition-all',
                      collectPII === option.id
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    )}
                  >
                    <p className="font-medium text-sm text-gray-900">{option.label}</p>
                    <p className="text-xs text-gray-500">{option.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t bg-gray-50">
          <p className="text-sm text-gray-500">
            {selectedTemplate 
              ? `Selected: ${formTemplates.find(t => t.id === selectedTemplate)?.name}`
              : 'Select a template to continue'
            }
          </p>
          <div className="flex gap-3">
            <button onClick={onCancel} className="btn btn-secondary">
              Cancel
            </button>
            <button
              onClick={handleContinue}
              disabled={!selectedTemplate}
              className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Continue
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}


function FormCard({ form, onEdit, onDelete, onToggle, apiEndpoint }: {
  form: FeedbackForm
  onEdit: (form: FeedbackForm) => void
  onDelete: (formId: string) => void
  onToggle: (formId: string, enabled: boolean) => void
  apiEndpoint: string
}) {
  const [copied, setCopied] = useState<string | null>(null)
  const [showEmbed, setShowEmbed] = useState(false)

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  const iframeUrl = `${apiEndpoint}/feedback-forms/${form.form_id}/iframe`
  const iframeEmbed = `<iframe 
  src="${iframeUrl}"
  style="width: 100%; min-height: 400px; border: none;"
  title="${form.name}"
></iframe>`

  return (
    <div className="card">
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h3 className="font-semibold text-lg">{form.name}</h3>
            <span className={clsx(
              'px-2 py-0.5 rounded text-xs font-medium',
              form.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
            )}>
              {form.enabled ? 'Active' : 'Disabled'}
            </span>
          </div>
          <p className="text-sm text-gray-500 mt-1">{form.title}</p>
          {form.category && (
            <p className="text-xs text-blue-600 mt-2">
              Category: <span className="font-medium">{form.category}</span>
              {form.subcategory && <span> → {form.subcategory}</span>}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onToggle(form.form_id, !form.enabled)}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            title={form.enabled ? 'Disable form' : 'Enable form'}
          >
            {form.enabled ? (
              <ToggleRight size={20} className="text-green-600" />
            ) : (
              <ToggleLeft size={20} className="text-gray-400" />
            )}
          </button>
          <button
            onClick={() => onEdit(form)}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            title="Edit form"
          >
            <Edit2 size={18} className="text-gray-600" />
          </button>
          <button
            onClick={() => onDelete(form.form_id)}
            className="p-2 hover:bg-red-50 rounded-lg transition-colors"
            title="Delete form"
          >
            <Trash2 size={18} className="text-red-500" />
          </button>
        </div>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-3 gap-4 mb-4 p-3 bg-gray-50 rounded-lg">
        <div>
          <p className="text-xs text-gray-500">Rating Type</p>
          <p className="font-medium text-sm">
            {form.rating_type === 'stars' ? '⭐ Stars' : form.rating_type === 'emoji' ? '😀 Emoji' : '🔢 Numeric'}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Collects</p>
          <p className="font-medium text-sm">
            {[form.collect_name && 'Name', form.collect_email && 'Email'].filter(Boolean).join(', ') || 'Rating & Text'}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Theme</p>
          <div className="flex items-center gap-1">
            <div className="w-4 h-4 rounded" style={{ backgroundColor: form.theme.primary_color }} />
            <span className="text-sm font-mono">{form.theme.primary_color}</span>
          </div>
        </div>
      </div>

      {/* Embed section */}
      <div className="border-t pt-4">
        <button
          onClick={() => setShowEmbed(!showEmbed)}
          className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700"
        >
          <Code size={16} />
          {showEmbed ? 'Hide Embed Code' : 'Show Embed Code'}
        </button>
        
        {showEmbed && (
          <div className="mt-3 space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-500">Direct Link</span>
                <div className="flex gap-2">
                  <a
                    href={iframeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
                  >
                    Preview <ExternalLink size={12} />
                  </a>
                  <button
                    onClick={() => copyToClipboard(iframeUrl, 'url')}
                    className="text-xs text-gray-600 hover:text-gray-800 flex items-center gap-1"
                  >
                    {copied === 'url' ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
                    Copy
                  </button>
                </div>
              </div>
              <code className="block bg-gray-100 p-2 rounded text-xs break-all">{iframeUrl}</code>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-500">iFrame Embed</span>
                <button
                  onClick={() => copyToClipboard(iframeEmbed, 'iframe')}
                  className="text-xs text-gray-600 hover:text-gray-800 flex items-center gap-1"
                >
                  {copied === 'iframe' ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
                  Copy
                </button>
              </div>
              <pre className="bg-gray-900 text-gray-100 p-2 rounded text-xs overflow-x-auto">
                <code>{iframeEmbed}</code>
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}


function FormEditor({ form, initialConfig, categories, onSave, onCancel, isSaving }: {
  form: FeedbackForm | null
  initialConfig?: Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'> | null
  categories: Array<{ id: string; name: string; subcategories: Array<{ id: string; name: string }> }>
  onSave: (form: Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'> & { form_id?: string }) => void
  onCancel: () => void
  isSaving?: boolean
}) {
  const [activeTab, setActiveTab] = useState<'settings' | 'theme' | 'category'>('settings')
  const [formData, setFormData] = useState<Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'> & { form_id?: string }>(
    form ? { ...form } : initialConfig ? { ...initialConfig } : { ...defaultFormConfig }
  )

  const selectedCategory = categories.find(c => c.id === formData.category)

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">
            {form ? 'Edit Feedback Form' : 'Create New Feedback Form'}
          </h2>
          <button onClick={onCancel} className="p-2 hover:bg-gray-100 rounded-lg">
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 px-4 pt-4 border-b border-gray-200">
          {[
            { id: 'settings', label: 'Form Settings', icon: Settings2 },
            { id: 'category', label: 'Category Routing', icon: Settings2 },
            { id: 'theme', label: 'Theme', icon: Palette },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 border-b-2 -mb-px transition-colors',
                activeTab === tab.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              )}
            >
              <tab.icon size={16} />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {activeTab === 'settings' && (
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Form Name (Internal)</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g., Website Footer Form"
                    className="input"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Form Title</label>
                  <input
                    type="text"
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    className="input"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <textarea
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    className="input min-h-[80px]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Question</label>
                  <input
                    type="text"
                    value={formData.question}
                    onChange={(e) => setFormData({ ...formData, question: e.target.value })}
                    className="input"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Placeholder Text</label>
                  <input
                    type="text"
                    value={formData.placeholder}
                    onChange={(e) => setFormData({ ...formData, placeholder: e.target.value })}
                    className="input"
                  />
                </div>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Submit Button Text</label>
                  <input
                    type="text"
                    value={formData.submit_button_text}
                    onChange={(e) => setFormData({ ...formData, submit_button_text: e.target.value })}
                    className="input"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Success Message</label>
                  <input
                    type="text"
                    value={formData.success_message}
                    onChange={(e) => setFormData({ ...formData, success_message: e.target.value })}
                    className="input"
                  />
                </div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={formData.rating_enabled}
                      onChange={(e) => setFormData({ ...formData, rating_enabled: e.target.checked })}
                      className="rounded border-gray-300 text-blue-600"
                    />
                    <span className="text-sm">Enable Rating</span>
                  </label>
                  {formData.rating_enabled && (
                    <select
                      value={formData.rating_type}
                      onChange={(e) => setFormData({ ...formData, rating_type: e.target.value as 'stars' | 'numeric' | 'emoji' })}
                      className="input w-auto"
                    >
                      <option value="stars">Stars ⭐</option>
                      <option value="numeric">Numeric (1-10)</option>
                      <option value="emoji">Emoji 😀</option>
                    </select>
                  )}
                </div>
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={formData.collect_name}
                      onChange={(e) => setFormData({ ...formData, collect_name: e.target.checked })}
                      className="rounded border-gray-300 text-blue-600"
                    />
                    <span className="text-sm">Collect Name</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={formData.collect_email}
                      onChange={(e) => setFormData({ ...formData, collect_email: e.target.checked })}
                      className="rounded border-gray-300 text-blue-600"
                    />
                    <span className="text-sm">Collect Email</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'category' && (
            <div className="space-y-6">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h4 className="font-medium text-blue-900 mb-2">Category Routing</h4>
                <p className="text-sm text-blue-800">
                  Assign a category to this form. All feedback submitted through this form will be automatically 
                  tagged with the selected category, making it easy to filter and analyze feedback by source.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                  <select
                    value={formData.category}
                    onChange={(e) => setFormData({ ...formData, category: e.target.value, subcategory: '' })}
                    className="input"
                  >
                    <option value="">-- Select Category --</option>
                    {categories.map(cat => (
                      <option key={cat.id} value={cat.id}>{cat.name}</option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Categories are configured in Settings → Feedback Categories
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Subcategory (Optional)</label>
                  <select
                    value={formData.subcategory}
                    onChange={(e) => setFormData({ ...formData, subcategory: e.target.value })}
                    className="input"
                    disabled={!selectedCategory}
                  >
                    <option value="">-- Select Subcategory --</option>
                    {selectedCategory?.subcategories.map(sub => (
                      <option key={sub.id} value={sub.id}>{sub.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {formData.category && (
                <div className="p-4 bg-gray-50 rounded-lg">
                  <p className="text-sm text-gray-700">
                    <strong>Preview:</strong> Feedback from this form will be tagged as:
                  </p>
                  <p className="mt-2 font-mono text-sm bg-white px-3 py-2 rounded border inline-block">
                    category: "{formData.category}"
                    {formData.subcategory && <>, subcategory: "{formData.subcategory}"</>}
                  </p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'theme' && (
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Primary Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={formData.theme.primary_color}
                      onChange={(e) => setFormData({ ...formData, theme: { ...formData.theme, primary_color: e.target.value } })}
                      className="w-10 h-10 rounded border cursor-pointer"
                    />
                    <input
                      type="text"
                      value={formData.theme.primary_color}
                      onChange={(e) => setFormData({ ...formData, theme: { ...formData.theme, primary_color: e.target.value } })}
                      className="input flex-1"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Background Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={formData.theme.background_color}
                      onChange={(e) => setFormData({ ...formData, theme: { ...formData.theme, background_color: e.target.value } })}
                      className="w-10 h-10 rounded border cursor-pointer"
                    />
                    <input
                      type="text"
                      value={formData.theme.background_color}
                      onChange={(e) => setFormData({ ...formData, theme: { ...formData.theme, background_color: e.target.value } })}
                      className="input flex-1"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Text Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={formData.theme.text_color}
                      onChange={(e) => setFormData({ ...formData, theme: { ...formData.theme, text_color: e.target.value } })}
                      className="w-10 h-10 rounded border cursor-pointer"
                    />
                    <input
                      type="text"
                      value={formData.theme.text_color}
                      onChange={(e) => setFormData({ ...formData, theme: { ...formData.theme, text_color: e.target.value } })}
                      className="input flex-1"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Border Radius</label>
                  <input
                    type="text"
                    value={formData.theme.border_radius}
                    onChange={(e) => setFormData({ ...formData, theme: { ...formData.theme, border_radius: e.target.value } })}
                    placeholder="8px"
                    className="input"
                  />
                </div>
              </div>
              {/* Preview */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Preview</label>
                <div
                  className="relative overflow-hidden border"
                  style={{
                    backgroundColor: formData.theme.background_color,
                    color: formData.theme.text_color,
                    borderRadius: formData.theme.border_radius,
                    minHeight: '280px',
                  }}
                >
                  <div 
                    className="absolute top-0 left-0 h-1 transition-all"
                    style={{ backgroundColor: formData.theme.primary_color, width: '33%' }}
                  />
                  <div className="flex flex-col items-center justify-center text-center p-6 h-full min-h-[280px]">
                    <h3 className="text-xl font-bold mb-2">{formData.title}</h3>
                    <p className="text-sm mb-4 opacity-70 max-w-xs">{formData.description}</p>
                    <button
                      className="px-5 py-2 text-white font-medium text-sm"
                      style={{ backgroundColor: formData.theme.primary_color, borderRadius: formData.theme.border_radius }}
                    >
                      Start →
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-4 border-t bg-gray-50">
          <button onClick={onCancel} className="btn btn-secondary" disabled={isSaving}>
            Cancel
          </button>
          <button
            onClick={() => onSave(formData)}
            disabled={isSaving}
            className="btn btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {isSaving ? (form ? 'Saving...' : 'Creating...') : (form ? 'Save Changes' : 'Create Form')}
          </button>
        </div>
      </div>
    </div>
  )
}


export default function FeedbackForms() {
  const queryClient = useQueryClient()
  const { config } = useConfigStore()
  const [editingForm, setEditingForm] = useState<FeedbackForm | null>(null)
  const [showWizard, setShowWizard] = useState(false)
  const [templateConfig, setTemplateConfig] = useState<Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'> | null>(null)
  const [deleteFormId, setDeleteFormId] = useState<string | null>(null)

  const { data: formsData, isLoading } = useQuery({
    queryKey: ['feedback-forms'],
    queryFn: () => api.getFeedbackForms(),
    enabled: !!config.apiEndpoint,
  })

  const { data: categoriesData } = useQuery({
    queryKey: ['categories-config'],
    queryFn: () => api.getCategoriesConfig(),
    enabled: !!config.apiEndpoint,
  })

  const saveMutation = useMutation({
    mutationFn: (form: Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'> & { form_id?: string }) =>
      form.form_id ? api.updateFeedbackForm(form.form_id, form) : api.createFeedbackForm(form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feedback-forms'] })
      setEditingForm(null)
      setTemplateConfig(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (formId: string) => api.deleteFeedbackForm(formId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feedback-forms'] })
    },
  })

  const toggleMutation = useMutation({
    mutationFn: ({ formId, enabled }: { formId: string; enabled: boolean }) =>
      api.updateFeedbackForm(formId, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feedback-forms'] })
    },
  })

  const handleDelete = (formId: string) => {
    setDeleteFormId(formId)
  }

  const apiEndpoint = config.apiEndpoint?.replace(/\/+$/, '') || ''
  const categories = categoriesData?.categories || []

  if (!config.apiEndpoint) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="card text-center py-12">
          <p className="text-gray-500 mb-4">Configure the API endpoint in Settings to manage feedback forms.</p>
          <a href="/settings" className="btn btn-primary">Go to Settings</a>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Feedback Forms</h1>
          <p className="text-gray-500">Create embeddable forms to collect customer feedback</p>
        </div>
        <button
          onClick={() => setShowWizard(true)}
          className="btn btn-primary flex items-center gap-2"
        >
          <Plus size={18} />
          Create Form
        </button>
      </div>

      {/* Info banner */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="font-medium text-blue-900 mb-2 flex items-center gap-2">
          <Eye size={16} /> Typeform-style Feedback Collection
        </h4>
        <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
          <li>Create multiple forms for different purposes (website, app, support, etc.)</li>
          <li>Each form has its own unique URL and embed code</li>
          <li>Assign categories to route feedback automatically</li>
          <li>All submissions go through AI enrichment (sentiment, personas, etc.)</li>
        </ul>
      </div>

      {/* Forms list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="animate-spin text-blue-600" size={32} />
        </div>
      ) : formsData?.forms && formsData.forms.length > 0 ? (
        <div className="space-y-4">
          {formsData.forms.map((form) => (
            <FormCard
              key={form.form_id}
              form={form}
              onEdit={setEditingForm}
              onDelete={handleDelete}
              onToggle={(formId, enabled) => toggleMutation.mutate({ formId, enabled })}
              apiEndpoint={apiEndpoint}
            />
          ))}
        </div>
      ) : (
        <div className="card text-center py-12">
          <div className="text-4xl mb-4">📝</div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">No feedback forms yet</h3>
          <p className="text-gray-500 mb-4">Create your first form to start collecting customer feedback.</p>
          <button
            onClick={() => setShowWizard(true)}
            className="btn btn-primary inline-flex items-center gap-2"
          >
            <Plus size={18} />
            Create Your First Form
          </button>
        </div>
      )}

      {/* Template Wizard */}
      {showWizard && (
        <TemplateWizard
          onSelect={(config) => {
            setTemplateConfig(config)
            setShowWizard(false)
          }}
          onCancel={() => setShowWizard(false)}
        />
      )}

      {/* Editor modal */}
      {(templateConfig || editingForm) && (
        <FormEditor
          form={editingForm}
          initialConfig={templateConfig}
          categories={categories}
          onSave={(form) => saveMutation.mutate(form)}
          onCancel={() => {
            setEditingForm(null)
            setTemplateConfig(null)
          }}
          isSaving={saveMutation.isPending}
        />
      )}

      <ConfirmModal
        isOpen={deleteFormId !== null}
        title="Delete Form"
        message="Are you sure you want to delete this form? This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        isLoading={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteFormId) {
            deleteMutation.mutate(deleteFormId, { onSettled: () => setDeleteFormId(null) })
          }
        }}
        onCancel={() => setDeleteFormId(null)}
      />
    </div>
  )
}

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Save, Copy, Check, Loader2, Eye, Code, Palette, Settings2 } from 'lucide-react'
import { api } from '../api/client'
import { useConfigStore } from '../store/configStore'
import clsx from 'clsx'

interface FormConfig {
  enabled: boolean
  title: string
  description: string
  question: string
  placeholder: string
  rating_enabled: boolean
  rating_type: 'stars' | 'numeric' | 'emoji'
  rating_max: number
  submit_button_text: string
  success_message: string
  theme: {
    primary_color: string
    background_color: string
    text_color: string
    border_radius: string
  }
  collect_email: boolean
  collect_name: boolean
  custom_fields: Array<{ id: string; label: string; type: string; required: boolean }>
  brand_name: string
}

const defaultConfig: FormConfig = {
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
  brand_name: '',
}

export default function FeedbackFormConfig() {
  const queryClient = useQueryClient()
  const { config: appConfig } = useConfigStore()
  const [activeTab, setActiveTab] = useState<'settings' | 'theme' | 'embed'>('settings')
  const [formConfig, setFormConfig] = useState<FormConfig>(defaultConfig)
  const [copied, setCopied] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['feedback-form-config'],
    queryFn: () => api.getFeedbackFormConfig(),
    enabled: !!appConfig.apiEndpoint,
  })

  useEffect(() => {
    if (data?.config) {
      setFormConfig({ ...defaultConfig, ...data.config })
    }
  }, [data])

  const saveMutation = useMutation({
    mutationFn: (config: FormConfig) => api.saveFeedbackFormConfig(config),
    onSuccess: () => {
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
      queryClient.invalidateQueries({ queryKey: ['feedback-form-config'] })
    },
  })

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  const apiEndpoint = appConfig.apiEndpoint?.replace(/\/+$/, '') || ''

  const scriptEmbed = `<!-- VoC Feedback Form Widget -->
<div id="voc-feedback-form"></div>
<script src="${apiEndpoint}/feedback-form/widget.js"></script>
<script>
  VoCFeedbackForm.init({
    container: '#voc-feedback-form',
    apiEndpoint: '${apiEndpoint}'
  });
</script>`

  const iframeEmbed = `<iframe 
  src="${apiEndpoint}/feedback-form/iframe"
  style="width: 100%; min-height: 400px; border: none;"
  title="Feedback Form"
></iframe>`

  if (isLoading) {
    return <div className="flex items-center gap-2 text-gray-500"><Loader2 className="animate-spin" size={16} /> Loading...</div>
  }

  return (
    <div className="space-y-6">
      {/* Header with enable toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={formConfig.enabled}
              onChange={(e) => setFormConfig({ ...formConfig, enabled: e.target.checked })}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="font-medium">Enable Feedback Form</span>
          </label>
          <span className={clsx('px-2 py-1 rounded text-xs', formConfig.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600')}>
            {formConfig.enabled ? 'Active' : 'Disabled'}
          </span>
        </div>
        <button
          onClick={() => saveMutation.mutate(formConfig)}
          disabled={saveMutation.isPending}
          className={clsx('btn flex items-center gap-2', saved ? 'bg-green-600 text-white' : 'btn-primary')}
        >
          {saveMutation.isPending ? <Loader2 size={16} className="animate-spin" /> : saved ? <Check size={16} /> : <Save size={16} />}
          {saved ? 'Saved!' : 'Save'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-200">
        {[
          { id: 'settings', label: 'Form Settings', icon: Settings2 },
          { id: 'theme', label: 'Theme', icon: Palette },
          { id: 'embed', label: 'Embed Code', icon: Code },
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

      {/* Settings Tab */}
      {activeTab === 'settings' && (
        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Form Title</label>
              <input
                type="text"
                value={formConfig.title}
                onChange={(e) => setFormConfig({ ...formConfig, title: e.target.value })}
                className="input"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                value={formConfig.description}
                onChange={(e) => setFormConfig({ ...formConfig, description: e.target.value })}
                className="input min-h-[80px]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Question</label>
              <input
                type="text"
                value={formConfig.question}
                onChange={(e) => setFormConfig({ ...formConfig, question: e.target.value })}
                className="input"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Placeholder Text</label>
              <input
                type="text"
                value={formConfig.placeholder}
                onChange={(e) => setFormConfig({ ...formConfig, placeholder: e.target.value })}
                className="input"
              />
            </div>
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Submit Button Text</label>
              <input
                type="text"
                value={formConfig.submit_button_text}
                onChange={(e) => setFormConfig({ ...formConfig, submit_button_text: e.target.value })}
                className="input"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Success Message</label>
              <input
                type="text"
                value={formConfig.success_message}
                onChange={(e) => setFormConfig({ ...formConfig, success_message: e.target.value })}
                className="input"
              />
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formConfig.rating_enabled}
                  onChange={(e) => setFormConfig({ ...formConfig, rating_enabled: e.target.checked })}
                  className="rounded border-gray-300 text-blue-600"
                />
                <span className="text-sm">Enable Rating</span>
              </label>
              {formConfig.rating_enabled && (
                <select
                  value={formConfig.rating_type}
                  onChange={(e) => setFormConfig({ ...formConfig, rating_type: e.target.value as FormConfig['rating_type'] })}
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
                  checked={formConfig.collect_name}
                  onChange={(e) => setFormConfig({ ...formConfig, collect_name: e.target.checked })}
                  className="rounded border-gray-300 text-blue-600"
                />
                <span className="text-sm">Collect Name</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formConfig.collect_email}
                  onChange={(e) => setFormConfig({ ...formConfig, collect_email: e.target.checked })}
                  className="rounded border-gray-300 text-blue-600"
                />
                <span className="text-sm">Collect Email</span>
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Theme Tab */}
      {activeTab === 'theme' && (
        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Primary Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={formConfig.theme.primary_color}
                  onChange={(e) => setFormConfig({ ...formConfig, theme: { ...formConfig.theme, primary_color: e.target.value } })}
                  className="w-10 h-10 rounded border cursor-pointer"
                />
                <input
                  type="text"
                  value={formConfig.theme.primary_color}
                  onChange={(e) => setFormConfig({ ...formConfig, theme: { ...formConfig.theme, primary_color: e.target.value } })}
                  className="input flex-1"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Background Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={formConfig.theme.background_color}
                  onChange={(e) => setFormConfig({ ...formConfig, theme: { ...formConfig.theme, background_color: e.target.value } })}
                  className="w-10 h-10 rounded border cursor-pointer"
                />
                <input
                  type="text"
                  value={formConfig.theme.background_color}
                  onChange={(e) => setFormConfig({ ...formConfig, theme: { ...formConfig.theme, background_color: e.target.value } })}
                  className="input flex-1"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Text Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={formConfig.theme.text_color}
                  onChange={(e) => setFormConfig({ ...formConfig, theme: { ...formConfig.theme, text_color: e.target.value } })}
                  className="w-10 h-10 rounded border cursor-pointer"
                />
                <input
                  type="text"
                  value={formConfig.theme.text_color}
                  onChange={(e) => setFormConfig({ ...formConfig, theme: { ...formConfig.theme, text_color: e.target.value } })}
                  className="input flex-1"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Border Radius</label>
              <input
                type="text"
                value={formConfig.theme.border_radius}
                onChange={(e) => setFormConfig({ ...formConfig, theme: { ...formConfig.theme, border_radius: e.target.value } })}
                placeholder="8px"
                className="input"
              />
            </div>
          </div>
          {/* Typeform-style Preview */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Preview (Typeform-style)</label>
            <div
              className="relative overflow-hidden border"
              style={{
                backgroundColor: formConfig.theme.background_color,
                color: formConfig.theme.text_color,
                borderRadius: formConfig.theme.border_radius,
                minHeight: '320px',
              }}
            >
              {/* Progress bar */}
              <div 
                className="absolute top-0 left-0 h-1 transition-all"
                style={{ backgroundColor: formConfig.theme.primary_color, width: '33%' }}
              />
              
              {/* Centered content */}
              <div className="flex flex-col items-center justify-center text-center p-8 h-full min-h-[320px]">
                <h3 className="text-2xl font-bold mb-3">{formConfig.title}</h3>
                <p className="text-sm mb-6 opacity-70 max-w-xs">{formConfig.description}</p>
                <button
                  className="px-6 py-3 text-white font-medium flex items-center gap-2"
                  style={{ backgroundColor: formConfig.theme.primary_color, borderRadius: formConfig.theme.border_radius }}
                >
                  Start →
                </button>
              </div>
              
              {/* Navigation hint */}
              <div className="absolute bottom-4 right-4 flex gap-2">
                <div className="w-8 h-8 border border-gray-300 rounded flex items-center justify-center text-gray-400">↑</div>
                <div 
                  className="w-8 h-8 rounded flex items-center justify-center text-white"
                  style={{ backgroundColor: formConfig.theme.primary_color }}
                >↓</div>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-2 text-center">
              One question at a time • Keyboard navigation • Smooth transitions
            </p>
          </div>
        </div>
      )}

      {/* Embed Tab */}
      {activeTab === 'embed' && (
        <div className="space-y-6">
          {!formConfig.enabled && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-800 text-sm">
              ⚠️ Enable the feedback form above before embedding it on your website.
            </div>
          )}
          
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">Script Embed (Recommended)</label>
              <button
                onClick={() => copyToClipboard(scriptEmbed, 'script')}
                className="btn btn-secondary text-xs flex items-center gap-1"
              >
                {copied === 'script' ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
                {copied === 'script' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg text-xs overflow-x-auto">
              <code>{scriptEmbed}</code>
            </pre>
            <p className="text-xs text-gray-500 mt-1">Paste this code where you want the form to appear.</p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">iFrame Embed (Alternative)</label>
              <button
                onClick={() => copyToClipboard(iframeEmbed, 'iframe')}
                className="btn btn-secondary text-xs flex items-center gap-1"
              >
                {copied === 'iframe' ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
                {copied === 'iframe' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg text-xs overflow-x-auto">
              <code>{iframeEmbed}</code>
            </pre>
            <p className="text-xs text-gray-500 mt-1">Use this if you prefer iframe isolation.</p>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h4 className="font-medium text-blue-900 mb-2 flex items-center gap-2">
              <Eye size={16} /> Typeform-style Experience
            </h4>
            <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
              <li><strong>One question at a time</strong> - focused, conversational flow</li>
              <li><strong>Keyboard navigation</strong> - Enter to continue, arrows to navigate</li>
              <li><strong>Smooth animations</strong> - slides transition between steps</li>
              <li><strong>Progress indicator</strong> - shows completion progress</li>
              <li>Feedback is processed as source: <code className="bg-blue-100 px-1 rounded">feedback_form</code></li>
              <li>Goes through AI enrichment (sentiment, categorization, personas)</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * @fileoverview Feedback form configuration component (legacy single form).
 *
 * Configure embeddable feedback form:
 * - Form title, description, question
 * - Rating type (stars, numeric, emoji)
 * - Theme customization
 * - Custom fields
 * - Generate embed code
 *
 * @module components/FeedbackFormConfig
 */

import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Save, Copy, Check, Loader2, Eye, Code, Palette, Settings2 } from 'lucide-react'
import { api } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
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

const DEFAULT_CONFIG: FormConfig = {
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

type TabId = 'settings' | 'theme' | 'embed'
type RatingType = 'stars' | 'numeric' | 'emoji'

function isValidRatingType(value: string): value is RatingType {
  return value === 'stars' || value === 'numeric' || value === 'emoji'
}

// Icon component for save button
function SaveButtonIcon({ isPending, saved }: Readonly<{ isPending: boolean; saved: boolean }>) {
  if (isPending) return <Loader2 size={16} className="animate-spin" />
  if (saved) return <Check size={16} />
  return <Save size={16} />
}

// Header component with enable toggle and save button
function FormHeader({ 
  enabled, 
  saved, 
  isPending, 
  onToggle, 
  onSave 
}: Readonly<{
  enabled: boolean
  saved: boolean
  isPending: boolean
  onToggle: (enabled: boolean) => void
  onSave: () => void
}>) {
  const buttonLabel = saved ? 'Saved!' : 'Save'
  const buttonClass = saved ? 'bg-green-600 text-white' : 'btn-primary'
  
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2 sm:gap-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="font-medium text-sm sm:text-base">Enable Feedback Form</span>
        </label>
        <span className={clsx('px-2 py-1 rounded text-xs', enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600')}>
          {enabled ? 'Active' : 'Disabled'}
        </span>
      </div>
      <button
        onClick={onSave}
        disabled={isPending}
        className={clsx('btn flex items-center justify-center gap-2 w-full sm:w-auto', buttonClass)}
      >
        <SaveButtonIcon isPending={isPending} saved={saved} />
        {buttonLabel}
      </button>
    </div>
  )
}


// Tab navigation component
function TabNavigation({ activeTab, onTabChange }: Readonly<{ activeTab: TabId; onTabChange: (tab: TabId) => void }>) {
  const tabs = [
    { id: 'settings' as const, label: 'Form Settings', shortLabel: 'Settings', icon: Settings2 },
    { id: 'theme' as const, label: 'Theme', shortLabel: 'Theme', icon: Palette },
    { id: 'embed' as const, label: 'Embed Code', shortLabel: 'Embed', icon: Code },
  ]

  return (
    <div className="flex gap-1 sm:gap-2 border-b border-gray-200 overflow-x-auto">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={clsx(
            'flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-4 py-2 border-b-2 -mb-px transition-colors whitespace-nowrap text-sm sm:text-base',
            activeTab === tab.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
          )}
        >
          <tab.icon size={16} />
          <span className="hidden sm:inline">{tab.label}</span>
          <span className="sm:hidden">{tab.shortLabel}</span>
        </button>
      ))}
    </div>
  )
}

// Settings tab content
function SettingsTab({ config, onChange }: Readonly<{ config: FormConfig; onChange: (config: FormConfig) => void }>) {
  const handleRatingTypeChange = (value: string) => {
    if (isValidRatingType(value)) {
      onChange({ ...config, rating_type: value })
    }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Form Title</label>
          <input type="text" value={config.title} onChange={(e) => onChange({ ...config, title: e.target.value })} className="input" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
          <textarea value={config.description} onChange={(e) => onChange({ ...config, description: e.target.value })} className="input min-h-[80px]" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Question</label>
          <input type="text" value={config.question} onChange={(e) => onChange({ ...config, question: e.target.value })} className="input" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Placeholder Text</label>
          <input type="text" value={config.placeholder} onChange={(e) => onChange({ ...config, placeholder: e.target.value })} className="input" />
        </div>
      </div>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Submit Button Text</label>
          <input type="text" value={config.submit_button_text} onChange={(e) => onChange({ ...config, submit_button_text: e.target.value })} className="input" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Success Message</label>
          <input type="text" value={config.success_message} onChange={(e) => onChange({ ...config, success_message: e.target.value })} className="input" />
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={config.rating_enabled} onChange={(e) => onChange({ ...config, rating_enabled: e.target.checked })} className="rounded border-gray-300 text-blue-600" />
            <span className="text-sm">Enable Rating</span>
          </label>
          {config.rating_enabled && (
            <select value={config.rating_type} onChange={(e) => handleRatingTypeChange(e.target.value)} className="input w-full sm:w-auto">
              <option value="stars">Stars ⭐</option>
              <option value="numeric">Numeric (1-10)</option>
              <option value="emoji">Emoji 😀</option>
            </select>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={config.collect_name} onChange={(e) => onChange({ ...config, collect_name: e.target.checked })} className="rounded border-gray-300 text-blue-600" />
            <span className="text-sm">Collect Name</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={config.collect_email} onChange={(e) => onChange({ ...config, collect_email: e.target.checked })} className="rounded border-gray-300 text-blue-600" />
            <span className="text-sm">Collect Email</span>
          </label>
        </div>
      </div>
    </div>
  )
}


// Color input component
function ColorInput({ label, value, onChange }: Readonly<{ label: string; value: string; onChange: (value: string) => void }>) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="w-10 h-10 rounded border cursor-pointer flex-shrink-0" />
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className="input flex-1 min-w-0" />
      </div>
    </div>
  )
}

// Theme preview component
function ThemePreview({ config }: Readonly<{ config: FormConfig }>) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">Preview (Typeform-style)</label>
      <div
        className="relative overflow-hidden border"
        style={{ backgroundColor: config.theme.background_color, color: config.theme.text_color, borderRadius: config.theme.border_radius, minHeight: '280px' }}
      >
        <div className="absolute top-0 left-0 h-1 transition-all" style={{ backgroundColor: config.theme.primary_color, width: '33%' }} />
        <div className="flex flex-col items-center justify-center text-center p-4 sm:p-8 h-full min-h-[280px]">
          <h3 className="text-xl sm:text-2xl font-bold mb-2 sm:mb-3">{config.title}</h3>
          <p className="text-xs sm:text-sm mb-4 sm:mb-6 opacity-70 max-w-xs">{config.description}</p>
          <button className="px-4 sm:px-6 py-2 sm:py-3 text-white font-medium flex items-center gap-2 text-sm sm:text-base" style={{ backgroundColor: config.theme.primary_color, borderRadius: config.theme.border_radius }}>
            Start →
          </button>
        </div>
        <div className="absolute bottom-4 right-4 hidden sm:flex gap-2">
          <div className="w-8 h-8 border border-gray-300 rounded flex items-center justify-center text-gray-400">↑</div>
          <div className="w-8 h-8 rounded flex items-center justify-center text-white" style={{ backgroundColor: config.theme.primary_color }}>↓</div>
        </div>
      </div>
      <p className="text-xs text-gray-500 mt-2 text-center">One question at a time • Keyboard navigation • Smooth transitions</p>
    </div>
  )
}

// Theme tab content
function ThemeTab({ config, onChange }: Readonly<{ config: FormConfig; onChange: (config: FormConfig) => void }>) {
  const updateTheme = (key: keyof FormConfig['theme'], value: string) => {
    onChange({ ...config, theme: { ...config.theme, [key]: value } })
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
      <div className="space-y-4 order-2 md:order-1">
        <ColorInput label="Primary Color" value={config.theme.primary_color} onChange={(v) => updateTheme('primary_color', v)} />
        <ColorInput label="Background Color" value={config.theme.background_color} onChange={(v) => updateTheme('background_color', v)} />
        <ColorInput label="Text Color" value={config.theme.text_color} onChange={(v) => updateTheme('text_color', v)} />
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Border Radius</label>
          <input type="text" value={config.theme.border_radius} onChange={(e) => updateTheme('border_radius', e.target.value)} placeholder="8px" className="input" />
        </div>
      </div>
      <div className="order-1 md:order-2">
        <ThemePreview config={config} />
      </div>
    </div>
  )
}


// Embed code block component
function EmbedCodeBlock({ label, code, id, copied, onCopy }: Readonly<{ label: string; code: string; id: string; copied: string | null; onCopy: (code: string, id: string) => void }>) {
  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
        <label className="block text-sm font-medium text-gray-700">{label}</label>
        <button onClick={() => onCopy(code, id)} className="btn btn-secondary text-xs flex items-center justify-center gap-1 w-full sm:w-auto">
          {copied === id ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
          {copied === id ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="bg-gray-900 text-gray-100 p-3 sm:p-4 rounded-lg text-xs overflow-x-auto">
        <code>{code}</code>
      </pre>
    </div>
  )
}

// Embed tab content
function EmbedTab({ config, apiEndpoint, copied, onCopy }: Readonly<{ config: FormConfig; apiEndpoint: string; copied: string | null; onCopy: (code: string, id: string) => void }>) {
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

  return (
    <div className="space-y-6">
      {!config.enabled && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-800 text-sm">
          ⚠️ Enable the feedback form above before embedding it on your website.
        </div>
      )}
      <EmbedCodeBlock label="Script Embed (Recommended)" code={scriptEmbed} id="script" copied={copied} onCopy={onCopy} />
      <p className="text-xs text-gray-500 -mt-4">Paste this code where you want the form to appear.</p>
      <EmbedCodeBlock label="iFrame Embed (Alternative)" code={iframeEmbed} id="iframe" copied={copied} onCopy={onCopy} />
      <p className="text-xs text-gray-500 -mt-4">Use this if you prefer iframe isolation.</p>
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
  )
}

// Main component
export default function FeedbackFormConfig() {
  const queryClient = useQueryClient()
  const { config: appConfig } = useConfigStore()
  const [activeTab, setActiveTab] = useState<TabId>('settings')
  const [copied, setCopied] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['feedback-form-config'],
    queryFn: () => api.getFeedbackFormConfig(),
    enabled: !!appConfig.apiEndpoint,
  })

  // Derive form config from query data
  const formConfig = useMemo<FormConfig>(() => {
    if (data?.config) {
      return { ...DEFAULT_CONFIG, ...data.config }
    }
    return DEFAULT_CONFIG
  }, [data])

  const [localConfig, setLocalConfig] = useState<FormConfig | null>(null)
  const currentConfig = localConfig ?? formConfig

  const saveMutation = useMutation({
    mutationFn: (config: FormConfig) => api.saveFeedbackFormConfig(config),
    onSuccess: () => {
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
      queryClient.invalidateQueries({ queryKey: ['feedback-form-config'] })
      setLocalConfig(null)
    },
  })

  const handleConfigChange = (newConfig: FormConfig) => {
    setLocalConfig(newConfig)
  }

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  // Strip trailing slashes without vulnerable regex
  const stripTrailingSlashes = (url: string): string => {
    const trimmed = url.trimEnd()
    if (!trimmed.endsWith('/')) return trimmed
    const lastNonSlash = [...trimmed].reverse().findIndex(c => c !== '/')
    return trimmed.slice(0, trimmed.length - lastNonSlash)
  }
  const apiEndpoint = stripTrailingSlashes(appConfig.apiEndpoint ?? '')

  if (isLoading) {
    return <div className="flex items-center gap-2 text-gray-500"><Loader2 className="animate-spin" size={16} /> Loading...</div>
  }

  return (
    <div className="space-y-6">
      <FormHeader
        enabled={currentConfig.enabled}
        saved={saved}
        isPending={saveMutation.isPending}
        onToggle={(enabled) => handleConfigChange({ ...currentConfig, enabled })}
        onSave={() => saveMutation.mutate(currentConfig)}
      />
      <TabNavigation activeTab={activeTab} onTabChange={setActiveTab} />
      {activeTab === 'settings' && <SettingsTab config={currentConfig} onChange={handleConfigChange} />}
      {activeTab === 'theme' && <ThemeTab config={currentConfig} onChange={handleConfigChange} />}
      {activeTab === 'embed' && <EmbedTab config={currentConfig} apiEndpoint={apiEndpoint} copied={copied} onCopy={copyToClipboard} />}
    </div>
  )
}

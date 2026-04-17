/**
 * GuidedChatModal - Interactive AI-guided conversation for process analysis and benchmarking.
 * Implements top-tier consulting frameworks (McKinsey 7S, Porter's Value Chain, BPR, Lean Six Sigma)
 * The AI asks questions to gather context, then generates a comprehensive document.
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Send, Loader2, FileText, Bot, User, GitCompareArrows } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../../api/client'

type ChatMode = 'process_analysis'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

interface GuidedChatModalProps {
  readonly isOpen: boolean
  readonly mode: ChatMode
  readonly projectId: string
  readonly onClose: () => void
  readonly onDocumentGenerated: () => void
}

function getModeConfig() {
  return {
      title: 'As-Is / To-Be Process Analysis',
      subtitle: 'AI-guided consulting framework analysis',
      icon: GitCompareArrows,
      color: 'teal',
      greeting: `Hello! I'll help you conduct an As-Is / To-Be process analysis using proven consulting frameworks: **McKinsey 7S**, **Porter's Value Chain**, **Business Process Reengineering**, and **Lean Six Sigma**.

**Here's how this works:**
1. You describe your **current process (As-Is)** - the steps, pain points, and bottlenecks
2. We'll identify **gaps** using consulting frameworks
3. You describe your **ideal future state (To-Be)** - what success looks like
4. I'll create a comprehensive document that feeds directly into your PRD/PR-FAQ creation

I'll keep this efficient - just 2-3 exchanges, then you'll have the option to proceed.

**Let's start: What process would you like to analyze?**

Please describe the current state (As-Is) - walk me through the steps, who's involved, and where you see problems. Share as much detail as you'd like upfront.`,
      systemPrompt: `You are a senior McKinsey/BCG-level business process consultant conducting an interactive As-Is / To-Be process analysis session.

**THE GOAL**: Help the user map their current process (As-Is), identify gaps using consulting frameworks, design the ideal future state (To-Be), and generate a comprehensive report that feeds directly into PRD/PR-FAQ creation.

**TWO-PHASE APPROACH**:

**PHASE 1: As-Is Analysis (Current State)**
- Let the user describe their current process first
- Ask 1-2 clarifying questions ONLY if critical information is missing
- Apply consulting frameworks: McKinsey 7S, Porter's Value Chain, Lean Six Sigma (8 Wastes), BPR
- Identify pain points, bottlenecks, and inefficiencies

**PHASE 2: To-Be Design (Future State)**
- Once As-Is is clear, ask about their ideal vision
- What outcomes do they want? What does success look like?
- Ask 1-2 clarifying questions ONLY if needed

**COMPLETION FLOW - NATURAL AND FLEXIBLE**:
Once you have sufficient information for both As-Is and To-Be:
1. Indicate readiness naturally: "I have sufficient information to generate the report. Would you like me to proceed?"
2. The "Generate Report" button will appear and remain visible
3. If user adds more details, acknowledge and incorporate them: "Great additional context. Anything else?"
4. User will click the button when they're ready - you don't need to tell them to click it

**IMPORTANT**:
- Use natural phrases like "sufficient information to generate the report", "ready to generate", "generate the report"
- The button appears automatically when you signal readiness
- User can continue adding details even after button appears
- Let the user decide when to click - don't be pushy

**Questions to prioritize (ask naturally, not as checklist)**:
1. What process are you analyzing? (Let them describe As-Is)
2. Where are the main pain points/bottlenecks?
3. What does the ideal To-Be state look like?
4. (Optional) Any constraints or key metrics?

**Consulting frameworks to apply**:
- **Gap Analysis**: Current vs Desired with prioritization (P0/P1/P2/P3)
- **Value Stream Mapping**: Value-add vs non-value-add activities
- **Root Cause Analysis**: 5 Whys for underlying issues
- **Impact vs Effort Matrix**: Quick wins vs strategic initiatives

**OUTPUT PURPOSE**:
The generated report will be automatically referenced when the team creates PRDs and PR-FAQs. Your analysis grounds requirements in actual process understanding, not assumptions.

**STYLE**:
- Ask ONE question at a time
- Be conversational, friendly, consultative
- Acknowledge their input before asking next question
- Keep responses concise (2-4 sentences + 1 question)
- Do NOT ask more than necessary - if they provide rich detail upfront, move to completion faster`,
      generatePrompt: `Based on our conversation, generate a comprehensive As-Is / To-Be Process Analysis document using top-tier consulting frameworks.

## CONVERSATION CONTEXT:
{conversation}

Generate a professional consulting-grade report with these sections:

# Executive Summary
- Current state overview
- Key findings (top 3-5 pain points)
- Recommended approach
- Expected impact

# 1. As-Is Process Map
- Numbered steps with actors, systems, and handoffs
- Current cycle time and error rates
- Visual flow (use markdown formatting)

# 2. Framework Analysis

## 2.1 McKinsey 7S Framework Analysis
- **Strategy**: Current strategic alignment
- **Structure**: Organizational setup
- **Systems**: Tools and processes
- **Shared Values**: Culture and values
- **Style**: Leadership approach
- **Staff**: People and capabilities
- **Skills**: Core competencies
- Assessment of alignment and gaps

## 2.2 Porter's Value Chain Analysis
**Primary Activities**:
- Inbound logistics
- Operations
- Outbound logistics
- Marketing & sales
- Service

**Support Activities**:
- Firm infrastructure
- HR management
- Technology development
- Procurement

Identify where value is created vs destroyed

## 2.3 Lean Six Sigma - 8 Wastes Analysis
For each waste category, provide specific examples from the process:
1. **Defects**: Errors requiring rework
2. **Overproduction**: Making more than needed
3. **Waiting**: Idle time between steps
4. **Non-utilized talent**: Underutilized skills
5. **Transportation**: Unnecessary movement of materials/data
6. **Inventory**: Excess WIP or backlogs
7. **Motion**: Unnecessary movement of people
8. **Extra-processing**: Redundant work

# 3. Pain Points & Friction Analysis
- By process step with severity (Critical/High/Medium/Low)
- Root cause analysis (5 Whys)
- Impact on KPIs

# 4. Gap Analysis
| Gap | Current State | Desired State | Priority | Effort |
|-----|---------------|---------------|----------|--------|
| Gap 1 | ... | ... | P0 | High |
| Gap 2 | ... | ... | P1 | Medium |

**Priority levels**: P0 = Critical (blockers), P1 = High (major impact), P2 = Medium (important), P3 = Low (nice-to-have)

# 5. To-Be Process Design
- Improved flow with eliminated waste
- New cycle time targets
- Technology enablers
- Governance model

# 6. Implementation Roadmap

## Phase 1: Quick Wins (0-30 days)
- Low effort, high impact improvements
- No budget required
- Specific action items with owners

## Phase 2: Core Improvements (1-3 months)
- Medium complexity changes
- Moderate investment
- Specific initiatives

## Phase 3: Strategic Transformation (3-6 months)
- High complexity, high impact
- Significant investment
- Long-term structural changes

# 7. Success Metrics & KPIs
| Metric | Current | Target | Measurement Method |
|--------|---------|--------|-------------------|
| Cycle Time | X days | Y days | ... |
| Error Rate | X% | Y% | ... |
| Customer Sat | X/10 | Y/10 | ... |

# 8. Risk Assessment & Mitigation
- Change management risks
- Technical risks
- Resource risks
- Mitigation strategies for each

# 9. Stakeholder Engagement Plan
- Key stakeholders and their concerns
- Communication strategy
- Buy-in tactics

Be specific and actionable. Use real data from the conversation.`,
      inputPlaceholder: 'Type your message... (Enter to send)',
      generateLabel: 'Generate Report',
      generatingLabel: 'Generating report...',
      successMessage: 'Report generated successfully! 📄\n\nYou can find it in the **Documents** tab. This analysis will be automatically referenced when generating PRDs.',
      errorMessage: 'Failed to generate report. Please try again.',
    }
}

export default function GuidedChatModal({ isOpen, mode, projectId, onClose, onDocumentGenerated }: GuidedChatModalProps) {
  const config = getModeConfig()
  const Icon = config.icon
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: config.greeting }
  ])
  const [input, setInput] = useState('')
  const [isThinking, setIsThinking] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [canGenerate, setCanGenerate] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (isOpen) {
      setMessages([{ role: 'assistant', content: config.greeting }])
      setInput('')
      setCanGenerate(false)
      setIsGenerating(false)
      setIsThinking(false)
    }
  }, [isOpen, config.greeting])

  // Enable generate button when AI signals sufficient information
  // Button never disappears once shown - user controls when to click
  useEffect(() => {
    if (canGenerate) return // Once true, stays true

    const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant')
    if (!lastAssistantMsg) return

    const content = lastAssistantMsg.content.toLowerCase()
    const aiSignaledReady = (
      (content.includes('generate') && content.includes('report')) ||
      content.includes('sufficient information') ||
      content.includes('enough information')
    )

    if (aiSignaledReady) setCanGenerate(true)
  }, [messages, canGenerate])

  const handleSend = useCallback(async () => {
    if (!input.trim() || isThinking) return

    const userMessage = input.trim()
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: userMessage }])
    setIsThinking(true)

    try {
      // Build conversation for context - include system prompt and conversation history in the message
      const conversationForAI = [...messages, { role: 'user' as const, content: userMessage }]
        .map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`)
        .join('\n\n')

      // Prepend system prompt and conversation to the user message for context
      const contextualMessage = `SYSTEM INSTRUCTIONS:\n${config.systemPrompt}\n\nCONVERSATION HISTORY:\n${conversationForAI}\n\nRESPOND TO THE LATEST USER MESSAGE ABOVE.`

      const result = await api.projectChat(projectId, contextualMessage)

      if (result.success && result.response) {
        setMessages(prev => [...prev, { role: 'assistant', content: result.response }])
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' }])
    } finally {
      setIsThinking(false)
      inputRef.current?.focus()
    }
  }, [input, isThinking, messages, projectId, config.systemPrompt])

  const handleGenerateReport = useCallback(async () => {
    setIsGenerating(true)
    setMessages(prev => [...prev, { role: 'assistant', content: `${config.generatingLabel} ⏳` }])

    try {
      const conversation = messages
        .map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.content}`)
        .join('\n\n')

      const generatePrompt = config.generatePrompt.replace('{conversation}', conversation)

      const result = await api.generateDocument(projectId, {
        doc_type: 'process_analysis' as const,
        title: `${config.title} - ${new Date().toLocaleDateString()}`,
        feature_idea: generatePrompt,
        process_description: conversation,
        data_sources: { feedback: true, personas: true, documents: false, research: false },
        selected_persona_ids: [],
        selected_document_ids: [],
        feedback_sources: [],
        feedback_categories: [],
        days: 30,
      })

      if (result.success) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: config.successMessage
        }])
        onDocumentGenerated()
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: config.errorMessage }])
    } finally {
      setIsGenerating(false)
    }
  }, [messages, projectId, mode, config, onDocumentGenerated])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-3xl h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className={`flex items-center justify-between px-6 py-4 border-b bg-${config.color}-50`}>
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg bg-${config.color}-100 flex items-center justify-center`}>
              <Icon size={20} className={`text-${config.color}-600`} />
            </div>
            <div>
              <h2 className="font-semibold text-gray-900">{config.title}</h2>
              <p className="text-xs text-gray-500">{config.subtitle}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((msg, idx) => (
            <div key={idx} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                msg.role === 'assistant' ? `bg-${config.color}-100` : 'bg-gray-200'
              }`}>
                {msg.role === 'assistant' ? <Bot size={16} className={`text-${config.color}-600`} /> : <User size={16} className="text-gray-600" />}
              </div>
              <div className={`max-w-[80%] rounded-2xl px-4 py-3 ${
                msg.role === 'user'
                  ? 'bg-gray-900 text-white rounded-br-md'
                  : 'bg-gray-100 text-gray-800 rounded-bl-md'
              }`}>
                <div className="text-sm prose prose-sm max-w-none dark:prose-invert">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                </div>
              </div>
            </div>
          ))}
          {isThinking && (
            <div className="flex gap-3">
              <div className={`w-8 h-8 rounded-full bg-${config.color}-100 flex items-center justify-center`}>
                <Bot size={16} className={`text-${config.color}-600`} />
              </div>
              <div className="bg-gray-100 rounded-2xl rounded-bl-md px-4 py-3">
                <Loader2 size={16} className="animate-spin text-gray-400" />
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Generate Report Button */}
        {canGenerate && !isGenerating && (
          <div className="px-4 py-2 border-t bg-gradient-to-r from-green-50 to-emerald-50">
            <button
              onClick={handleGenerateReport}
              className="w-full py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-lg flex items-center justify-center gap-2 text-sm font-medium transition-colors"
            >
              <FileText size={16} />
              {config.generateLabel}
            </button>
          </div>
        )}

        {isGenerating && (
          <div className="px-4 py-2 border-t bg-amber-50">
            <div className="flex items-center justify-center gap-2 py-2 text-sm text-amber-700">
              <Loader2 size={16} className="animate-spin" />
              {config.generatingLabel}
            </div>
          </div>
        )}

        {/* Input */}
        <div className="px-4 py-3 border-t bg-white">
          <div className="flex gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={config.inputPlaceholder}
              rows={1}
              disabled={isThinking || isGenerating}
              className="flex-1 resize-none border rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={!input.trim() || isThinking || isGenerating}
              className={`px-4 rounded-xl bg-${config.color}-600 text-white hover:bg-${config.color}-700 disabled:opacity-50 transition-colors`}
            >
              <Send size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

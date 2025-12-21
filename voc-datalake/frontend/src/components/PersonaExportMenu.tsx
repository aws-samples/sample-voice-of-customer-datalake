/**
 * @fileoverview Persona export menu component.
 *
 * Export options for customer personas:
 * - Copy as Markdown
 * - Download as PDF with formatted sections
 *
 * @module components/PersonaExportMenu
 */

import { useState, useRef, useEffect } from 'react'
import { Copy, Check, FileDown, MoreVertical, FileText, FileType } from 'lucide-react'
import type { ProjectPersona } from '../api/client'
import jsPDF from 'jspdf'
import html2canvas from 'html2canvas'
import { createRoot } from 'react-dom/client'

interface PersonaExportMenuProps {
  persona: ProjectPersona | null
}

export default function PersonaExportMenu({ persona }: PersonaExportMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [exporting, setExporting] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    window.document.addEventListener('mousedown', handleClickOutside)
    return () => window.document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  if (!persona) return null

  const sanitizeFilename = (name: string) => name.replace(/[^a-z0-9]/gi, '_')

  // Convert persona to markdown format
  const personaToMarkdown = (): string => {
    const lines: string[] = []
    
    lines.push(`# ${persona.name}`)
    lines.push(`*${persona.tagline}*`)
    lines.push('')
    
    if (persona.confidence) {
      lines.push(`**Confidence:** ${persona.confidence}${persona.feedback_count ? ` (${persona.feedback_count} reviews)` : ''}`)
      lines.push('')
    }
    
    // Identity & Demographics
    const identity = persona.identity || persona.demographics
    if (identity) {
      lines.push('## Identity & Demographics')
      if (identity.bio) lines.push(identity.bio)
      lines.push('')
      const attrs = Object.entries(identity).filter(([k, v]) => k !== 'bio' && v)
      if (attrs.length > 0) {
        attrs.forEach(([k, v]) => lines.push(`- **${k.replace(/_/g, ' ')}:** ${v}`))
        lines.push('')
      }
    }
    
    // Goals & Motivations
    const goals = persona.goals_motivations
    if (goals || persona.goals?.length) {
      lines.push('## Goals & Motivations')
      if (goals?.primary_goal) lines.push(`**Primary Goal:** ${goals.primary_goal}`)
      const secondaryGoals = goals?.secondary_goals || persona.goals || []
      if (secondaryGoals.length > 0) {
        lines.push('**Secondary Goals:**')
        secondaryGoals.forEach(g => lines.push(`- ${g}`))
      }
      if (goals?.underlying_motivations?.length) {
        lines.push('**Underlying Motivations:**')
        goals.underlying_motivations.forEach(m => lines.push(`- ${m}`))
      }
      lines.push('')
    }
    
    // Pain Points & Frustrations
    const painPoints = persona.pain_points
    if (painPoints || persona.frustrations?.length) {
      lines.push('## Pain Points & Frustrations')
      const challenges = painPoints?.current_challenges || persona.frustrations || []
      if (challenges.length > 0) {
        lines.push('**Current Challenges:**')
        challenges.forEach(c => lines.push(`- ${c}`))
      }
      if (painPoints?.blockers?.length) {
        lines.push('**Blockers:**')
        painPoints.blockers.forEach(b => lines.push(`- ${b}`))
      }
      if (painPoints?.workarounds?.length) {
        lines.push('**Workarounds:**')
        painPoints.workarounds.forEach(w => lines.push(`- ${w}`))
      }
      lines.push('')
    }
    
    // Behaviors
    const behaviors = persona.behaviors
    if (behaviors) {
      lines.push('## Behaviors & Habits')
      if (Array.isArray(behaviors)) {
        behaviors.forEach(b => lines.push(`- ${b}`))
      } else {
        if (behaviors.current_solutions?.length) {
          lines.push('**Current Solutions:**')
          behaviors.current_solutions.forEach(s => lines.push(`- ${s}`))
        }
        if (behaviors.tech_savviness) lines.push(`- **Tech Savviness:** ${behaviors.tech_savviness}`)
        if (behaviors.activity_frequency) lines.push(`- **Activity Frequency:** ${behaviors.activity_frequency}`)
        if (behaviors.decision_style) lines.push(`- **Decision Style:** ${behaviors.decision_style}`)
        if (behaviors.tools_used?.length) lines.push(`- **Tools Used:** ${behaviors.tools_used.join(', ')}`)
      }
      lines.push('')
    }
    
    // Context & Environment
    if (persona.context_environment) {
      lines.push('## Context & Environment')
      if (persona.context_environment.usage_context) lines.push(persona.context_environment.usage_context)
      if (persona.context_environment.devices?.length) lines.push(`**Devices:** ${persona.context_environment.devices.join(', ')}`)
      if (persona.context_environment.time_constraints) lines.push(`**Time Constraints:** ${persona.context_environment.time_constraints}`)
      lines.push('')
    }
    
    // Quotes
    if (persona.quotes?.length || persona.quote) {
      lines.push('## Representative Quotes')
      if (persona.quotes?.length) {
        persona.quotes.forEach(q => {
          lines.push(`> "${q.text}"`)
          if (q.context) lines.push(`> — ${q.context}`)
          lines.push('')
        })
      } else if (persona.quote) {
        lines.push(`> "${persona.quote}"`)
        lines.push('')
      }
    }
    
    // Scenario
    if (persona.scenario) {
      lines.push('## Scenario')
      if (typeof persona.scenario === 'string') {
        lines.push(persona.scenario)
      } else {
        if (persona.scenario.title) lines.push(`### ${persona.scenario.title}`)
        if (persona.scenario.narrative) lines.push(persona.scenario.narrative)
        if (persona.scenario.trigger) lines.push(`**Trigger:** ${persona.scenario.trigger}`)
        if (persona.scenario.outcome) lines.push(`**Desired Outcome:** ${persona.scenario.outcome}`)
      }
      lines.push('')
    }
    
    // Research Notes
    if (persona.research_notes?.length) {
      lines.push('## Research Notes')
      persona.research_notes.forEach(note => {
        const text = typeof note === 'string' ? note : note.text
        lines.push(`- ${text}`)
      })
      lines.push('')
    }
    
    // Needs (legacy support)
    if (persona.needs?.length && !persona.goals_motivations) {
      lines.push('## Needs')
      persona.needs.forEach(n => lines.push(`- ${n}`))
      lines.push('')
    }
    
    return lines.join('\n')
  }

  const copyContent = async () => {
    await navigator.clipboard.writeText(personaToMarkdown())
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const downloadAsMarkdown = () => {
    const blob = new Blob([personaToMarkdown()], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = window.document.createElement('a')
    a.href = url
    a.download = `${sanitizeFilename(persona.name)}_persona.md`
    a.click()
    URL.revokeObjectURL(url)
    setIsOpen(false)
  }

  const downloadAsTxt = () => {
    const content = personaToMarkdown()
      .replace(/#{1,6}\s/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/^>\s/gm, '')
    
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = window.document.createElement('a')
    a.href = url
    a.download = `${sanitizeFilename(persona.name)}_persona.txt`
    a.click()
    URL.revokeObjectURL(url)
    setIsOpen(false)
  }

  const downloadAsPDF = async () => {
    setExporting(true)
    try {
      const iframe = window.document.createElement('iframe')
      iframe.style.position = 'absolute'
      iframe.style.left = '-9999px'
      iframe.style.top = '0'
      iframe.style.width = '800px'
      iframe.style.height = '10000px'
      iframe.style.border = 'none'
      window.document.body.appendChild(iframe)

      await new Promise<void>((resolve) => {
        iframe.onload = () => resolve()
        iframe.src = 'about:blank'
      })

      const iframeDoc = iframe.contentDocument!
      const container = iframeDoc.createElement('div')
      container.style.width = '800px'
      container.style.backgroundColor = '#ffffff'
      container.style.fontFamily = 'system-ui, -apple-system, sans-serif'
      container.style.color = '#000000'
      iframeDoc.body.appendChild(container)
      iframeDoc.body.style.margin = '0'
      iframeDoc.body.style.padding = '0'
      iframeDoc.body.style.backgroundColor = '#ffffff'

      const root = createRoot(container)
      
      const identity = persona.identity || persona.demographics
      const goals = persona.goals_motivations
      const painPoints = persona.pain_points
      
      const PDFContent = () => (
        <div style={{ padding: '40px', backgroundColor: 'white' }}>
          {/* Header */}
          <div data-pdf-section style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
            {persona.avatar_url ? (
              <img 
                src={persona.avatar_url} 
                alt={persona.name}
                style={{ 
                  width: '80px', height: '80px', borderRadius: '50%', 
                  objectFit: 'cover', border: '3px solid #e9d5ff'
                }}
                crossOrigin="anonymous"
              />
            ) : (
              <div style={{ 
                width: '80px', height: '80px', borderRadius: '50%', 
                background: 'linear-gradient(135deg, #8b5cf6, #ec4899)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'white', fontSize: '32px', fontWeight: 'bold'
              }}>
                {persona.name.charAt(0)}
              </div>
            )}
            <div>
              <h1 style={{ fontSize: '28px', fontWeight: 'bold', margin: 0, color: '#111827' }}>{persona.name}</h1>
              <p style={{ fontSize: '16px', color: '#6b7280', margin: '4px 0 0 0' }}>{persona.tagline}</p>
              {persona.confidence && (
                <span style={{ 
                  display: 'inline-block', marginTop: '8px', padding: '4px 12px', 
                  backgroundColor: persona.confidence === 'high' ? '#dcfce7' : persona.confidence === 'medium' ? '#fef9c3' : '#f3f4f6',
                  color: persona.confidence === 'high' ? '#166534' : persona.confidence === 'medium' ? '#854d0e' : '#374151',
                  borderRadius: '12px', fontSize: '12px', fontWeight: '500'
                }}>
                  {persona.confidence} confidence{persona.feedback_count ? ` • ${persona.feedback_count} reviews` : ''}
                </span>
              )}
            </div>
          </div>
          
          <hr style={{ border: 'none', borderTop: '2px solid #e5e7eb', marginBottom: '24px' }} />
          
          {/* Identity */}
          {identity && (
            <div data-pdf-section style={{ marginBottom: '24px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#7c3aed', marginBottom: '12px' }}>👤 Identity & Demographics</h2>
              {identity.bio && <p style={{ color: '#374151', marginBottom: '12px', lineHeight: '1.6' }}>{identity.bio}</p>}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {Object.entries(identity).filter(([k, v]) => k !== 'bio' && v).map(([k, v]) => (
                  <span key={k} style={{ padding: '4px 10px', backgroundColor: '#f3e8ff', color: '#7c3aed', borderRadius: '6px', fontSize: '12px' }}>
                    {k.replace(/_/g, ' ')}: {String(v)}
                  </span>
                ))}
              </div>
            </div>
          )}
          
          {/* Goals */}
          {(goals || persona.goals?.length) && (
            <div data-pdf-section style={{ marginBottom: '24px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#16a34a', marginBottom: '12px' }}>🎯 Goals & Motivations</h2>
              {goals?.primary_goal && (
                <div data-pdf-section style={{ padding: '12px', backgroundColor: '#f0fdf4', borderRadius: '8px', marginBottom: '12px' }}>
                  <p style={{ fontSize: '12px', color: '#16a34a', fontWeight: '500', marginBottom: '4px' }}>Primary Goal</p>
                  <p style={{ color: '#374151', margin: 0 }}>{goals.primary_goal}</p>
                </div>
              )}
              {(goals?.secondary_goals || persona.goals)?.length > 0 && (
                <div data-pdf-section style={{ marginBottom: '12px' }}>
                  <p style={{ fontSize: '14px', fontWeight: '500', color: '#6b7280', marginBottom: '8px' }}>Secondary Goals</p>
                  <ul style={{ margin: 0, paddingLeft: '20px', color: '#374151' }}>
                    {(goals?.secondary_goals || persona.goals || []).map((g, i) => <li key={i} style={{ marginBottom: '4px' }}>{g}</li>)}
                  </ul>
                </div>
              )}
              {(goals?.underlying_motivations?.length ?? 0) > 0 && (
                <div data-pdf-section>
                  <p style={{ fontSize: '14px', fontWeight: '500', color: '#6b7280', marginBottom: '8px' }}>Underlying Motivations</p>
                  <ul style={{ margin: 0, paddingLeft: '20px', color: '#374151' }}>
                    {goals?.underlying_motivations?.map((m, i) => <li key={i} style={{ marginBottom: '4px' }}>{m}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
          
          {/* Pain Points */}
          {(painPoints || persona.frustrations?.length) && (
            <div data-pdf-section style={{ marginBottom: '24px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#dc2626', marginBottom: '12px' }}>😤 Pain Points & Frustrations</h2>
              {(painPoints?.current_challenges || persona.frustrations || []).length > 0 && (
                <div data-pdf-section style={{ marginBottom: '12px' }}>
                  <p style={{ fontSize: '14px', fontWeight: '500', color: '#6b7280', marginBottom: '8px' }}>Current Challenges</p>
                  <ul style={{ margin: 0, paddingLeft: '20px', color: '#374151' }}>
                    {(painPoints?.current_challenges || persona.frustrations || []).map((f, i) => <li key={i} style={{ marginBottom: '4px' }}>{f}</li>)}
                  </ul>
                </div>
              )}
              {(painPoints?.blockers?.length ?? 0) > 0 && (
                <div data-pdf-section style={{ marginBottom: '12px' }}>
                  <p style={{ fontSize: '14px', fontWeight: '500', color: '#6b7280', marginBottom: '8px' }}>Blockers</p>
                  <ul style={{ margin: 0, paddingLeft: '20px', color: '#374151' }}>
                    {painPoints?.blockers?.map((b, i) => <li key={i} style={{ marginBottom: '4px' }}>{b}</li>)}
                  </ul>
                </div>
              )}
              {(painPoints?.workarounds?.length ?? 0) > 0 && (
                <div data-pdf-section>
                  <p style={{ fontSize: '14px', fontWeight: '500', color: '#6b7280', marginBottom: '8px' }}>Current Workarounds</p>
                  <ul style={{ margin: 0, paddingLeft: '20px', color: '#374151' }}>
                    {painPoints?.workarounds?.map((w, i) => <li key={i} style={{ marginBottom: '4px' }}>{w}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
          
          {/* Behaviors & Habits */}
          {persona.behaviors && (
            <div data-pdf-section style={{ marginBottom: '24px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#2563eb', marginBottom: '12px' }}>🔄 Behaviors & Habits</h2>
              {Array.isArray(persona.behaviors) ? (
                <ul style={{ margin: 0, paddingLeft: '20px', color: '#374151' }}>
                  {persona.behaviors.map((b, i) => <li key={i} style={{ marginBottom: '4px' }}>{b}</li>)}
                </ul>
              ) : (
                <div>
                  {((persona.behaviors as { current_solutions?: string[] })?.current_solutions?.length ?? 0) > 0 && (
                    <div data-pdf-section style={{ marginBottom: '12px' }}>
                      <p style={{ fontSize: '14px', fontWeight: '500', color: '#6b7280', marginBottom: '8px' }}>Current Solutions</p>
                      <ul style={{ margin: 0, paddingLeft: '20px', color: '#374151' }}>
                        {(persona.behaviors as { current_solutions?: string[] })?.current_solutions?.map((s, i) => <li key={i} style={{ marginBottom: '4px' }}>{s}</li>)}
                      </ul>
                    </div>
                  )}
                  <div data-pdf-section style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
                    {persona.behaviors.tech_savviness && (
                      <span style={{ padding: '4px 10px', backgroundColor: '#dbeafe', color: '#1d4ed8', borderRadius: '6px', fontSize: '12px' }}>
                        Tech: {persona.behaviors.tech_savviness}
                      </span>
                    )}
                    {persona.behaviors.activity_frequency && (
                      <span style={{ padding: '4px 10px', backgroundColor: '#dbeafe', color: '#1d4ed8', borderRadius: '6px', fontSize: '12px' }}>
                        {persona.behaviors.activity_frequency}
                      </span>
                    )}
                    {persona.behaviors.decision_style && (
                      <span style={{ padding: '4px 10px', backgroundColor: '#dbeafe', color: '#1d4ed8', borderRadius: '6px', fontSize: '12px' }}>
                        {persona.behaviors.decision_style}
                      </span>
                    )}
                  </div>
                  {((persona.behaviors as { tools_used?: string[] })?.tools_used?.length ?? 0) > 0 && (
                    <div data-pdf-section>
                      <p style={{ fontSize: '14px', fontWeight: '500', color: '#6b7280', marginBottom: '8px' }}>Tools Used</p>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {(persona.behaviors as { tools_used?: string[] })?.tools_used?.map((t, i) => (
                          <span key={i} style={{ padding: '2px 8px', backgroundColor: '#f3f4f6', color: '#4b5563', borderRadius: '4px', fontSize: '12px' }}>{t}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          
          {/* Context & Environment */}
          {persona.context_environment && (
            <div data-pdf-section style={{ marginBottom: '24px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#d97706', marginBottom: '12px' }}>🌍 Context & Environment</h2>
              {persona.context_environment.usage_context && (
                <p style={{ color: '#374151', marginBottom: '12px', lineHeight: '1.6' }}>{persona.context_environment.usage_context}</p>
              )}
              {(persona.context_environment.devices?.length ?? 0) > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
                  {persona.context_environment.devices?.map((d, i) => (
                    <span key={i} style={{ padding: '4px 10px', backgroundColor: '#fef3c7', color: '#92400e', borderRadius: '6px', fontSize: '12px' }}>{d}</span>
                  ))}
                </div>
              )}
              {persona.context_environment.time_constraints && (
                <p style={{ color: '#374151', fontSize: '14px' }}><strong>Time constraints:</strong> {persona.context_environment.time_constraints}</p>
              )}
            </div>
          )}
          
          {/* Quotes */}
          {(persona.quotes?.length || persona.quote) && (
            <div data-pdf-section style={{ marginBottom: '24px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#6366f1', marginBottom: '12px' }}>💬 Representative Quotes</h2>
              {persona.quotes?.length ? persona.quotes.map((q, i) => (
                <blockquote key={i} data-pdf-section style={{ borderLeft: '4px solid #a5b4fc', paddingLeft: '16px', margin: '0 0 12px 0', fontStyle: 'italic', color: '#374151' }}>
                  "{q.text}"
                  {q.context && <p style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>— {q.context}</p>}
                </blockquote>
              )) : persona.quote && (
                <blockquote style={{ borderLeft: '4px solid #a5b4fc', paddingLeft: '16px', margin: 0, fontStyle: 'italic', color: '#374151' }}>
                  "{persona.quote}"
                </blockquote>
              )}
            </div>
          )}
          
          {/* Scenario */}
          {persona.scenario && (
            <div data-pdf-section style={{ marginBottom: '24px', pageBreakInside: 'avoid' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#0d9488', marginBottom: '12px' }}>📖 Scenario</h2>
              {typeof persona.scenario === 'string' ? (
                <p data-pdf-section style={{ color: '#374151', lineHeight: '1.6' }}>{persona.scenario}</p>
              ) : (
                <div>
                  {persona.scenario.title && <h3 data-pdf-section style={{ fontSize: '16px', fontWeight: '500', marginBottom: '8px' }}>{persona.scenario.title}</h3>}
                  {persona.scenario.narrative && <p data-pdf-section style={{ color: '#374151', lineHeight: '1.6', marginBottom: '12px' }}>{persona.scenario.narrative}</p>}
                  {(persona.scenario.trigger || persona.scenario.outcome) && (
                    <div data-pdf-section style={{ display: 'flex', gap: '16px', pageBreakInside: 'avoid' }}>
                      {persona.scenario.trigger && (
                        <div style={{ flex: 1, padding: '12px', backgroundColor: '#f0fdfa', borderRadius: '8px' }}>
                          <p style={{ fontSize: '12px', color: '#0d9488', fontWeight: '500', marginBottom: '4px' }}>Trigger</p>
                          <p style={{ color: '#374151', margin: 0, fontSize: '14px' }}>{persona.scenario.trigger}</p>
                        </div>
                      )}
                      {persona.scenario.outcome && (
                        <div style={{ flex: 1, padding: '12px', backgroundColor: '#f0fdfa', borderRadius: '8px' }}>
                          <p style={{ fontSize: '12px', color: '#0d9488', fontWeight: '500', marginBottom: '4px' }}>Desired Outcome</p>
                          <p style={{ color: '#374151', margin: 0, fontSize: '14px' }}>{persona.scenario.outcome}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          
          {/* Research Notes */}
          {(persona.research_notes?.length ?? 0) > 0 && (
            <div data-pdf-section style={{ marginBottom: '24px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#6b7280', marginBottom: '12px' }}>📝 Research Notes</h2>
              <ul style={{ margin: 0, paddingLeft: '20px', color: '#374151' }}>
                {persona.research_notes?.map((note, i) => (
                  <li key={i} style={{ marginBottom: '4px' }}>{typeof note === 'string' ? note : note.text}</li>
                ))}
              </ul>
            </div>
          )}
          
          {/* Footer */}
          <div data-pdf-section>
          <hr style={{ border: 'none', borderTop: '1px solid #e5e7eb', marginTop: '32px', marginBottom: '16px' }} />
          <p style={{ fontSize: '11px', color: '#9ca3af', textAlign: 'center' }}>
            Generated on {new Date().toLocaleDateString()} • VoC Analytics
          </p>
          </div>
        </div>
      )

      await new Promise<void>((resolve) => {
        root.render(<PDFContent />)
        setTimeout(resolve, 200)
      })

      // Get all section elements to find safe page break points
      // Store both offset and height for each section
      const sections = container.querySelectorAll('[data-pdf-section]')
      const sectionBounds: { top: number; bottom: number }[] = []
      sections.forEach((section) => {
        const el = section as HTMLElement
        sectionBounds.push({
          top: el.offsetTop,
          bottom: el.offsetTop + el.offsetHeight
        })
      })

      const canvas = await html2canvas(container, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
      })

      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
      const pageWidth = pdf.internal.pageSize.getWidth()
      const pageHeight = pdf.internal.pageSize.getHeight()
      const margin = 10
      const contentWidth = pageWidth - (margin * 2)
      const contentHeight = pageHeight - (margin * 2)
      
      const imgWidthMM = contentWidth
      const scale = canvas.width / 800 // Original container width
      const pxPerMM = canvas.width / imgWidthMM
      const pageHeightPx = contentHeight * pxPerMM
      
      let currentY = 0
      let pageNum = 0
      
      while (currentY < canvas.height) {
        if (pageNum > 0) pdf.addPage()
        
        // Calculate where we'd ideally end this page
        const idealEndY = currentY + pageHeightPx
        
        // Find a safe break point (at a section boundary)
        let endY: number
        if (idealEndY >= canvas.height) {
          endY = canvas.height
        } else {
          // Scale section bounds to canvas coordinates
          const scaledBounds = sectionBounds.map(b => ({
            top: b.top * scale,
            bottom: b.bottom * scale
          }))
          
          // Find the best break point - prefer section tops that are:
          // 1. After current position
          // 2. Before or at the ideal end
          // 3. Closest to the ideal end without going over
          let bestBreak = idealEndY
          let foundGoodBreak = false
          
          // Search within 35% of page height for a good break (increased from 20%)
          const searchStart = idealEndY - (pageHeightPx * 0.35)
          
          // First pass: find section tops that would make good break points
          for (const bounds of scaledBounds) {
            // A section top is a good break if it's within our search range
            if (bounds.top > currentY + 50 && bounds.top >= searchStart && bounds.top <= idealEndY) {
              // Check if breaking here would cut through another section
              const wouldCutSection = scaledBounds.some(b => 
                b.top < bounds.top && b.bottom > bounds.top && b.bottom <= idealEndY + 20
              )
              
              if (!wouldCutSection) {
                bestBreak = bounds.top
                foundGoodBreak = true
              }
            }
          }
          
          // If no good break found, look for any section boundary
          if (!foundGoodBreak) {
            // Find the last section that ends before idealEndY
            for (const bounds of scaledBounds) {
              if (bounds.bottom > currentY + 50 && bounds.bottom <= idealEndY) {
                bestBreak = bounds.bottom
                foundGoodBreak = true
              }
            }
          }
          
          // If still no good break, check if we're cutting through a section
          // and if so, break before that section starts
          if (!foundGoodBreak) {
            for (const bounds of scaledBounds) {
              if (bounds.top < idealEndY && bounds.bottom > idealEndY && bounds.top > currentY + 50) {
                // We would cut this section - break before it instead
                bestBreak = bounds.top
                foundGoodBreak = true
                break
              }
            }
          }
          
          endY = bestBreak
        }
        
        const sourceHeight = endY - currentY
        
        const pageCanvas = window.document.createElement('canvas')
        pageCanvas.width = canvas.width
        pageCanvas.height = sourceHeight
        const ctx = pageCanvas.getContext('2d')!
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height)
        ctx.drawImage(canvas, 0, currentY, canvas.width, sourceHeight, 0, 0, canvas.width, sourceHeight)
        
        const pageImgData = pageCanvas.toDataURL('image/jpeg', 0.92)
        const pageImgHeightMM = (sourceHeight / pxPerMM)
        
        pdf.addImage(pageImgData, 'JPEG', margin, margin, imgWidthMM, pageImgHeightMM)
        
        currentY = endY
        pageNum++
        
        // Safety check to prevent infinite loops
        if (pageNum > 50) break
      }

      root.unmount()
      window.document.body.removeChild(iframe)
      pdf.save(`${sanitizeFilename(persona.name)}_persona.pdf`)
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error('PDF export failed:', error)
      }
    } finally {
      setExporting(false)
      setIsOpen(false)
    }
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
        title="Export persona"
        aria-label="Export persona"
        aria-expanded={isOpen}
        aria-haspopup="menu"
      >
        <MoreVertical size={18} />
      </button>

      {isOpen && (
        <div 
          className="absolute right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 w-52 max-w-[calc(100vw-2rem)] py-1"
          role="menu"
          aria-orientation="vertical"
        >
          <button
            onClick={copyContent}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
            role="menuitem"
          >
            {copied ? <Check size={16} className="text-green-500 flex-shrink-0" /> : <Copy size={16} className="flex-shrink-0" />}
            <span className="truncate">{copied ? 'Copied!' : 'Copy as Markdown'}</span>
          </button>

          <hr className="my-1 border-gray-100" />

          <button
            onClick={downloadAsMarkdown}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
            role="menuitem"
          >
            <FileText size={16} className="flex-shrink-0" />
            <span className="truncate">Download as Markdown</span>
          </button>

          <button
            onClick={downloadAsPDF}
            disabled={exporting}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50"
            role="menuitem"
          >
            <FileDown size={16} className="flex-shrink-0" />
            <span className="truncate">{exporting ? 'Generating PDF...' : 'Download as PDF'}</span>
          </button>

          <button
            onClick={downloadAsTxt}
            className="w-full flex items-center gap-2 px-3 py-2.5 sm:py-2 text-sm text-gray-700 hover:bg-gray-50 active:bg-gray-100"
            role="menuitem"
          >
            <FileType size={16} className="flex-shrink-0" />
            <span className="truncate">Download as TXT</span>
          </button>
        </div>
      )}
    </div>
  )
}

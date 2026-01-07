/**
 * @fileoverview Modal components for ArtifactBuilder.
 * @module pages/ArtifactBuilder/ArtifactBuilderModals
 */

import { useState } from 'react'
import {
  Sparkles,
  Loader2,
  ChevronDown,
  Plus,
  X,
  RefreshCw,
  Code,
  Copy,
  Check,
  Folder,
  ArrowLeft,
  Download,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import clsx from 'clsx'
import { CodeViewer } from './ArtifactBuilderComponents'
import { getFileIcon } from './artifactBuilderHelpers'

// Types
interface Template {
  id: string
  name: string
}

interface Style {
  id: string
  name: string
}

interface SourceFile {
  path: string
  type: 'file' | 'folder'
}

// BuildModal Component
interface BuildModalProps {
  readonly templates: Template[]
  readonly styles: Style[]
  readonly isCreating: boolean
  readonly createError: Error | null
  readonly onClose: () => void
  readonly onSubmit: (data: {
    prompt: string
    projectType: string
    style: string
    includeMockData: boolean
    pages: string[]
  }) => void
}

export function BuildModal({ templates, styles, isCreating, createError, onClose, onSubmit }: BuildModalProps) {
  const [prompt, setPrompt] = useState('')
  const [projectType, setProjectType] = useState('react-vite')
  const [style, setStyle] = useState('minimal')
  const [includeMockData, setIncludeMockData] = useState(false)
  const [pages, setPages] = useState<string[]>([])
  const [newPage, setNewPage] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!prompt.trim()) return
    onSubmit({ prompt: prompt.trim(), projectType, style, includeMockData, pages })
  }

  const addPage = () => {
    if (newPage.trim() && !pages.includes(newPage.trim())) {
      setPages([...pages, newPage.trim()])
      setNewPage('')
    }
  }

  const removePage = (page: string) => {
    setPages(pages.filter(p => p !== page))
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[95vh] sm:max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-3 sm:p-4 border-b shrink-0">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="w-8 h-8 sm:w-10 sm:h-10 bg-purple-100 rounded-lg flex items-center justify-center">
              <Sparkles className="w-4 h-4 sm:w-5 sm:h-5 text-purple-600" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-semibold">Build New Artifact</h2>
              <p className="text-xs sm:text-sm text-gray-500">Generate a web prototype from your prompt</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 sm:space-y-6">
          <div>
            <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
              What do you want to build?
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="A landing page for a SaaS product with pricing table, feature highlights, and a contact form..."
              className="w-full h-28 sm:h-32 px-3 sm:px-4 py-2 sm:py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-500 resize-none text-sm sm:text-base"
              required
              autoFocus
            />
            <p className="mt-1 text-xs sm:text-sm text-gray-500">
              Be specific about pages, features, and design preferences
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <div>
              <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                Project Type
              </label>
              <select
                value={projectType}
                onChange={(e) => setProjectType(e.target.value)}
                className="w-full px-3 sm:px-4 py-2 sm:py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-500 bg-white text-sm sm:text-base"
              >
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
                Style
              </label>
              <select
                value={style}
                onChange={(e) => setStyle(e.target.value)}
                className="w-full px-3 sm:px-4 py-2 sm:py-2.5 border border-gray-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-500 bg-white text-sm sm:text-base"
              >
                {styles.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          </div>

          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={includeMockData}
              onChange={(e) => setIncludeMockData(e.target.checked)}
              className="w-5 h-5 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
            />
            <span className="text-sm text-gray-700">Include realistic mock data</span>
          </label>

          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
            >
              <ChevronDown className={clsx('w-4 h-4 transition-transform', showAdvanced && 'rotate-180')} />
              Advanced Options
            </button>

            {showAdvanced && (
              <div className="mt-4 p-4 bg-gray-50 rounded-xl space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Specific Pages (optional)
                  </label>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="text"
                      value={newPage}
                      onChange={(e) => setNewPage(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPage(); } }}
                      placeholder="e.g., About, Pricing, Contact"
                      className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                    />
                    <button
                      type="button"
                      onClick={addPage}
                      className="px-3 py-2 bg-gray-200 hover:bg-gray-300 rounded-lg"
                    >
                      <Plus className="w-5 h-5" />
                    </button>
                  </div>
                  {pages.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {pages.map(page => (
                        <span
                          key={page}
                          className="inline-flex items-center gap-1 px-3 py-1 bg-purple-100 text-purple-700 rounded-full text-sm"
                        >
                          {page}
                          <button type="button" onClick={() => removePage(page)} className="hover:text-purple-900">
                            <X className="w-4 h-4" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </form>

        <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 p-3 sm:p-4 border-t bg-gray-50 shrink-0">
          <button 
            type="button"
            onClick={onClose} 
            className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm sm:text-base"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!prompt.trim() || isCreating}
            className="flex items-center justify-center gap-2 px-4 sm:px-6 py-2 bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 text-white font-medium rounded-lg shadow-lg shadow-purple-500/25 disabled:opacity-50 disabled:cursor-not-allowed text-sm sm:text-base"
          >
            {isCreating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                Generate Artifact
              </>
            )}
          </button>
        </div>

        {createError && (
          <p className="px-6 pb-4 text-red-600 text-sm text-center">
            {createError.message}
          </p>
        )}
      </div>
    </div>
  )
}

// IterateModal Component
interface IterateModalProps {
  readonly jobId: string
  readonly isIterating: boolean
  readonly onClose: () => void
  readonly onSubmit: (prompt: string) => void
}

export function IterateModal({ jobId, isIterating, onClose, onSubmit }: IterateModalProps) {
  const [iteratePrompt, setIteratePrompt] = useState('')

  const handleSubmit = () => {
    if (!iteratePrompt.trim()) return
    onSubmit(iteratePrompt.trim())
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[95vh] sm:max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between p-3 sm:p-4 border-b">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="w-8 h-8 sm:w-10 sm:h-10 bg-blue-100 rounded-lg flex items-center justify-center">
              <RefreshCw className="w-4 h-4 sm:w-5 sm:h-5 text-blue-600" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-semibold">Iterate on Artifact</h2>
              <p className="text-xs sm:text-sm text-gray-500">Continue building from job #{jobId.slice(0, 8)}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 sm:p-6 space-y-4">
          <div>
            <label className="block text-xs sm:text-sm font-medium text-gray-700 mb-2">
              What changes do you want to make?
            </label>
            <textarea
              value={iteratePrompt}
              onChange={(e) => setIteratePrompt(e.target.value)}
              placeholder="e.g., Add a dark mode toggle, Change the hero section colors to blue, Add a contact form page..."
              className="w-full h-28 sm:h-32 px-3 sm:px-4 py-2 sm:py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none text-sm sm:text-base"
              autoFocus
            />
            <p className="mt-2 text-xs sm:text-sm text-gray-500">
              Kiro will modify the existing codebase based on your request, preserving what's already built.
            </p>
          </div>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 sm:p-4">
            <h4 className="font-medium text-blue-800 mb-2 text-sm sm:text-base">💡 Iteration Tips</h4>
            <ul className="text-xs sm:text-sm text-blue-700 space-y-1">
              <li>• Be specific about what you want to change</li>
              <li>• Reference existing components or pages by name</li>
              <li>• You can iterate multiple times on the same artifact</li>
            </ul>
          </div>
        </div>
        <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 sm:gap-3 p-3 sm:p-4 border-t bg-gray-50">
          <button onClick={onClose} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm sm:text-base">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!iteratePrompt.trim() || isIterating}
            className="flex items-center justify-center gap-2 px-4 sm:px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm sm:text-base"
          >
            {isIterating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4" />
                Start Iteration
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}


// SourceModal Component
interface SourceModalProps {
  readonly jobId: string
  readonly downloadUrl: string | undefined
  readonly sourceFiles: SourceFile[]
  readonly sourceFilesLoading: boolean
  readonly selectedSourceFile: string | null
  readonly sourceFileContent: string
  readonly sourceFileLoading: boolean
  readonly currentSourcePath: string
  readonly onClose: () => void
  readonly onLoadFiles: (path: string) => void
  readonly onLoadFileContent: (filePath: string) => void
  readonly onCopyClone: () => void
  readonly copiedClone: boolean
}

function getMarkdownComponents() {
  return {
    h1: ({ children }: { children?: React.ReactNode }) => <h1 className="text-2xl font-bold text-gray-900 mt-6 mb-3">{children}</h1>,
    h2: ({ children }: { children?: React.ReactNode }) => <h2 className="text-xl font-semibold text-gray-900 mt-5 mb-2">{children}</h2>,
    h3: ({ children }: { children?: React.ReactNode }) => <h3 className="text-lg font-medium text-gray-900 mt-4 mb-2">{children}</h3>,
    p: ({ children }: { children?: React.ReactNode }) => <p className="text-gray-700 my-2">{children}</p>,
    ul: ({ children }: { children?: React.ReactNode }) => <ul className="list-disc list-inside my-2 space-y-1">{children}</ul>,
    ol: ({ children }: { children?: React.ReactNode }) => <ol className="list-decimal list-inside my-2 space-y-1">{children}</ol>,
    li: ({ children }: { children?: React.ReactNode }) => <li className="text-gray-700">{children}</li>,
    code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
      const isInline = !className
      if (isInline) {
        return <code className="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono text-pink-600">{children}</code>
      }
      return <code className="block bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto my-3 text-sm font-mono">{children}</code>
    },
    pre: ({ children }: { children?: React.ReactNode }) => <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto my-3 text-sm">{children}</pre>,
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => <a href={href} className="text-blue-600 hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>,
    strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }: { children?: React.ReactNode }) => <em className="italic">{children}</em>,
  }
}

function FileTreeHeader({ currentSourcePath, onNavigateUp }: Readonly<{ currentSourcePath: string; onNavigateUp: () => void }>) {
  if (currentSourcePath) {
    return (
      <button
        onClick={onNavigateUp}
        className="flex items-center gap-2 text-xs sm:text-sm text-gray-600 hover:text-gray-900"
      >
        <ArrowLeft className="w-4 h-4" />
        <span className="truncate max-w-[140px] sm:max-w-[180px]">/{currentSourcePath}</span>
      </button>
    )
  }
  return <span className="text-xs sm:text-sm font-medium text-gray-700">Files</span>
}

function FileTreeContent({
  sourceFilesLoading,
  sourceFiles,
  selectedSourceFile,
  onFileClick,
}: Readonly<{
  sourceFilesLoading: boolean
  sourceFiles: SourceFile[]
  selectedSourceFile: string | null
  onFileClick: (file: SourceFile) => void
}>) {
  if (sourceFilesLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
      </div>
    )
  }
  
  if (sourceFiles.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 text-xs sm:text-sm text-gray-500 text-center">
        No files found
      </div>
    )
  }
  
  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-1">
      {sourceFiles.map((file) => (
        <button
          key={file.path}
          onClick={() => onFileClick(file)}
          className={clsx(
            'w-full flex items-center gap-2 px-2 sm:px-3 py-1.5 sm:py-2 rounded-lg text-left text-xs sm:text-sm transition-colors',
            selectedSourceFile === file.path
              ? 'bg-purple-100 text-purple-700'
              : 'hover:bg-gray-100 text-gray-700'
          )}
        >
          {file.type === 'folder' ? (
            <Folder className="w-4 h-4 text-yellow-500 shrink-0" />
          ) : (
            getFileIcon(file.path.split('/').pop() ?? '')
          )}
          <span className="truncate">{file.path.split('/').pop()}</span>
        </button>
      ))}
    </div>
  )
}

function FileContentViewer({
  selectedSourceFile,
  sourceFileLoading,
  sourceFileContent,
}: Readonly<{
  selectedSourceFile: string | null
  sourceFileLoading: boolean
  sourceFileContent: string
}>) {
  if (!selectedSourceFile) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        <div className="text-center p-4">
          <Code className="w-10 h-10 sm:w-12 sm:h-12 mx-auto mb-3 text-gray-300" />
          <p className="text-xs sm:text-sm">Select a file to view its contents</p>
        </div>
      </div>
    )
  }
  
  if (sourceFileLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    )
  }
  
  const isMarkdown = selectedSourceFile.toLowerCase().endsWith('.md')
  
  if (isMarkdown) {
    return (
      <div className="p-4 sm:p-6 prose prose-sm max-w-none">
        <ReactMarkdown components={getMarkdownComponents()}>
          {sourceFileContent}
        </ReactMarkdown>
      </div>
    )
  }
  
  return (
    <div className="p-3 sm:p-4">
      <CodeViewer content={sourceFileContent} />
    </div>
  )
}

export function SourceModal({
  jobId,
  downloadUrl,
  sourceFiles,
  sourceFilesLoading,
  selectedSourceFile,
  sourceFileContent,
  sourceFileLoading,
  currentSourcePath,
  onClose,
  onLoadFiles,
  onLoadFileContent,
  onCopyClone,
  copiedClone,
}: SourceModalProps) {
  const handleNavigateUp = () => {
    const parentPath = currentSourcePath.split('/').slice(0, -1).join('/')
    onLoadFiles(parentPath)
  }

  const handleFileClick = (file: SourceFile) => {
    if (file.type === 'folder') {
      onLoadFiles(file.path)
    } else {
      onLoadFileContent(file.path)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div className="bg-white rounded-xl w-full max-w-5xl h-[95vh] sm:h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-3 sm:p-4 border-b shrink-0">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="w-8 h-8 sm:w-10 sm:h-10 bg-gray-100 rounded-lg flex items-center justify-center">
              <Code className="w-4 h-4 sm:w-5 sm:h-5 text-gray-600" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-semibold">Source Code</h2>
              <p className="text-xs sm:text-sm text-gray-500">Job #{jobId.slice(0, 8)}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Clone Instructions */}
        <div className="p-3 sm:p-4 bg-gray-50 border-b shrink-0">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-xs sm:text-sm font-medium text-gray-700">Clone this repository</p>
              <p className="text-xs text-gray-500 mt-0.5 sm:mt-1 hidden sm:block">Requires AWS CLI with CodeCommit credentials configured</p>
            </div>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <button
                onClick={onCopyClone}
                className="flex items-center justify-center gap-2 px-3 py-2 bg-gray-900 hover:bg-gray-800 text-white text-xs sm:text-sm font-mono rounded-lg overflow-hidden"
              >
                {copiedClone ? <Check className="w-4 h-4 shrink-0" /> : <Copy className="w-4 h-4 shrink-0" />}
                <span className="truncate">git clone ...artifact-{jobId.slice(0, 8)}</span>
              </button>
              {downloadUrl && (
                <a
                  href={downloadUrl}
                  className="flex items-center justify-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-xs sm:text-sm font-medium rounded-lg"
                >
                  <Download className="w-4 h-4" />
                  Download ZIP
                </a>
              )}
            </div>
          </div>
        </div>

        {/* File Browser */}
        <div className="flex-1 flex flex-col sm:flex-row overflow-hidden">
          {/* File Tree */}
          <div className="w-full sm:w-56 md:w-64 border-b sm:border-b-0 sm:border-r bg-gray-50 overflow-hidden flex flex-col shrink-0 h-40 sm:h-auto">
            <div className="h-10 sm:h-11 px-3 border-b bg-white flex items-center shrink-0">
              <FileTreeHeader currentSourcePath={currentSourcePath} onNavigateUp={handleNavigateUp} />
            </div>
            <FileTreeContent
              sourceFilesLoading={sourceFilesLoading}
              sourceFiles={sourceFiles}
              selectedSourceFile={selectedSourceFile}
              onFileClick={handleFileClick}
            />
          </div>

          {/* File Content */}
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            <div className="h-10 sm:h-11 px-3 border-b bg-white flex items-center gap-2 shrink-0">
              {selectedSourceFile ? (
                <>
                  {getFileIcon(selectedSourceFile.split('/').pop() ?? '')}
                  <p className="text-xs sm:text-sm font-mono text-gray-700 truncate">{selectedSourceFile}</p>
                </>
              ) : (
                <span className="text-xs sm:text-sm text-gray-400">No file selected</span>
              )}
            </div>
            <div className="flex-1 overflow-auto">
              <FileContentViewer
                selectedSourceFile={selectedSourceFile}
                sourceFileLoading={sourceFileLoading}
                sourceFileContent={sourceFileContent}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

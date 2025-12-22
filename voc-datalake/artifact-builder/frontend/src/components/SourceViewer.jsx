import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { 
  X, Folder, FileText, FileCode, ChevronRight, ChevronDown,
  Loader2, File, Image, Package
} from 'lucide-react'
import { api } from '../api'

// File extension to language mapping for syntax highlighting
const EXT_TO_LANG = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  json: 'json',
  html: 'html',
  css: 'css',
  scss: 'scss',
  md: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'bash',
  bash: 'bash',
}

// Get file icon based on extension
function getFileIcon(filename) {
  const ext = filename.split('.').pop()?.toLowerCase()
  
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico'].includes(ext)) {
    return <Image className="w-4 h-4 text-purple-500" />
  }
  if (['js', 'jsx', 'ts', 'tsx'].includes(ext)) {
    return <FileCode className="w-4 h-4 text-yellow-500" />
  }
  if (['json', 'yaml', 'yml'].includes(ext)) {
    return <FileCode className="w-4 h-4 text-green-500" />
  }
  if (ext === 'md') {
    return <FileText className="w-4 h-4 text-blue-500" />
  }
  if (['css', 'scss'].includes(ext)) {
    return <FileCode className="w-4 h-4 text-pink-500" />
  }
  if (ext === 'html') {
    return <FileCode className="w-4 h-4 text-orange-500" />
  }
  if (filename === 'package.json') {
    return <Package className="w-4 h-4 text-red-500" />
  }
  return <File className="w-4 h-4 text-gray-400" />
}

// Simple markdown renderer
function MarkdownRenderer({ content }) {
  const renderMarkdown = (text) => {
    const lines = text.split('\n')
    const elements = []
    let inCodeBlock = false
    let codeBlockContent = []
    let codeBlockLang = ''
    let listItems = []
    let inList = false
    
    const flushList = () => {
      if (listItems.length > 0) {
        elements.push(
          <ul key={`list-${elements.length}`} className="list-disc list-inside my-2 space-y-1">
            {listItems.map((item, i) => (
              <li key={i} className="text-gray-700">{item}</li>
            ))}
          </ul>
        )
        listItems = []
      }
      inList = false
    }
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      
      // Code block handling
      if (line.startsWith('```')) {
        if (inCodeBlock) {
          elements.push(
            <pre key={`code-${i}`} className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto my-3 text-sm">
              <code>{codeBlockContent.join('\n')}</code>
            </pre>
          )
          codeBlockContent = []
          inCodeBlock = false
        } else {
          flushList()
          inCodeBlock = true
          codeBlockLang = line.slice(3).trim()
        }
        continue
      }
      
      if (inCodeBlock) {
        codeBlockContent.push(line)
        continue
      }
      
      // Headers
      if (line.startsWith('# ')) {
        flushList()
        elements.push(<h1 key={i} className="text-2xl font-bold text-gray-900 mt-6 mb-3">{line.slice(2)}</h1>)
        continue
      }
      if (line.startsWith('## ')) {
        flushList()
        elements.push(<h2 key={i} className="text-xl font-semibold text-gray-900 mt-5 mb-2">{line.slice(3)}</h2>)
        continue
      }
      if (line.startsWith('### ')) {
        flushList()
        elements.push(<h3 key={i} className="text-lg font-medium text-gray-900 mt-4 mb-2">{line.slice(4)}</h3>)
        continue
      }
      
      // List items
      if (line.match(/^[-*]\s/)) {
        inList = true
        listItems.push(formatInlineMarkdown(line.slice(2)))
        continue
      }
      
      // Numbered list
      if (line.match(/^\d+\.\s/)) {
        inList = true
        listItems.push(formatInlineMarkdown(line.replace(/^\d+\.\s/, '')))
        continue
      }
      
      // Empty line
      if (line.trim() === '') {
        flushList()
        continue
      }
      
      // Regular paragraph
      flushList()
      elements.push(<p key={i} className="text-gray-700 my-2">{formatInlineMarkdown(line)}</p>)
    }
    
    flushList()
    return elements
  }
  
  const formatInlineMarkdown = (text) => {
    // Bold
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Inline code
    text = text.replace(/`(.+?)`/g, '<code class="bg-gray-100 px-1.5 py-0.5 rounded text-sm font-mono text-pink-600">$1</code>')
    // Links
    text = text.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" class="text-blue-600 hover:underline" target="_blank" rel="noopener">$1</a>')
    
    return <span dangerouslySetInnerHTML={{ __html: text }} />
  }
  
  return <div className="prose max-w-none">{renderMarkdown(content)}</div>
}

// Code viewer with line numbers
function CodeViewer({ content, filename }) {
  const lines = content.split('\n')
  const ext = filename.split('.').pop()?.toLowerCase()
  const lang = EXT_TO_LANG[ext] || 'text'
  
  return (
    <div className="bg-gray-900 rounded-lg overflow-hidden">
      <div className="flex text-sm font-mono">
        {/* Line numbers */}
        <div className="select-none bg-gray-800 text-gray-500 text-right py-4 px-3 border-r border-gray-700">
          {lines.map((_, i) => (
            <div key={i} className="leading-6">{i + 1}</div>
          ))}
        </div>
        {/* Code content */}
        <pre className="flex-1 overflow-x-auto py-4 px-4 text-gray-100">
          <code>
            {lines.map((line, i) => (
              <div key={i} className="leading-6 whitespace-pre">{line || ' '}</div>
            ))}
          </code>
        </pre>
      </div>
    </div>
  )
}

// File tree item
function FileTreeItem({ item, selectedPath, onSelect, jobId, level = 0 }) {
  const [expanded, setExpanded] = useState(level === 0)
  const isFolder = item.type === 'folder'
  const isSelected = selectedPath === item.path
  const filename = item.path.split('/').pop()
  
  // Fetch children if folder is expanded
  const { data: children } = useQuery({
    queryKey: ['source-files', jobId, item.path],
    queryFn: () => api.getSourceFiles(jobId, item.path),
    enabled: isFolder && expanded,
  })
  
  const handleClick = () => {
    if (isFolder) {
      setExpanded(!expanded)
    } else {
      onSelect(item.path)
    }
  }
  
  return (
    <div>
      <div
        onClick={handleClick}
        className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer rounded text-sm ${
          isSelected ? 'bg-primary-100 text-primary-700' : 'hover:bg-gray-100'
        }`}
        style={{ paddingLeft: `${level * 12 + 8}px` }}
      >
        {isFolder ? (
          <>
            {expanded ? (
              <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
            ) : (
              <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
            )}
            <Folder className="w-4 h-4 text-yellow-500 flex-shrink-0" />
          </>
        ) : (
          <>
            <span className="w-4" />
            {getFileIcon(filename)}
          </>
        )}
        <span className="truncate">{filename}</span>
      </div>
      
      {isFolder && expanded && children?.files && (
        <div>
          {children.files.map((child) => (
            <FileTreeItem
              key={child.path}
              item={child}
              selectedPath={selectedPath}
              onSelect={onSelect}
              jobId={jobId}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function SourceViewer({ jobId, onClose }) {
  const [selectedPath, setSelectedPath] = useState(null)
  
  // Fetch root files
  const { data: rootFiles, isLoading: loadingTree } = useQuery({
    queryKey: ['source-files', jobId, ''],
    queryFn: () => api.getSourceFiles(jobId),
  })
  
  // Fetch selected file content
  const { data: fileContent, isLoading: loadingFile } = useQuery({
    queryKey: ['source-file', jobId, selectedPath],
    queryFn: () => api.getSourceFileContent(jobId, selectedPath),
    enabled: !!selectedPath,
  })
  
  // Auto-select README.md on load
  useEffect(() => {
    if (rootFiles?.files && !selectedPath) {
      const readme = rootFiles.files.find(f => 
        f.type === 'file' && f.path.toLowerCase() === 'readme.md'
      )
      if (readme) {
        setSelectedPath(readme.path)
      }
    }
  }, [rootFiles, selectedPath])
  
  const isMarkdown = selectedPath?.toLowerCase().endsWith('.md')
  const filename = selectedPath?.split('/').pop() || ''
  
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-6xl h-[85vh] flex flex-col overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
          <h2 className="font-semibold text-gray-900">Source Code</h2>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-200 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        
        {/* Content */}
        <div className="flex flex-1 overflow-hidden">
          {/* File tree sidebar */}
          <div className="w-64 border-r border-gray-200 overflow-y-auto bg-gray-50">
            {loadingTree ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
              </div>
            ) : (
              <div className="py-2">
                {rootFiles?.files?.map((item) => (
                  <FileTreeItem
                    key={item.path}
                    item={item}
                    selectedPath={selectedPath}
                    onSelect={setSelectedPath}
                    jobId={jobId}
                  />
                ))}
              </div>
            )}
          </div>
          
          {/* File content */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {selectedPath && (
              <div className="px-4 py-2 border-b border-gray-200 bg-gray-50 flex items-center gap-2">
                {getFileIcon(filename)}
                <span className="text-sm font-medium text-gray-700">{selectedPath}</span>
              </div>
            )}
            
            <div className="flex-1 overflow-auto p-4">
              {!selectedPath ? (
                <div className="flex items-center justify-center h-full text-gray-400">
                  Select a file to view
                </div>
              ) : loadingFile ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : fileContent?.content ? (
                isMarkdown ? (
                  <MarkdownRenderer content={fileContent.content} />
                ) : (
                  <CodeViewer content={fileContent.content} filename={filename} />
                )
              ) : (
                <div className="text-gray-400 text-center">No content</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

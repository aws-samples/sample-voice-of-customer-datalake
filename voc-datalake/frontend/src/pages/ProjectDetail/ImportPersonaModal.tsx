/**
 * ImportPersonaModal - Modal for importing personas from PDF, image, or text
 */
import { Upload, FileUp, Image, FileText, CheckCircle, X, Loader2 } from 'lucide-react'
import clsx from 'clsx'

type ImportType = 'pdf' | 'image' | 'text'

interface ImportPersonaModalProps {
  readonly importType: ImportType
  readonly importContent: string
  readonly importFileName: string
  readonly importMediaType: string
  readonly isImporting: boolean
  readonly onTypeChange: (type: ImportType) => void
  readonly onContentChange: (content: string) => void
  readonly onFileChange: (file: File) => void
  readonly onClose: () => void
  readonly onImport: () => void
}

function getAcceptedFileTypes(importType: ImportType): string {
  return importType === 'pdf' ? '.pdf,application/pdf' : 'image/png,image/jpeg,image/gif,image/webp'
}

function getFileTypeLabel(importType: ImportType): string {
  return importType === 'pdf' ? 'PDF files only' : 'PNG, JPG, GIF, WebP'
}

function getUploadLabel(importType: ImportType): string {
  return importType === 'pdf' ? 'PDF Document' : 'Image'
}

function getImportTypeLabel(importType: ImportType): string {
  if (importType === 'pdf') return 'PDF document'
  if (importType === 'image') return 'image'
  return 'text'
}

// Import type button component
function ImportTypeButton({
  icon: Icon,
  label,
  description,
  isSelected,
  onClick,
}: Readonly<{
  icon: typeof FileUp
  label: string
  description: string
  isSelected: boolean
  onClick: () => void
}>) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'p-4 rounded-lg border text-center',
        isSelected ? 'bg-purple-50 border-purple-300' : 'bg-white border-gray-200 hover:border-purple-200'
      )}
    >
      <Icon size={24} className="mx-auto mb-2 text-purple-500" />
      <div className="font-medium">{label}</div>
      <div className="text-xs text-gray-500">{description}</div>
    </button>
  )
}

// File upload section component
function FileUploadSection({
  importType,
  importFileName,
  onFileChange,
}: Readonly<{
  importType: ImportType
  importFileName: string
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}>) {
  if (importType !== 'pdf' && importType !== 'image') return null

  return (
    <div>
      <h3 className="font-medium mb-3">Upload {getUploadLabel(importType)}</h3>
      <label className="block">
        <div className={clsx(
          'border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors',
          importFileName ? 'border-purple-300 bg-purple-50' : 'border-gray-300 hover:border-purple-300'
        )}>
          {importFileName ? (
            <div>
              <CheckCircle size={32} className="mx-auto mb-2 text-purple-500" />
              <p className="font-medium text-purple-700">{importFileName}</p>
              <p className="text-sm text-gray-500 mt-1">Click to change file</p>
            </div>
          ) : (
            <div>
              <Upload size={32} className="mx-auto mb-2 text-gray-400" />
              <p className="text-gray-600">Click to upload or drag and drop</p>
              <p className="text-sm text-gray-400 mt-1">{getFileTypeLabel(importType)}</p>
            </div>
          )}
        </div>
        <input
          type="file"
          accept={getAcceptedFileTypes(importType)}
          className="hidden"
          onChange={onFileChange}
        />
      </label>
    </div>
  )
}

// Text input section component
function TextInputSection({
  importType,
  importContent,
  onContentChange,
}: Readonly<{
  importType: ImportType
  importContent: string
  onContentChange: (content: string) => void
}>) {
  if (importType !== 'text') return null

  return (
    <div>
      <h3 className="font-medium mb-3">Paste Persona Content</h3>
      <textarea
        value={importContent}
        onChange={(e) => onContentChange(e.target.value)}
        placeholder="Paste your persona description, user research notes, or any text describing the persona..."
        rows={10}
        className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
      />
    </div>
  )
}

export default function ImportPersonaModal({
  importType,
  importContent,
  importFileName,
  isImporting,
  onTypeChange,
  onContentChange,
  onFileChange,
  onClose,
  onImport,
}: ImportPersonaModalProps) {
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      onFileChange(file)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold">Import Persona</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg"><X size={20} /></button>
        </div>
        <div className="p-6 space-y-6">
          {/* Import Type Selection */}
          <div>
            <h3 className="font-medium mb-3">Import From</h3>
            <div className="grid grid-cols-3 gap-3">
              <ImportTypeButton icon={FileUp} label="PDF" description="Upload document" isSelected={importType === 'pdf'} onClick={() => onTypeChange('pdf')} />
              <ImportTypeButton icon={Image} label="Image" description="Screenshot or card" isSelected={importType === 'image'} onClick={() => onTypeChange('image')} />
              <ImportTypeButton icon={FileText} label="Text" description="Paste content" isSelected={importType === 'text'} onClick={() => onTypeChange('text')} />
            </div>
          </div>

          <FileUploadSection importType={importType} importFileName={importFileName} onFileChange={handleFileInputChange} />
          <TextInputSection importType={importType} importContent={importContent} onContentChange={onContentChange} />

          {/* Info */}
          <div className="bg-purple-50 rounded-lg p-4 text-sm">
            <p className="text-purple-700">
              <strong>AI-Powered Import:</strong> Claude will extract persona information from your {getImportTypeLabel(importType)} and create a structured persona with an AI-generated avatar.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-3 p-4 border-t bg-gray-50">
          <button onClick={onClose} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg">Cancel</button>
          <button
            onClick={onImport}
            disabled={!importContent || isImporting}
            className="flex items-center gap-2 px-6 py-2 bg-purple-600 text-white rounded-lg disabled:opacity-50 hover:bg-purple-700"
          >
            {isImporting ? (
              <><Loader2 size={16} className="animate-spin" />Importing...</>
            ) : (
              <><Upload size={16} />Import Persona</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

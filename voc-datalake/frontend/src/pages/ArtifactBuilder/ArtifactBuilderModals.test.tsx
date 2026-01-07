/**
 * @fileoverview Tests for ArtifactBuilderModals components
 * @module pages/ArtifactBuilder/ArtifactBuilderModals.test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BuildModal, IterateModal, SourceModal } from './ArtifactBuilderModals'

describe('BuildModal', () => {
  const defaultProps = {
    templates: [
      { id: 'react-vite', name: 'React + Vite' },
      { id: 'nextjs', name: 'Next.js' },
    ],
    styles: [
      { id: 'minimal', name: 'Minimal' },
      { id: 'modern', name: 'Modern' },
    ],
    isCreating: false,
    createError: null,
    onClose: vi.fn(),
    onSubmit: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Rendering', () => {
    it('renders modal with title and description', () => {
      render(<BuildModal {...defaultProps} />)

      expect(screen.getByText('Build New Artifact')).toBeInTheDocument()
      expect(screen.getByText('Generate a web prototype from your prompt')).toBeInTheDocument()
    })

    it('renders prompt textarea', () => {
      render(<BuildModal {...defaultProps} />)

      expect(screen.getByPlaceholderText(/landing page for a SaaS product/i)).toBeInTheDocument()
    })

    it('renders project type dropdown with templates', () => {
      render(<BuildModal {...defaultProps} />)

      const selects = screen.getAllByRole('combobox')
      expect(selects).toHaveLength(2)
      expect(screen.getByText('React + Vite')).toBeInTheDocument()
      expect(screen.getByText('Next.js')).toBeInTheDocument()
    })

    it('renders style dropdown with styles', () => {
      render(<BuildModal {...defaultProps} />)

      const selects = screen.getAllByRole('combobox')
      expect(selects).toHaveLength(2)
      expect(screen.getByText('Minimal')).toBeInTheDocument()
      expect(screen.getByText('Modern')).toBeInTheDocument()
    })

    it('renders mock data checkbox', () => {
      render(<BuildModal {...defaultProps} />)

      expect(screen.getByRole('checkbox')).toBeInTheDocument()
      expect(screen.getByText('Include realistic mock data')).toBeInTheDocument()
    })
  })

  describe('Form Submission', () => {
    it('submits form with entered values', async () => {
      const user = userEvent.setup()
      render(<BuildModal {...defaultProps} />)

      await user.type(screen.getByPlaceholderText(/landing page/i), 'Build a dashboard')
      
      const selects = screen.getAllByRole('combobox')
      await user.selectOptions(selects[0], 'nextjs')
      await user.selectOptions(selects[1], 'modern')
      await user.click(screen.getByRole('checkbox'))
      await user.click(screen.getByRole('button', { name: /generate artifact/i }))

      expect(defaultProps.onSubmit).toHaveBeenCalledWith({
        prompt: 'Build a dashboard',
        projectType: 'nextjs',
        style: 'modern',
        includeMockData: true,
        pages: [],
      })
    })

    it('disables submit button when prompt is empty', () => {
      render(<BuildModal {...defaultProps} />)

      expect(screen.getByRole('button', { name: /generate artifact/i })).toBeDisabled()
    })

    it('enables submit button when prompt has content', async () => {
      const user = userEvent.setup()
      render(<BuildModal {...defaultProps} />)

      await user.type(screen.getByPlaceholderText(/landing page/i), 'Test prompt')

      expect(screen.getByRole('button', { name: /generate artifact/i })).not.toBeDisabled()
    })

    it('disables submit button while creating', () => {
      render(<BuildModal {...defaultProps} isCreating={true} />)

      expect(screen.getByRole('button', { name: /creating/i })).toBeDisabled()
    })

    it('shows loading state while creating', () => {
      render(<BuildModal {...defaultProps} isCreating={true} />)

      expect(screen.getByText('Creating...')).toBeInTheDocument()
    })
  })

  describe('Advanced Options', () => {
    it('shows advanced options when clicked', async () => {
      const user = userEvent.setup()
      render(<BuildModal {...defaultProps} />)

      await user.click(screen.getByText('Advanced Options'))

      expect(screen.getByText('Specific Pages (optional)')).toBeInTheDocument()
    })

    it('adds pages to list', async () => {
      const user = userEvent.setup()
      render(<BuildModal {...defaultProps} />)

      await user.click(screen.getByText('Advanced Options'))
      await user.type(screen.getByPlaceholderText(/about, pricing/i), 'Home')
      
      // Find the plus button by its parent container
      const addButtons = screen.getAllByRole('button')
      const plusButton = addButtons.find(btn => btn.querySelector('.lucide-plus'))
      if (plusButton) await user.click(plusButton)

      expect(screen.getByText('Home')).toBeInTheDocument()
    })

    it('adds page on Enter key', async () => {
      const user = userEvent.setup()
      render(<BuildModal {...defaultProps} />)

      await user.click(screen.getByText('Advanced Options'))
      await user.type(screen.getByPlaceholderText(/about, pricing/i), 'Contact{Enter}')

      expect(screen.getByText('Contact')).toBeInTheDocument()
    })

    it('removes page when X is clicked', async () => {
      const user = userEvent.setup()
      render(<BuildModal {...defaultProps} />)

      await user.click(screen.getByText('Advanced Options'))
      await user.type(screen.getByPlaceholderText(/about, pricing/i), 'Home{Enter}')

      expect(screen.getByText('Home')).toBeInTheDocument()

      const removeButton = screen.getByText('Home').parentElement?.querySelector('button')
      if (removeButton) await user.click(removeButton)

      expect(screen.queryByText('Home')).not.toBeInTheDocument()
    })

    it('does not add duplicate pages', async () => {
      const user = userEvent.setup()
      render(<BuildModal {...defaultProps} />)

      await user.click(screen.getByText('Advanced Options'))
      await user.type(screen.getByPlaceholderText(/about, pricing/i), 'Home{Enter}')
      await user.type(screen.getByPlaceholderText(/about, pricing/i), 'Home{Enter}')

      const homeElements = screen.getAllByText('Home')
      expect(homeElements).toHaveLength(1)
    })

    it('includes pages in submission', async () => {
      const user = userEvent.setup()
      render(<BuildModal {...defaultProps} />)

      await user.type(screen.getByPlaceholderText(/landing page/i), 'Test')
      await user.click(screen.getByText('Advanced Options'))
      await user.type(screen.getByPlaceholderText(/about, pricing/i), 'Home{Enter}')
      await user.type(screen.getByPlaceholderText(/about, pricing/i), 'About{Enter}')
      await user.click(screen.getByRole('button', { name: /generate artifact/i }))

      expect(defaultProps.onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ pages: ['Home', 'About'] })
      )
    })
  })

  describe('Close Modal', () => {
    it('calls onClose when cancel button is clicked', async () => {
      const user = userEvent.setup()
      render(<BuildModal {...defaultProps} />)

      await user.click(screen.getByRole('button', { name: /cancel/i }))

      expect(defaultProps.onClose).toHaveBeenCalled()
    })

    it('calls onClose when X button is clicked', async () => {
      const user = userEvent.setup()
      render(<BuildModal {...defaultProps} />)

      const closeButtons = screen.getAllByRole('button')
      const xButton = closeButtons.find(btn => btn.querySelector('.lucide-x'))
      if (xButton) await user.click(xButton)

      expect(defaultProps.onClose).toHaveBeenCalled()
    })
  })

  describe('Error Display', () => {
    it('displays error message when createError is set', () => {
      render(<BuildModal {...defaultProps} createError={new Error('Failed to create job')} />)

      expect(screen.getByText('Failed to create job')).toBeInTheDocument()
    })
  })
})

describe('IterateModal', () => {
  const defaultProps = {
    jobId: 'job-12345678',
    isIterating: false,
    onClose: vi.fn(),
    onSubmit: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Rendering', () => {
    it('renders modal with title and job ID', () => {
      render(<IterateModal {...defaultProps} />)

      expect(screen.getByText('Iterate on Artifact')).toBeInTheDocument()
      expect(screen.getByText('Continue building from job #job-1234')).toBeInTheDocument()
    })

    it('renders prompt textarea', () => {
      render(<IterateModal {...defaultProps} />)

      expect(screen.getByPlaceholderText(/add a dark mode toggle/i)).toBeInTheDocument()
    })

    it('renders iteration tips', () => {
      render(<IterateModal {...defaultProps} />)

      expect(screen.getByText('💡 Iteration Tips')).toBeInTheDocument()
      expect(screen.getByText(/be specific about what you want to change/i)).toBeInTheDocument()
    })
  })

  describe('Form Submission', () => {
    it('submits prompt when button is clicked', async () => {
      const user = userEvent.setup()
      render(<IterateModal {...defaultProps} />)

      await user.type(screen.getByPlaceholderText(/add a dark mode/i), 'Add footer section')
      await user.click(screen.getByRole('button', { name: /start iteration/i }))

      expect(defaultProps.onSubmit).toHaveBeenCalledWith('Add footer section')
    })

    it('disables submit when prompt is empty', () => {
      render(<IterateModal {...defaultProps} />)

      expect(screen.getByRole('button', { name: /start iteration/i })).toBeDisabled()
    })

    it('shows loading state while iterating', () => {
      render(<IterateModal {...defaultProps} isIterating={true} />)

      expect(screen.getByText('Creating...')).toBeInTheDocument()
    })
  })

  describe('Close Modal', () => {
    it('calls onClose when cancel is clicked', async () => {
      const user = userEvent.setup()
      render(<IterateModal {...defaultProps} />)

      await user.click(screen.getByRole('button', { name: /cancel/i }))

      expect(defaultProps.onClose).toHaveBeenCalled()
    })
  })
})

describe('SourceModal', () => {
  const defaultProps = {
    jobId: 'job-12345678',
    downloadUrl: 'https://s3.example.com/artifact.zip',
    sourceFiles: [
      { path: 'src', type: 'folder' as const },
      { path: 'package.json', type: 'file' as const },
      { path: 'README.md', type: 'file' as const },
    ],
    sourceFilesLoading: false,
    selectedSourceFile: null,
    sourceFileContent: '',
    sourceFileLoading: false,
    currentSourcePath: '',
    onClose: vi.fn(),
    onLoadFiles: vi.fn(),
    onLoadFileContent: vi.fn(),
    onCopyClone: vi.fn(),
    copiedClone: false,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Rendering', () => {
    it('renders modal with title and job ID', () => {
      render(<SourceModal {...defaultProps} />)

      expect(screen.getByText('Source Code')).toBeInTheDocument()
      expect(screen.getByText('Job #job-1234')).toBeInTheDocument()
    })

    it('renders clone command button', () => {
      render(<SourceModal {...defaultProps} />)

      expect(screen.getByText(/git clone.*artifact-job-1234/)).toBeInTheDocument()
    })

    it('renders download ZIP button when URL provided', () => {
      render(<SourceModal {...defaultProps} />)

      const downloadLink = screen.getByRole('link', { name: /download zip/i })
      expect(downloadLink).toHaveAttribute('href', 'https://s3.example.com/artifact.zip')
    })

    it('does not render download button when no URL', () => {
      render(<SourceModal {...defaultProps} downloadUrl={undefined} />)

      expect(screen.queryByRole('link', { name: /download zip/i })).not.toBeInTheDocument()
    })
  })

  describe('File Tree', () => {
    it('renders file list', () => {
      render(<SourceModal {...defaultProps} />)

      expect(screen.getByText('src')).toBeInTheDocument()
      expect(screen.getByText('package.json')).toBeInTheDocument()
      expect(screen.getByText('README.md')).toBeInTheDocument()
    })

    it('shows loading state when files are loading', () => {
      render(<SourceModal {...defaultProps} sourceFilesLoading={true} sourceFiles={[]} />)

      // Check for the spinner animation class
      const spinner = document.querySelector('.animate-spin')
      expect(spinner).toBeTruthy()
    })

    it('shows empty state when no files', () => {
      render(<SourceModal {...defaultProps} sourceFiles={[]} />)

      expect(screen.getByText('No files found')).toBeInTheDocument()
    })

    it('calls onLoadFiles when folder is clicked', async () => {
      const user = userEvent.setup()
      render(<SourceModal {...defaultProps} />)

      await user.click(screen.getByText('src'))

      expect(defaultProps.onLoadFiles).toHaveBeenCalledWith('src')
    })

    it('calls onLoadFileContent when file is clicked', async () => {
      const user = userEvent.setup()
      render(<SourceModal {...defaultProps} />)

      await user.click(screen.getByText('package.json'))

      expect(defaultProps.onLoadFileContent).toHaveBeenCalledWith('package.json')
    })

    it('shows current path with back button', () => {
      render(<SourceModal {...defaultProps} currentSourcePath="src/components" />)

      expect(screen.getByText('/src/components')).toBeInTheDocument()
    })

    it('navigates up when back button is clicked', async () => {
      const user = userEvent.setup()
      render(<SourceModal {...defaultProps} currentSourcePath="src/components" />)

      await user.click(screen.getByText('/src/components'))

      expect(defaultProps.onLoadFiles).toHaveBeenCalledWith('src')
    })
  })

  describe('File Content', () => {
    it('shows placeholder when no file selected', () => {
      render(<SourceModal {...defaultProps} />)

      expect(screen.getByText('Select a file to view its contents')).toBeInTheDocument()
    })

    it('shows file content when file is selected', () => {
      render(
        <SourceModal
          {...defaultProps}
          selectedSourceFile="src/App.tsx"
          sourceFileContent="export default function App() { return <div>Hello</div> }"
        />
      )

      expect(screen.getByText(/export default function App/)).toBeInTheDocument()
    })

    it('shows loading state when file content is loading', () => {
      render(
        <SourceModal
          {...defaultProps}
          selectedSourceFile="src/App.tsx"
          sourceFileLoading={true}
        />
      )

      expect(document.querySelector('.animate-spin')).toBeTruthy()
    })

    it('renders markdown files with formatting', () => {
      render(
        <SourceModal
          {...defaultProps}
          selectedSourceFile="README.md"
          sourceFileContent="# Title\n\nSome **bold** text"
        />
      )

      // Markdown is rendered - check for the bold text
      expect(screen.getByText('bold')).toBeInTheDocument()
    })

    it('highlights selected file in tree', () => {
      render(
        <SourceModal
          {...defaultProps}
          selectedSourceFile="package.json"
        />
      )

      const fileButton = screen.getByRole('button', { name: /package\.json/i })
      expect(fileButton).toHaveClass('bg-purple-100')
    })
  })

  describe('Clone Command', () => {
    it('calls onCopyClone when clone button is clicked', async () => {
      const user = userEvent.setup()
      render(<SourceModal {...defaultProps} />)

      await user.click(screen.getByText(/git clone/))

      expect(defaultProps.onCopyClone).toHaveBeenCalled()
    })

    it('shows check icon when copied', () => {
      render(<SourceModal {...defaultProps} copiedClone={true} />)

      expect(document.querySelector('.lucide-check')).toBeTruthy()
    })
  })

  describe('Close Modal', () => {
    it('calls onClose when X button is clicked', async () => {
      const user = userEvent.setup()
      render(<SourceModal {...defaultProps} />)

      const closeButtons = screen.getAllByRole('button')
      const xButton = closeButtons.find(btn => btn.querySelector('.lucide-x'))
      if (xButton) await user.click(xButton)

      expect(defaultProps.onClose).toHaveBeenCalled()
    })
  })
})

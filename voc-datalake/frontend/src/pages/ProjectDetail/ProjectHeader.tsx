/**
 * ProjectHeader - Header component for project detail page
 */
import { ArrowLeft } from 'lucide-react'

interface ProjectHeaderProps {
  readonly name: string
  readonly description?: string
  readonly onBack: () => void
}

export default function ProjectHeader({ name, description, onBack }: ProjectHeaderProps) {
  return (
    <div className="flex items-center gap-4">
      <button onClick={onBack} className="p-2 hover:bg-gray-100 rounded-lg">
        <ArrowLeft size={20} />
      </button>
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{name}</h1>
        {description && <p className="text-gray-500">{description}</p>}
      </div>
    </div>
  )
}

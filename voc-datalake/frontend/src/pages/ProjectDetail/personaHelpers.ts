const confidenceClasses: Record<string, string> = {
  high: 'bg-green-100 text-green-700',
  medium: 'bg-yellow-100 text-yellow-700',
}

export function getConfidenceClass(confidence: string | undefined): string {
  return confidenceClasses[confidence ?? ''] ?? 'bg-gray-100 text-gray-600'
}

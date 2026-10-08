const confidenceClasses: Record<string, string> = {
  high: 'bg-ok-subtle text-ok',
  medium: 'bg-warn-subtle text-warn',
}

export function getConfidenceClass(confidence: string | undefined): string {
  return confidenceClasses[confidence ?? ''] ?? 'bg-bg-hover text-text'
}

/**
 * @fileoverview Helper data and functions for FeedbackDetail page.
 * @module pages/FeedbackDetail/feedbackDetailHelpers
 */

export const suggestedResponses: Record<string, string[]> = {
  delivery: [
    "We sincerely apologize for the delay in your delivery. We're looking into this immediately and will ensure your order reaches you as soon as possible.",
    'Thank you for bringing this to our attention. We understand how frustrating delivery issues can be. Our team is investigating and will follow up shortly.',
  ],
  customer_support: [
    "We're sorry to hear about your experience with our support team. This isn't the level of service we strive for. We'd like to make this right.",
    'Thank you for your feedback. We take customer service seriously and will use this to improve our training.',
  ],
  product_quality: [
    "We apologize that our product didn't meet your expectations. Quality is our top priority, and we'd like to offer a replacement or refund.",
    "Thank you for letting us know about this issue. We're committed to quality and would like to resolve this for you.",
  ],
  pricing: [
    'We appreciate your feedback on our pricing. We strive to offer competitive value and would be happy to discuss available options.',
    "Thank you for sharing your concerns. We regularly review our pricing to ensure we're providing fair value.",
  ],
  default: [
    'Thank you for taking the time to share your feedback. We value your input and are committed to improving.',
    'We appreciate you bringing this to our attention. Our team will review this and work on addressing your concerns.',
  ],
}

export function getResponses(category: string): string[] {
  return suggestedResponses[category] ?? suggestedResponses.default
}

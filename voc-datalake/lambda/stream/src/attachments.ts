/**
 * Attachment validation and Bedrock content block conversion.
 */
import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import type { Attachment } from './schema.js';
import { ValidationError } from './lib/errors.js';

const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const FORMAT_MAP: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/**
 * Validate attachments and convert to Bedrock Converse API content blocks.
 */
export function attachmentsToContentBlocks(attachments: Attachment[]): ContentBlock[] {
  return attachments.map((att) => {
    const decoded = Buffer.from(att.data, 'base64');
    if (decoded.length > MAX_SIZE_BYTES) {
      throw new ValidationError(
        `Attachment '${att.name}' exceeds 5MB limit (${decoded.length} bytes)`,
      );
    }

    const format = FORMAT_MAP[att.media_type];
    if (!format) {
      throw new ValidationError(`Unsupported media type: ${att.media_type}`);
    }

    if (IMAGE_TYPES.has(att.media_type)) {
      return {
        image: {
          format: format as 'png' | 'jpeg' | 'gif' | 'webp',
          source: { bytes: decoded },
        },
      };
    }

    // PDF document
    const docName = att.name.includes('.') ? att.name.split('.').slice(0, -1).join('.') : att.name;
    return {
      document: {
        format: format as 'pdf',
        name: docName,
        source: { bytes: decoded },
      },
    };
  });
}

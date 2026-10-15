/**
 * Attachment validation and Bedrock content block conversion.
 */
import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import type { Attachment } from './schema.js';
import { ValidationError } from './lib/errors.js';

// 5MB
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

const IMAGE_FORMATS: Record<string, ImageFormat> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const PDF_TYPE = 'application/pdf';

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

    const imageFormat = IMAGE_FORMATS[att.media_type];
    if (imageFormat) {
      return {
        image: {
          format: imageFormat,
          source: { bytes: decoded },
        },
      };
    }

    if (att.media_type !== PDF_TYPE) {
      throw new ValidationError(`Unsupported media type: ${att.media_type}`);
    }

    const docName = att.name.includes('.') ? att.name.split('.').slice(0, -1).join('.') : att.name;
    return {
      document: {
        format: 'pdf',
        name: docName,
        source: { bytes: decoded },
      },
    };
  });
}

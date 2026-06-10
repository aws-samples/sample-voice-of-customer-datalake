/**
 * Tool definitions for the Converse Stream API.
 */
import type { Tool } from '@aws-sdk/client-bedrock-runtime';

export function getUpdateDocumentTool(): Tool {
  return {
    toolSpec: {
      name: 'update_document',
      description:
        'Update the content of a project document (PRD, PR/FAQ, research, or custom). ' +
        'Use this when the user asks to edit, modify, add to, or rewrite a document. ' +
        'Always provide the COMPLETE updated content, not just the changes.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            document_id: {
              type: 'string',
              description: 'The ID of the document to update.',
            },
            title: {
              type: 'string',
              description: 'Updated title (optional, only if the user wants to rename).',
            },
            content: {
              type: 'string',
              description: 'The full updated document content in markdown format.',
            },
            summary: {
              type: 'string',
              description: 'Brief summary of what was changed for the user.',
            },
          },
          required: ['document_id', 'content', 'summary'],
        },
      },
    },
  };
}

export function getCreateDocumentTool(): Tool {
  return {
    toolSpec: {
      name: 'create_document',
      description:
        'Create a new document in the project from the conversation. ' +
        'Use this when the user asks to create a new PRD, PR/FAQ, or custom document.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'Document title.',
            },
            content: {
              type: 'string',
              description: 'Document content in markdown format.',
            },
            document_type: {
              type: 'string',
              enum: ['prd', 'prfaq', 'custom'],
              description: 'Type of document to create.',
            },
          },
          required: ['title', 'content', 'document_type'],
        },
      },
    },
  };
}

export function getSearchFeedbackTool(): Tool {
  return {
    toolSpec: {
      name: 'search_feedback',
      description:
        'Search and retrieve customer feedback/reviews from the database. ' +
        'Use this tool ONLY when the user is asking about customer feedback, reviews, complaints, or opinions. ' +
        'Do NOT use for greetings, general questions, or non-feedback topics. ' +
        'You can also look up a specific review by its ID (32-character hex string).',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Search query to find relevant feedback (e.g., "delivery", "pricing", "app crash"). Can also be a feedback ID for direct lookup.',
            },
            source: {
              type: 'string',
              description: 'Filter by source platform (e.g., "webscraper", "manual_import", "s3_import").',
            },
            category: {
              type: 'string',
              description: 'Filter by category (e.g., "delivery", "customer_support", "product_quality").',
            },
            sentiment: {
              type: 'string',
              enum: ['positive', 'negative', 'neutral', 'mixed'],
              description: 'Filter by sentiment.',
            },
            urgency: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description: 'Filter by urgency level.',
            },
            limit: {
              type: 'integer',
              description: 'Maximum number of feedback items to return (default: 15, max: 30).',
            },
          },
          required: [],
        },
      },
    },
  };
}

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
        'You can also look up a specific review by its ID (32-character hex string).\n\n' +
        'IMPORTANT for broad questions: when the user asks to summarize, count, find trends, ' +
        'or surface "the most urgent / top / biggest issues" across feedback, set mode="aggregate" — ' +
        'it returns distribution stats over the ENTIRE match set in ONE call (no need to page). ' +
        'To rank by urgency, also use filters/sorting rather than free-text: pass urgency="high" and/or ' +
        'sort_by="urgency" instead of putting words like "urgent" in the query (query is a literal ' +
        'substring match against review text and will NOT find items by urgency level).',
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
              description: 'Maximum number of feedback items to return (default: 15, max: 30). In aggregate mode this only caps the example items shown alongside the stats.',
            },
            mode: {
              type: 'string',
              enum: ['list', 'aggregate'],
              description: 'list (default) returns individual feedback items. aggregate returns distribution stats (counts by urgency/sentiment/category/source + average rating) over ALL matches plus top examples — use for "summarize", "trends", "top/most urgent issues", or any whole-dataset question.',
            },
            sort_by: {
              type: 'string',
              enum: ['recent', 'urgency'],
              description: 'recent (default) or urgency (high→medium→low, most negative first). Use urgency when the user wants the most urgent/critical items.',
            },
          },
          required: [],
        },
      },
    },
  };
}

export function getCreateProjectTool(): Tool {
  return {
    toolSpec: {
      name: 'create_project',
      description:
        'Create a new project from the insights discovered in this conversation. ' +
        'Use this when the user asks to turn feedback findings into a project (e.g. ' +
        '"make a project out of this", "create a project for this issue", "프로젝트 만들어줘"). ' +
        'Draft the optional product-context fields (product_name, one_liner, target_users, ' +
        'problem_solved, key_features) from the feedback you analyzed so the new project starts ' +
        'pre-filled instead of blank — but only include a field if you can ground it in the ' +
        'actual feedback; leave it out rather than inventing.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Short project name (e.g. "Booking reliability fixes").',
            },
            description: {
              type: 'string',
              description: 'One-paragraph project description summarizing the goal/scope derived from the feedback.',
            },
            product_name: { type: 'string', description: 'Product/service name, if identifiable from feedback.' },
            one_liner: { type: 'string', description: 'One-line product summary.' },
            target_users: { type: 'string', description: 'Who the users are, per the feedback.' },
            problem_solved: { type: 'string', description: 'The core problem(s) the feedback surfaced.' },
            key_features: { type: 'string', description: 'Key features or fixes implied by the feedback.' },
          },
          required: ['name'],
        },
      },
    },
  };
}

/**
 * Textual grounding and metadata selection for project documents.
 * Prototype HTML remains metadata-only because it uses a dedicated revision flow.
 */
import type { ProjectItem } from './project-context.js';

export interface DocumentsContext {
  selectedContent: string;
  selectedTextDocuments: ProjectItem[];
  otherDocsList: string[];
}

export function isPrototypeDocument(document: ProjectItem): boolean {
  return document.document_type === 'prototype'
    || document.sk.startsWith('PROTOTYPE#');
}

export function buildDocumentsContext(
  documents: ProjectItem[],
  selectedDocumentIds: string[],
): DocumentsContext {
  const selectedParts: string[] = [];
  const selectedTextDocuments: ProjectItem[] = [];
  const otherDocsList: string[] = [];
  for (const doc of documents) {
    const docId = doc.document_id ?? '';
    const docType = (doc.document_type ?? 'doc').toUpperCase();
    const docTitle = doc.title ?? 'Untitled';
    const textContent = typeof doc.content === 'string' ? doc.content : '';
    const selectedTextDocument = selectedDocumentIds.includes(docId)
      && !isPrototypeDocument(doc)
      && textContent.trim().length > 0;
    if (selectedTextDocument) {
      selectedTextDocuments.push(doc);
      selectedParts.push(`\n## 📄 DOCUMENT: ${docTitle} (${docType}) [ID: ${docId}]\n\n${textContent}\n\n---\n`);
    } else {
      otherDocsList.push(`- ${docType}: ${docTitle} [ID: ${docId}]`);
    }
  }
  return {
    selectedContent: selectedParts.join(''),
    selectedTextDocuments,
    otherDocsList,
  };
}

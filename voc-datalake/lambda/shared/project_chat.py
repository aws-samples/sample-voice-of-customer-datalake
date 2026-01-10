"""
Shared project chat utilities for VoC Lambda functions.
Provides context building for project-based AI chat.
"""

import re
from boto3.dynamodb.conditions import Key

from shared.logging import logger


def get_project_data(projects_table, project_id: str) -> dict:
    """
    Get a project with all its data (metadata, personas, documents).
    
    Args:
        projects_table: DynamoDB Table resource for projects
        project_id: The project ID
    
    Returns:
        Dict with 'project', 'personas', 'documents' keys, or 'error' key on failure
    """
    if not projects_table:
        return {'error': 'Projects table not configured'}
    
    response = projects_table.query(
        KeyConditionExpression=Key('pk').eq(f'PROJECT#{project_id}')
    )
    
    items = response.get('Items', [])
    if not items:
        return {'error': 'Project not found'}
    
    project = None
    personas = []
    documents = []
    
    for item in items:
        sk = item.get('sk', '')
        if sk == 'META':
            project = {
                'project_id': item.get('project_id'),
                'name': item.get('name'),
                'description': item.get('description'),
                'status': item.get('status', 'active'),
                'created_at': item.get('created_at'),
                'updated_at': item.get('updated_at'),
                'persona_count': item.get('persona_count', 0),
                'document_count': item.get('document_count', 0),
                'filters': item.get('filters', {}),
            }
        elif sk.startswith('PERSONA#'):
            personas.append({
                'persona_id': item.get('persona_id'),
                'name': item.get('name'),
                'tagline': item.get('tagline'),
                'demographics': item.get('demographics', {}),
                'quote': item.get('quote'),
                'goals': item.get('goals', []),
                'frustrations': item.get('frustrations', []),
                'behaviors': item.get('behaviors', []),
                'needs': item.get('needs', []),
                'scenario': item.get('scenario'),
                'created_at': item.get('created_at'),
            })
        elif sk.startswith('DOC#') or sk.startswith('RESEARCH#') or sk.startswith('PRD#') or sk.startswith('PRFAQ#'):
            documents.append({
                'document_id': item.get('document_id'),
                'document_type': item.get('document_type'),
                'title': item.get('title'),
                'content': item.get('content'),
                'feature_idea': item.get('feature_idea'),
                'question': item.get('question'),
                'created_at': item.get('created_at'),
            })
    
    if not project:
        return {'error': 'Project metadata not found'}
    
    return {'project': project, 'personas': personas, 'documents': documents}


def get_feedback_for_chat(feedback_table, filters: dict, limit: int = 30) -> list:
    """
    Get feedback items based on filters for chat context.
    
    Args:
        feedback_table: DynamoDB Table resource for feedback
        filters: Dict with optional 'sources', 'categories', 'sentiments' keys
        limit: Maximum items to return
    
    Returns:
        List of feedback items
    """
    if not feedback_table:
        return []
    
    try:
        response = feedback_table.query(
            IndexName='gsi1-by-date',
            KeyConditionExpression=Key('gsi1pk').eq('DATE'),
            ScanIndexForward=False,
            Limit=limit * 2
        )
        
        items = response.get('Items', [])
        sources = filters.get('sources', [])
        categories = filters.get('categories', [])
        sentiments = filters.get('sentiments', [])
        
        filtered = []
        for item in items:
            if sources and item.get('source_platform') not in sources:
                continue
            if categories and item.get('category') not in categories:
                continue
            if sentiments and item.get('sentiment_label') not in sentiments:
                continue
            filtered.append(item)
            if len(filtered) >= limit:
                break
        
        return filtered
    except Exception as e:
        logger.warning(f"Failed to get feedback for chat: {e}")
        return []


def format_feedback_for_chat(items: list) -> str:
    """
    Format feedback items for LLM chat context.
    
    Args:
        items: List of feedback items
    
    Returns:
        Formatted string for LLM context
    """
    if not items:
        return "No feedback data available."
    
    lines = []
    for item in items[:20]:
        source = item.get('source_platform', 'unknown')
        sentiment = item.get('sentiment_label', 'unknown')
        category = item.get('category', 'unknown')
        text = item.get('original_text', '')[:300]
        lines.append(f"[{source}|{sentiment}|{category}] {text}")
    
    return "\n\n".join(lines)


def build_personas_context(personas: list) -> str:
    """
    Build detailed persona context for system prompt.
    
    Args:
        personas: List of persona dicts
    
    Returns:
        Formatted string for LLM context
    """
    if not personas:
        return ""
    
    detail = "\n## 👤 ACTIVE PERSONAS (Respond from their perspective)\n"
    for p in personas:
        goals = '\n'.join(['- ' + g for g in p.get('goals', [])[:4]])
        frustrations = '\n'.join(['- ' + f for f in p.get('frustrations', [])[:4]])
        needs = '\n'.join(['- ' + n for n in p.get('needs', [])[:4]])
        detail += f"""
### {p.get('name')} - {p.get('tagline', '')}

**Their voice:** "{p.get('quote', '')}"

**Goals:**
{goals}

**Frustrations:**
{frustrations}

**Needs:**
{needs}

---
"""
    return detail


def build_chat_context(
    projects_table,
    feedback_table,
    project_id: str,
    message: str,
    selected_persona_ids: list | None = None,
    selected_document_ids: list | None = None,
) -> tuple[str | None, str | None, dict]:
    """
    Build the system prompt and context for project chat.
    
    Args:
        projects_table: DynamoDB Table resource for projects
        feedback_table: DynamoDB Table resource for feedback
        project_id: The project ID
        message: User message
        selected_persona_ids: List of persona IDs to include
        selected_document_ids: List of document IDs to include
    
    Returns:
        Tuple of (system_prompt, user_message, metadata)
        - system_prompt is None if project not found (check metadata['error'])
    """
    selected_persona_ids = selected_persona_ids or []
    selected_document_ids = selected_document_ids or []
    
    project_data = get_project_data(projects_table, project_id)
    if 'error' in project_data:
        return None, None, {'error': project_data['error']}
    
    project = project_data.get('project', {})
    personas = project_data.get('personas', [])
    documents = project_data.get('documents', [])
    filters = project.get('filters', {})
    
    # Build persona map for mention detection
    persona_map = {p.get('name', '').lower(): p for p in personas}
    selected_personas = [p for p in personas if p.get('persona_id') in selected_persona_ids]
    
    # Check for persona mentions in message (e.g., @Marcus)
    mentions = re.findall(r'@(\w+)', message)
    mentioned_personas = []
    for mention in mentions:
        for name, persona in persona_map.items():
            if mention.lower() in name.lower() and persona not in mentioned_personas:
                mentioned_personas.append(persona)
    
    # Combine selected and mentioned personas (deduplicated by persona_id)
    all_active_personas = list({
        p.get('persona_id'): p for p in (selected_personas + mentioned_personas)
    }.values())
    
    # Build documents context - ONLY include selected documents with full content
    selected_docs_content = ""
    other_docs_list = []
    
    for doc in documents:
        doc_id = doc.get('document_id', '')
        doc_type = doc.get('document_type', 'doc').upper()
        doc_title = doc.get('title', 'Untitled')
        
        if doc_id in selected_document_ids:
            content = doc.get('content', '')
            selected_docs_content += f"\n## 📄 DOCUMENT: {doc_title} ({doc_type})\n\n{content}\n\n---\n"
        else:
            other_docs_list.append(f"- {doc_type}: {doc_title}")
    
    # Build system prompt
    system_prompt = f'You are an AI product research assistant working on the project "{project.get("name", "Project")}".\n\n'

    if selected_docs_content:
        system_prompt += f"## REFERENCED DOCUMENTS (Use this content to answer the question)\n{selected_docs_content}\n"

    if all_active_personas:
        active_personas_detail = build_personas_context(all_active_personas)
        persona_names = [p.get('name') for p in all_active_personas]
        system_prompt += f"{active_personas_detail}\n🎯 PERSONA MODE ACTIVE: {', '.join(persona_names)}\n"
        system_prompt += 'Respond AS IF you are this persona - use first person ("I think...", "As someone who..."), channel their specific frustrations, goals, and needs.\n\n'

    # Only fetch feedback if NO documents are selected
    feedback_items = []
    if not selected_document_ids:
        feedback_items = get_feedback_for_chat(feedback_table, filters, limit=30)
        feedback_context = format_feedback_for_chat(feedback_items[:15])
        system_prompt += f"## Recent Customer Feedback\n{feedback_context}\n\n"

    if other_docs_list:
        system_prompt += f"## Other Available Documents (not currently referenced)\n{chr(10).join(other_docs_list[:5])}\n\n"
    
    if personas and not all_active_personas:
        persona_names_list = [f"@{p.get('name')}" for p in personas[:5]]
        system_prompt += f"## Available Personas (mention with @ to activate)\n{', '.join(persona_names_list)}\n\n"

    if selected_document_ids:
        doc_titles = [doc.get('title') for doc in documents if doc.get('document_id') in selected_document_ids]
        system_prompt += f"📄 IMPORTANT: The user has tagged the document(s): {', '.join(doc_titles)}\n"
        system_prompt += "You MUST use the document content provided above to answer their question.\n\n"

    system_prompt += "Be specific, accurate, and base your response on the provided context."

    metadata = {
        'mentioned_personas': [p.get('name') for p in mentioned_personas],
        'selected_personas': [p.get('name') for p in selected_personas],
        'referenced_documents': [doc.get('title') for doc in documents if doc.get('document_id') in selected_document_ids],
        'context': {
            'feedback_count': len(feedback_items),
            'persona_count': len(personas),
            'document_count': len(documents)
        }
    }
    
    return system_prompt, message, metadata

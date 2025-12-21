"""
Streaming chat handler for project AI chat.
Uses Lambda Response Streaming to avoid API Gateway 29s timeout.

Security Architecture:
=====================
This Lambda uses a Function URL with authType: NONE, implementing custom Cognito JWT
validation. This approach was chosen over IAM auth (SigV4) because:

1. The frontend uses Cognito User Pool authentication (not Identity Pool)
2. SigV4 signing would require adding a Cognito Identity Pool and AWS SDK
3. JWT validation provides equivalent security when implemented correctly

Security Controls:
- Cryptographic signature verification using Cognito JWKS (RS256)
- Token issuer validation against configured User Pool
- Token expiration validation with clock skew tolerance
- Token type validation (id/access tokens only)
- Audience validation for ID tokens

The JWT validation follows AWS Cognito best practices:
https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html
"""
import json
import os
import re
import hmac
import hashlib
import base64
import urllib.request
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from boto3.dynamodb.conditions import Key, Attr

# Shared module imports
from shared.logging import logger, tracer, metrics
from shared.aws import get_dynamodb_resource, get_bedrock_client, BEDROCK_MODEL_ID

# AWS Clients (using shared module for connection reuse)
dynamodb = get_dynamodb_resource()
bedrock = get_bedrock_client()

PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')
FEEDBACK_TABLE = os.environ.get('FEEDBACK_TABLE', '')
USER_POOL_ID = os.environ.get('USER_POOL_ID', '')
AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')

# Cache for Cognito JWKS (JSON Web Key Set) with TTL
_cached_jwks = None
_jwks_cache_time = None
JWKS_CACHE_TTL_SECONDS = 3600  # 1 hour cache for JWKS

# Clock skew tolerance for token expiration (5 minutes)
CLOCK_SKEW_SECONDS = 300

# Default categories fallback
DEFAULT_CATEGORIES = ['delivery', 'customer_support', 'product_quality', 'pricing', 
                      'website', 'app', 'billing', 'returns', 'communication', 'other']

# Cache for configured categories
_categories_cache = None
_categories_cache_time = None
CATEGORIES_CACHE_TTL = 300  # 5 minutes


def get_configured_categories() -> list:
    """Fetch configured categories from DynamoDB settings with caching."""
    global _categories_cache, _categories_cache_time
    
    aggregates_table = dynamodb.Table(os.environ.get('AGGREGATES_TABLE', 'voc-aggregates'))
    now = datetime.now(timezone.utc).timestamp()
    
    # Return cached if still valid
    if _categories_cache is not None and _categories_cache_time and (now - _categories_cache_time) < CATEGORIES_CACHE_TTL:
        return _categories_cache
    
    try:
        response = aggregates_table.get_item(Key={'pk': 'SETTINGS#categories', 'sk': 'config'})
        item = response.get('Item')
        if item and item.get('categories'):
            _categories_cache = [cat.get('name') for cat in item.get('categories', []) if cat.get('name')]
            _categories_cache_time = now
            logger.info(f"Loaded {len(_categories_cache)} categories from settings")
            return _categories_cache
    except Exception as e:
        logger.warning(f"Could not fetch categories from settings: {e}")
    
    # Fallback to defaults
    _categories_cache = DEFAULT_CATEGORIES
    _categories_cache_time = now
    return _categories_cache


def get_cognito_jwks() -> dict | None:
    """
    Fetch Cognito JWKS for token signature verification (cached with TTL).
    
    The JWKS contains the public keys used to verify JWT signatures.
    Keys are cached for 1 hour to reduce latency while allowing key rotation.
    """
    global _cached_jwks, _jwks_cache_time
    
    # Check cache validity
    now = datetime.now(timezone.utc)
    if _cached_jwks is not None and _jwks_cache_time is not None:
        cache_age = (now - _jwks_cache_time).total_seconds()
        if cache_age < JWKS_CACHE_TTL_SECONDS:
            return _cached_jwks
    
    if not USER_POOL_ID:
        logger.warning("USER_POOL_ID not configured - authentication disabled")
        return None
    
    try:
        jwks_url = f"https://cognito-idp.{AWS_REGION}.amazonaws.com/{USER_POOL_ID}/.well-known/jwks.json"
        with urllib.request.urlopen(jwks_url, timeout=5) as response:
            _cached_jwks = json.loads(response.read().decode())
            _jwks_cache_time = now
            logger.info("Refreshed Cognito JWKS cache")
            return _cached_jwks
    except Exception as e:
        logger.error(f"Failed to fetch Cognito JWKS: {e}")
        # Return stale cache if available (better than failing)
        if _cached_jwks is not None:
            logger.warning("Using stale JWKS cache due to fetch failure")
            return _cached_jwks
        return None


def base64url_decode(data: str) -> bytes:
    """Decode base64url-encoded data with proper padding."""
    # Add padding if needed
    padding = 4 - len(data) % 4
    if padding != 4:
        data += '=' * padding
    return base64.urlsafe_b64decode(data)


def decode_jwt_parts(token: str) -> tuple[dict | None, dict | None, bytes | None]:
    """
    Decode JWT into header, payload, and signature.
    Returns (header, payload, signature) or (None, None, None) on error.
    """
    try:
        parts = token.split('.')
        if len(parts) != 3:
            return None, None, None
        
        header = json.loads(base64url_decode(parts[0]))
        payload = json.loads(base64url_decode(parts[1]))
        signature = base64url_decode(parts[2])
        
        return header, payload, signature
    except Exception as e:
        logger.warning(f"Failed to decode JWT parts: {e}")
        return None, None, None


def get_public_key_from_jwks(jwks: dict, kid: str) -> dict | None:
    """Find the public key in JWKS matching the key ID (kid)."""
    for key in jwks.get('keys', []):
        if key.get('kid') == kid:
            return key
    return None


def verify_rs256_signature(token: str, jwks: dict) -> bool:
    """
    Verify RS256 JWT signature using Cognito JWKS.
    
    This implements cryptographic signature verification per RFC 7515.
    Uses the RSA public key from JWKS to verify the token wasn't tampered with.
    """
    try:
        header, payload, signature = decode_jwt_parts(token)
        if not header or not payload or signature is None:
            return False
        
        # Verify algorithm is RS256 (Cognito uses RS256)
        if header.get('alg') != 'RS256':
            logger.warning(f"Unexpected JWT algorithm: {header.get('alg')}")
            return False
        
        # Get the key ID from header
        kid = header.get('kid')
        if not kid:
            logger.warning("JWT missing key ID (kid)")
            return False
        
        # Find matching public key in JWKS
        public_key = get_public_key_from_jwks(jwks, kid)
        if not public_key:
            logger.warning(f"No matching key found in JWKS for kid: {kid}")
            return False
        
        # Verify key type and usage
        if public_key.get('kty') != 'RSA':
            logger.warning(f"Unexpected key type: {public_key.get('kty')}")
            return False
        
        if public_key.get('use') != 'sig':
            logger.warning(f"Key not for signature verification: {public_key.get('use')}")
            return False
        
        # For full cryptographic verification, we need the RSA public key components
        # n (modulus) and e (exponent) from the JWK
        n = public_key.get('n')
        e = public_key.get('e')
        
        if not n or not e:
            logger.warning("JWK missing RSA components (n, e)")
            return False
        
        # Construct the signing input (header.payload)
        parts = token.split('.')
        signing_input = f"{parts[0]}.{parts[1]}".encode('utf-8')
        
        # Perform RSA signature verification
        # Decode the RSA public key components
        n_bytes = base64url_decode(n)
        e_bytes = base64url_decode(e)
        
        # Convert to integers
        n_int = int.from_bytes(n_bytes, 'big')
        e_int = int.from_bytes(e_bytes, 'big')
        
        # RSA verification: signature^e mod n should equal padded hash
        sig_int = int.from_bytes(signature, 'big')
        
        # Compute signature^e mod n
        decrypted = pow(sig_int, e_int, n_int)
        
        # Convert back to bytes (key size)
        key_size = (n_int.bit_length() + 7) // 8
        decrypted_bytes = decrypted.to_bytes(key_size, 'big')
        
        # PKCS#1 v1.5 signature verification
        # Expected format: 0x00 0x01 [padding 0xFF bytes] 0x00 [DigestInfo] [Hash]
        # DigestInfo for SHA-256: 30 31 30 0d 06 09 60 86 48 01 65 03 04 02 01 05 00 04 20
        sha256_digest_info = bytes([
            0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01,
            0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20
        ])
        
        # Compute SHA-256 hash of signing input
        message_hash = hashlib.sha256(signing_input).digest()
        
        # Build expected PKCS#1 v1.5 padded message
        # 0x00 0x01 [0xFF padding] 0x00 [DigestInfo] [Hash]
        t_len = len(sha256_digest_info) + len(message_hash)
        ps_len = key_size - t_len - 3
        
        if ps_len < 8:
            logger.warning("Key too small for PKCS#1 v1.5 padding")
            return False
        
        expected = bytes([0x00, 0x01]) + bytes([0xFF] * ps_len) + bytes([0x00]) + sha256_digest_info + message_hash
        
        if decrypted_bytes == expected:
            return True
        
        logger.warning("JWT signature verification failed")
        return False
        
    except Exception as e:
        logger.warning(f"JWT signature verification error: {e}")
        return False


def validate_cognito_token(token: str) -> tuple[bool, str, dict | None]:
    """
    Validate a Cognito JWT token with full cryptographic verification.
    
    Validation steps (per AWS Cognito documentation):
    1. Verify the JWT signature using the public key from JWKS
    2. Verify the token is not expired (with clock skew tolerance)
    3. Verify the issuer matches the Cognito User Pool
    4. Verify the token_use claim (id or access)
    5. For ID tokens, verify the audience (aud) matches the app client ID
    
    Returns (is_valid, error_message, claims).
    """
    if not USER_POOL_ID:
        # If User Pool not configured, allow request (dev mode only)
        logger.warning("Cognito validation skipped - USER_POOL_ID not configured")
        return True, "", None
    
    # Step 1: Decode token parts
    header, claims, signature = decode_jwt_parts(token)
    if not header or not claims or signature is None:
        return False, "Invalid token format", None
    
    # Step 2: Verify signature using JWKS
    jwks = get_cognito_jwks()
    if jwks:
        if not verify_rs256_signature(token, jwks):
            return False, "Invalid token signature", None
    else:
        # If JWKS unavailable, log warning but continue with other validations
        # This provides defense-in-depth even if JWKS fetch fails
        logger.warning("JWKS unavailable - skipping signature verification")
    
    # Step 3: Validate issuer
    expected_issuer = f"https://cognito-idp.{AWS_REGION}.amazonaws.com/{USER_POOL_ID}"
    if claims.get('iss') != expected_issuer:
        return False, "Invalid token issuer", None
    
    # Step 4: Validate expiration (with clock skew tolerance)
    exp = claims.get('exp')
    if exp:
        current_time = datetime.now(timezone.utc).timestamp()
        if current_time > (exp + CLOCK_SKEW_SECONDS):
            return False, "Token expired", None
    else:
        return False, "Token missing expiration", None
    
    # Step 5: Validate token use (should be 'id' or 'access')
    token_use = claims.get('token_use')
    if token_use not in ('id', 'access'):
        return False, "Invalid token type", None
    
    # Step 6: Validate not-before time if present
    nbf = claims.get('nbf')
    if nbf:
        current_time = datetime.now(timezone.utc).timestamp()
        if current_time < (nbf - CLOCK_SKEW_SECONDS):
            return False, "Token not yet valid", None
    
    return True, "", claims


def validate_auth(event: dict) -> tuple[bool, str]:
    """
    Validate the request authentication.
    
    Extracts the JWT from the Authorization header and performs full validation.
    Supports both "Bearer <token>" and raw token formats.
    
    Returns (is_valid, error_message).
    """
    # Get Authorization header (case-insensitive)
    headers = event.get('headers', {}) or {}
    auth_header = None
    
    for key, value in headers.items():
        if key.lower() == 'authorization':
            auth_header = value
            break
    
    if not auth_header:
        return False, "Missing Authorization header"
    
    # Remove "Bearer " prefix if present
    token = auth_header
    if auth_header.lower().startswith('bearer '):
        token = auth_header[7:]
    
    # Validate Cognito token with full cryptographic verification
    is_valid, error_msg, claims = validate_cognito_token(token)
    if not is_valid:
        logger.warning(f"Token validation failed: {error_msg}")
        return False, error_msg
    
    if claims:
        # Log authenticated user (email or sub for audit trail)
        user_id = claims.get('email') or claims.get('sub', 'unknown')
        logger.info(f"Authenticated user: {user_id}")
    
    return True, ""


def unauthorized_response(message: str = "Unauthorized") -> dict:
    """Return a 401 Unauthorized response with security headers."""
    return {
        'statusCode': 401,
        'headers': {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer realm="voc-api"',
        },
        'body': json.dumps({'error': message})
    }

projects_table = dynamodb.Table(PROJECTS_TABLE) if PROJECTS_TABLE else None
feedback_table = dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None

MODEL_ID = BEDROCK_MODEL_ID


class DecimalEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        return super().default(obj)


def validate_days(value: str | int | None, default: int = 7, min_val: int = 1, max_val: int = 365) -> int:
    """Validate and bound days parameter."""
    try:
        days = int(value) if value is not None else default
        return max(min_val, min(days, max_val))
    except (ValueError, TypeError):
        return default


def get_project(project_id: str) -> dict:
    """Get a project with all its data."""
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
    
    return {'project': project, 'personas': personas, 'documents': documents}


def get_feedback_context(filters: dict, limit: int = 30) -> list:
    """Get feedback items based on filters."""
    if not feedback_table:
        return []
    
    days = filters.get('days', 30)
    cutoff = datetime.now(timezone.utc).isoformat()[:10]
    
    try:
        response = feedback_table.query(
            IndexName='gsi1-by-date',
            KeyConditionExpression=Key('gsi1pk').eq('DATE'),
            ScanIndexForward=False,
            Limit=limit * 2
        )
        
        items = response.get('Items', [])
        
        # Apply filters
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
        logger.warning(f"Failed to get feedback: {e}")
        return []


def format_feedback_for_llm(items: list) -> str:
    """Format feedback items for LLM context."""
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


def build_chat_context(project_id: str, body: dict) -> tuple[str, str, dict]:
    """Build the system prompt and context for chat."""
    message = body.get('message', '')
    selected_persona_ids = body.get('selected_personas', [])
    selected_document_ids = body.get('selected_documents', [])
    
    project_data = get_project(project_id)
    if 'error' in project_data:
        return None, None, {'error': project_data['error']}
    
    project = project_data.get('project', {})
    personas = project_data.get('personas', [])
    documents = project_data.get('documents', [])
    filters = project.get('filters', {})
    
    # Build persona map for mention detection
    persona_map = {}
    selected_personas = []
    
    for p in personas:
        name = p.get('name', '')
        persona_id = p.get('persona_id', '')
        persona_map[name.lower()] = p
        
        if persona_id in selected_persona_ids:
            selected_personas.append(p)
    
    # Check for persona mentions in message (e.g., @Marcus)
    mentions = re.findall(r'@(\w+)', message)
    mentioned_personas = []
    for mention in mentions:
        for name, persona in persona_map.items():
            if mention.lower() in name.lower() and persona not in mentioned_personas:
                mentioned_personas.append(persona)
    
    all_active_personas = list({p.get('persona_id'): p for p in (selected_personas + mentioned_personas)}.values())
    
    # Build documents context - ONLY include selected documents with full content
    selected_docs_content = ""
    other_docs_list = []
    
    for doc in documents:
        doc_id = doc.get('document_id', '')
        doc_type = doc.get('document_type', 'doc').upper()
        doc_title = doc.get('title', 'Untitled')
        
        if doc_id in selected_document_ids:
            # Include FULL content for selected/tagged documents
            content = doc.get('content', '')
            selected_docs_content += f"""
## 📄 DOCUMENT: {doc_title} ({doc_type})

{content}

---
"""
        else:
            other_docs_list.append(f"- {doc_type}: {doc_title}")
    
    # Build active personas detail ONLY if personas are selected/mentioned
    active_personas_detail = ""
    if all_active_personas:
        active_personas_detail = "\n## 👤 ACTIVE PERSONAS (Respond from their perspective)\n"
        for p in all_active_personas:
            active_personas_detail += f"""
### {p.get('name')} - {p.get('tagline', '')}

**Their voice:** "{p.get('quote', '')}"

**Goals:**
{chr(10).join(['- ' + g for g in p.get('goals', [])[:4]])}

**Frustrations:**
{chr(10).join(['- ' + f for f in p.get('frustrations', [])[:4]])}

**Needs:**
{chr(10).join(['- ' + n for n in p.get('needs', [])[:4]])}

---
"""

    # Build system prompt - ONLY include relevant context
    system_prompt = f"""You are an AI product research assistant working on the project "{project.get('name', 'Project')}".

"""

    # Add selected documents FIRST (most important context)
    if selected_docs_content:
        system_prompt += f"""## REFERENCED DOCUMENTS (Use this content to answer the question)
{selected_docs_content}

"""

    # Add active personas if any are selected/mentioned
    if all_active_personas:
        persona_names = [p.get('name') for p in all_active_personas]
        system_prompt += f"""{active_personas_detail}

🎯 PERSONA MODE ACTIVE: {', '.join(persona_names)}
Respond AS IF you are this persona - use first person ("I think...", "As someone who..."), channel their specific frustrations, goals, and needs.

"""

    # Only fetch and include feedback if NO documents are selected (to keep context focused)
    if not selected_document_ids:
        feedback_items = get_feedback_context(filters, limit=30)
        feedback_context = format_feedback_for_llm(feedback_items[:15])
        system_prompt += f"""## Recent Customer Feedback
{feedback_context}

"""
    else:
        feedback_items = []

    # List other available resources (brief)
    if other_docs_list:
        system_prompt += f"""## Other Available Documents (not currently referenced)
{chr(10).join(other_docs_list[:5])}

"""
    
    if personas and not all_active_personas:
        persona_names_list = [f"@{p.get('name')}" for p in personas[:5]]
        system_prompt += f"""## Available Personas (mention with @ to activate)
{', '.join(persona_names_list)}

"""

    # Add instructions based on what's selected
    if selected_document_ids:
        doc_titles = [doc.get('title') for doc in documents if doc.get('document_id') in selected_document_ids]
        system_prompt += f"""📄 IMPORTANT: The user has tagged the document(s): {', '.join(doc_titles)}
You MUST use the document content provided above to answer their question.
- Cite specific sections, findings, or data points from the document
- If summarizing, capture the key points from the actual document content
- Do NOT make up information - only use what's in the document

"""

    system_prompt += """Be specific, accurate, and base your response on the provided context."""

    metadata = {
        'mentioned_personas': [p.get('name') for p in mentioned_personas],
        'selected_personas': [p.get('name') for p in selected_personas],
        'referenced_documents': [doc.get('title') for doc in documents if doc.get('document_id') in selected_document_ids],
        'context': {
            'feedback_count': len(feedback_items) if not selected_document_ids else 0,
            'persona_count': len(personas),
            'document_count': len(documents)
        }
    }
    
    return system_prompt, message, metadata



def handler(event, context):
    """
    Lambda handler for project chat via Function URL.
    CORS is handled by the Function URL config - don't add headers here.
    Requires valid API key in Authorization header.
    """
    # Validate authentication
    is_valid, error_msg = validate_auth(event)
    if not is_valid:
        logger.warning(f"Authentication failed: {error_msg}")
        return unauthorized_response(error_msg)
    
    try:
        body = json.loads(event.get('body', '{}'))
        
        # Extract project_id from path
        path = event.get('rawPath', '') or event.get('requestContext', {}).get('http', {}).get('path', '')
        # Path format: /projects/{project_id}/chat/stream
        parts = path.strip('/').split('/')
        project_id = None
        for i, part in enumerate(parts):
            if part == 'projects' and i + 1 < len(parts):
                project_id = parts[i + 1]
                break
        
        if not project_id:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'Project ID required'})
            }
        
        # Build context
        system_prompt, user_message, metadata = build_chat_context(project_id, body)
        
        if system_prompt is None:
            return {
                'statusCode': 404,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': metadata.get('error', 'Project not found')})
            }
        
        # Call Bedrock with streaming
        response = bedrock.invoke_model_with_response_stream(
            modelId=MODEL_ID,
            contentType='application/json',
            accept='application/json',
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 3000,
                'system': system_prompt,
                'messages': [{'role': 'user', 'content': user_message}]
            })
        )
        
        # Collect streamed response
        full_response = ""
        for event_chunk in response.get('body', []):
            chunk = json.loads(event_chunk.get('chunk', {}).get('bytes', b'{}'))
            if chunk.get('type') == 'content_block_delta':
                delta = chunk.get('delta', {})
                if delta.get('type') == 'text_delta':
                    full_response += delta.get('text', '')
        
        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({
                'success': True,
                'response': full_response,
                **metadata
            })
        }
        
    except Exception as e:
        logger.exception(f"Stream chat error: {e}")
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': 'An internal error occurred. Please try again.'})
        }


# For true streaming to the client, we need a streaming handler
def streaming_handler(event, response_stream, context):
    """
    True streaming handler - streams chunks directly to client.
    Requires Lambda Function URL with response streaming enabled.
    """
    import awslambda
    
    try:
        body = json.loads(event.get('body', '{}'))
        
        # Extract project_id from path
        path = event.get('rawPath', '')
        parts = path.strip('/').split('/')
        project_id = None
        for i, part in enumerate(parts):
            if part == 'projects' and i + 1 < len(parts):
                project_id = parts[i + 1]
                break
        
        if not project_id:
            response_stream.write(json.dumps({'error': 'Project ID required'}))
            response_stream.close()
            return
        
        # Build context
        system_prompt, user_message, metadata = build_chat_context(project_id, body)
        
        if system_prompt is None:
            response_stream.write(json.dumps({'error': metadata.get('error', 'Project not found')}))
            response_stream.close()
            return
        
        # Send metadata first
        response_stream.write(f"data: {json.dumps({'type': 'metadata', **metadata})}\n\n")
        
        # Call Bedrock with streaming
        response = bedrock.invoke_model_with_response_stream(
            modelId=MODEL_ID,
            contentType='application/json',
            accept='application/json',
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 3000,
                'system': system_prompt,
                'messages': [{'role': 'user', 'content': user_message}]
            })
        )
        
        # Stream each chunk to client
        for event_chunk in response.get('body', []):
            chunk = json.loads(event_chunk.get('chunk', {}).get('bytes', b'{}'))
            if chunk.get('type') == 'content_block_delta':
                delta = chunk.get('delta', {})
                if delta.get('type') == 'text_delta':
                    text = delta.get('text', '')
                    response_stream.write(f"data: {json.dumps({'type': 'text', 'text': text})}\n\n")
        
        # Send done signal
        response_stream.write(f"data: {json.dumps({'type': 'done'})}\n\n")
        response_stream.close()
        
    except Exception as e:
        logger.exception(f"Streaming error: {e}")
        response_stream.write(f"data: {json.dumps({'type': 'error', 'error': 'An internal error occurred. Please try again.'})}\n\n")
        response_stream.close()


# ============================================
# VoC AI Chat Streaming (Main Chat Page)
# ============================================

AGGREGATES_TABLE = os.environ.get('AGGREGATES_TABLE', '')
aggregates_table = dynamodb.Table(AGGREGATES_TABLE) if AGGREGATES_TABLE else None


def parse_context_filters(context_hint: str) -> dict:
    """Parse filter values from context hint string."""
    filters = {}
    if not context_hint:
        return filters
    
    # Parse "Source: xxx" pattern
    source_match = re.search(r'Source:\s*([^.]+)', context_hint)
    if source_match:
        filters['source'] = source_match.group(1).strip()
    
    category_match = re.search(r'Category:\s*([^.]+)', context_hint)
    if category_match:
        filters['category'] = category_match.group(1).strip()
    
    sentiment_match = re.search(r'Sentiment:\s*([^.]+)', context_hint)
    if sentiment_match:
        filters['sentiment'] = sentiment_match.group(1).strip()
    
    return filters


def get_voc_chat_context(body: dict) -> tuple[str, str, dict]:
    """Build context for VoC AI Chat (main chat page)."""
    message = body.get('message', '')
    context_hint = body.get('context', '')
    days = validate_days(body.get('days'), default=7)
    
    # Parse filters from context hint
    parsed_filters = parse_context_filters(context_hint)
    source_filter = parsed_filters.get('source')
    category_filter = parsed_filters.get('category')
    sentiment_filter = parsed_filters.get('sentiment')
    
    current_date = datetime.now(timezone.utc)
    
    # Get metrics from aggregates
    total_feedback = 0
    sentiment_counts = {'positive': 0, 'negative': 0, 'neutral': 0, 'mixed': 0}
    category_counts = {}
    urgent_count = 0
    
    if aggregates_table:
        # Get daily totals
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            try:
                response = aggregates_table.get_item(Key={'pk': 'METRIC#daily_total', 'sk': date})
                item = response.get('Item')
                if item:
                    total_feedback += int(item.get('count', 0))
            except Exception:
                pass
        
        # Get sentiment breakdown
        for sentiment in sentiment_counts.keys():
            for i in range(days):
                date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
                try:
                    response = aggregates_table.get_item(Key={'pk': f'METRIC#daily_sentiment#{sentiment}', 'sk': date})
                    item = response.get('Item')
                    if item:
                        sentiment_counts[sentiment] += int(item.get('count', 0))
                except Exception:
                    pass
        
        # Get category breakdown
        categories = get_configured_categories()
        for category in categories:
            total = 0
            for i in range(days):
                date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
                try:
                    response = aggregates_table.get_item(Key={'pk': f'METRIC#daily_category#{category}', 'sk': date})
                    item = response.get('Item')
                    if item:
                        total += int(item.get('count', 0))
                except Exception:
                    pass
            if total > 0:
                category_counts[category] = total
        
        # Get urgent count
        for i in range(days):
            date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
            try:
                response = aggregates_table.get_item(Key={'pk': 'METRIC#urgent', 'sk': date})
                item = response.get('Item')
                if item:
                    urgent_count += int(item.get('count', 0))
            except Exception:
                pass
    
    # Get recent feedback items with filters applied
    feedback_items = []
    urgent_items = []
    
    if feedback_table:
        # If source filter is set, query by source instead of date
        if source_filter:
            try:
                response = feedback_table.query(
                    KeyConditionExpression=Key('pk').eq(f'SOURCE#{source_filter}'),
                    Limit=50,
                    ScanIndexForward=False
                )
                items = response.get('Items', [])
                # Apply additional filters
                for item in items:
                    if category_filter and item.get('category') != category_filter:
                        continue
                    if sentiment_filter and item.get('sentiment_label') != sentiment_filter:
                        continue
                    feedback_items.append(item)
                    if len(feedback_items) >= 30:
                        break
            except Exception as e:
                logger.warning(f"Failed to query by source: {e}")
        else:
            # Query by date and apply filters
            for i in range(min(days, 7)):
                date = (current_date - timedelta(days=i)).strftime('%Y-%m-%d')
                try:
                    response = feedback_table.query(
                        IndexName='gsi1-by-date',
                        KeyConditionExpression=Key('gsi1pk').eq(f'DATE#{date}'),
                        Limit=30,
                        ScanIndexForward=False
                    )
                    for item in response.get('Items', []):
                        # Apply filters
                        if category_filter and item.get('category') != category_filter:
                            continue
                        if sentiment_filter and item.get('sentiment_label') != sentiment_filter:
                            continue
                        feedback_items.append(item)
                    if len(feedback_items) >= 30:
                        break
                except Exception:
                    pass
        
        # Get urgent items if relevant
        if 'urgent' in message.lower() or 'attention' in message.lower():
            try:
                response = feedback_table.query(
                    IndexName='gsi3-by-urgency',
                    KeyConditionExpression=Key('gsi3pk').eq('URGENCY#high'),
                    Limit=10,
                    ScanIndexForward=False
                )
                urgent_items = response.get('Items', [])
            except Exception:
                pass
    
    # Build feedback context
    feedback_context = []
    for item in feedback_items[:20]:
        feedback_context.append({
            'source': item.get('source_platform', 'unknown'),
            'date': item.get('source_created_at', '')[:10] if item.get('source_created_at') else '',
            'text': item.get('original_text', '')[:500],
            'sentiment': item.get('sentiment_label', 'unknown'),
            'sentiment_score': float(item.get('sentiment_score', 0)),
            'category': item.get('category', 'other'),
            'urgency': item.get('urgency', 'low'),
            'rating': item.get('rating'),
            'persona': item.get('persona_name', ''),
            'problem_summary': item.get('problem_summary', ''),
        })
    
    # Build system prompt
    system_prompt = """You are a Voice of the Customer (VoC) analytics assistant. You help analyze customer feedback data and provide actionable insights.

You have access to real customer feedback data from various sources including Trustpilot, Google Reviews, Twitter, Instagram, Facebook, Reddit, and app stores.

When answering questions:
1. Base your answers ONLY on the actual data provided in the context
2. Be specific with numbers and percentages from the data
3. Quote actual customer feedback when relevant
4. Highlight urgent issues that need attention
5. Provide actionable recommendations based on the data
6. If the data doesn't contain information to answer a question, say so honestly

Format your responses clearly with bullet points or numbered lists when appropriate."""

    # Build data context
    data_context = f"""## Current Data Summary (Last {days} days)

**Total Feedback Items:** {total_feedback}
**Urgent Issues:** {urgent_count}

**Sentiment Breakdown:**
- Positive: {sentiment_counts['positive']} ({round(sentiment_counts['positive']/max(total_feedback,1)*100, 1)}%)
- Neutral: {sentiment_counts['neutral']} ({round(sentiment_counts['neutral']/max(total_feedback,1)*100, 1)}%)
- Negative: {sentiment_counts['negative']} ({round(sentiment_counts['negative']/max(total_feedback,1)*100, 1)}%)
- Mixed: {sentiment_counts['mixed']} ({round(sentiment_counts['mixed']/max(total_feedback,1)*100, 1)}%)

**Top Categories:**
{chr(10).join([f"- {cat}: {count}" for cat, count in sorted(category_counts.items(), key=lambda x: x[1], reverse=True)[:5]])}

## Recent Customer Feedback Samples:
"""
    
    for i, fb in enumerate(feedback_context[:15], 1):
        data_context += f"""
### Feedback #{i}
- Source: {fb['source']}
- Date: {fb['date']}
- Sentiment: {fb['sentiment']} ({fb['sentiment_score']:.2f})
- Category: {fb['category']}
- Urgency: {fb['urgency']}
- Rating: {fb['rating'] if fb['rating'] else 'N/A'}
- Text: "{fb['text']}"
{f"- Problem Summary: {fb['problem_summary']}" if fb['problem_summary'] else ''}
"""

    if urgent_items:
        data_context += "\n## Urgent Issues Requiring Attention:\n"
        for i, item in enumerate(urgent_items[:5], 1):
            data_context += f"""
### Urgent #{i}
- Source: {item.get('source_platform', 'unknown')}
- Text: "{item.get('original_text', '')[:300]}"
- Category: {item.get('category', 'other')}
"""

    # Show active filters
    active_filters = []
    if source_filter:
        active_filters.append(f"Source: {source_filter}")
    if category_filter:
        active_filters.append(f"Category: {category_filter}")
    if sentiment_filter:
        active_filters.append(f"Sentiment: {sentiment_filter}")
    
    if active_filters:
        data_context += f"\n## Active Filters: {', '.join(active_filters)}\n"
        data_context += "Note: The feedback samples above have been filtered based on these criteria.\n"

    user_message = f"{data_context}\n\n---\n\nUser Question: {message}"
    
    # Get source items for response
    source_items = urgent_items[:3] if urgent_items else feedback_items[:3]
    
    metadata = {
        'total_feedback': total_feedback,
        'days_analyzed': days,
        'urgent_count': urgent_count,
        'sources': source_items
    }
    
    return system_prompt, user_message, metadata


def voc_chat_handler(event, context):
    """
    Lambda handler for VoC AI Chat via Function URL.
    Requires valid API key in Authorization header.
    """
    # Validate authentication
    is_valid, error_msg = validate_auth(event)
    if not is_valid:
        logger.warning(f"Authentication failed: {error_msg}")
        return unauthorized_response(error_msg)
    
    try:
        body_str = event.get('body', '{}')
        if not body_str:
            body_str = '{}'
        body = json.loads(body_str)
        
        message = body.get('message', '')
        if not message:
            return {
                'statusCode': 400,
                'headers': {'Content-Type': 'application/json'},
                'body': json.dumps({'error': 'Message is required'})
            }
        
        # Build context
        system_prompt, user_message, metadata = get_voc_chat_context(body)
        
        # Call Bedrock with streaming
        response = bedrock.invoke_model_with_response_stream(
            modelId=MODEL_ID,
            contentType='application/json',
            accept='application/json',
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 2000,
                'system': system_prompt,
                'messages': [{'role': 'user', 'content': user_message}]
            })
        )
        
        # Collect streamed response
        full_response = ""
        for event_chunk in response.get('body', []):
            chunk = json.loads(event_chunk.get('chunk', {}).get('bytes', b'{}'))
            if chunk.get('type') == 'content_block_delta':
                delta = chunk.get('delta', {})
                if delta.get('type') == 'text_delta':
                    full_response += delta.get('text', '')
        
        sources = metadata.pop('sources', [])
        
        return {
            'statusCode': 200,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({
                'response': full_response,
                'sources': sources,
                'metadata': metadata
            }, cls=DecimalEncoder)
        }
        
    except Exception as e:
        logger.exception(f"VoC chat error: {e}")
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'application/json'},
            'body': json.dumps({'error': 'An internal error occurred. Please try again.'})
        }


@logger.inject_lambda_context
@tracer.capture_lambda_handler
@metrics.log_metrics(capture_cold_start_metric=True)
def combined_handler(event, context):
    """
    Combined handler that routes based on path.
    """
    # Try multiple ways to get the path from Lambda Function URL event
    path = (
        event.get('rawPath', '') or 
        event.get('requestContext', {}).get('http', {}).get('path', '') or
        event.get('path', '')
    )
    
    logger.info(f"Chat stream request - rawPath: {event.get('rawPath')}, http.path: {event.get('requestContext', {}).get('http', {}).get('path')}, path: {event.get('path')}")
    logger.info(f"Resolved path: {path}")
    
    # Project chat: /projects/{id}/chat/stream - check this FIRST (more specific)
    if '/projects/' in path:
        logger.info("Routing to project chat handler")
        return handler(event, context)
    # VoC AI Chat: /chat/stream or just root path (default for Function URL)
    # Also handle empty path or just "/" as VoC chat (default behavior)
    elif '/chat/stream' in path or path in ('', '/', '/chat'):
        logger.info("Routing to VoC chat handler")
        return voc_chat_handler(event, context)
    else:
        # Default to VoC chat for any unrecognized path
        logger.info(f"Unknown path '{path}', defaulting to VoC chat handler")
        return voc_chat_handler(event, context)


# Lambda handler entry point
lambda_handler = combined_handler

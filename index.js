/**
 * Shadow Nexus Social AI Studio — Cloudflare Worker Backend
 * Deployed to: https://shadow-nexus-ai.nthntjrn.workers.dev
 *
 * Secrets (set in Worker dashboard → Settings → Variables → Encrypt):
 *   OPENAI_API_KEY  — your OpenAI secret key
 *   OPENAI_MODEL    — model name, default: gpt-4o
 */

const BUILD_SYSTEM_PROMPT = `You are Shadow Nexus AI, an expert web developer built into Shadow Nexus Social AI Studio.

You MUST respond with ONLY a valid JSON object — no markdown, no explanation outside the JSON, no code fences wrapping the JSON.

The JSON must exactly follow this schema:
{
  "type": "project_changes",
  "summary": "Short human-readable description of what was built or changed",
  "files": [
    {
      "path": "index.html",
      "action": "create",
      "description": "Main HTML file",
      "content": "...full file content..."
    }
  ]
}

Rules:
- "action" must be "create", "modify", or "delete"
- For "delete" actions, omit "content"
- Every file must have complete, working content — never partial
- For HTML projects: always provide index.html, styles.css, and app.js
- CSS/JS referenced in HTML must use filenames that exactly match their "path" in the files array
- Do NOT use external CDN URLs unless specifically asked
- The website must be visually complete, responsive, and functional
- Use modern CSS (flexbox, grid, custom properties) and vanilla JS unless React is requested
- For modifications: only include files that actually changed
- All file content must be a valid JSON string (escape newlines as \\n, quotes as \\", backslashes as \\\\)

Do not output anything other than the JSON object.`;

const SYSTEM_PROMPT = `You are Shadow Nexus AI, an expert AI assistant built into Shadow Nexus Social AI Studio — a professional AI-powered website builder, code editor, and creative environment.

Your capabilities:
- Answer any question clearly and helpfully
- Build, explain, debug, and improve code (HTML, CSS, JavaScript, React, Node.js, Firebase, and more)
- Generate complete website layouts, components, pages, and full applications
- Analyze existing code and suggest improvements
- Help with responsive design, accessibility, performance, and security
- Guide users through Firebase, authentication, databases, and APIs
- Explain concepts from beginner to advanced level
- Generate project file structures and full implementations
- Analyze and fix errors from error logs
- Help with non-coding questions too: brainstorming, learning, planning, writing

When generating code:
- Always wrap code in proper markdown fences with language tags (\`\`\`html, \`\`\`javascript, \`\`\`css, \`\`\`jsx)
- Provide complete, working implementations — not pseudocode
- Explain what you built and important decisions
- Add comments in complex code

When analyzing or fixing:
- Identify the root cause
- Explain why the issue occurred
- Provide the corrected code
- Suggest how to prevent similar issues

Be conversational, direct, and professional.`;

// In-memory rate limit map (resets per isolate restart — good enough for Workers)
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const max = 20;
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > windowMs) {
    entry.count = 1;
    entry.start = now;
  } else {
    entry.count++;
  }
  rateLimitMap.set(ip, entry);
  return entry.count <= max;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// Probe OpenAI by fetching the models list — cheap, no tokens used
async function probeOpenAI(key) {
  if (!key || !key.startsWith('sk-')) return { ok: false, reason: 'not_configured' };
  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${key}` },
      // short timeout via signal
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return { ok: false, reason: 'invalid_key' };
    if (res.status === 403) return { ok: false, reason: 'forbidden' };
    if (res.status === 429) return { ok: false, reason: 'rate_limit' };
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    return { ok: true };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'network_error' };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    // ── Routes ──────────────────────────────────────────────────────────────

    // Health check — liveness only, no secrets
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ status: 'ok', service: 'Shadow Nexus Social AI Studio Worker' }, 200, origin);
    }

    // Status — real OpenAI probe, no key values returned
    if (url.pathname === '/api/status' && request.method === 'GET') {
      const probe = await probeOpenAI(env.OPENAI_API_KEY);
      return json({
        backend: 'online',
        openai: probe.ok ? 'connected' : probe.reason === 'not_configured' ? 'not_configured' : probe.reason,
        openai_ok: probe.ok,
        firebase: 'client_side',   // Firebase runs client-side; backend has no Firebase
        model: probe.ok ? (env.OPENAI_MODEL || 'gpt-4o') : null,
        timestamp: new Date().toISOString(),
      }, 200, origin);
    }

    // AI chat
    if (url.pathname === '/api/ai/chat' && request.method === 'POST') {
      if (!checkRateLimit(ip)) {
        return json({ error: 'Rate limit exceeded. Please wait a moment.', code: 'RATE_LIMIT' }, 429, origin);
      }
      return handleChat(request, env, origin);
    }

    // AI analyze (Make it Better)
    if (url.pathname === '/api/ai/analyze' && request.method === 'POST') {
      if (!checkRateLimit(ip)) {
        return json({ error: 'Rate limit exceeded. Please wait a moment.', code: 'RATE_LIMIT' }, 429, origin);
      }
      return handleAnalyze(request, env, origin);
    }

    // AI build — structured project generation / modification
    if (url.pathname === '/api/ai/build' && request.method === 'POST') {
      if (!checkRateLimit(ip)) {
        return json({ error: 'Rate limit exceeded. Please wait a moment.', code: 'RATE_LIMIT' }, 429, origin);
      }
      return handleBuild(request, env, origin);
    }

    // AI phone — parse user intent and return a structured phone action
    if (url.pathname === '/api/ai/phone' && request.method === 'POST') {
      if (!checkRateLimit(ip)) {
        return json({ error: 'Rate limit exceeded. Please wait a moment.', code: 'RATE_LIMIT' }, 429, origin);
      }
      return handlePhone(request, env, origin);
    }

    return json({ error: 'Not found' }, 404, origin);
  },
};

async function handleChat(request, env, origin) {
  const key = env.OPENAI_API_KEY;
  if (!key || !key.startsWith('sk-')) {
    return json({
      error: 'OpenAI is not configured. Add OPENAI_API_KEY as an encrypted secret in your Cloudflare Worker settings.',
      code: 'NOT_CONFIGURED',
    }, 503, origin);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body.' }, 400, origin); }

  const { messages, context } = body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: 'messages array is required.' }, 400, origin);
  }

  for (const msg of messages) {
    if (!['user', 'assistant', 'system'].includes(msg.role) || typeof msg.content !== 'string') {
      return json({ error: 'Invalid message format.' }, 400, origin);
    }
    if (msg.content.length > 16000) {
      return json({ error: 'Message content too long.' }, 400, origin);
    }
  }

  let systemPrompt = SYSTEM_PROMPT;
  if (context) {
    if (context.projectName) systemPrompt += `\n\nCurrent project: "${context.projectName}"`;
    if (context.currentFile) systemPrompt += `\nCurrent file: ${context.currentFile}`;
    if (context.selectedCode) systemPrompt += `\n\nSelected code:\n\`\`\`\n${context.selectedCode.substring(0, 4000)}\n\`\`\``;
    if (context.errors?.length) systemPrompt += `\n\nCurrent errors:\n${context.errors.slice(0, 5).join('\n')}`;
    if (context.currentPage) systemPrompt += `\n\nUser is currently on: ${context.currentPage}`;
  }

  const model = env.OPENAI_MODEL || 'gpt-4o';

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.slice(-20).map(m => ({ role: m.role, content: m.content })),
        ],
        max_tokens: 4096,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const status = response.status;
      if (status === 401) return json({ error: 'Invalid OpenAI API key. Check your OPENAI_API_KEY secret.', code: 'INVALID_KEY' }, 401, origin);
      if (status === 403) return json({ error: 'Access denied by OpenAI.', code: 'FORBIDDEN' }, 403, origin);
      if (status === 429) return json({ error: 'OpenAI rate limit reached. Please wait and try again.', code: 'RATE_LIMIT' }, 429, origin);
      if (status >= 500) return json({ error: 'OpenAI service error. Please try again shortly.', code: 'OPENAI_SERVER_ERROR' }, 502, origin);
      return json({ error: 'Unexpected error from OpenAI.', code: 'OPENAI_ERROR' }, 502, origin);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message?.content;
    if (!message) return json({ error: 'No response received from AI.' }, 500, origin);

    return json({ message, model: data.model, usage: data.usage }, 200, origin);
  } catch (err) {
    return json({ error: 'Network error contacting OpenAI.', code: 'NETWORK_ERROR' }, 500, origin);
  }
}

async function handleBuild(request, env, origin) {
  const key = env.OPENAI_API_KEY;
  if (!key || !key.startsWith('sk-')) {
    return json({ error: 'OpenAI is not configured.', code: 'NOT_CONFIGURED' }, 503, origin);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body.' }, 400, origin); }

  const { request: userRequest, existingFiles, projectName, messages } = body;
  if (!userRequest || typeof userRequest !== 'string') {
    return json({ error: 'request string is required.' }, 400, origin);
  }

  let userContent = userRequest;
  if (existingFiles && Object.keys(existingFiles).length > 0) {
    const fileList = Object.entries(existingFiles)
      .slice(0, 10)
      .map(([name, content]) => `=== ${name} ===\n${String(content).substring(0, 3000)}`)
      .join('\n\n');
    userContent = `${userRequest}\n\nExisting project files (project: "${projectName || 'untitled'}"):\n${fileList}`;
  }

  const historyMessages = Array.isArray(messages)
    ? messages.slice(-6).map(m => ({ role: m.role, content: m.content }))
    : [];

  const model = env.OPENAI_MODEL || 'gpt-4o';

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: BUILD_SYSTEM_PROMPT },
          ...historyMessages,
          { role: 'user', content: userContent },
        ],
        max_tokens: 8192,
        temperature: 0.4,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const status = response.status;
      if (status === 401) return json({ error: 'Invalid OpenAI API key.', code: 'INVALID_KEY' }, 401, origin);
      if (status === 429) return json({ error: 'OpenAI rate limit reached.', code: 'RATE_LIMIT' }, 429, origin);
      return json({ error: 'OpenAI error during build.', code: 'OPENAI_ERROR' }, 502, origin);
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return json({ error: 'No response received from AI.' }, 500, origin);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ error: 'AI returned an invalid response. Please try again.', code: 'PARSE_ERROR' }, 500, origin);
    }

    if (!parsed.type || parsed.type !== 'project_changes') parsed.type = 'project_changes';
    if (!Array.isArray(parsed.files)) {
      return json({ error: 'AI response missing files array.', code: 'INVALID_STRUCTURE' }, 500, origin);
    }

    parsed.files = parsed.files.map(f => ({
      path: String(f.path || '').trim(),
      action: ['create', 'modify', 'delete'].includes(f.action) ? f.action : 'create',
      description: String(f.description || ''),
      content: f.action === 'delete' ? undefined : String(f.content || ''),
    })).filter(f => f.path.length > 0);

    return json({ ...parsed, model: data.model, usage: data.usage }, 200, origin);
  } catch {
    return json({ error: 'Network error during build.', code: 'NETWORK_ERROR' }, 500, origin);
  }
}

async function handleAnalyze(request, env, origin) {
  const key = env.OPENAI_API_KEY;
  if (!key || !key.startsWith('sk-')) {
    return json({ error: 'OpenAI is not configured.', code: 'NOT_CONFIGURED' }, 503, origin);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body.' }, 400, origin); }

  const { files, projectName } = body;
  if (!files || typeof files !== 'object') {
    return json({ error: 'files object is required.' }, 400, origin);
  }

  const fileList = Object.entries(files)
    .slice(0, 10)
    .map(([name, content]) => `=== ${name} ===\n${String(content).substring(0, 2000)}`)
    .join('\n\n');

  const model = env.OPENAI_MODEL || 'gpt-4o';

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Analyze this project${projectName ? ` "${projectName}"` : ''} and provide specific, actionable recommendations.\n\nEvaluate:\n1. **Visual Design** — Colors, typography, layout\n2. **Mobile Responsiveness** — Breakpoints, touch targets\n3. **Accessibility** — ARIA, contrast, keyboard nav\n4. **Performance** — Asset optimization, lazy loading\n5. **Code Quality** — Best practices, maintainability\n6. **Navigation & UX** — User flow, clarity\n7. **Security** — Input validation, XSS prevention\n8. **Error Handling** — Graceful fallbacks\n\nFor each area give a rating (Excellent / Good / Needs Improvement) and 2–3 specific, actionable suggestions.\n\nFiles:\n${fileList}`,
          },
        ],
        max_tokens: 2048,
        temperature: 0.5,
      }),
    });

    if (!response.ok) {
      return json({ error: 'Failed to analyze project. Please try again.' }, 502, origin);
    }

    const data = await response.json();
    return json({ analysis: data.choices?.[0]?.message?.content || 'No analysis returned.', model: data.model }, 200, origin);
  } catch {
    return json({ error: 'Network error during analysis.' }, 500, origin);
  }
}

async function handlePhone(request, env, origin) {
  const key = env.OPENAI_API_KEY;
  if (!key || !key.startsWith('sk-')) {
    return json({ error: 'OpenAI is not configured.', code: 'NOT_CONFIGURED' }, 503, origin);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body.' }, 400, origin); }

  const { message, capabilities, messages } = body;
  if (!message || typeof message !== 'string') {
    return json({ error: 'message string is required.' }, 400, origin);
  }

  const ALLOWED_ACTIONS = [
    'open_app', 'make_call', 'create_message', 'open_maps', 'navigate',
    'create_calendar_event', 'create_reminder', 'set_alarm',
    'open_settings', 'control_media', 'open_camera', 'take_photo',
    'open_browser', 'web_search', 'share_text', 'copy_text', 'speak_text',
    'pick_contact', 'get_location', 'vibrate', 'open_email', 'general_chat',
  ];

  const PHONE_SYSTEM = `You are Shadow Nexus AI, the phone assistant module of Shadow Nexus Social AI Studio.

Your job is to interpret the user's message and return a structured JSON object.

ALLOWED action types (you MUST use only these exact strings):
${ALLOWED_ACTIONS.map(a => `  - "${a}"`).join('\n')}

Use "general_chat" when the request is a question, explanation, or anything that is NOT a phone action.

IMPORTANT SECURITY RULES:
- You MUST NOT invent new action types.
- You MUST NOT return executable code.
- For make_call/create_message — never guess a phone number unless the user explicitly provided one.
- "requires_confirmation" must be true for: make_call, create_message, share_text, create_calendar_event, create_reminder, set_alarm.

Response JSON schema (respond with ONLY the JSON, no markdown wrappers):
{
  "type": "phone_action",
  "action": "<one of the allowed action strings>",
  "params": {
    // open_app:              { "target": "youtube" }
    // make_call:             { "number": "+15551234567", "contact": "John" }
    // create_message:        { "to": "+15551234567", "contact": "Mom", "body": "Hey, I'll be there soon." }
    // open_maps:             { "query": "coffee shops near me" }
    // navigate:              { "destination": "Times Square, New York" }
    // create_calendar_event: { "title": "Meeting", "date": "2025-01-15", "time": "14:00", "duration": 60, "location": "", "notes": "" }
    // create_reminder:       { "text": "Take medicine", "time": "2025-01-15T09:00:00" }
    // set_alarm:             { "time": "07:00", "label": "Wake up" }
    // open_settings:         { "section": "wifi" }
    // control_media:         { "command": "play", "app": "spotify" }
    // open_camera:           {}
    // take_photo:            {}
    // open_browser:          { "url": "https://example.com" }
    // web_search:            { "query": "search terms" }
    // share_text:            { "text": "...", "title": "...", "url": "..." }
    // copy_text:             { "text": "..." }
    // speak_text:            { "text": "..." }
    // pick_contact:          {}
    // get_location:          {}
    // vibrate:               { "pattern": [200, 100, 200] }
    // open_email:            { "to": "someone@example.com", "subject": "Hello", "body": "..." }
    // general_chat:          {}
  },
  "requires_confirmation": false,
  "human_summary": "Short description of what this action will do, shown to user before confirmation.",
  "chat_response": "Friendly reply to show in the chat. For general_chat, this is the full answer."
}`;

  const historyMessages = Array.isArray(messages)
    ? messages.slice(-6).map(m => ({ role: m.role, content: m.content }))
    : [];

  const capsSummary = capabilities
    ? `\nDevice capabilities: ${JSON.stringify(capabilities)}`
    : '';

  const model = env.OPENAI_MODEL || 'gpt-4o';

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: PHONE_SYSTEM + capsSummary },
          ...historyMessages,
          { role: 'user', content: message },
        ],
        max_tokens: 1024,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const status = response.status;
      if (status === 401) return json({ error: 'Invalid OpenAI API key.', code: 'INVALID_KEY' }, 401, origin);
      if (status === 429) return json({ error: 'OpenAI rate limit reached.', code: 'RATE_LIMIT' }, 429, origin);
      return json({ error: 'OpenAI error during phone request.', code: 'OPENAI_ERROR' }, 502, origin);
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return json({ error: 'No response from AI.' }, 500, origin);

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return json({ error: 'AI returned invalid JSON.', code: 'PARSE_ERROR' }, 500, origin); }

    // Server-side validation: reject unknown action types
    if (!ALLOWED_ACTIONS.includes(parsed.action)) {
      parsed.action = 'general_chat';
      parsed.chat_response = parsed.chat_response || "I'm not sure how to help with that.";
    }

    return json({ ...parsed, model: data.model }, 200, origin);
  } catch {
    return json({ error: 'Network error during phone request.', code: 'NETWORK_ERROR' }, 500, origin);
  }
}

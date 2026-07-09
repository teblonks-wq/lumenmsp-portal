import { getSetting } from './settings';

// Turn rough dictated/typed notes into a clean, ready-to-send business message using Claude
// (Anthropic Messages API). Voice-to-text happens client-side (Web Speech API); this is the
// "tidy it into a proper message" step only. Key comes from env ANTHROPIC_API_KEY, or the
// 'anthropic'/'api_key' setting. No key -> throws a friendly error the UI surfaces.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'; // cheap + plenty for message tidy-up

export interface ComposeInput {
  transcript: string;           // the rough dictation / notes
  recipient?: string | null;    // recipient's name (for the greeting), if known
  signoffName?: string | null;  // sender's name for the sign-off
  tone?: string | null;         // e.g. 'friendly', 'formal'
  channel?: string | null;      // 'email' | 'teams' | 'whatsapp' - adjusts greeting/sign-off formality
}

// Settings (managed in the UI) win; the server .env is a fallback. So pasting a key in the
// Integrations box overrides a stale/placeholder ANTHROPIC_API_KEY in the environment.
async function resolveKey(): Promise<string> {
  return ((await getSetting('anthropic', 'api_key')) || '').trim() || (process.env.ANTHROPIC_API_KEY || '').trim();
}

export async function aiComposeConfigured(): Promise<boolean> {
  return !!(await resolveKey());
}

export async function aiComposeMessage(input: ComposeInput): Promise<string> {
  const key = await resolveKey();
  if (!key) throw new Error('Claude is not configured - add your API key in Settings -> Integrations (or ANTHROPIC_API_KEY in the server .env).');
  const model = ((await getSetting('anthropic', 'model')) || '').trim() || DEFAULT_MODEL;

  const transcript = String(input.transcript || '').trim();
  if (!transcript) throw new Error('Nothing to polish - dictate or type something first.');

  const channel = (input.channel || 'email').toLowerCase();
  const briefChannel = channel === 'whatsapp' || channel === 'teams';
  const system = [
    'You turn rough, dictated or hastily-typed notes from a support/IT engineer into a clear, professional, friendly business message that is ready to send to a customer.',
    'Rules:',
    '- Preserve the sender\'s meaning and every fact exactly. NEVER invent details, names, dates, prices or commitments that are not in the notes.',
    '- Fix grammar, spelling, punctuation and phrasing; make it read well and politely.',
    '- Start with an appropriate greeting (use the recipient\'s first name if provided, otherwise "Hi there"), then a well-structured body.',
    '- DO NOT add any sign-off or closing - no "Kind regards", "Thanks", "Best wishes", and NO sender name. The email signature is added automatically, so end immediately after the last line of the body.',
    '- Break the message into SHORT paragraphs (1-2 sentences each) separated by a BLANK LINE, so it is easy to read. Avoid dense blocks of text.',
    briefChannel
      ? '- This is a short chat message (Teams/WhatsApp): keep it brief and informal; no long email formalities.'
      : '- This is an email: courteous and well-structured.',
    input.tone ? `- Tone: ${input.tone}.` : '- Tone: warm and professional.',
    '- Return ONLY the finished message text. No preamble, no explanations, no markdown fences.',
  ].join('\n');

  const userText = [
    input.recipient ? `Recipient: ${input.recipient}` : null,
    `Notes to turn into a message:\n${transcript}`,
  ].filter(Boolean).join('\n\n');

  return callClaude(key, model, system, userText, 800);
}

export interface PolishInput { text: string; mode?: 'polish' | 'proofread'; }

// Generic "Improve with Claude" used platform-wide: tidy any draft into clear, professional British
// English. Preserves meaning and every fact; never invents. Reuses the shared Anthropic call below.
export async function aiPolishText(input: PolishInput): Promise<string> {
  const key = await resolveKey();
  if (!key) throw new Error('Claude is not configured - add your API key in Settings -> Integrations (or ANTHROPIC_API_KEY in the server .env).');
  const model = ((await getSetting('anthropic', 'model')) || '').trim() || DEFAULT_MODEL;
  const text = String(input.text || '').trim();
  if (!text) throw new Error('Type something first, then use Improve with Claude.');
  const proofread = input.mode === 'proofread';
  const system = [
    'You improve a draft written by a UK business user. Always write in clear, professional British English (en-GB).',
    'Rules:',
    '- ALWAYS use British spelling and conventions (organise, colour, licence, apologise, whilst; dd/mm/yyyy dates; £).',
    '- Preserve the writer\'s meaning and EVERY fact exactly. NEVER invent details, names, dates, prices or commitments.',
    proofread
      ? '- PROOFREAD ONLY: correct spelling, grammar and punctuation. Do not change wording, tone or structure.'
      : '- Improve grammar, spelling, punctuation, clarity and flow; keep the writer\'s intent and tone; make it read well.',
    '- Keep roughly the same length; do not add greetings or sign-offs unless they were already present.',
    '- Return ONLY the improved text. No preamble, no explanations, no markdown fences, no surrounding quotes.',
  ].join('\n');
  const maxTokens = Math.min(2000, Math.max(400, Math.ceil(text.length / 2) + 300));
  return callClaude(key, model, system, text, maxTokens);
}

export interface ItReportInput {
  clientName: string;
  period: string;                 // e.g. "June 2026"
  metricsBrief: string;           // plain-text digest of the collected metrics (devices, tickets, DNS, security)
  sdmNotes?: string | null;       // the Service Delivery Manager's own commentary for this period
}
export interface ItReportNarrative { executiveSummary: string; commentary: string; overallStatus: string; }

// Writes the narrative of the monthly IT Operations & Security Snapshot: the Executive Summary,
// a Service Delivery Commentary that consolidates the whole month's running notes/comments, and
// the Overall IT Status wrap-up. Brings every note together into polished prose — correcting
// spelling, grammar and standardising IT terminology — and weaves in the collected metrics, in
// Lumen's house style (calm, factual, reassuring, British English). The data-driven checklist
// sections are rendered mechanically elsewhere — this is the prose only.
export async function aiWriteItReport(input: ItReportInput): Promise<ItReportNarrative> {
  const key = await resolveKey();
  if (!key) throw new Error('Claude is not configured - add your API key in Settings -> Integrations (or ANTHROPIC_API_KEY in the server .env).');
  const model = ((await getSetting('anthropic', 'model')) || '').trim() || DEFAULT_MODEL;

  const system = [
    'You are writing the narrative of a monthly "IT Operations & Security Snapshot" that a UK managed-service provider (Lumen IT Solutions) sends to a business client.',
    'Write in clear, professional British English (organise, colour, prioritise, licence, whilst; £; dd/mm/yyyy dates). Calm, factual and reassuring — never salesy, never alarmist.',
    'You are given: (a) a full digest of the metrics collected for the period (devices and compliance, patching, backup, email security, threat protection, Secure Score, vulnerability scan and support activity), and (b) the Service Delivery Manager\'s notes — standing commentary plus dated running notes jotted through the month.',
    'Use ALL of it. Read every metric and every note together and form ONE coherent picture of the estate. The Executive Summary and Overall IT Status must reflect the whole environment — security posture, device health, backup, email security AND support — not just the notes. The SDM notes are authoritative; reflect them faithfully. If a data point is missing or unavailable, work around it rather than guessing.',
    'Your job with the notes: CONSOLIDATE every note and comment into coherent, polished prose. This means:',
    '- Correct all spelling, grammar and punctuation.',
    '- Standardise and correct IT/technical terminology and product names (e.g. Microsoft 365, Intune, Entra ID, Microsoft Defender, Secure Score, SharePoint, VoIP, firewall, endpoint) with correct casing.',
    '- Merge related notes, resolve duplication, and order the points logically. Turn dated shorthand (e.g. "[12 Jun] internet outage, poss review supplier") into a clean professional sentence.',
    '- Preserve every fact, date, figure and commitment exactly. NEVER invent numbers, incidents, names or commitments. If a figure is missing, write around it.',
    'Sections to produce — keep each DISTINCT in purpose so they do not repeat one another:',
    '- Executive Summary: one flowing paragraph (3-5 sentences) — the high-level posture and headline for the month.',
    '- Service Delivery Commentary: 1-3 short paragraphs that bring ALL the month\'s notes/comments together — issues seen, actions taken, anything being watched or reviewed (e.g. supplier reviews, recurring outages). If there are no notes, return an empty string for this field.',
    '- Overall IT Status: 2-4 short sentences — the closing, forward-looking assessment and any watch-items. Do not simply restate the Executive Summary.',
    'Readability and no duplication (important):',
    '- Write for easy reading: short sentences, plain English, one idea per sentence, active voice. Avoid jargon walls and long run-on sentences.',
    '- Do NOT repeat the same point or figure across the three sections — each fact appears once, in the section where it fits best.',
    '- The report already shows the metrics as tiles and tick-lists (device counts, ticket totals, Secure Score, DNS, vulnerability figures). Do NOT re-list those raw numbers in the prose; interpret or summarise them instead (e.g. "support demand was steady" rather than repeating every count).',
    '- Remove duplicate or near-duplicate notes; merge points that overlap.',
    '- Do not use markdown, headings or bullet points. Prose only. Separate paragraphs with a blank line.',
    '- Return ONLY a JSON object of the form {"executiveSummary": "...", "commentary": "...", "overallStatus": "..."} with no code fences and no other text.',
  ].join('\n');

  const userText = [
    `Client: ${input.clientName}`,
    `Reporting period: ${input.period}`,
    `\nMetrics collected:\n${input.metricsBrief}`,
    input.sdmNotes && input.sdmNotes.trim() ? `\nService Delivery Manager's notes and comments (consolidate + polish these):\n${input.sdmNotes.trim()}` : '\n(The Service Delivery Manager did not add notes for this period.)',
  ].join('\n');

  const raw = await callClaude(key, model, system, userText, 1300);
  try {
    const json = JSON.parse(raw.replace(/^```json\s*|```\s*$/g, '').trim());
    return {
      executiveSummary: String(json.executiveSummary || '').trim(),
      commentary: String(json.commentary || '').trim(),
      overallStatus: String(json.overallStatus || '').trim(),
    };
  } catch {
    // If the model didn't return clean JSON, fall back to using the whole reply as the summary.
    return { executiveSummary: raw.trim(), commentary: '', overallStatus: '' };
  }
}

// Classify an inbound support message into ONE helpdesk category. Reads the content and returns
// a category from the allowed list, or NULL when it isn't confident (so the ticket is left with
// NO category and a human must choose before work starts). Never guesses.
// Master switch for the Claude ticket-category feature (auto-classify + the "must set a category
// before replying" gate). OFF by default — turn on with setting group 'tickets' key 'ai_category'
// = 'on'. When off, tickets behave as before (default category, no gate).
export async function aiTicketCategoryEnabled(): Promise<boolean> {
  return ((await getSetting('tickets', 'ai_category')) || '').toLowerCase() === 'on';
}

const TICKET_CATEGORIES = ['incident', 'problem', 'service_request', 'change_request', 'enquiry', 'order', 'repair', 'warranty'];
export async function aiClassifyTicketCategory(subject: string, body: string): Promise<string | null> {
  const key = await resolveKey();
  if (!key) return null;
  const model = ((await getSetting('anthropic', 'model')) || '').trim() || DEFAULT_MODEL;
  const system = [
    'You classify an inbound IT support message into ONE support category for a managed-service-provider helpdesk.',
    'Allowed categories (return the exact value):',
    '- incident: something is broken / not working / an error / an outage, with NO sign it has happened before.',
    '- problem: a RECURRING or repeat issue. If the message hints the same thing has happened before — words like "again", "still", "keeps happening", "same as last time", "recurring", "back", "once more", "yet again" — classify it as problem, even if it also describes something broken. Recurrence takes priority over incident.',
    '- service_request: a request for a standard, low-risk service — access, a new account, a password reset, install, how-to setup.',
    '- change_request: a planned change to systems/configuration.',
    '- enquiry: a general question or request for information (no action to fix anything).',
    '- order: buying/procuring hardware, software or licences.',
    '- repair: physical repair of a device.',
    '- warranty: a warranty claim / RMA.',
    'Rules:',
    '- Choose the single best fit.',
    '- If you are NOT confident which one fits, return "unsure" — do NOT guess.',
    '- Return ONLY a JSON object {"category":"<one value from the list, or unsure>"} with no other text.',
  ].join('\n');
  const userText = `Subject: ${subject || '(none)'}\n\nMessage:\n${String(body || '').slice(0, 3000)}`;
  try {
    const raw = await callClaude(key, model, system, userText, 60);
    const j = JSON.parse(raw.replace(/^```json\s*|```\s*$/g, '').trim());
    const c = String(j.category || '').trim().toLowerCase();
    return TICKET_CATEGORIES.includes(c) ? c : null;
  } catch { return null; }
}

export interface StudioImage { media_type: string; data: string; } // base64 (no data: prefix)

// Shared Anthropic Messages call + friendly error mapping, used by every compose helper here.
// Optional images are sent as vision blocks before the text so Claude can see them.
async function callClaude(key: string, model: string, system: string, userText: string, maxTokens: number, images?: StudioImage[]): Promise<string> {
  const content: any = (images && images.length)
    ? [
        ...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })),
        { type: 'text', text: userText },
      ]
    : userText;
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.3,
        system,
        messages: [{ role: 'user', content }],
      }),
    });
  } catch (e: any) {
    throw new Error('Could not reach Claude: ' + (e.message || 'network error'));
  }

  if (!res.ok) {
    let detail = '';
    try { const j: any = await res.json(); detail = j?.error?.message || ''; } catch { /* ignore */ }
    if (res.status === 401) throw new Error('Claude rejected the API key (401) - check ANTHROPIC_API_KEY.');
    if (res.status === 429) throw new Error('Claude rate/credit limit hit (429) - check your Anthropic billing.');
    throw new Error(`Claude error ${res.status}${detail ? ': ' + detail : ''}`);
  }

  const data: any = await res.json();
  const text = Array.isArray(data?.content)
    ? data.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('').trim()
    : '';
  if (!text) throw new Error('Claude returned an empty message.');
  return text;
}

export interface TicketReplyInput {
  draft: string;                // the engineer's rough/typed draft for the next reply
  context: string;              // the assembled ticket thread (chronological, labelled) incl. internal notes
  recipient?: string | null;    // customer's name for the greeting
  channel?: string | null;      // 'email' | 'teams' | 'whatsapp'
}

// Context-aware "Claude Update": polish the engineer's draft into the next reply on a ticket, using
// the WHOLE conversation (incl. internal notes) for context — but stay anchored to what the engineer
// actually said. Never invents facts/commitments or reveals internal notes to the customer.
export async function aiComposeTicketReply(input: TicketReplyInput): Promise<string> {
  const key = await resolveKey();
  if (!key) throw new Error('Claude is not configured - add your API key in Settings -> Integrations (or ANTHROPIC_API_KEY in the server .env).');
  // Stronger model for reasoning over a whole thread; override via the 'anthropic'/'model_strong' setting.
  const model = ((await getSetting('anthropic', 'model_strong')) || '').trim() || 'claude-sonnet-4-6';

  const draft = String(input.draft || '').trim();
  if (!draft) throw new Error('Type or dictate your update first, then use Claude Update.');
  const context = String(input.context || '').trim();

  const channel = (input.channel || 'email').toLowerCase();
  const briefChannel = channel === 'whatsapp' || channel === 'teams';

  const system = [
    'You help a support/IT engineer turn their rough draft into the next reply to a customer on a support ticket.',
    'You are given the FULL ticket conversation so far (customer messages, previous replies, and the team\'s INTERNAL notes) and the engineer\'s DRAFT for the next reply.',
    'Rewrite the engineer\'s draft so it reads well and fits naturally as the next message — addressing the customer\'s latest point and using the thread so the reply is accurate, complete and well-pitched.',
    'CRITICAL boundaries:',
    '- Stay anchored to what the ENGINEER is saying in the draft. Do not change their meaning, decision or intent.',
    '- You MAY bring in relevant facts already established earlier in the thread to make the reply clearer and more complete.',
    '- NEVER invent or add facts, fixes, dates, prices or commitments that are not in the draft or the thread. Do not overstep what the engineer has said.',
    '- Internal notes are for YOUR context only — never quote them or reveal anything internal/private to the customer.',
    '- Preserve every fact, name, number and date exactly.',
    'Formatting:',
    '- Start with an appropriate greeting (use the recipient\'s first name if provided, otherwise "Hi there"), then a well-structured body.',
    '- DO NOT add any sign-off, closing or sender name — the signature is added automatically. End after the last line of the body.',
    '- Short paragraphs (1-2 sentences) separated by a BLANK LINE.',
    briefChannel
      ? '- This is a short chat message (Teams/WhatsApp): keep it brief and informal; no long email formalities.'
      : '- This is an email: courteous and well-structured.',
    '- Tone: warm and professional.',
    '- Return ONLY the finished message text. No preamble, no explanations, no markdown fences.',
  ].join('\n');

  const userText = [
    input.recipient ? `Recipient (the customer): ${input.recipient}` : null,
    context ? `=== TICKET CONVERSATION SO FAR (context only — includes internal notes you must NOT reveal) ===\n${context}` : null,
    `=== ENGINEER'S DRAFT REPLY (polish this; do not overstep it) ===\n${draft}`,
  ].filter(Boolean).join('\n\n');

  return callClaude(key, model, system, userText, 1200);
}

// ── Marketing content studio ──────────────────────────────────────────────────
// Fetch a page and reduce it to readable text for use as a Claude source (best-effort).
async function fetchUrlText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (LumenMSP content studio)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return `(could not fetch ${url}: HTTP ${res.status})`;
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|h[1-6]|li)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return text.slice(0, 6000); // cap per source to keep the prompt sane
  } catch (e: any) {
    return `(could not fetch ${url}: ${e?.message || 'error'})`;
  }
}

export interface StudioInput { topic: string; urls: string[]; context?: string | null; images?: StudioImage[]; }
export interface StudioOutput {
  relevanceDate: string | null;
  imageQuery: string;
  linkedin: string; facebook: string; google: string;
  website: { title: string; excerpt: string; category: string; body: string };
}

// Topic + up to 3 source URLs (+ optional steer) -> four platform-tailored drafts via Claude (Sonnet).
export async function aiGenerateStudio(input: StudioInput): Promise<StudioOutput> {
  const key = await resolveKey();
  if (!key) throw new Error('Claude is not configured - add your API key in Settings -> Integrations.');
  const model = ((await getSetting('anthropic', 'model_strong')) || '').trim() || 'claude-sonnet-4-6';

  const topic = String(input.topic || '').trim();
  if (!topic) throw new Error('Add a topic first.');
  const urls = (input.urls || []).map((u) => String(u || '').trim()).filter(Boolean);
  const sources = await Promise.all(urls.map(async (u, i) => `SOURCE ${i + 1} (${u}):\n${await fetchUrlText(u)}`));

  const system = [
    'You are the content writer for Lumen MSP, a UK managed IT services provider based in Swindon. From a topic and source articles you produce ready-to-publish marketing content, each piece tailored to where it will be posted.',
    'Return ONLY a single JSON object (no markdown fences, no commentary) with EXACTLY these keys:',
    '{',
    '  "relevanceDate": "YYYY-MM-DD, or null — the date the topic is tied to (event/announcement) if clear from the sources, else null",',
    '  "imageQuery": "a 2-4 word stock-photo search phrase for a free image that matches this content (e.g. cyber security office, server room, business meeting)",',
    '  "linkedin": "LinkedIn post: professional and insightful, 1-3 short paragraphs, a strong hook, a takeaway for business leaders, 2-3 relevant hashtags",',
    '  "facebook": "Facebook post: friendly and approachable, shorter, a light hook, 1-2 hashtags",',
    '  "google": "Google Business post: concise, plain, local-business tone, NO hashtags, a clear call to action",',
    '  "website": { "title": "article headline", "excerpt": "~150 character summary for meta/preview", "category": "IT News or Advice", "body": "full article in Markdown — ## headings, short paragraphs, 300-600 words, written for Lumen MSP\'s website" }',
    '}',
    'Rules: base everything on the SOURCES and topic; never invent facts, figures, prices, statistics or quotes. UK English. No sign-offs or company signature (added automatically elsewhere).',
    (input.images && input.images.length) ? `${input.images.length} image(s) are attached for context — use them to inform tone/subject and reference what they show where relevant, but do not describe them literally unless it helps the reader.` : '',
  ].filter(Boolean).join('\n');

  const userText = [
    `TOPIC: ${topic}`,
    input.context ? `EXTRA CONTEXT / STEER FROM THE TEAM:\n${input.context}` : null,
    sources.length ? `SOURCES:\n\n${sources.join('\n\n---\n\n')}` : '(no source URLs provided — use the topic and context only)',
  ].filter(Boolean).join('\n\n');

  const raw = await callClaude(key, model, system, userText, 2500, input.images);
  const jsonStr = (raw.match(/\{[\s\S]*\}/) || [raw])[0]; // tolerate stray text/fences around the JSON
  let parsed: any;
  try { parsed = JSON.parse(jsonStr); } catch { throw new Error('Claude returned content that could not be parsed — try Generate again.'); }
  const w = parsed.website || {};
  return {
    relevanceDate: parsed.relevanceDate || null,
    imageQuery: String(parsed.imageQuery || topic).trim(),
    linkedin: String(parsed.linkedin || '').trim(),
    facebook: String(parsed.facebook || '').trim(),
    google: String(parsed.google || '').trim(),
    website: {
      title: String(w.title || topic).trim(),
      excerpt: String(w.excerpt || '').trim(),
      category: String(w.category || 'IT News').trim(),
      body: String(w.body || '').trim(),
    },
  };
}

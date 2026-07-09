// WhatsApp message-template registry + Meta Management API push/list.
// Single source of truth used to (a) submit templates to Meta for approval via the API, and
// (b) drive the "new message" composer once they're approved. Template `name`s must stay stable.
const GRAPH = 'https://graph.facebook.com/v21.0';

export interface WaTemplate {
  name: string;              // Meta template name (lowercase_underscore) — stable id
  label: string;            // friendly name for the composer
  category: 'UTILITY';       // support/service messages = Utility (approved fastest)
  language: string;          // en_GB
  body: string;              // body text with {{1}} placeholders
  vars: string[];            // human labels for each {{n}} — drives the composer fields
  example: string[];         // sample values for Meta approval (one per {{n}})
  footer?: string;
}

export const WA_TEMPLATES: WaTemplate[] = [
  { name: 'case_update', label: 'Case update', category: 'UTILITY', language: 'en_GB',
    body: 'Hi {{1}}, an update on your support case {{2}} with Lumen IT: {{3}}. Reply here if there\'s anything else you need.',
    vars: ['First name', 'Case number', 'Update'],
    example: ['Rob', 'CASE-1042', 'your new laptop has shipped and should arrive tomorrow'], footer: 'Lumen IT Solutions' },
  { name: 'awaiting_response', label: 'Awaiting your reply', category: 'UTILITY', language: 'en_GB',
    body: 'Hi {{1}}, we\'re waiting on your reply to progress support case {{2}}. When you have a moment, please reply here and we\'ll pick it straight back up.',
    vars: ['First name', 'Case number'], example: ['Rob', 'CASE-1042'], footer: 'Lumen IT Solutions' },
  { name: 'info_request', label: 'Information needed', category: 'UTILITY', language: 'en_GB',
    body: 'Hi {{1}}, to progress your support case {{2}} we need a little more information: {{3}}. Please reply here whenever you\'re ready.',
    vars: ['First name', 'Case number', 'What we need'],
    example: ['Rob', 'CASE-1042', 'the serial number on the base of the device'], footer: 'Lumen IT Solutions' },
  { name: 'engineer_visit', label: 'Engineer visit', category: 'UTILITY', language: 'en_GB',
    body: 'Hi {{1}}, confirming your Lumen IT engineer visit for case {{2}} on {{3}} at {{4}}. Reply CONFIRM to accept, or reply here to rearrange.',
    vars: ['First name', 'Case number', 'Date', 'Time'],
    example: ['Rob', 'CASE-1042', 'Mon 6 Jul', '10:00'], footer: 'Lumen IT Solutions' },
  { name: 'support_callback', label: 'We tried to reach you', category: 'UTILITY', language: 'en_GB',
    body: 'Hi {{1}}, this is Lumen IT Support about case {{2}}. We tried to reach you and would like to keep things moving — please call us on {{3}} or reply here and we\'ll pick it back up.',
    vars: ['First name', 'Case number', 'Phone'],
    example: ['Rob', 'CASE-1042', '01235 000000'], footer: 'Lumen IT Solutions' },
  { name: 'case_resolved', label: 'Case resolved', category: 'UTILITY', language: 'en_GB',
    body: 'Hi {{1}}, we\'ve marked your support case {{2}} as resolved. If everything\'s working as expected there\'s nothing more to do — if not, just reply here and we\'ll reopen it.',
    vars: ['First name', 'Case number'], example: ['Rob', 'CASE-1042'], footer: 'Lumen IT Solutions' },
  { name: 'support_message', label: 'General message', category: 'UTILITY', language: 'en_GB',
    body: 'Hi {{1}}, this is Lumen IT Support. {{2}} Please reply here and we\'ll help.',
    vars: ['First name', 'Message'],
    example: ['Rob', 'we noticed your backup last ran on Friday and wanted to check in.'], footer: 'Lumen IT Solutions' },
];

// Fill a template body's {{n}} placeholders with params, for previews and stored copies.
export function renderTemplateBody(tpl: WaTemplate, params: string[]): string {
  return tpl.body.replace(/\{\{(\d+)\}\}/g, (_m, n) => params[Number(n) - 1] || '');
}

export interface MetaTemplateStatus { name: string; status: string; category?: string; language?: string; }

// Read back the templates Meta holds for this WABA (with approval status).
export async function listMetaTemplates(wabaId: string, token: string): Promise<{ ok: true; rows: MetaTemplateStatus[] } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${GRAPH}/${wabaId}/message_templates?fields=name,status,category,language&limit=200`, { headers: { Authorization: `Bearer ${token}` } });
    const data: any = await res.json();
    if (!res.ok) return { ok: false, error: data?.error?.message || ('HTTP ' + res.status) };
    return { ok: true, rows: (data.data || []).map((t: any) => ({ name: t.name, status: t.status, category: t.category, language: t.language })) };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

// Submit one template to Meta for review. Returns ok, or the error (e.g. duplicate name / bad token).
export async function pushTemplateToMeta(wabaId: string, token: string, tpl: WaTemplate): Promise<{ ok: boolean; id?: string; status?: string; error?: string }> {
  const components: any[] = [
    { type: 'BODY', text: tpl.body, ...(tpl.example.length ? { example: { body_text: [tpl.example] } } : {}) },
  ];
  if (tpl.footer) components.push({ type: 'FOOTER', text: tpl.footer });
  try {
    const res = await fetch(`${GRAPH}/${wabaId}/message_templates`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: tpl.name, language: tpl.language, category: tpl.category, components }),
    });
    const data: any = await res.json();
    if (!res.ok) return { ok: false, error: data?.error?.error_user_msg || data?.error?.message || ('HTTP ' + res.status) };
    return { ok: true, id: data.id, status: data.status };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

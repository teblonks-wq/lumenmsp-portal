import { getSetting, getGroup } from './settings';

// Live Teams messaging. App-only Graph chat sends are blocked by Microsoft, so we go through
// either an Azure Bot (Bot Framework) or a Power Automate "Workflow" HTTP relay. Inbound Teams
// messages arrive at POST /webhooks/teams; replies post back using the saved conversation
// reference. Config lives in settings group 'teams'.

export interface TeamsConfig {
  inboundSecret: string;  // shared secret the inbound relay/bot must present
  outboundUrl: string;    // Power Automate flow (or bot relay) URL the portal POSTs replies to
  outboundSecret: string; // secret we present to the outbound relay
  botName: string;        // display name shown for our side, optional
}

export async function teamsConfig(): Promise<TeamsConfig> {
  const g = await getGroup('teams');
  return {
    inboundSecret: g.inbound_secret || '',
    outboundUrl: g.outbound_url || '',
    outboundSecret: g.outbound_secret || '',
    botName: g.bot_name || 'Lumen IT',
  };
}

export async function teamsConfigured(): Promise<boolean> {
  const c = await teamsConfig();
  return !!c.outboundUrl;
}

export interface TeamsSendResult { ok: boolean; error?: string; }

// Reply over Teams. `conversation` is the JSON reference we stored when the customer first
// messaged in (chat/conversation id, serviceUrl, etc.); `toEmail` lets a Power Automate relay
// post a 1:1 to the customer by address. The relay can use whichever it prefers.
export async function sendTeamsReply(conversation: string | null, text: string, toEmail?: string | null): Promise<TeamsSendResult> {
  const c = await teamsConfig();
  if (!c.outboundUrl) return { ok: false, error: 'Teams sending not configured' };
  if (!conversation && !toEmail) return { ok: false, error: 'No Teams conversation or recipient on this case — the customer must message first' };
  try {
    const res = await fetch(c.outboundUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(c.outboundSecret ? { 'X-Relay-Secret': c.outboundSecret } : {}) },
      body: JSON.stringify({ conversation: safeParse(conversation), to_email: toEmail || null, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: 'HTTP ' + res.status + (body ? ': ' + body.slice(0, 200) : '') };
    }
    return { ok: true };
  } catch (e: any) { return { ok: false, error: e.message }; }
}

function safeParse(s: string | null): any { if (!s) return null; try { return JSON.parse(s); } catch { return s; } }

// Internal staff alert via the Power Automate "Workflow" webhook (separate from customer replies).
// No-op (and never throws) when no webhook is configured.
export async function sendTeamsNotice(payload: {
  toEmail?: string; title: string; text?: string; link?: string;
}): Promise<void> {
  try {
    const url = await getSetting('integrations', 'teams_webhook');
    if (!url) return;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) { console.error('[teams] webhook failed:', (e as Error).message); }
}

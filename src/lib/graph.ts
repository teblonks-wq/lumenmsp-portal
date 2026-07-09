import { config } from '../config';

// Microsoft Graph client-credentials helper.
// App-only auth (no signed-in user): the app registration needs the
// Application permission Mail.Send (and Mail.ReadWrite for inbound sync),
// with admin consent granted. Token is cached until ~60s before expiry.

const TOKEN_URL = (tenant: string) =>
  `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
const GRAPH = 'https://graph.microsoft.com/v1.0';

let _token: { value: string; expires: number } | null = null;

export function graphConfigured(): boolean {
  return !!(config.GRAPH_TENANT_ID && config.GRAPH_CLIENT_ID && config.GRAPH_CLIENT_SECRET);
}

export async function getGraphToken(): Promise<string> {
  if (_token && Date.now() < _token.expires) return _token.value;
  if (!graphConfigured()) throw new Error('Graph is not configured (missing tenant/client/secret).');

  const body = new URLSearchParams({
    client_id: config.GRAPH_CLIENT_ID,
    client_secret: config.GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  const res = await fetch(TOKEN_URL(config.GRAPH_TENANT_ID), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data: any = await res.json();
  if (!res.ok) {
    throw new Error(`Graph token error ${res.status}: ${data.error} — ${data.error_description || ''}`);
  }
  _token = { value: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return _token.value;
}

export interface GraphAttachment { filename: string; contentType: string; base64: string; }

export interface GraphSendOptions {
  from?: string;            // mailbox to send AS (defaults to GRAPH_SEND_FROM / FROM_EMAIL)
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  html: string;
  attachments?: GraphAttachment[];
  saveToSentItems?: boolean;
  autoSubmitted?: boolean;  // mark as an automated reply so other systems won't auto-respond (loop guard)
}

// PS_INTERNET_HEADERS namespace — lets us set arbitrary MIME headers (incl. non X- ones) on a sent message.
const PS_INTERNET_HEADERS = '00020386-0000-0000-C000-000000000046';

const recip = (addr: string) => ({ emailAddress: { address: addr.trim() } });
const recips = (v?: string | string[]) =>
  (!v ? [] : (Array.isArray(v) ? v : v.split(/[;,]/))).map((s) => s.trim()).filter(Boolean).map(recip);

// Sends mail as the given mailbox via POST /users/{mailbox}/sendMail.
export async function graphSendMail(opts: GraphSendOptions): Promise<void> {
  const token = await getGraphToken();
  const sender = (opts.from || config.GRAPH_SEND_FROM || config.FROM_EMAIL).trim();

  const message: any = {
    subject: opts.subject,
    body: { contentType: 'HTML', content: opts.html },
    toRecipients: recips(opts.to),
  };
  if (opts.cc) message.ccRecipients = recips(opts.cc);
  if (opts.bcc) message.bccRecipients = recips(opts.bcc);
  if (opts.autoSubmitted) {
    // Tell well-behaved mail systems this is machine-generated, so they don't auto-reply (mail-loop guard).
    message.singleValueExtendedProperties = [
      { id: `String {${PS_INTERNET_HEADERS}} Name Auto-Submitted`, value: 'auto-replied' },
      { id: `String {${PS_INTERNET_HEADERS}} Name X-Auto-Response-Suppress`, value: 'All' },
    ];
  }
  if (opts.attachments && opts.attachments.length) {
    message.attachments = opts.attachments.map((a) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename,
      contentType: a.contentType,
      contentBytes: a.base64,
    }));
  }

  const res = await fetch(`${GRAPH}/users/${encodeURIComponent(sender)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, saveToSentItems: opts.saveToSentItems !== false }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Graph sendMail failed ${res.status} (as ${sender}): ${err}`);
  }
}

export interface GraphMessage {
  id: string;
  subject: string;
  bodyPreview: string;
  bodyHtml: string;        // full HTML body, as the sender composed it
  bodyText: string;        // plain-text fallback (preview)
  bodyContentType: string; // 'html' | 'text'
  hasAttachments: boolean;
  from: string;
  fromName: string;
  toRecipients: string[];
  ccRecipients: string[];
  headers: Record<string, string>;  // lower-cased internet message headers (for loop/auto detection)
  receivedDateTime: string;
}

// Lists inbox messages for a mailbox, oldest first. Pass an ISO date to only get mail
// received after it; pass null/'' to take whatever is currently in the Inbox (used when
// processed mail is filed into "Imported", so the Inbox itself drains). Requires
// Mail.Read (or Mail.ReadWrite to move).
export async function graphListInbox(mailbox: string, sinceIso: string | null, top = 50): Promise<GraphMessage[]> {
  const token = await getGraphToken();
  const params = new URLSearchParams({
    '$select': 'id,subject,bodyPreview,body,hasAttachments,from,toRecipients,ccRecipients,internetMessageHeaders,receivedDateTime',
    '$orderby': 'receivedDateTime asc',
    '$top': String(top),
  });
  if (sinceIso) params.set('$filter', `receivedDateTime gt ${sinceIso}`);
  const url = `${GRAPH}/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages?${params}`;
  // No Prefer header → Graph returns the HTML body by default.
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`Graph listInbox failed ${res.status}: ${JSON.stringify(data.error || data).slice(0, 300)}`);
  return (data.value || []).map((m: any): GraphMessage => {
    const ct = (m.body?.contentType || 'html').toLowerCase();
    return {
      id: m.id,
      subject: m.subject || '',
      bodyPreview: m.bodyPreview || '',
      bodyHtml: ct === 'html' ? (m.body?.content || '') : '',
      bodyText: ct === 'text' ? (m.body?.content || '') : (m.bodyPreview || ''),
      bodyContentType: ct,
      hasAttachments: !!m.hasAttachments,
      from: m.from?.emailAddress?.address || '',
      fromName: m.from?.emailAddress?.name || '',
      toRecipients: (m.toRecipients || []).map((r: any) => r.emailAddress?.address).filter(Boolean),
      ccRecipients: (m.ccRecipients || []).map((r: any) => r.emailAddress?.address).filter(Boolean),
      headers: (m.internetMessageHeaders || []).reduce((acc: Record<string, string>, h: any) => {
        if (h && h.name) acc[String(h.name).toLowerCase()] = String(h.value || '');
        return acc;
      }, {} as Record<string, string>),
      receivedDateTime: m.receivedDateTime,
    };
  });
}

// Finds (or creates) a top-level mail folder by display name; returns its id.
// Used to file processed mail into an "Imported" folder so it's never re-read.
async function findFolderByName(mailbox: string, token: string, name: string): Promise<string | null> {
  const url = `${GRAPH}/users/${encodeURIComponent(mailbox)}/mailFolders?$select=id,displayName&$top=200`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`Graph list folders failed ${res.status}: ${JSON.stringify(data.error || data).slice(0, 200)}`);
  const hit = (data.value || []).find((f: any) => String(f.displayName || '').toLowerCase() === name.toLowerCase());
  return hit ? hit.id : null;
}
export async function graphEnsureFolder(mailbox: string, name: string): Promise<string> {
  const token = await getGraphToken();
  const existing = await findFolderByName(mailbox, token, name);
  if (existing) return existing;
  const res = await fetch(`${GRAPH}/users/${encodeURIComponent(mailbox)}/mailFolders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: name }),
  });
  const data: any = await res.json();
  if (res.ok) return data.id;
  // Race / already exists → re-list and use it.
  const after = await findFolderByName(mailbox, token, name);
  if (after) return after;
  throw new Error(`Graph create folder failed ${res.status}: ${JSON.stringify(data.error || data).slice(0, 200)}`);
}

// Moves a message to another folder (requires Mail.ReadWrite on the app registration).
export async function graphMoveMessage(mailbox: string, messageId: string, destinationId: string): Promise<void> {
  const token = await getGraphToken();
  const res = await fetch(`${GRAPH}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/move`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ destinationId }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Graph move failed ${res.status}: ${t.slice(0, 200)}`); }
}

export interface GraphInboundAttachment {
  name: string;
  contentType: string;
  base64: string;
  size: number;
  isInline: boolean;
  contentId: string; // for inline images referenced as cid:... in the HTML body
}

// Fetches file attachments for a message — including ones nested inside a forwarded email that
// was attached as an item (Outlook "Forward as attachment"). Reference attachments are skipped.
export async function graphListAttachments(mailbox: string, messageId: string): Promise<GraphInboundAttachment[]> {
  const token = await getGraphToken();
  const url = `${GRAPH}/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`Graph attachments failed ${res.status}: ${JSON.stringify(data.error || data).slice(0, 200)}`);
  const out: GraphInboundAttachment[] = [];

  const pushFile = (a: any) => {
    if (!a || !a.contentBytes) return;
    out.push({
      name: a.name || 'attachment',
      contentType: a.contentType || 'application/octet-stream',
      base64: a.contentBytes,
      size: a.size || 0,
      isInline: !!a.isInline,
      contentId: (a.contentId || '').replace(/^<|>$/g, ''),
    });
  };

  for (const a of (data.value || [])) {
    const type = a['@odata.type'];
    if (type === '#microsoft.graph.fileAttachment') {
      let bytes: string | undefined = a.contentBytes;
      // Graph omits contentBytes from the attachments listing for larger files (e.g. multi-MB PDFs).
      // Fetch the single attachment to get its bytes so big invoices aren't silently dropped.
      if (!bytes && a.id) {
        try {
          const r2 = await fetch(`${url}/${encodeURIComponent(a.id)}`, { headers: { Authorization: `Bearer ${token}` } });
          if (r2.ok) { const d2: any = await r2.json(); bytes = d2.contentBytes; }
        } catch { /* leave undefined → skipped */ }
      }
      if (bytes) pushFile({ ...a, contentBytes: bytes });
    } else if (type === '#microsoft.graph.itemAttachment' && a.id) {
      // A forwarded email attached as an item — the real invoice files are nested inside it.
      // Expand the embedded message and pull its file attachments out.
      try {
        const r2 = await fetch(`${url}/${encodeURIComponent(a.id)}?$expand=microsoft.graph.itemAttachment/item`,
          { headers: { Authorization: `Bearer ${token}` } });
        if (r2.ok) {
          const d2: any = await r2.json();
          const nested = (d2.item && d2.item.attachments) || [];
          for (const na of nested) {
            if (na['@odata.type'] === '#microsoft.graph.fileAttachment') pushFile(na);
          }
        }
      } catch { /* nested fetch best-effort */ }
    }
  }
  return out;
}

// Resolve an AAD user id from a UPN/email.
async function graphUserId(token: string, upn: string): Promise<string | null> {
  const r = await fetch(`${GRAPH}/users/${encodeURIComponent(upn)}?$select=id`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const d: any = await r.json();
  return d.id || null;
}

// Best-effort 1:1 Teams chat message from the Teams-licensed mailbox to a user.
// Needs Application permissions Chat.Create + ChatMessage.Send (app-only chat
// messaging may require Microsoft's protected-API enrolment). Throws on failure.
export async function graphSendTeamsChat(senderUpn: string, recipientUpn: string, html: string): Promise<void> {
  const token = await getGraphToken();
  const [sid, rid] = await Promise.all([graphUserId(token, senderUpn), graphUserId(token, recipientUpn)]);
  if (!sid || !rid) throw new Error('Could not resolve Teams users (' + senderUpn + ', ' + recipientUpn + ')');

  const chatRes = await fetch(`${GRAPH}/chats`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chatType: 'oneOnOne',
      members: [
        { '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${sid}')` },
        { '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${rid}')` },
      ],
    }),
  });
  const chat: any = await chatRes.json();
  if (!chatRes.ok) throw new Error(`Teams chat create ${chatRes.status}: ${JSON.stringify(chat.error || chat).slice(0, 200)}`);

  const msgRes = await fetch(`${GRAPH}/chats/${chat.id}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: { contentType: 'html', content: html } }),
  });
  if (!msgRes.ok) throw new Error(`Teams chat message ${msgRes.status}: ${(await msgRes.text()).slice(0, 200)}`);
}

// App-only token for a SPECIFIC tenant (a customer's Entra tenant). The app must be
// multi-tenant and admin-consented in that tenant. Cached per tenant until expiry.
const _tenantTokens: Record<string, { value: string; expires: number }> = {};
export async function getGraphTokenForTenant(tenant: string): Promise<string> {
  const cached = _tenantTokens[tenant];
  if (cached && Date.now() < cached.expires) return cached.value;
  if (!graphConfigured()) throw new Error('Graph is not configured.');
  const res = await fetch(TOKEN_URL(tenant), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GRAPH_CLIENT_ID, client_secret: config.GRAPH_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
    }),
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(`Graph token (tenant ${tenant}) ${res.status}: ${data.error} — ${(data.error_description || '').slice(0, 160)}`);
  _tenantTokens[tenant] = { value: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

export interface GraphDirUser {
  id: string; displayName: string; email: string; jobTitle: string;
  mobilePhone: string; businessPhone: string; enabled: boolean;
}

// Lists a customer tenant's directory users. Needs User.Read.All / Directory.Read.All
// (Application) consented in that tenant.
export async function graphListTenantUsers(tenant: string): Promise<GraphDirUser[]> {
  const token = await getGraphTokenForTenant(tenant);
  const out: GraphDirUser[] = [];
  let url: string = `${GRAPH}/users?$select=id,displayName,mail,userPrincipalName,accountEnabled,jobTitle,mobilePhone,businessPhones,assignedLicenses,userType&$top=200`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data: any = await res.json();
    if (!res.ok) throw new Error(`Graph listTenantUsers ${res.status}: ${JSON.stringify(data.error || data).slice(0, 300)}`);
    for (const u of (data.value || [])) {
      if ((u.userType || 'Member') === 'Guest') continue; // humans = members, not external guests
      if (!(u.assignedLicenses || []).length) continue;  // licensed users only — skips shared mailboxes/rooms/service accounts
      const email = (u.mail || u.userPrincipalName || '').toLowerCase();
      if (!email) continue;
      out.push({
        id: u.id, displayName: u.displayName || email, email, jobTitle: u.jobTitle || '',
        mobilePhone: u.mobilePhone || '', businessPhone: (u.businessPhones && u.businessPhones[0]) || '',
        enabled: u.accountEnabled !== false,
      });
    }
    url = data['@odata.nextLink'] || '';
  }
  return out;
}

export interface GraphUser { id: string; displayName: string; email: string; enabled: boolean; }

// Lists directory users who hold at least one assigned licence.
// Requires Application permission User.Read.All (or Directory.Read.All) + admin consent.
export async function graphListLicensedUsers(): Promise<GraphUser[]> {
  const token = await getGraphToken();
  const out: GraphUser[] = [];
  let url: string = `${GRAPH}/users?$select=id,displayName,mail,userPrincipalName,accountEnabled,assignedLicenses&$top=200`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data: any = await res.json();
    if (!res.ok) throw new Error(`Graph listUsers failed ${res.status}: ${JSON.stringify(data.error || data).slice(0, 300)}`);
    for (const u of (data.value || [])) {
      if (!(u.assignedLicenses || []).length) continue; // licensed only
      const email = (u.mail || u.userPrincipalName || '').toLowerCase();
      if (!email) continue;
      out.push({ id: u.id, displayName: u.displayName || email, email, enabled: u.accountEnabled !== false });
    }
    url = data['@odata.nextLink'] || '';
  }
  out.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return out;
}

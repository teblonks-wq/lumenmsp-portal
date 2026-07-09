import type { Server } from 'http';
import type { RequestHandler } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { pool } from '../db/pool';
import { logChannel } from './commslog';
import { preAcceptCall, acceptCall, rejectCall, terminateCall, connectCall, type WaCallEvent } from './wacalls';
import { normaliseWaNumber } from './whatsapp';

// 24h customer-service window: a call-back (business-initiated call) is only allowed when the
// customer has messaged or called us within the last 24 hours.
const WINDOW_MS = 24 * 60 * 60 * 1000;

// In-portal WhatsApp softphone signalling hub.
// - A WebSocket per staff browser tab (auth'd via the express session on upgrade).
// - Inbound WhatsApp call → ring every connected agent; first to accept wins.
// - Relays the agent's SDP answer to Meta (pre_accept → accept); media is WebRTC
//   browser <-> WhatsApp (this server never touches the audio).

interface AgentSocket { ws: WebSocket; userId: number; name: string; }
interface ActiveCall {
  call: WaCallEvent;
  direction: 'inbound' | 'outbound';
  callerName: string;
  contactId: number | null;
  customerId: number | null;
  ticketId: number | null;
  status: 'ringing' | 'connected' | 'ended';
  ownerUserId: number | null;
  startedAt: number;
  connectedAt: number | null;
}

const agents = new Set<AgentSocket>();
const calls = new Map<string, ActiveCall>();

function send(ws: WebSocket, msg: any): void {
  if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ } }
}
function broadcast(msg: any, filter?: (a: AgentSocket) => boolean): void {
  for (const a of agents) if (!filter || filter(a)) send(a.ws, msg);
}

// Look up who's calling so the toast shows a name, not just a number.
async function identifyCaller(from: string): Promise<{ name: string; contactId: number | null; customerId: number | null }> {
  const last9 = from.slice(-9);
  if (last9.length >= 7) {
    const r = await pool.query(
      `SELECT cc.id, cc.customer_id, cc.full_name
         FROM customer_contacts cc JOIN customers c ON c.id = cc.customer_id
        WHERE c.deleted_at IS NULL AND (
              regexp_replace(COALESCE(cc.mobile_phone,''), '\\D', '', 'g') LIKE '%' || $1
           OR regexp_replace(COALESCE(cc.phone,''),        '\\D', '', 'g') LIKE '%' || $1 )
        ORDER BY cc.is_primary DESC LIMIT 1`, [last9]
    );
    if (r.rows[0]) return { name: r.rows[0].full_name || ('+' + from), contactId: r.rows[0].id, customerId: r.rows[0].customer_id };
  }
  return { name: '+' + from, contactId: null, customerId: null };
}

// ── Inbound call entry points (called from the WhatsApp webhook) ────────────────

export async function onInboundCall(call: WaCallEvent): Promise<void> {
  if (calls.has(call.callId)) return; // dedupe re-delivered webhooks
  const who = await identifyCaller(call.from);
  const ac: ActiveCall = {
    call, direction: 'inbound', callerName: who.name, contactId: who.contactId, customerId: who.customerId,
    ticketId: null, status: 'ringing', ownerUserId: null, startedAt: Date.now(), connectedAt: null,
  };
  calls.set(call.callId, ac);

  await logChannel({ channel: 'whatsapp', direction: 'inbound', status: 'received',
    contactId: who.contactId, peer: '+' + call.from, peerName: who.name, preview: '📞 Incoming WhatsApp call', externalId: call.callId });

  if (!agents.size) {
    // Nobody logged in to answer — reject so the caller isn't left ringing.
    await rejectCall(call.callId).catch(() => {});
    ac.status = 'ended';
    await finishLog(ac, 'missed (no agent online)');
    calls.delete(call.callId);
    return;
  }
  broadcast({ type: 'incoming', callId: call.callId, from: '+' + call.from, name: who.name,
    offerSdp: call.offerSdp, customerId: who.customerId });

  // Auto-give-up if no one answers within 45s.
  setTimeout(() => {
    const c = calls.get(call.callId);
    if (c && c.status === 'ringing') {
      rejectCall(call.callId).catch(() => {});
      c.status = 'ended';
      broadcast({ type: 'ended', callId: call.callId, reason: 'unanswered' });
      finishLog(c, 'missed (timed out)').catch(() => {});
      calls.delete(call.callId);
    }
  }, 45000);
}

export async function onCallTerminate(callId: string): Promise<void> {
  const c = calls.get(callId);
  if (!c) return;
  c.status = 'ended';
  broadcast({ type: 'ended', callId, reason: 'remote_hangup' });
  await finishLog(c, c.connectedAt ? 'completed' : 'missed (caller hung up)');
  calls.delete(callId);
}

async function finishLog(c: ActiveCall, outcome: string): Promise<void> {
  const secs = c.connectedAt ? Math.round((Date.now() - c.connectedAt) / 1000) : 0;
  const peer = '+' + (c.direction === 'outbound' ? c.call.to : c.call.from);
  const preview = `📞 WhatsApp call (${c.direction}) — ${outcome}${secs ? ` (${Math.floor(secs / 60)}m ${secs % 60}s)` : ''}`;
  try {
    await logChannel({ channel: 'whatsapp', direction: c.direction, status: c.connectedAt ? 'received' : 'failed',
      ticketId: c.ticketId, contactId: c.contactId, peer, peerName: c.callerName, preview, externalId: c.call.callId, userId: c.ownerUserId });
  } catch { /* ignore */ }
  // Persist to the call-history table (best-effort).
  try {
    await pool.query(
      `INSERT INTO wa_calls (call_id, direction, peer, peer_name, contact_id, customer_id, agent_user_id, status, started_at, connected_at, ended_at, duration_secs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, to_timestamp($9/1000.0), $10, NOW(), $11)
       ON CONFLICT (call_id) DO UPDATE SET status=EXCLUDED.status, connected_at=EXCLUDED.connected_at, ended_at=EXCLUDED.ended_at, duration_secs=EXCLUDED.duration_secs`,
      [c.call.callId, c.direction, peer, c.callerName, c.contactId, c.customerId, c.ownerUserId, outcome,
       c.startedAt, c.connectedAt ? new Date(c.connectedAt) : null, secs]
    );
  } catch (e) { console.error('[callhub] wa_calls insert failed:', (e as Error).message); }
}

export async function ensureCallTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wa_calls (
      id            BIGSERIAL PRIMARY KEY,
      call_id       TEXT UNIQUE,
      direction     TEXT NOT NULL,
      peer          TEXT NOT NULL,
      peer_name     TEXT,
      contact_id    INTEGER,
      customer_id   INTEGER,
      agent_user_id INTEGER,
      status        TEXT,
      started_at    TIMESTAMPTZ DEFAULT NOW(),
      connected_at  TIMESTAMPTZ,
      ended_at      TIMESTAMPTZ,
      duration_secs INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_wa_calls_started ON wa_calls (started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wa_calls_peer ON wa_calls (peer, started_at DESC);
  `);
}

// Recent call history with a `callable` flag — true only while the 24h service window is open
// (i.e. the peer messaged or called us within 24h, recorded in channel_log as inbound).
export async function callHistory(limit = 40): Promise<any[]> {
  const r = await pool.query(
    `SELECT c.call_id, c.direction, c.peer, c.peer_name, c.contact_id, c.customer_id, c.status,
            c.started_at, c.duration_secs,
            (SELECT MAX(cl.created_at) FROM channel_log cl
              WHERE cl.channel='whatsapp' AND cl.direction='inbound' AND cl.peer = c.peer) AS last_inbound_at
       FROM wa_calls c ORDER BY c.started_at DESC LIMIT $1`, [limit]
  );
  const now = Date.now();
  return r.rows.map((row: any) => ({
    ...row,
    callable: !!row.last_inbound_at && (now - new Date(row.last_inbound_at).getTime()) < WINDOW_MS,
    window_expires_at: row.last_inbound_at ? new Date(new Date(row.last_inbound_at).getTime() + WINDOW_MS).toISOString() : null,
  }));
}

// Is a call-back to this peer currently allowed (open 24h window)?
async function withinWindow(peer: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT MAX(created_at) AS last_in FROM channel_log WHERE channel='whatsapp' AND direction='inbound' AND peer=$1`, [peer]
  );
  const last = r.rows[0]?.last_in;
  return !!last && (Date.now() - new Date(last).getTime()) < WINDOW_MS;
}

// ── Agent actions over the WebSocket ────────────────────────────────────────────

async function handleAccept(agent: AgentSocket, callId: string, answerSdp: string): Promise<void> {
  const c = calls.get(callId);
  if (!c) { send(agent.ws, { type: 'ended', callId, reason: 'gone' }); return; }
  if (c.status !== 'ringing') { send(agent.ws, { type: 'taken', callId }); return; }
  c.status = 'connected';
  c.ownerUserId = agent.userId;
  c.connectedAt = Date.now();

  const pre = await preAcceptCall(callId, answerSdp);
  const acc = await acceptCall(callId, answerSdp);
  if (!acc.ok) {
    c.status = 'ended';
    send(agent.ws, { type: 'error', callId, message: acc.error || pre.error || 'Accept failed' });
    broadcast({ type: 'ended', callId, reason: 'accept_failed' });
    await finishLog(c, 'failed to connect');
    calls.delete(callId);
    return;
  }
  send(agent.ws, { type: 'accepted', callId });
  broadcast({ type: 'taken', callId }, (a) => a !== agent); // dismiss the toast for everyone else
}

async function handleReject(callId: string): Promise<void> {
  const c = calls.get(callId);
  if (!c) return;
  await rejectCall(callId).catch(() => {});
  c.status = 'ended';
  broadcast({ type: 'ended', callId, reason: 'declined' });
  await finishLog(c, 'declined');
  calls.delete(callId);
}

async function handleHangup(callId: string): Promise<void> {
  const c = calls.get(callId);
  if (!c) return;
  await terminateCall(callId).catch(() => {});
  c.status = 'ended';
  broadcast({ type: 'ended', callId, reason: 'agent_hangup' });
  await finishLog(c, 'completed');
  calls.delete(callId);
}

// ── Outbound call-back ──────────────────────────────────────────────────────────

async function handleCallback(agent: AgentSocket, toRaw: string, offerSdp: string): Promise<void> {
  const waId = normaliseWaNumber(toRaw);
  if (!waId) { send(agent.ws, { type: 'error', message: 'No valid number to call' }); return; }
  const peer = '+' + waId;
  if (!(await withinWindow(peer))) {
    send(agent.ws, { type: 'error', message: 'Call-back window has expired — the customer must message or call again first (24h rule).' });
    return;
  }
  const res = await connectCall(waId, offerSdp);
  if (!res.ok || !res.callId) { send(agent.ws, { type: 'error', message: res.error || 'Could not place the call' }); return; }

  const who = await identifyCaller(waId);
  const ac: ActiveCall = {
    call: { callId: res.callId, from: '', to: waId, event: 'connect', offerSdp: null, answerSdp: null, timestamp: Math.floor(Date.now() / 1000), raw: {} },
    direction: 'outbound', callerName: who.name, contactId: who.contactId, customerId: who.customerId,
    ticketId: null, status: 'ringing', ownerUserId: agent.userId, startedAt: Date.now(), connectedAt: null,
  };
  calls.set(res.callId, ac);
  send(agent.ws, { type: 'calling', callId: res.callId, name: who.name, to: peer });

  // Give up if the customer doesn't answer within 45s.
  setTimeout(() => {
    const c = calls.get(res.callId!);
    if (c && c.status === 'ringing') {
      terminateCall(res.callId!).catch(() => {});
      c.status = 'ended';
      send(agent.ws, { type: 'ended', callId: res.callId, reason: 'no_answer' });
      finishLog(c, 'no answer').catch(() => {});
      calls.delete(res.callId!);
    }
  }, 45000);
}

// The customer answered our outbound call — relay their SDP answer to the agent who placed it.
export async function onCallAnswer(callId: string, answerSdp: string): Promise<void> {
  const c = calls.get(callId);
  if (!c || c.direction !== 'outbound') return;
  c.status = 'connected';
  c.connectedAt = Date.now();
  const owner = [...agents].find((a) => a.userId === c.ownerUserId);
  if (owner) send(owner.ws, { type: 'answer', callId, answerSdp });
}

// ── WebSocket server ────────────────────────────────────────────────────────────

export function attachCallSocket(server: Server, sessionMiddleware: RequestHandler): void {
  ensureCallTable().catch((e) => console.error('[callhub] ensureCallTable failed:', e.message));
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws/calls')) return; // leave other upgrades alone
    // Run the express-session middleware to populate req.session from the cookie.
    sessionMiddleware(req as any, {} as any, () => {
      const sess = (req as any).session;
      const user = sess && sess.user;
      // Staff only (portal users have no customerId); customers never get the softphone.
      if (!user || user.customerId) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const agent: AgentSocket = { ws, userId: user.id, name: user.displayName || user.email || 'Agent' };
        agents.add(agent);
        send(ws, { type: 'ready' });
        ws.on('message', async (raw) => {
          let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
          try {
            if (m.type === 'accept' && m.callId && m.answerSdp) await handleAccept(agent, m.callId, m.answerSdp);
            else if (m.type === 'reject' && m.callId) await handleReject(m.callId);
            else if (m.type === 'hangup' && m.callId) await handleHangup(m.callId);
            else if (m.type === 'callback' && m.to && m.offerSdp) await handleCallback(agent, m.to, m.offerSdp);
            else if (m.type === 'ping') send(ws, { type: 'pong' });
          } catch (e) { console.error('[callhub] action failed:', (e as Error).message); }
        });
        ws.on('close', () => { agents.delete(agent); });
        ws.on('error', () => { agents.delete(agent); });
      });
    });
  });

  console.log('✓ WhatsApp call socket attached at /ws/calls');
}

export function agentsOnline(): number { return agents.size; }

// Push an arbitrary event to every connected staff browser (used for live website-chat alerts).
export function notifyAgents(msg: any): void { broadcast(msg); }

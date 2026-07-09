import { pool } from '../db/pool';

// Records a WhatsApp/Teams message (either direction) into channel_log, mirroring email_log so
// the Comms Log admin views can show inbound + outbound for the non-email channels. Best-effort:
// never throws into the caller (logging must not break a send or an inbound webhook).

export interface ChannelLogEntry {
  channel: 'whatsapp' | 'teams';
  direction: 'inbound' | 'outbound';
  status?: 'received' | 'sent' | 'failed' | 'recorded';
  ticketId?: number | null;
  contactId?: number | null;
  peer?: string | null;
  peerName?: string | null;
  preview?: string | null;
  externalId?: string | null;
  error?: string | null;
  userId?: number | null;
}

export async function logChannel(e: ChannelLogEntry): Promise<void> {
  try {
    const preview = e.preview ? String(e.preview).replace(/\s+/g, ' ').trim().slice(0, 280) : null;
    await pool.query(
      `INSERT INTO channel_log (channel, direction, status, ticket_id, contact_id, peer, peer_name, preview, external_id, error, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [e.channel, e.direction, e.status || (e.direction === 'inbound' ? 'received' : 'sent'),
       e.ticketId ?? null, e.contactId ?? null, e.peer ?? null, e.peerName ?? null,
       preview, e.externalId ?? null, e.error ?? null, e.userId ?? null]
    );
  } catch (err) {
    console.error('channel_log insert failed:', err);
  }
}

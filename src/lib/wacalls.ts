import { whatsappConfig } from './whatsapp';

// WhatsApp Business Calling API (Cloud API). Voice calls ride on the same WABA/phone-number
// as messaging. Media is WebRTC; signalling is via Graph + the `calls` webhook field.
// Flow for an inbound call:
//   1. webhook delivers a `connect` event with the customer's SDP *offer*
//   2. an agent's browser builds an SDP *answer*
//   3. we POST pre_accept (answer SDP) then accept to /{phoneNumberId}/calls
//   4. media flows browser <-> WhatsApp
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/calling/
const GRAPH = 'https://graph.facebook.com/v21.0';

export type WaCallAction = 'pre_accept' | 'accept' | 'reject' | 'terminate';

export interface WaCallEvent {
  callId:    string;
  from:      string;        // customer wa_id (digits)
  to:        string;        // our business number
  event:     'connect' | 'terminate' | 'ringing' | string;
  offerSdp:  string | null; // present on an inbound 'connect' (sdp_type 'offer')
  answerSdp: string | null; // present when the user answers our OUTBOUND call (sdp_type 'answer')
  timestamp: number;
  raw:       any;
}

// Parse a single call object from the webhook `value.calls[]` array into our shape.
export function parseWaCall(call: any): WaCallEvent | null {
  if (!call) return null;
  const callId = String(call.id || call.call_id || '');
  if (!callId) return null;
  const session = call.session || call.sdp || {};
  const sdpType = session.sdp_type || session.type || '';
  const sdp = session.sdp || null;
  const offerSdp  = (sdpType === 'offer')  ? sdp : (sdpType === '' && call.event === 'connect' ? sdp : null);
  const answerSdp = (sdpType === 'answer') ? sdp : null;
  return {
    callId,
    from:      String(call.from || '').replace(/[^\d]/g, ''),
    to:        String(call.to || '').replace(/[^\d]/g, ''),
    event:     String(call.event || call.status || 'connect'),
    offerSdp,
    answerSdp,
    timestamp: call.timestamp ? Number(call.timestamp) : Math.floor(Date.now() / 1000),
    raw:       call,
  };
}

async function callAction(body: Record<string, any>): Promise<{ ok: boolean; error?: string; data?: any }> {
  const c = await whatsappConfig();
  if (!c.phoneNumberId || !c.token) return { ok: false, error: 'WhatsApp not configured' };
  try {
    const res = await fetch(`${GRAPH}/${c.phoneNumberId}/calls`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error?.message || ('HTTP ' + res.status), data };
    return { ok: true, data };
  } catch (e: any) { return { ok: false, error: e.message }; }
}

// Reserve/answer the call media path. pre_accept warms the connection so audio is ready the
// instant accept lands (Meta recommends pre_accept then accept for the smoothest connect).
export function preAcceptCall(callId: string, answerSdp: string) {
  return callAction({ call_id: callId, action: 'pre_accept', session: { sdp_type: 'answer', sdp: answerSdp } });
}
export function acceptCall(callId: string, answerSdp: string) {
  return callAction({ call_id: callId, action: 'accept', session: { sdp_type: 'answer', sdp: answerSdp } });
}
export function rejectCall(callId: string) {
  return callAction({ call_id: callId, action: 'reject' });
}
export function terminateCall(callId: string) {
  return callAction({ call_id: callId, action: 'terminate' });
}

// Business-initiated (outbound) call. We are the offerer: send our SDP offer to the user.
// Only valid inside the 24h customer-service window (the user messaged/called us recently) —
// the caller must enforce that before calling this. Returns the new call_id on success.
export async function connectCall(toWaId: string, offerSdp: string): Promise<{ ok: boolean; callId?: string; error?: string }> {
  const r = await callAction({ to: toWaId, action: 'connect', session: { sdp_type: 'offer', sdp: offerSdp } });
  if (!r.ok) return { ok: false, error: r.error };
  const callId = r.data?.calls?.[0]?.id || r.data?.id || r.data?.call_id;
  return { ok: true, callId };
}

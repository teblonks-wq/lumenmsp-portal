import { notifyAgents } from './callhub';

/**
 * Estate toasts — the top-right cards that tell whoever is at a screen that something
 * happened out in the estate: a machine enrolled, Bitdefender landed on one.
 *
 * These are DELIBERATELY not alerts. Nothing here opens a ticket, emails anybody or makes
 * a noise. They are the good news, and good news that pages people stops being good news.
 * The record of what happened lives in /assets and /security; this is only the glance.
 *
 * Two rules the callers depend on:
 *
 *   • **Never throw, never block.** A toast is decoration on top of an enrolment or an
 *     install. If the websocket is unhappy, the enrolment still has to finish — so every
 *     call here is fire-and-forget inside a try/catch and returns void.
 *   • **Always name the machine AND the customer.** "A device enrolled" is useless; the
 *     two questions anybody asks next are which machine and whose. If we cannot name the
 *     customer we say so plainly rather than shipping a card with a hole in it.
 *
 * The browser collapses these per customer (see static/js/call-widget.js), so a 40-machine
 * onboarding is one card that counts up rather than forty cards to dismiss. That is why
 * customerId travels with every message and why it matters that it is the real id.
 */

export interface EstateToastTarget {
  hostname: string | null | undefined;
  customerId: number | null | undefined;
  customerName: string | null | undefined;
}

function base(t: EstateToastTarget) {
  return {
    hostname: String(t.hostname || '').slice(0, 120) || 'unnamed machine',
    customer: String(t.customerName || '').slice(0, 120) || 'unknown customer',
    customerId: Number(t.customerId) || null,
  };
}

/** A machine the Portal has never seen before has enrolled. NOT a re-enrolment — a machine
 *  coming back after a rebuild is not news, and treating it as news trains people to ignore
 *  the card that matters. */
export function toastDeviceEnrolled(t: EstateToastTarget): void {
  try {
    notifyAgents({ type: 'estate', kind: 'enrolled', ...base(t) });
  } catch { /* a toast is never worth failing an enrolment over */ }
}

/**
 * Bitdefender has landed on a machine.
 *
 * `confirmed` carries the distinction the deploy module is built around, and it must not be
 * flattened: false means OUR agent can see Bitdefender on the machine; true means
 * GravityZone has the endpoint enrolled as well. Terry asked for the early one, so the card
 * appears as soon as the agent sees it — but it says "installed", not "protected", and the
 * machine's name gains a tick when GravityZone catches up. An install that never enrols is
 * a real failure mode (see the Chropynska notes in gravityzone-deploy.ts), so the card must
 * never claim the stronger thing on the weaker evidence.
 */
export function toastEndpointSecurity(t: EstateToastTarget & { confirmed: boolean }): void {
  try {
    notifyAgents({ type: 'estate', kind: 'endpoint', confirmed: !!t.confirmed, ...base(t) });
  } catch { /* as above */ }
}

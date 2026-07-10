import { getGroup } from './settings';

// GoCardless Payments API v2. API key + environment stored in settings group 'gocardless'.

const LIVE_BASE = 'https://api.gocardless.com';
const SANDBOX_BASE = 'https://api-sandbox.gocardless.com';
const API_VERSION = '2015-07-06';

export class GoCardless {
  apiKey = '';
  environment = 'live';

  static async load(): Promise<GoCardless> {
    const gc = new GoCardless();
    const cfg = await getGroup('gocardless');
    gc.apiKey = cfg.api_key || '';
    gc.environment = cfg.environment || 'live';
    return gc;
  }

  isConfigured(): boolean { return this.apiKey !== ''; }
  private baseUrl(): string { return this.environment === 'sandbox' ? SANDBOX_BASE : LIVE_BASE; }
  private headers(): Record<string, string> {
    return { Authorization: 'Bearer ' + this.apiKey, 'GoCardless-Version': API_VERSION, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  private async apiGet(path: string): Promise<any> {
    const res = await fetch(this.baseUrl() + path, { headers: this.headers() });
    const body = await res.text();
    if (res.status >= 400) throw new Error('GoCardless API error (HTTP ' + res.status + '): ' + body.slice(0, 300));
    return JSON.parse(body);
  }

  private async apiPost(path: string, payload: any): Promise<any> {
    const res = await fetch(this.baseUrl() + path, { method: 'POST', headers: this.headers(), body: JSON.stringify(payload) });
    const body = await res.text();
    if (res.status >= 400) {
      const d = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      throw new Error('GoCardless API error (HTTP ' + res.status + '): ' + (d?.error?.message || body.slice(0, 300)));
    }
    return JSON.parse(body);
  }

  async listMandates(status = 'active'): Promise<any[]> {
    const all: any[] = [];
    let after: string | null = null;
    do {
      let path = '/mandates?limit=500';
      if (status) path += '&status=' + encodeURIComponent(status);
      if (after) path += '&after=' + encodeURIComponent(after);
      const data = await this.apiGet(path);
      const batch = data?.mandates || [];
      all.push(...batch);
      after = data?.meta?.cursors?.after || null;
      if (batch.length === 0) break;
    } while (after);
    return all;
  }

  async getMandate(mandateId: string): Promise<any> {
    const d = await this.apiGet('/mandates/' + encodeURIComponent(mandateId));
    return d?.mandates || {};
  }

  // All customers (paginated). Fields used: id, email, given_name, family_name, company_name.
  async listCustomers(): Promise<any[]> {
    const all: any[] = [];
    let after: string | null = null;
    do {
      let path = '/customers?limit=500';
      if (after) path += '&after=' + encodeURIComponent(after);
      const data = await this.apiGet(path);
      const batch = data?.customers || [];
      all.push(...batch);
      after = data?.meta?.cursors?.after || null;
      if (batch.length === 0) break;
    } while (after);
    return all;
  }

  // Create a mandate-setup (Direct Debit) flow for a customer and return a hosted link to email
  // them. The customer fills their bank details on GoCardless's hosted page; a mandate is created
  // on completion. `metadata` (e.g. our customer id) rides along so we can match the mandate back.
  async createMandateSetupFlow(opts: {
    redirectUri: string; exitUri: string;
    email?: string; companyName?: string; givenName?: string; familyName?: string;
    metadata?: Record<string, string>;
  }): Promise<{ authorisationUrl: string; billingRequestId: string }> {
    const billing_requests: any = { mandate_request: { scheme: 'bacs', currency: 'GBP' } };
    if (opts.metadata) billing_requests.metadata = opts.metadata;
    const br = await this.apiPost('/billing_requests', { billing_requests });
    const brId = br?.billing_requests?.id;
    if (!brId) throw new Error('GoCardless returned no billing request ID.');

    const prefilled_customer: any = {};
    if (opts.email) prefilled_customer.email = opts.email;
    if (opts.companyName) prefilled_customer.company_name = opts.companyName;
    if (opts.givenName) prefilled_customer.given_name = opts.givenName;
    if (opts.familyName) prefilled_customer.family_name = opts.familyName;

    const flowPayload: any = { billing_request_flows: { redirect_uri: opts.redirectUri, exit_uri: opts.exitUri, links: { billing_request: brId } } };
    if (Object.keys(prefilled_customer).length) flowPayload.billing_request_flows.prefilled_customer = prefilled_customer;
    const flow = await this.apiPost('/billing_request_flows', flowPayload);
    const url = flow?.billing_request_flows?.authorisation_url;
    if (!url) throw new Error('GoCardless returned no authorisation URL.');
    return { authorisationUrl: url, billingRequestId: brId };
  }

  // Fetch a single payment — used to track collection status (pending → confirmed →
  // paid_out) so invoices can be marked paid without waiting for the QuickBooks side.
  async getPayment(paymentId: string): Promise<any> {
    const d = await this.apiGet('/payments/' + encodeURIComponent(paymentId));
    return d?.payments || {};
  }

  // Fetch a payout — gives the bank-statement reference + arrival date for the payout
  // a paid_out payment was bundled into (printed on the invoice next to the payment ref).
  async getPayout(payoutId: string): Promise<any> {
    const d = await this.apiGet('/payouts/' + encodeURIComponent(payoutId));
    return d?.payouts || {};
  }

  // All payments collected against one mandate (paginated) — used to back-link invoices
  // that were imported (e.g. from QB) without a GoCardless payment reference.
  async listPayments(mandateId: string): Promise<any[]> {
    const all: any[] = [];
    let after: string | null = null;
    do {
      let path = '/payments?limit=500&mandate=' + encodeURIComponent(mandateId);
      if (after) path += '&after=' + encodeURIComponent(after);
      const data = await this.apiGet(path);
      const batch = data?.payments || [];
      all.push(...batch);
      after = data?.meta?.cursors?.after || null;
      if (batch.length === 0) break;
    } while (after);
    return all;
  }

  // Create a payment against a mandate. amountPence = GBP × 100.
  // chargeDate (YYYY-MM-DD) = the collection date (your invoice due date). If omitted,
  // or if it's too soon for the scheme, GoCardless collects at the earliest valid date.
  async createPayment(mandateId: string, amountPence: number, description: string, chargeDate?: string): Promise<string> {
    const payments: any = { amount: amountPence, currency: 'GBP', description: description.slice(0, 100), links: { mandate: mandateId } };
    if (chargeDate && /^\d{4}-\d{2}-\d{2}$/.test(chargeDate)) payments.charge_date = chargeDate;
    const d = await this.apiPost('/payments', { payments });
    const id = d?.payments?.id || '';
    if (!id) throw new Error('GoCardless returned no payment ID.');
    return id;
  }
}

// Helper: an invoice due date as a GC charge_date, only if it's today or future
// (GoCardless rejects past dates and enforces a scheme minimum notice period).
export function chargeDateFor(dueDate: any): string | undefined {
  if (!dueDate) return undefined;
  const d = new Date(dueDate);
  if (isNaN(d.getTime())) return undefined;
  const iso = d.toISOString().slice(0, 10);
  return iso >= new Date().toISOString().slice(0, 10) ? iso : undefined;
}

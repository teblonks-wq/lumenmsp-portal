import { config } from '../config';
import { pool } from '../db/pool';
import { getGroup, getSetting, setSetting } from './settings';

// QuickBooks Online integration. OAuth client creds from env (QB_CLIENT_ID/SECRET);
// tokens + realm stored in settings group 'quickbooks'.

const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const PROD_BASE = 'https://quickbooks.api.intuit.com/v3/company';
const SAND_BASE = 'https://sandbox-quickbooks.api.intuit.com/v3/company';
const SCOPE = 'com.intuit.quickbooks.accounting';

export class QuickBooks {
  clientId = config.QB_CLIENT_ID;
  clientSecret = config.QB_CLIENT_SECRET;
  accessToken: string | null = null;
  refreshToken: string | null = null;
  realmId: string | null = null;
  environment = config.QB_ENVIRONMENT as string;

  static async load(): Promise<QuickBooks> {
    const qb = new QuickBooks();
    const cfg = await getGroup('quickbooks');
    if (cfg.client_id) qb.clientId = cfg.client_id;
    if (cfg.client_secret) qb.clientSecret = cfg.client_secret;
    qb.accessToken = cfg.access_token || null;
    qb.refreshToken = cfg.refresh_token || null;
    qb.realmId = cfg.realm_id || null;
    qb.environment = cfg.environment || qb.environment;
    return qb;
  }

  hasCredentials(): boolean { return !!this.clientId && !!this.clientSecret; }
  isConnected(): boolean { return !!this.realmId && !!this.accessToken; }

  getAuthUrl(redirectUri: string, state: string): string {
    const p = new URLSearchParams({ client_id: this.clientId, scope: SCOPE, redirect_uri: redirectUri, response_type: 'code', state });
    return AUTH_URL + '?' + p.toString();
  }

  private async tokenRequest(params: Record<string, string>): Promise<any> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(this.clientId + ':' + this.clientSecret).toString('base64'),
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    });
    return res.json().catch(() => ({}));
  }

  async exchangeCode(code: string, redirectUri: string, realmId: string, environment: string): Promise<boolean> {
    const r = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    if (!r.access_token) return false;
    const expiresAt = new Date(Date.now() + (r.expires_in || 3600) * 1000).toISOString();
    await setSetting('quickbooks', 'access_token', r.access_token);
    await setSetting('quickbooks', 'refresh_token', r.refresh_token || '');
    await setSetting('quickbooks', 'realm_id', realmId);
    await setSetting('quickbooks', 'token_expires_at', expiresAt);
    await setSetting('quickbooks', 'environment', environment);
    this.accessToken = r.access_token; this.refreshToken = r.refresh_token || ''; this.realmId = realmId; this.environment = environment;
    return true;
  }

  async refreshTokens(): Promise<boolean> {
    if (!this.refreshToken) return false;
    const r = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.refreshToken });
    if (!r.access_token) return false;
    const expiresAt = new Date(Date.now() + (r.expires_in || 3600) * 1000).toISOString();
    await setSetting('quickbooks', 'access_token', r.access_token);
    await setSetting('quickbooks', 'token_expires_at', expiresAt);
    if (r.refresh_token) { await setSetting('quickbooks', 'refresh_token', r.refresh_token); this.refreshToken = r.refresh_token; }
    this.accessToken = r.access_token;
    return true;
  }

  async disconnect(): Promise<void> {
    for (const k of ['access_token', 'refresh_token', 'realm_id', 'token_expires_at']) await setSetting('quickbooks', k, null);
    this.accessToken = null; this.refreshToken = null; this.realmId = null;
  }

  private async ensureValidToken(): Promise<void> {
    const expiresAt = await getSetting('quickbooks', 'token_expires_at');
    if (expiresAt && new Date(expiresAt).getTime() - 300000 < Date.now()) {
      if (!(await this.refreshTokens())) throw new Error('QuickBooks token expired and refresh failed — reconnect in Settings.');
    }
  }

  private baseUrl(): string { return (this.environment === 'sandbox' ? SAND_BASE : PROD_BASE) + '/' + this.realmId; }

  // Upload a file and link it to an entity (e.g. a Purchase) via the Attachable multipart endpoint.
  private async uploadAttachable(entityId: string, entityType: string, filePath: string, fileName: string, contentType: string): Promise<boolean> {
    await this.ensureValidToken();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    if (!fs.existsSync(filePath)) return false;
    const meta = {
      AttachableRef: [{ EntityRef: { type: entityType, value: entityId }, IncludeOnSend: true }],
      FileName: fileName, ContentType: contentType,
    };
    const form = new FormData();
    form.append('file_metadata_0', new Blob([JSON.stringify(meta)], { type: 'application/json' }), 'metadata.json');
    const buf = new Uint8Array(fs.readFileSync(filePath));
    form.append('file_content_0', new Blob([buf], { type: contentType }), fileName);
    const res = await fetch(this.baseUrl() + '/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.accessToken, Accept: 'application/json' },
      body: form as any,
    });
    const body = await res.text();
    if (res.status >= 400) { console.error('[QB attachable] HTTP', res.status, body.slice(0, 500)); return false; }
    return true;
  }

  private async apiGet(path: string): Promise<any> {
    await this.ensureValidToken();
    // Fail fast (12s) so a slow/hung QuickBooks doesn't hold the request open into a gateway timeout.
    const res = await fetch(this.baseUrl() + path, {
      headers: { Authorization: 'Bearer ' + this.accessToken, Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    const body = await res.text();
    if (res.status >= 400) throw new Error('QB API error (HTTP ' + res.status + '): ' + body.slice(0, 300));
    return JSON.parse(body);
  }

  private async apiPost(path: string, payload: any): Promise<any> {
    await this.ensureValidToken();
    const res = await fetch(this.baseUrl() + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.accessToken, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    if (res.status >= 400) {
      console.error('[QB apiPost] HTTP', res.status, 'path=', path);
      console.error('[QB apiPost] payload=', JSON.stringify(payload));
      console.error('[QB apiPost] response=', body.slice(0, 1500));
      const d = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      const errs = (d?.Fault?.Error || []).map((e: any) => `${e.Message || ''} — ${e.Detail || ''}`).join(' | ');
      throw new Error('QB API error (HTTP ' + res.status + '): ' + (errs || body.slice(0, 300)));
    }
    return JSON.parse(body);
  }

  async testConnection(): Promise<{ ok: boolean; name: string; error: string }> {
    if (!this.isConnected()) return { ok: false, name: '', error: 'Not connected to QuickBooks.' };
    try {
      const d = await this.apiGet('/companyinfo/' + this.realmId);
      const name = d?.CompanyInfo?.CompanyName || '';
      return name ? { ok: true, name, error: '' } : { ok: false, name: '', error: 'No company name returned.' };
    } catch (e: any) { return { ok: false, name: '', error: e.message }; }
  }

  private async query(sql: string): Promise<any> {
    return this.apiGet('/query?query=' + encodeURIComponent(sql) + '&minorversion=65');
  }

  async getCustomers(): Promise<any[]> {
    const d = await this.query('SELECT Id, DisplayName FROM Customer WHERE Active = true MAXRESULTS 1000');
    return d?.QueryResponse?.Customer || [];
  }

  async findCustomerByName(name: string): Promise<string | null> {
    const esc = (name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const d = await this.query(`SELECT Id, DisplayName FROM Customer WHERE DisplayName = '${esc}' MAXRESULTS 1`);
    const c = d?.QueryResponse?.Customer?.[0];
    return c ? String(c.Id) : null;
  }

  // Resolve a QB customer id for a portal customer: reuse an existing QB customer by name, else create.
  async findOrCreateCustomer(c: any): Promise<string> {
    const existing = await this.findCustomerByName(c.name || '');
    if (existing) return existing;
    return this.createQbCustomer(c);
  }

  async getItems(): Promise<any[]> {
    const d = await this.query('SELECT Id, Name, Type FROM Item WHERE Active = true MAXRESULTS 200');
    return d?.QueryResponse?.Item || [];
  }

  async getTaxCodes(): Promise<any[]> {
    const d = await this.query('SELECT Id, Name, Description FROM TaxCode MAXRESULTS 100');
    return d?.QueryResponse?.TaxCode || [];
  }

  async getIncomeAccounts(): Promise<any[]> {
    const d = await this.query("SELECT Id, Name FROM Account WHERE AccountType = 'Income' AND Active = true MAXRESULTS 50");
    return d?.QueryResponse?.Account || [];
  }

  // Cost-of-sales / expense accounts — the categories for the expense reconciliation.
  // Also surfaces director-loan accounts (liability type, e.g. "TOK Director Loan",
  // "NOK Director Loan") so expenses paid personally by a director can be categorised to them.
  async getExpenseAccounts(): Promise<any[]> {
    // Main category list. (QuickBooks' query language doesn't support parenthesised OR,
    // so the director-loan accounts are fetched separately and merged in below.)
    const d = await this.query("SELECT Id, Name, AccountType, AccountSubType FROM Account WHERE Active = true AND AccountType IN ('Expense','Cost of Goods Sold','Other Expense') MAXRESULTS 300");
    const accounts: any[] = d?.QueryResponse?.Account || [];
    // Director-loan accounts (liability type, e.g. "TOK Director Loan") — best-effort, never
    // let a failure here wipe the main list.
    try {
      const dl = await this.query("SELECT Id, Name, AccountType, AccountSubType FROM Account WHERE Active = true AND Name LIKE '%Director%' MAXRESULTS 50");
      for (const a of (dl?.QueryResponse?.Account || [])) { if (!accounts.some((x) => x.Id === a.Id)) accounts.push(a); }
    } catch { /* director query unsupported / failed — ignore */ }
    // Director-loan accounts sort to the bottom of the list, the rest stay alphabetical.
    return accounts.sort((a, b) => {
      const da = /director/i.test(a.Name) ? 1 : 0, db = /director/i.test(b.Name) ? 1 : 0;
      return da - db || String(a.Name).localeCompare(String(b.Name));
    });
  }

  // Bank / credit-card accounts — which account the expense was paid from.
  async getBankAccounts(): Promise<any[]> {
    const d = await this.query("SELECT Id, Name FROM Account WHERE Active = true AND AccountType IN ('Bank','Credit Card') MAXRESULTS 50");
    return d?.QueryResponse?.Account || [];
  }

  // Create a QuickBooks Purchase (expense) categorised to a COS/expense account.
  async createPurchase(p: { bankAccountId: string; expenseAccountId: string; amount: number; date: string; description?: string; payee?: string }): Promise<string> {
    const payload: any = {
      PaymentType: 'Cash',
      AccountRef: { value: p.bankAccountId },
      TxnDate: p.date,
      PrivateNote: p.payee || p.description || '',
      Line: [{
        Amount: Math.abs(p.amount),
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: p.description || '',
        AccountBasedExpenseLineDetail: { AccountRef: { value: p.expenseAccountId } },
      }],
    };
    const d = await this.apiPost('/purchase', payload);
    return d?.Purchase?.Id || '';
  }

  // Attach a file (receipt/invoice) to a Purchase via the Attachable multipart endpoint.
  async attachToPurchase(purchaseId: string, filePath: string, fileName: string, contentType: string): Promise<boolean> {
    return this.uploadAttachable(purchaseId, 'Purchase', filePath, fileName, contentType);
  }

  async findItemByName(name: string): Promise<string | null> {
    const esc = (name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const d = await this.query(`SELECT Id, Name FROM Item WHERE Name = '${esc}' MAXRESULTS 1`);
    const it = d?.QueryResponse?.Item?.[0];
    return it ? String(it.Id) : null;
  }

  // Create a Service item in QB. Returns the new QB Item Id. If an item with that name already
  // exists (QB names are globally unique), link to the existing one instead of failing.
  async createItem(name: string, incomeAccountId: string): Promise<string> {
    let d: any;
    try {
      d = await this.apiPost('/item', { Name: name, Type: 'Service', IncomeAccountRef: { value: incomeAccountId } });
    } catch (e: any) {
      if (/duplicate name/i.test(e.message || '')) {
        const existing = await this.findItemByName(name);
        if (existing) return existing;
      }
      throw e;
    }
    const id = d?.Item?.Id || '';
    if (!id) throw new Error('QuickBooks returned no item id for "' + name + '".');
    return id;
  }

  async createQbCustomer(c: any): Promise<string> {
    const payload: any = { DisplayName: c.name || '' };
    if (c.phone) payload.PrimaryPhone = { FreeFormNumber: c.phone };
    if (c.email) payload.PrimaryEmailAddr = { Address: c.email };
    if (c.website) payload.WebAddr = { URI: c.website };
    const d = await this.apiPost('/customer', payload);
    const id = d?.Customer?.Id || '';
    if (!id) throw new Error('QB returned no customer ID (name must be unique in QuickBooks).');
    return id;
  }

  // Build QB SalesItemLine[] from portal invoice items (throws if any line is unmapped).
  private async buildInvoiceLines(items: any[]): Promise<any[]> {
    if (!items || items.length === 0) throw new Error('Invoice has no line items to send to QuickBooks.');
    // VAT codes (QB tax-code IDs): standard for rated lines, zero code for 0%/exempt. Configurable.
    const stdCode = (await getSetting('quickbooks', 'tax_code_standard')) || '7'; // UK 20% (default 7)
    const zeroCode = (await getSetting('quickbooks', 'tax_code_zero')) || '';
    // Default QB items for source-based lines with no catalogue product (comms bill-run lines carry
    // no product_id — they post under one configured item, e.g. "Telecoms Services").
    const commsItem = (await getSetting('quickbooks', 'item_comms')) || '';
    const giacomItem = (await getSetting('quickbooks', 'item_giacom')) || '';
    const defItem = (await getSetting('quickbooks', 'item_default')) || '';
    // Per comms-category QB items (voice→Simply VoIP, mobile→Simply Mobile, etc.). Fall back to
    // the single comms item, then the global default.
    const catItems: Record<string, string> = {};
    for (const cat of ['voice', 'mobile', 'internet', 'additional', 'oneoff', 'call']) catItems[cat] = (await getSetting('quickbooks', 'item_cat_' + cat)) || '';
    const productMap: Record<number, string> = {};
    const ppids = items.map((i) => Number(i.product_id || 0)).filter(Boolean);
    if (ppids.length) {
      const pr = await pool.query(`SELECT id, quickbooks_item_id FROM asset_products WHERE id = ANY($1) AND quickbooks_item_id IS NOT NULL`, [ppids]);
      for (const row of pr.rows) productMap[row.id] = row.quickbooks_item_id;
    }
    // Giacom lines ALSO resolve by their Giacom CODE — the part of sync_ref before '|'. This is how
    // the staged audit matches, and it means: (a) a part-month catch-up line ("…|pro") resolves to the
    // SAME catalogue product as its base service, and (b) a service catalogued AFTER the invoice was
    // synced maps without needing a re-sync. Mirrors `itCloudStagedAudit`.
    const giacomCodeMap: Record<string, string> = {};
    const gCodes = Array.from(new Set(items
      .filter((i) => String(i.source || '') === 'giacom')
      .map((i) => String(i.sync_ref || '').split('|')[0].trim().toLowerCase())
      .filter(Boolean)));
    if (gCodes.length) {
      const cr = await pool.query(
        `SELECT lower(code) AS code, quickbooks_item_id FROM asset_products
          WHERE source_tag='giacom' AND is_active=true AND quickbooks_item_id IS NOT NULL AND lower(code) = ANY($1)`, [gCodes]);
      for (const row of cr.rows) giacomCodeMap[row.code] = row.quickbooks_item_id;
    }
    // SELF-HEAL: a comms/call line with no configured (or catalogue) QB item gets its category item
    // auto-created in QuickBooks (Simply VoIP / Simply Mobile / …) and mapped — so the push never
    // fails on unmapped comms lines and Terry needn't pre-create them.
    const catName: Record<string, string> = { voice: 'Simply VoIP', mobile: 'Simply Mobile', internet: 'Broadband & Connectivity', additional: 'Additional Services', oneoff: 'One-off Charges', call: 'Call Charges' };
    const needCats = new Set<string>();
    for (const it of items) {
      const src = String(it.source || '');
      if (src !== 'comms' && src !== 'calls') continue;
      if (productMap[Number(it.product_id)]) continue;
      const cat = String(it.invoice_category || '') || 'additional';
      if (!catItems[cat] && !commsItem && !defItem) needCats.add(cat);
    }
    if (needCats.size) {
      let incomeId = '';
      try { const accts = await this.getIncomeAccounts(); incomeId = accts[0]?.Id || ''; } catch { /* ignore */ }
      if (incomeId) {
        for (const cat of needCats) {
          try { const idv = await this.createItem(catName[cat] || ('Comms — ' + cat), incomeId); catItems[cat] = idv; await setSetting('quickbooks', 'item_cat_' + cat, idv); }
          catch { /* leave unmapped → reported below */ }
        }
      }
    }
    const lineQbItem = (it: any): string => {
      const src = String(it.source || '');
      if (src === 'comms' || src === 'calls') return catItems[String(it.invoice_category || '') || 'additional'] || commsItem || defItem;
      if (src === 'giacom') return giacomItem || defItem;
      return defItem;
    };

    const unmapped: string[] = []; const noVat: string[] = [];
    const lines = items.map((it) => {
      const qty = Number(it.quantity) || 1, price = Number(it.unit_price) || 0;
      // Resolve the QB item for the sync only (never written back to the invoice):
      //   1. the line's stamped catalogue product, then
      //   2. its Giacom code (covers part-month '…|pro' lines + services catalogued after sync), then
      //   3. the configured default item for this line's category/source.
      const baseCode = String(it.source || '') === 'giacom' ? String(it.sync_ref || '').split('|')[0].trim().toLowerCase() : '';
      const qbItem = productMap[Number(it.product_id)] || (baseCode ? giacomCodeMap[baseCode] : '') || lineQbItem(it);
      if (!qbItem) unmapped.push(it.description || '(no description)');
      const isZero = !(Number(it.tax_rate) > 0);
      if (isZero && !zeroCode) noVat.push(it.description || '(no description)');
      return {
        DetailType: 'SalesItemLineDetail',
        Amount: Math.round(qty * price * 100) / 100,
        Description: it.description || '',
        SalesItemLineDetail: { ItemRef: { value: qbItem || '' }, UnitPrice: price, Qty: qty, TaxCodeRef: { value: isZero ? zeroCode : stdCode } },
      };
    });
    if (unmapped.length) {
      throw new Error('These lines have no QuickBooks item: ' + unmapped.join('; ')
        + '. Map the catalogue product (Products → QuickBooks) OR set a default item for the source in Settings → QuickBooks (e.g. a "Telecoms Services" item for comms).');
    }
    if (noVat.length) {
      throw new Error('Zero/exempt-VAT lines need a QuickBooks zero-rate tax code set in Settings → QuickBooks: ' + noVat.join('; '));
    }
    return lines;
  }
  private fmtDate(d: any): string { return d ? new Date(d).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10); }

  // Create a portal invoice in QB. Customer must have quickbooks_customer_id.
  async pushInvoice(invoice: any, items: any[], qbCustomerId: string): Promise<string> {
    const lines = await this.buildInvoiceLines(items);
    const d = await this.apiPost('/invoice', {
      CustomerRef: { value: qbCustomerId }, DocNumber: invoice.invoice_number || '',
      TxnDate: this.fmtDate(invoice.issue_date), DueDate: this.fmtDate(invoice.due_date),
      GlobalTaxCalculation: 'TaxExcluded', Line: lines,
    });
    const id = d?.Invoice?.Id || '';
    if (!id) throw new Error('QB returned no invoice ID — check item mapping in Settings → QuickBooks.');
    return id;
  }

  // Amend an existing QB invoice (sync portal edits). Reads the current SyncToken first.
  async updateInvoice(invoice: any, items: any[], qbCustomerId: string, qbInvoiceId: string): Promise<string> {
    const cur = await this.apiGet('/invoice/' + qbInvoiceId);
    const syncToken = cur?.Invoice?.SyncToken;
    if (syncToken === undefined || syncToken === null) throw new Error('Could not read the QuickBooks invoice to amend (it may have been deleted in QB).');
    const lines = await this.buildInvoiceLines(items);
    const d = await this.apiPost('/invoice', {
      Id: qbInvoiceId, SyncToken: syncToken, sparse: true,
      CustomerRef: { value: qbCustomerId }, DocNumber: invoice.invoice_number || '',
      TxnDate: this.fmtDate(invoice.issue_date), DueDate: this.fmtDate(invoice.due_date),
      GlobalTaxCalculation: 'TaxExcluded', Line: lines,
    });
    return d?.Invoice?.Id || qbInvoiceId;
  }

  // Read-only reconciliation: pull every invoice from QuickBooks and report which ones
  // are NOT yet in the portal (matched by DocNumber → invoice_number). Existence check
  // only — no import, no payment status. Optional { since, until } window by TxnDate.
  async reconcileInvoices(opts: { since?: string; until?: string } = {}): Promise<{
    qbTotal: number; matched: number; missing: { doc: string; date: string; amount: number; customer: string }[];
  }> {
    const portal = new Set(
      (await pool.query('SELECT invoice_number FROM invoices WHERE deleted_at IS NULL')).rows.map((r: any) => String(r.invoice_number))
    );
    const conds: string[] = [];
    if (opts.since) conds.push(`TxnDate >= '${opts.since.replace(/[^0-9-]/g, '')}'`);
    if (opts.until) conds.push(`TxnDate <= '${opts.until.replace(/[^0-9-]/g, '')}'`);
    const whereSql = conds.length ? ' WHERE ' + conds.join(' AND ') : '';

    let qbTotal = 0, matched = 0, start = 1;
    const missing: { doc: string; date: string; amount: number; customer: string }[] = [];
    for (;;) {
      const d = await this.query(`SELECT Id, DocNumber, TxnDate, TotalAmt, CustomerRef FROM Invoice${whereSql} ORDER BY TxnDate STARTPOSITION ${start} MAXRESULTS 100`);
      const invs: any[] = d?.QueryResponse?.Invoice || [];
      if (invs.length === 0) break;
      for (const qi of invs) {
        qbTotal++;
        const doc = qi.DocNumber || ('QB-' + qi.Id);
        if (portal.has(doc)) matched++;
        else missing.push({ doc, date: qi.TxnDate || '', amount: Number(qi.TotalAmt || 0), customer: qi.CustomerRef?.name || '' });
      }
      start += invs.length;
      if (invs.length < 100) break;
    }
    return { qbTotal, matched, missing };
  }

  // Sync payment state FROM QuickBooks into existing portal invoices (the bookkeeper
  // marks invoices paid in QB; the portal just reflects it). Matches by DocNumber →
  // invoice_number; updates balance, payment_status and status. Does NOT create invoices.
  async syncPayments(opts: { since?: string; until?: string } = {}): Promise<{ checked: number; updated: number }> {
    const conds: string[] = [];
    if (opts.since) conds.push(`TxnDate >= '${opts.since.replace(/[^0-9-]/g, '')}'`);
    if (opts.until) conds.push(`TxnDate <= '${opts.until.replace(/[^0-9-]/g, '')}'`);
    const whereSql = conds.length ? ' WHERE ' + conds.join(' AND ') : '';

    let checked = 0, updated = 0, start = 1;
    for (;;) {
      const d = await this.query(`SELECT Id, DocNumber, TotalAmt, Balance FROM Invoice${whereSql} ORDER BY TxnDate STARTPOSITION ${start} MAXRESULTS 100`);
      const invs: any[] = d?.QueryResponse?.Invoice || [];
      if (invs.length === 0) break;
      for (const qi of invs) {
        checked++;
        const doc = qi.DocNumber || ('QB-' + qi.Id);
        const total = Number(qi.TotalAmt || 0);
        const balance = Number(qi.Balance ?? total);
        const payStatus = balance <= 0 ? 'paid' : (balance < total ? 'pending' : 'unpaid');
        // Only touch invoices that exist in the portal; don't override draft/void.
        const r = await pool.query(
          `UPDATE invoices SET balance=$1::numeric, payment_status=$2,
             status = CASE WHEN status IN ('draft','void') THEN status WHEN $1::numeric <= 0 THEN 'paid' ELSE 'issued' END,
             quickbooks_invoice_id = COALESCE(quickbooks_invoice_id, $3),
             payment_synced_at = NOW()
           WHERE invoice_number = $4 AND deleted_at IS NULL`,
          [balance.toFixed(2), payStatus, String(qi.Id), doc]
        );
        if (r.rowCount) updated += r.rowCount;
      }
      start += invs.length;
      if (invs.length < 100) break;
    }
    return { checked, updated };
  }

  // Raise a Credit Memo in QB (for an overpayment / goodwill credit). Hangs the credit
  // on a QB item — a configured 'credit_item_id' setting, else the first available item.
  async pushCreditMemo(qbCustomerId: string, amount: number, description: string): Promise<string> {
    let itemId = (await getSetting('quickbooks', 'credit_item_id')) || '';
    if (!itemId) { const items = await this.getItems(); itemId = items[0]?.Id || ''; }
    if (!itemId) throw new Error('No QuickBooks item available for the credit note — match at least one item in Settings → QuickBooks first.');
    const d = await this.apiPost('/creditmemo', {
      CustomerRef: { value: qbCustomerId },
      GlobalTaxCalculation: 'TaxExcluded',
      Line: [{
        DetailType: 'SalesItemLineDetail',
        Amount: Math.round(amount * 100) / 100,
        Description: description || 'Customer credit',
        SalesItemLineDetail: { ItemRef: { value: itemId }, UnitPrice: amount, Qty: 1, TaxCodeRef: { value: '7' } },
      }],
    });
    const id = d?.CreditMemo?.Id || '';
    if (!id) throw new Error('QuickBooks returned no credit memo id.');
    return id;
  }

  // Import invoices FROM QuickBooks into the portal (upsert by quickbooks_invoice_id).
  // Pass { since, until } (YYYY-MM-DD) to back-fill a specific window by transaction date.
  async importInvoices(opts: { since?: string; until?: string } = {}): Promise<{ imported: number; skipped: number }> {
    let imported = 0, skipped = 0, start = 1;
    // portal customers keyed by their quickbooks_customer_id
    const custRows = (await pool.query(`SELECT id, quickbooks_customer_id FROM customers WHERE quickbooks_customer_id IS NOT NULL`)).rows;
    const custByQb: Record<string, number> = {};
    for (const c of custRows) custByQb[String(c.quickbooks_customer_id)] = c.id;

    const conds: string[] = [];
    if (opts.since) conds.push(`TxnDate >= '${opts.since.replace(/[^0-9-]/g, '')}'`);
    if (opts.until) conds.push(`TxnDate <= '${opts.until.replace(/[^0-9-]/g, '')}'`);
    const whereSql = conds.length ? ' WHERE ' + conds.join(' AND ') : '';

    for (;;) {
      const d = await this.query(`SELECT * FROM Invoice${whereSql} ORDER BY MetaData.CreateTime STARTPOSITION ${start} MAXRESULTS 100`);
      const invs: any[] = d?.QueryResponse?.Invoice || [];
      if (invs.length === 0) break;
      for (const qi of invs) {
        const qbId = String(qi.Id);
        const customerId = custByQb[String(qi.CustomerRef?.value)] ?? null;
        const total = Number(qi.TotalAmt || 0);
        const tax = Number(qi.TxnTaxDetail?.TotalTax || 0);
        const balance = Number(qi.Balance ?? total);
        const status = balance <= 0 ? 'paid' : 'issued';
        const payStatus = balance <= 0 ? 'paid' : 'unpaid';
        const number = qi.DocNumber || ('QB-' + qbId);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const up = await client.query(
            `INSERT INTO invoices (customer_id, quickbooks_invoice_id, invoice_number, title, status, payment_status,
               issue_date, due_date, subtotal, tax_total, total, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
             ON CONFLICT (invoice_number) DO UPDATE SET
               quickbooks_invoice_id=EXCLUDED.quickbooks_invoice_id, status=EXCLUDED.status,
               payment_status=EXCLUDED.payment_status, issue_date=EXCLUDED.issue_date, due_date=EXCLUDED.due_date,
               subtotal=EXCLUDED.subtotal, tax_total=EXCLUDED.tax_total, total=EXCLUDED.total,
               customer_id=COALESCE(invoices.customer_id, EXCLUDED.customer_id), updated_at=NOW()
             RETURNING id`,
            [customerId, qbId, number, 'Imported from QuickBooks', status, payStatus,
             qi.TxnDate || null, qi.DueDate || null, (total - tax).toFixed(2), tax.toFixed(2), total.toFixed(2)]
          );
          const invId = up.rows[0].id;
          await client.query('DELETE FROM invoice_items WHERE invoice_id=$1', [invId]);
          let sort = 1;
          for (const ln of (qi.Line || [])) {
            if (ln.DetailType !== 'SalesItemLineDetail') continue;
            const sd = ln.SalesItemLineDetail || {};
            const qty = Number(sd.Qty || 1), price = Number(sd.UnitPrice ?? ln.Amount ?? 0);
            await client.query(
              `INSERT INTO invoice_items (invoice_id, sort_order, description, quantity, unit_price, tax_rate, line_total)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`,
              [invId, sort++, ln.Description || '', qty, price, 20, Number(ln.Amount || 0)]
            );
          }
          await client.query('COMMIT');
          imported++;
        } catch (e) { await client.query('ROLLBACK'); console.error('QB import invoice failed:', e); skipped++; }
        finally { client.release(); }
      }
      start += invs.length;
      if (invs.length < 100) break;
    }
    return { imported, skipped };
  }
}

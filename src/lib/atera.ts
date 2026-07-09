import { config } from '../config';
import { getGroup, getSetting } from './settings';

// Atera RMM/PSA integration. Read-only pulls of customers, contacts and tickets.
// Auth: X-API-KEY header. v3 paginates with ?page=N&itemsInPage=M and returns
// { items, page, itemsInPage, totalPages, totalItemCount }. Key stored in settings
// group 'atera' (manageable in the UI), with an env fallback.

const DEFAULT_BASE = 'https://app.atera.com/api/v3';

export class Atera {
  apiKey = config.ATERA_API_KEY;
  baseUrl = DEFAULT_BASE;

  static async load(): Promise<Atera> {
    const a = new Atera();
    const cfg = await getGroup('atera');
    if (cfg.api_key) a.apiKey = cfg.api_key;
    if (cfg.base_url) a.baseUrl = cfg.base_url.replace(/\/+$/, '');
    return a;
  }

  hasKey(): boolean { return !!this.apiKey; }

  private async get(path: string): Promise<any> {
    if (!this.apiKey) throw new Error('Atera API key not set — add it in Settings → Integrations.');
    const res = await fetch(this.baseUrl + path, {
      headers: { 'X-API-KEY': this.apiKey, Accept: 'application/json' },
    });
    const text = await res.text();
    if (res.status >= 400) throw new Error('Atera API error (HTTP ' + res.status + '): ' + text.slice(0, 300));
    try { return JSON.parse(text); } catch { return {}; }
  }

  // Walk all pages of a v3 list endpoint, returning the flattened items.
  private async getAll(path: string, maxPages = 200): Promise<any[]> {
    const out: any[] = [];
    let page = 1;
    for (;;) {
      const sep = path.includes('?') ? '&' : '?';
      const d = await this.get(`${path}${sep}page=${page}&itemsInPage=50`);
      const items: any[] = d?.items || d?.Items || [];
      out.push(...items);
      const totalPages = Number(d?.totalPages ?? d?.TotalPages ?? 1);
      if (items.length === 0 || page >= totalPages || page >= maxPages) break;
      page++;
    }
    return out;
  }

  async testConnection(): Promise<{ ok: boolean; count?: number; error?: string }> {
    try {
      const d = await this.get('/customers?page=1&itemsInPage=1');
      return { ok: true, count: Number(d?.totalItemCount ?? d?.TotalItemCount ?? 0) };
    } catch (e: any) { return { ok: false, error: e.message }; }
  }

  getCustomers(): Promise<any[]> { return this.getAll('/customers'); }
  getContacts(): Promise<any[]> { return this.getAll('/contacts'); }
  // Full comment thread for a ticket (the whole case history).
  getTicketComments(ticketId: string): Promise<any[]> {
    return this.getAll(`/tickets/${encodeURIComponent(ticketId)}/comments`, 50);
  }
  // status: an Atera ticketStatus value (e.g. 'Open', 'Closed', 'Resolved'); omit for all.
  // maxPages caps the pull (50 tickets/page) — keep small for a quick preview sample.
  getTickets(status?: string, maxPages = 2000): Promise<any[]> {
    return this.getAll(status ? `/tickets?ticketStatus=${encodeURIComponent(status)}` : '/tickets', maxPages);
  }
  // Fast total without pulling everything (reads the API's totalItemCount).
  async ticketCount(): Promise<number> {
    const d = await this.get('/tickets?page=1&itemsInPage=1');
    return Number(d?.totalItemCount ?? d?.TotalItemCount ?? 0);
  }
  // Fast per-status total (for accurate preview tab counts). Resilient — 0 on any error.
  async ticketCountByStatus(status: string): Promise<number> {
    try {
      const d = await this.get(`/tickets?ticketStatus=${encodeURIComponent(status)}&page=1&itemsInPage=1`);
      return Number(d?.totalItemCount ?? d?.TotalItemCount ?? 0);
    } catch { return 0; }
  }
}

// A ticket that Atera considers deleted / archived / merged — we never import or count these.
export function isAteraDeleted(t: any): boolean {
  const s = String(t?.TicketStatus ?? t?.Status ?? '').toLowerCase();
  if (/\b(deleted|trash|archived|spam|merged|merge)\b/.test(s)) return true;
  if (t?.IsDeleted === true || t?.Deleted === true || t?.isDeleted === true) return true;
  // Merged tickets carry a reference to the ticket they were merged into.
  if (t?.IsMerged === true || t?.Merged === true) return true;
  const mergedInto = t?.MergedToTicketID ?? t?.MergedToTicketId ?? t?.MergedIntoTicketID ?? t?.ParentTicketID;
  return mergedInto != null && String(mergedInto) !== '' && String(mergedInto) !== '0';
}

// Pull the first non-empty value across a list of possible Atera field names.
export function pick(row: any, names: string[]): string {
  for (const n of names) { const v = row?.[n]; if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim(); }
  return '';
}

export async function ateraConfigured(): Promise<boolean> {
  return !!(await getSetting('atera', 'api_key')) || !!config.ATERA_API_KEY;
}

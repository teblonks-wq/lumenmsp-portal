/**
 * Tollring iCall Suite API Client
 * Docs: Tollring_APIs_Broadworks_v3.7
 */

export interface TollringCallRecord {
  RecordId:            number;
  Extno:               string;
  Call_date:           string;
  Number:              string;
  Port:                string;
  Ring_time:           number;
  Duration:            number;
  Direction:           string;
  Unanswer:            string;
  CallId:              string;
  Group_no:            string;
  Call_outcome:        number;
  Call_legId:          number;
  LegID:               string;
  PreviousLegID:       string;
  Call_legs:           number;
  GroupPosition:       number;
  firstGroupRingpoint: number;
  waitTime:            number | null;
  totalDuration:       number | null;
}

export interface TollringResult {
  ErrorCode:   string;
  Description: string;
}

export interface TollringResponse<T> {
  Data:   T[];
  Result: TollringResult;
}

export function outcomeFromCode(code: number): string {
  const map: Record<number, string> = {
    0: 'Answered', 1: 'Transferred', 2: 'Missed', 3: 'Bounced',
    4: 'Answered', 5: 'Missed', 6: 'Answered', 7: 'Answered', 8: 'Overflowed',
  };
  return map[code] ?? 'Unknown';
}

/**
 * Per-leg Answered/Missed from the authoritative raw fields, not the opaque
 * Call_outcome code (which is a 3-digit scheme that doesn't match outcomeFromCode).
 * Confirmed against Larkmead data 2026-06-05: Tollring's `Unanswer` flag is '0'
 * when the leg was answered and '1' when it rang out, and talk time (Duration > 0)
 * confirms a connect. A leg is answered if Unanswer is '0' OR it has talk time.
 */
export function outcomeFromRecord(r: { Unanswer?: string | number | null; Duration?: number | null }): string {
  const unanswer = String(r.Unanswer ?? '').trim();
  const answered = unanswer === '0' || (Number(r.Duration) || 0) > 0;
  return answered ? 'Answered' : 'Missed';
}

const tokenChains = new Map<string, Promise<void>>();
const tokenLastAt = new Map<string, number>();

function gateForToken(key: string, minIntervalMs: number): Promise<void> {
  const prev = tokenChains.get(key) ?? Promise.resolve();
  const next = prev.then(async () => {
    const since = Date.now() - (tokenLastAt.get(key) ?? 0);
    if (since < minIntervalMs) {
      await new Promise(r => setTimeout(r, minIntervalMs - since));
    }
    tokenLastAt.set(key, Date.now());
  });
  tokenChains.set(key, next.catch(() => {}));
  return next;
}

export class TollringClient {
  private baseUrl:  string;
  private token:    string;
  private username: string;
  private minIntervalMs: number;
  private gateKey:  string;

  constructor(baseUrl: string, token: string, username = '', minIntervalMs = 6000) {
    this.baseUrl       = baseUrl.replace(/\/$/, '');
    this.token         = token;
    this.username      = username;
    this.minIntervalMs = minIntervalMs;
    this.gateKey       = `${this.baseUrl}|${this.token}`;
  }

  private throttle(): Promise<void> {
    return gateForToken(this.gateKey, this.minIntervalMs);
  }

  private authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.username}:${this.token}`).toString('base64');
  }

  // fetch with a hard per-request timeout so a stalled socket can never hang the
  // caller indefinitely (a request that never returns would otherwise freeze the
  // page that awaited it). Default 30s per HTTP call.
  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 30000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<T>(endpoint: string, body: Record<string, unknown>): Promise<TollringResponse<T>> {
    const url = `${this.baseUrl}/api/v3/${endpoint}`;
    const maxAttempts = 6;
    for (let attempt = 1; ; attempt++) {
      await this.throttle();
      const res = await this.fetchWithTimeout(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': this.authHeader() },
        body:    JSON.stringify(body),
      });
      if (res.ok) {
        return res.json() as Promise<TollringResponse<T>>;
      }
      const text = await res.text();
      if (text.includes('0x1009') && attempt < maxAttempts) {
        // Escalating backoff — Tollring tightens the gate under sustained load,
        // so a flat 6s isn't always enough. Wait 6s, 12s, 18s, 24s, 30s.
        await new Promise(r => setTimeout(r, this.minIntervalMs * attempt));
        continue;
      }
      throw new Error(`Tollring ${endpoint} HTTP ${res.status}: ${text}`);
    }
  }

  async getCallsByCLI(params: { cli: string; startDate: string; endDate: string; groups?: string; ddis?: string }): Promise<TollringCallRecord[]> {
    const all: TollringCallRecord[] = [];
    let startRecordId: number | undefined;
    while (true) {
      const body: Record<string, unknown> = { CLI: params.cli, StartDate: params.startDate, EndDate: params.endDate };
      if (params.groups)  body.Groups        = params.groups;
      if (params.ddis)    body.DDIs          = params.ddis;
      if (startRecordId)  body.StartRecordId = startRecordId;
      const resp = await this.post<TollringCallRecord>('GetCallsByCLI', body);
      if (resp.Result.ErrorCode !== '0x0000') throw new Error(`GetCallsByCLI: ${resp.Result.Description}`);
      all.push(...resp.Data);
      if (resp.Data.length < 1000) break;
      startRecordId = resp.Data[resp.Data.length - 1].RecordId + 1;
    }
    return all;
  }

  async getCallsByDate(params: { startDate: string; endDate: string; groups?: string; ddis?: string; directions?: string; minDuration?: number }): Promise<TollringCallRecord[]> {
    // Tollring caps GetCallsByDate at 1000 rows per call and returns them in
    // DATE order (which is why the old StartRecordId paging overlapped and every
    // window truncated to its first 1000). So we page by TIME: fetch up to 1000
    // from the cursor, then advance the cursor to the last row's Call_date and
    // fetch again, until a page comes back short (= end of range reached).
    // The boundary row re-appears each step but DB-side dedup (record_id) drops it.
    const toMs  = (d: string) => Date.parse(d.replace(' ', 'T') + 'Z');
    const fmtMs = (ms: number) => new Date(ms).toISOString().replace('T', ' ').substring(0, 19);
    const endMs = toMs(params.endDate);

    const all: TollringCallRecord[] = [];
    let cursorMs = toMs(params.startDate);
    let guard = 0;

    while (true) {
      const page = await this.fetchDatePage(params, fmtMs(cursorMs), params.endDate);
      all.push(...page);
      if (page.length < 1000) break; // fewer than the cap → we've reached the end

      // Advance to the latest Call_date in this page (results are date-ordered).
      let maxMs = -Infinity;
      for (const r of page) {
        const t = toMs(String(r.Call_date));
        if (Number.isFinite(t) && t > maxMs) maxMs = t;
      }
      // If the whole page sits at one instant (>1000 rows in the same second) the
      // cursor can't advance — nudge 1s to avoid an infinite loop. Vanishingly
      // unlikely in practice; warn so we'd notice if it ever happens.
      if (!Number.isFinite(maxMs) || maxMs <= cursorMs) {
        console.warn(`[tollring] >1000 rows at ${fmtMs(cursorMs)}; nudging cursor 1s (possible truncation)`);
        maxMs = cursorMs + 1000;
      }
      if (maxMs >= endMs) break;
      cursorMs = maxMs;
      if (++guard > 200000) throw new Error('GetCallsByDate time-paging guard tripped');
    }
    return all;
  }

  private async fetchDatePage(
    params: { groups?: string; ddis?: string; directions?: string; minDuration?: number },
    startDate: string,
    endDate: string,
  ): Promise<TollringCallRecord[]> {
    const body: Record<string, unknown> = { StartDate: startDate, EndDate: endDate };
    if (params.groups)      body.Groups          = params.groups;
    if (params.ddis)        body.DDIs            = params.ddis;
    if (params.directions)  body.Directions      = params.directions;
    if (params.minDuration) body.MinCallDuration = params.minDuration;
    const resp = await this.post<TollringCallRecord>('GetCallsByDate', body);
    if (resp.Result.ErrorCode !== '0x0000') throw new Error(`GetCallsByDate: ${resp.Result.Description}`);
    return resp.Data;
  }

  async pingVerbose(): Promise<{ ok: boolean; detail: string }> {
    const now = new Date();
    const start = new Date(now.getTime() - 3600000);
    const fmt = (d: Date) => d.toISOString().replace('T', ' ').substring(0, 19);
    try {
      await this.throttle();
      const res = await this.fetchWithTimeout(`${this.baseUrl}/api/v3/GetCallsByDate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': this.authHeader() },
        body: JSON.stringify({ StartDate: fmt(start), EndDate: fmt(now) }),
      }, 15000);
      const text = await res.text();
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${text.substring(0, 200)}` };
      try {
        const json = JSON.parse(text);
        const code = json?.Result?.ErrorCode;
        return (code === '0x0000' || code === undefined)
          ? { ok: true, detail: 'OK' }
          : { ok: false, detail: `API error ${code}: ${json?.Result?.Description}` };
      } catch {
        return { ok: true, detail: 'OK' };
      }
    } catch (err: any) {
      return { ok: false, detail: err.message || 'Network error' };
    }
  }

  async ping(): Promise<boolean> {
    return (await this.pingVerbose()).ok;
  }
}

export function clientFromCustomer(row: {
  icalls_api_url?:      string | null;
  icalls_api_token?:    string | null;
  icalls_api_username?: string | null;
}): TollringClient | null {
  if (!row.icalls_api_url || !row.icalls_api_token) return null;
  return new TollringClient(row.icalls_api_url, row.icalls_api_token, row.icalls_api_username || '');
}

import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';
import { logActivity } from '../lib/activity';
import { getSetting, setSetting } from '../lib/settings';
import { Atera, pick, isAteraDeleted } from '../lib/atera';
import { loadStatusMap, saveStatusMap, mapStatus, PORTAL_STATUSES, PORTAL_DEPARTMENTS, StatusTarget } from '../lib/atera-status';
import { cleanInboundEmail } from '../lib/sanitize';

const router = Router();
router.use('/settings/atera', requireAuth, requireAdmin);

const nz = (v: any): string | null => { const s = (v ?? '').toString().trim(); return s !== '' ? s : null; };
const normDomain = (d: string): string => (d || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').trim().toLowerCase();

// ── Atera field extractors ───────────────────────────────────────────────────────
function ateraCustomer(r: any) {
  return {
    ateraId: pick(r, ['CustomerID', 'CustomerId', 'id']),
    name: pick(r, ['CustomerName', 'Name']),
    address: pick(r, ['Address', 'Address1', 'Street']),
    city: pick(r, ['City']),
    postcode: pick(r, ['ZipCode', 'Zip', 'PostalCode']),
    country: pick(r, ['Country']) || 'United Kingdom',
    phone: pick(r, ['Phone', 'PhoneNumber']),
    domain: normDomain(pick(r, ['Domain', 'Website'])),
  };
}
function ateraContact(r: any) {
  const first = pick(r, ['Firstname', 'FirstName']);
  const last = pick(r, ['Lastname', 'LastName']);
  const full = (first + ' ' + last).trim() || pick(r, ['DisplayName', 'ContactName', 'Name']);
  return {
    ateraId: pick(r, ['EndUserID', 'ContactID', 'id']),
    customerAteraId: pick(r, ['CustomerID', 'customerId']),
    fullName: full,
    email: pick(r, ['Email']),
    phone: pick(r, ['Phone']),
    mobile: pick(r, ['MobilePhone', 'Mobile']),
    jobTitle: pick(r, ['JobTitle']),
    department: pick(r, ['Department']),
    isPrimary: !!(r?.IsContactPerson || r?.IsPrimary || r?.is_primary),
  };
}

// ── Save key / test ──────────────────────────────────────────────────────────────
router.post('/settings/atera/save', async (req: Request, res: Response) => {
  const key = String(req.body.api_key || '').trim();
  if (key) await setSetting('atera', 'api_key', key);
  if (req.body.base_url !== undefined) await setSetting('atera', 'base_url', String(req.body.base_url || '').trim());
  res.redirect('/settings/integrations?msg=Atera+saved');
});

router.post('/settings/atera/test', async (req: Request, res: Response) => {
  const a = await Atera.load();
  const r = await a.testConnection();
  res.redirect('/settings/integrations?msg=' + encodeURIComponent(r.ok ? `Atera connected — ${r.count} customers visible` : 'Atera test failed: ' + r.error));
});

// ── Status MAP editor ──────────────────────────────────────────────────────────────
router.get('/settings/atera/status-map', async (req: Request, res: Response) => {
  const map = await loadStatusMap();
  res.render('settings/atera-status', {
    user: req.session.user!, map, statuses: PORTAL_STATUSES, departments: PORTAL_DEPARTMENTS,
    notice: req.query.msg || null,
  });
});
router.post('/settings/atera/status-map', async (req: Request, res: Response) => {
  const keys: string[] = ([] as string[]).concat(req.body.atera || []);
  const statuses: string[] = ([] as string[]).concat(req.body.status || []);
  const stages: string[] = ([] as string[]).concat(req.body.stage || []);
  const depts: string[] = ([] as string[]).concat(req.body.department || []);
  const map: Record<string, StatusTarget> = {};
  for (let i = 0; i < keys.length; i++) {
    const k = (keys[i] || '').toLowerCase().trim();
    if (!k) continue;
    map[k] = { status: statuses[i] || 'open', stage: (stages[i] || 'in_progress').trim(), department: depts[i] || 'support' };
  }
  // Add a new row if provided.
  const nk = String(req.body.new_atera || '').toLowerCase().trim();
  if (nk) map[nk] = { status: String(req.body.new_status || 'open'), stage: String(req.body.new_stage || 'in_progress'), department: String(req.body.new_department || 'support') };
  await saveStatusMap(map);
  await logActivity(req.session.user!.id, 'updated', 'settings', null, 'Atera status map updated');
  res.redirect('/settings/atera/status-map?msg=' + encodeURIComponent('Status map saved'));
});

// ── Clients & contacts review (pull + diff, nothing applied) ───────────────────────
router.get('/settings/atera/review', async (req: Request, res: Response) => {
  const a = await Atera.load();
  if (!a.hasKey()) { res.redirect('/settings/integrations?err=' + encodeURIComponent('Set the Atera API key first.')); return; }
  let aCustomers: any[] = [], aContacts: any[] = [];
  try { [aCustomers, aContacts] = await Promise.all([a.getCustomers(), a.getContacts()]); }
  catch (e: any) { res.redirect('/settings/integrations?err=' + encodeURIComponent('Atera pull failed: ' + e.message)); return; }

  // Existing portal state
  const extRows = (await pool.query("SELECT external_id, customer_id FROM customer_external_ids WHERE source_system='atera'")).rows;
  const custByAtera = new Map<string, number>(); extRows.forEach((r: any) => custByAtera.set(String(r.external_id), r.customer_id));
  const portalCusts = (await pool.query("SELECT id, lower(name) AS lname, name, phone, domain FROM customers WHERE deleted_at IS NULL AND is_placeholder=false")).rows;
  const byName = new Map<string, any>(); portalCusts.forEach((c: any) => byName.set(c.lname, c));
  const ignored = new Set(((await getSetting('atera', 'ignored_customers')) || '').split(',').map((s) => s.trim()).filter(Boolean));
  const customers = portalCusts.map((p: any) => ({ id: p.id, name: p.name })).sort((a: any, b: any) => a.name.localeCompare(b.name));

  const newClients: any[] = []; const fillClients: any[] = []; const ignoredClients: any[] = [];
  for (const raw of aCustomers) {
    const c = ateraCustomer(raw);
    if (!c.ateraId || !c.name) continue;
    const pc: any = custByAtera.has(c.ateraId) ? portalCusts.find((p: any) => p.id === custByAtera.get(c.ateraId)) : byName.get(c.name.toLowerCase());
    if (!pc) { if (ignored.has(c.ateraId)) ignoredClients.push(c); else newClients.push(c); continue; }
    // Existing → only offer to fill blanks (never overwrite).
    const fills: Record<string, string> = {};
    if (!pc.phone && c.phone) fills.phone = c.phone;
    if (!pc.domain && c.domain) fills.domain = c.domain;
    if (Object.keys(fills).length) fillClients.push({ customerId: pc.id, name: pc.name, ateraId: c.ateraId, fills });
  }

  // Contacts: resolve to a portal customer (existing or one we'd create).
  const newAteraCustIds = new Set(newClients.map((c) => c.ateraId));
  const contactsByCustAtera = new Map<string, number>(); // atera cust id -> portal cust id (existing)
  custByAtera.forEach((cid, aid) => contactsByCustAtera.set(aid, cid));
  // Also map by name for existing
  const existContacts = (await pool.query(`SELECT cc.customer_id, lower(cc.email) AS email, lower(cc.full_name) AS fname, cc.atera_contact_id
                                            FROM customer_contacts cc`)).rows;
  const haveContact = new Set<string>();
  const haveAteraContact = new Set<string>();
  existContacts.forEach((c: any) => { if (c.atera_contact_id) haveAteraContact.add(String(c.atera_contact_id)); haveContact.add(c.customer_id + '|' + (c.email || '')); haveContact.add(c.customer_id + '|n|' + (c.fname || '')); });

  const newContacts: any[] = [];
  for (const raw of aContacts) {
    const c = ateraContact(raw);
    if (!c.ateraId || !c.fullName) continue;
    if (haveAteraContact.has(c.ateraId)) continue;
    const portalCustId = contactsByCustAtera.get(c.customerAteraId);
    const intoNewClient = newAteraCustIds.has(c.customerAteraId);
    if (!portalCustId && !intoNewClient) continue; // contact's customer isn't (and won't be) in the portal
    if (portalCustId) {
      if (c.email && haveContact.has(portalCustId + '|' + c.email.toLowerCase())) continue;
      if (haveContact.has(portalCustId + '|n|' + c.fullName.toLowerCase())) continue;
    }
    const cn = aCustomers.find((x) => pick(x, ['CustomerID', 'CustomerId', 'id']) === c.customerAteraId);
    const defaultTarget = portalCustId ? String(portalCustId) : (intoNewClient ? 'new:' + c.customerAteraId : '');
    newContacts.push({ ...c, customerName: cn ? pick(cn, ['CustomerName', 'Name']) : '(customer ' + c.customerAteraId + ')', intoNewClient, defaultTarget });
  }

  res.render('settings/atera-review', {
    user: req.session.user!, newClients, fillClients, newContacts, ignoredClients, customers,
    counts: { aCustomers: aCustomers.length, aContacts: aContacts.length },
    notice: req.query.msg || null,
  });
});

// ── Apply selected creates/updates ────────────────────────────────────────────────
router.post('/settings/atera/apply', async (req: Request, res: Response) => {
  const user = req.session.user!;
  const a = await Atera.load();
  const createClients = new Set(([] as string[]).concat(req.body.create_client || []));
  const fillClients = new Set(([] as string[]).concat(req.body.fill_client || []));
  const contactTargets: Record<string, string> = req.body.contact || {}; // ateraContactId -> portal customer id | 'new:<ateraCustId>' | ''

  let aCustomers: any[] = [], aContacts: any[] = [];
  try { [aCustomers, aContacts] = await Promise.all([a.getCustomers(), a.getContacts()]); }
  catch (e: any) { res.redirect('/settings/integrations?err=' + encodeURIComponent('Atera pull failed: ' + e.message)); return; }

  const ext = (await pool.query("SELECT external_id, customer_id FROM customer_external_ids WHERE source_system='atera'")).rows;
  const custByAtera = new Map<string, number>(); ext.forEach((r: any) => custByAtera.set(String(r.external_id), r.customer_id));
  let createdC = 0, filledC = 0, createdCt = 0;

  // 1. Create selected new clients (+ external id, primary site, domain).
  for (const raw of aCustomers) {
    const c = ateraCustomer(raw);
    if (!createClients.has(c.ateraId) || custByAtera.has(c.ateraId)) continue;
    const ins = await pool.query(
      "INSERT INTO customers (name, status, phone, domain, created_by) VALUES ($1,'active',$2,$3,$4) RETURNING id",
      [c.name, nz(c.phone), nz(c.domain), user.id]
    );
    const cid = ins.rows[0].id; custByAtera.set(c.ateraId, cid);
    await pool.query("INSERT INTO customer_external_ids (customer_id, source_system, external_id) VALUES ($1,'atera',$2) ON CONFLICT (source_system, external_id) DO NOTHING", [cid, c.ateraId]);
    if (c.address || c.city || c.postcode) {
      await pool.query("INSERT INTO customer_sites (customer_id, site_name, address_line_1, city, postcode, country, is_primary) VALUES ($1,'Main',$2,$3,$4,$5,true)",
        [cid, nz(c.address), nz(c.city), nz(c.postcode), nz(c.country)]);
    }
    if (c.domain) await pool.query("INSERT INTO customer_domains (customer_id, domain, is_primary) VALUES ($1,$2,true) ON CONFLICT (customer_id, domain) DO NOTHING", [cid, c.domain]);
    createdC++;
  }

  // 2. Fill blanks on selected existing clients (never overwrite).
  for (const raw of aCustomers) {
    const c = ateraCustomer(raw);
    if (!fillClients.has(c.ateraId)) continue;
    const cid = custByAtera.get(c.ateraId); if (!cid) continue;
    await pool.query("UPDATE customers SET phone=COALESCE(NULLIF(phone,''),$2), domain=COALESCE(NULLIF(domain,''),$3), updated_at=NOW() WHERE id=$1",
      [cid, nz(c.phone), nz(c.domain)]);
    filledC++;
  }

  // 3. Create selected new contacts against the customer chosen in the dropdown.
  //    Target is a portal customer id, or 'new:<ateraCustId>' to use a client just created.
  const byAteraContact = new Map<string, any>();
  for (const raw of aContacts) byAteraContact.set(pick(raw, ['EndUserID', 'ContactID', 'id']), raw);
  for (const [ateraContactId, targetRaw] of Object.entries(contactTargets)) {
    const target = String(targetRaw || '').trim();
    if (!target) continue;
    const raw = byAteraContact.get(ateraContactId); if (!raw) continue;
    const c = ateraContact(raw);
    const cid = target.startsWith('new:') ? (custByAtera.get(target.slice(4)) || null) : (parseInt(target, 10) || null);
    if (!cid) continue;
    if ((await pool.query("SELECT 1 FROM customer_contacts WHERE atera_contact_id=$1 LIMIT 1", [c.ateraId])).rows.length) continue; // already imported
    const has = (await pool.query("SELECT COUNT(*)::int n FROM customer_contacts WHERE customer_id=$1", [cid])).rows[0].n;
    await pool.query(
      `INSERT INTO customer_contacts (customer_id, atera_contact_id, full_name, email, phone, mobile_phone, job_title, department, is_primary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [cid, c.ateraId, c.fullName, nz(c.email), nz(c.phone), nz(c.mobile), nz(c.jobTitle), nz(c.department), has === 0]
    );
    createdCt++;
  }

  await logActivity(user.id, 'created', 'customers', null, `Atera review applied: ${createdC} clients, ${createdCt} contacts, ${filledC} filled`);
  res.redirect('/settings/atera/review?msg=' + encodeURIComponent(`Applied: ${createdC} clients, ${createdCt} contacts, ${filledC} filled`));
});

// ── Ignore / restore a new client (keeps it off the review screen) ─────────────────
router.post('/settings/atera/ignore-client', async (req: Request, res: Response) => {
  const id = String(req.body.atera_id || '').trim();
  const set = new Set(((await getSetting('atera', 'ignored_customers')) || '').split(',').map((s) => s.trim()).filter(Boolean));
  if (id) set.add(id);
  await setSetting('atera', 'ignored_customers', Array.from(set).join(','));
  res.redirect('/settings/atera/review');
});
router.post('/settings/atera/unignore-client', async (req: Request, res: Response) => {
  const id = String(req.body.atera_id || '').trim();
  const set = new Set(((await getSetting('atera', 'ignored_customers')) || '').split(',').map((s) => s.trim()).filter(Boolean));
  set.delete(id);
  await setSetting('atera', 'ignored_customers', Array.from(set).join(','));
  res.redirect('/settings/atera/review');
});

// Full ticket pull, cached 2 min — so the preview can bucket EVERY status (incl. custom
// CS/RC ones) via the status map, instead of only sampling Atera's plain "Open".
let _allTicketsCache: { at: number; tickets: any[] } | null = null;
async function getAllTicketsCached(a: Atera): Promise<any[]> {
  if (_allTicketsCache && Date.now() - _allTicketsCache.at < 120000) return _allTicketsCache.tickets;
  const tickets = await a.getTickets();
  _allTicketsCache = { at: Date.now(), tickets };
  return tickets;
}

// ── Ticket import PREVIEW (Live / Closed / Resolved tabs) ──────────────────────────
router.get('/settings/atera/tickets', async (req: Request, res: Response) => {
  const a = await Atera.load();
  if (!a.hasKey()) { res.redirect('/settings/integrations?err=' + encodeURIComponent('Set the Atera API key first.')); return; }
  const map = await loadStatusMap();
  const custByAtera = new Map<string, number>();
  (await pool.query("SELECT external_id, customer_id FROM customer_external_ids WHERE source_system='atera'")).rows
    .forEach((r: any) => custByAtera.set(String(r.external_id), r.customer_id));
  const nameById = new Map<number, string>();
  (await pool.query("SELECT id, name FROM customers WHERE deleted_at IS NULL")).rows.forEach((r: any) => nameById.set(r.id, r.name));
  const engByEmail = new Map<string, string>();
  const engByFirst = new Map<string, string>();   // first name → portal engineer (first match wins)
  (await pool.query("SELECT lower(email) AS email, display_name FROM users WHERE is_active=true AND customer_id IS NULL AND hidden_from_lookups=false").catch(() => ({ rows: [] }) as any)).rows
    .forEach((u: any) => {
      if (u.email) engByEmail.set(u.email, u.display_name);
      const fn = String(u.display_name || '').trim().split(/\s+/)[0].toLowerCase();
      if (fn && !engByFirst.has(fn)) engByFirst.set(fn, u.display_name);
    });
  const haveTicket = new Set<string>();
  (await pool.query("SELECT atera_ticket_id FROM inbox_tickets WHERE atera_ticket_id IS NOT NULL")).rows
    .forEach((r: any) => haveTicket.add(String(r.atera_ticket_id)));

  // Build a preview item from an Atera ticket row.
  const toItem = (t: any) => {
    const ateraId = pick(t, ['TicketID', 'ticketId', 'id', 'Id']);
    const aStatus = pick(t, ['TicketStatus', 'Status']);
    const custId = custByAtera.get(pick(t, ['CustomerID', 'customerId']));
    const contact = (pick(t, ['ContactFirstName', 'EndUserFirstName']) + ' ' + pick(t, ['ContactLastName', 'EndUserLastName'])).trim() || pick(t, ['ContactEmail', 'EndUserEmail']) || '—';
    // Engineer: match by login email, else by first name → portal engineer's first name.
    const techName = pick(t, ['TechnicianFullName', 'TechnicianFirstName']);
    const techFirst = techName.trim().split(/\s+/)[0].toLowerCase();
    const engineer = engByEmail.get(pick(t, ['TechnicianLoginEmail']).toLowerCase()) || engByFirst.get(techFirst) || techName || 'Unassigned';
    const created = pick(t, ['TicketCreatedDate', 'CreatedOn', 'createdOn', 'Created']);
    // Seed the detail with the description + last comments; the full thread is loaded below.
    const note = (who: string, ts: string, body: string) => body
      ? `<div style="border-left:3px solid #cbd5e1;padding:4px 0 4px 12px;margin:0 0 12px;"><div style="font-size:12px;color:#64748b;">${who}${ts ? ' · ' + new Date(ts).toLocaleString('en-GB') : ''}</div><div style="font-size:14px;margin-top:3px;">${body}</div></div>`
      : '';
    let detailHtml = note(contact + ' — reported', created, cleanBody(pick(t, ['Description', 'description'])));
    detailHtml += note(contact, pick(t, ['LastEndUserCommentTimestamp']), cleanBody(pick(t, ['LastEndUserComment'])));
    detailHtml += note(engineer + ' (engineer)', pick(t, ['LastTechnicianCommentTimestamp']), cleanBody(pick(t, ['LastTechnicianComment'])));
    if (!detailHtml) detailHtml = '<p style="color:#94a3b8;">No description or comments on this ticket.</p>';
    return {
      ateraId, exists: haveTicket.has(ateraId),
      subject: pick(t, ['TicketTitle', 'Title', 'title']) || '(no subject)',
      customerName: custId ? (nameById.get(custId) || ('#' + custId)) : 'Unmatched',
      contact, engineer,
      ateraStatus: aStatus || '—', portalStatus: mapStatus(map, aStatus).status,
      created, detailHtml,
    };
  };

  // Bucket EVERY (non-deleted) ticket via the status map → accurate Live/Closed/Resolved
  // counts that include custom CS/RC statuses. The lists show a sample per tab; the View
  // modal pulls each ticket's full conversation on demand.
  let total = 0; const groups: Record<string, any[]> = { live: [], closed: [], resolved: [] };
  const counts: Record<string, number> = { live: 0, closed: 0, resolved: 0 };
  const SAMPLE = 60;
  try {
    const all = await getAllTicketsCached(a);
    total = all.length;
    for (const t of all) {
      if (isAteraDeleted(t)) continue;
      const ps = mapStatus(map, pick(t, ['TicketStatus', 'Status'])).status;
      const bucket = ps === 'resolved' ? 'resolved' : ps === 'closed' ? 'closed' : 'live';
      counts[bucket]++;
      if (groups[bucket].length < SAMPLE) groups[bucket].push(toItem(t));
    }
  } catch (e: any) { res.redirect('/settings/integrations?err=' + encodeURIComponent('Atera tickets pull failed: ' + e.message)); return; }

  const newCount = total - (await pool.query("SELECT COUNT(*)::int n FROM inbox_tickets WHERE atera_ticket_id IS NOT NULL").catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  const importStatus = (await getSetting('atera', 'ticket_import_status')) || '';
  res.render('settings/atera-tickets', { user: req.session.user!, groups, counts, newCount: Math.max(0, newCount), total, sampleSize: groups.live.length + groups.closed.length + groups.resolved.length, importStatus, notice: req.query.msg || null });
});

// On-demand full conversation for the preview "View" modal.
router.get('/settings/atera/ticket/:id/detail.json', async (req: Request, res: Response) => {
  const a = await Atera.load();
  if (!a.hasKey()) { res.json({ html: '' }); return; }
  const esc = (s: string) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);
  try {
    const comments = (await a.getTicketComments(String(req.params.id))).map(ateraComment).filter((c) => c.body)
      .sort((x, y) => (x.ts?.getTime() || 0) - (y.ts?.getTime() || 0));
    const html = comments.map((c) =>
      `<div style="border-left:3px solid ${c.internal ? '#fca5a5' : '#cbd5e1'};padding:4px 0 4px 12px;margin:0 0 12px;"><div style="font-size:12px;color:#64748b;">${esc(c.who)}${c.internal ? ' (internal)' : ''}${c.ts ? ' · ' + c.ts.toLocaleString('en-GB') : ''}</div><div style="font-size:14px;margin-top:3px;">${c.body}</div></div>`
    ).join('');
    res.json({ html });
  } catch { res.json({ html: '' }); }
});

// ── Reconciliation: which Atera tickets are NOT in the portal (and why) ─────────────
router.get('/settings/atera/missing', async (req: Request, res: Response) => {
  const a = await Atera.load();
  if (!a.hasKey()) { res.redirect('/settings/integrations?err=' + encodeURIComponent('Set the Atera API key first.')); return; }
  const have = new Set<string>();
  (await pool.query("SELECT atera_ticket_id FROM inbox_tickets WHERE atera_ticket_id IS NOT NULL")).rows.forEach((r: any) => have.add(String(r.atera_ticket_id)));
  const custByAtera = new Map<string, number>();
  (await pool.query("SELECT external_id, customer_id FROM customer_external_ids WHERE source_system='atera'")).rows.forEach((r: any) => custByAtera.set(String(r.external_id), r.customer_id));
  const nameById = new Map<number, string>();
  (await pool.query("SELECT id, name FROM customers WHERE deleted_at IS NULL")).rows.forEach((r: any) => nameById.set(r.id, r.name));
  let all: any[] = [];
  try { all = await a.getTickets(); } catch (e: any) { res.redirect('/settings/atera/tickets?err=' + encodeURIComponent('Atera pull failed: ' + e.message)); return; }
  const missing = all
    .filter((t) => { const id = pick(t, ['TicketID', 'ticketId', 'id', 'Id']); return id && !have.has(String(id)); })
    .map((t) => {
      const custId = custByAtera.get(pick(t, ['CustomerID', 'customerId']));
      return {
        ateraId: pick(t, ['TicketID', 'ticketId', 'id', 'Id']),
        subject: pick(t, ['TicketTitle', 'Title', 'title']) || '(no subject)',
        ateraStatus: pick(t, ['TicketStatus', 'Status']) || '—',
        customerName: custId ? (nameById.get(custId) || ('#' + custId)) : 'Unmatched (no customer link)',
        created: pick(t, ['TicketCreatedDate', 'CreatedOn', 'createdOn', 'Created']),
        reason: isAteraDeleted(t) ? 'Deleted/archived — skipped' : 'Not imported',
      };
    });
  res.render('settings/atera-missing', { user: req.session.user!, missing, totalAtera: all.length, imported: have.size });
});

// ── Ticket import — runs in the BACKGROUND (full history can be thousands) ──────────
let _ticketImportRunning = false;
router.post('/settings/atera/import-tickets', async (req: Request, res: Response) => {
  const user = req.session.user!;
  const a = await Atera.load();
  if (!a.hasKey()) { res.redirect('/settings/integrations?err=' + encodeURIComponent('Set the Atera API key first.')); return; }
  if (_ticketImportRunning) { res.redirect('/settings/atera/tickets?msg=' + encodeURIComponent('An import is already running — refresh for progress.')); return; }
  _ticketImportRunning = true;
  await setSetting('atera', 'ticket_import_status', 'Running — started ' + new Date().toLocaleString('en-GB') + '…');
  // Fire-and-forget so the request returns immediately; progress is written to settings.
  runTicketImport(user.id).catch((e) => { console.error('[atera] ticket import failed:', e.message); setSetting('atera', 'ticket_import_status', 'Failed: ' + e.message); })
    .finally(() => { _ticketImportRunning = false; });
  res.redirect('/settings/atera/tickets?msg=' + encodeURIComponent('Import started in the background — it processes your full Atera history. Refresh this page for progress.'));
});

async function runTicketImport(userId: number): Promise<void> {
  const a = await Atera.load();
  const map = await loadStatusMap();
  const custByAtera = new Map<string, number>();
  (await pool.query("SELECT external_id, customer_id FROM customer_external_ids WHERE source_system='atera'")).rows
    .forEach((r: any) => custByAtera.set(String(r.external_id), r.customer_id));
  const engByEmail = new Map<string, number>();
  const engByFirst = new Map<string, number>();   // first name → portal engineer id
  (await pool.query("SELECT id, lower(email) AS email, display_name FROM users WHERE is_active=true AND customer_id IS NULL AND hidden_from_lookups=false")).rows
    .forEach((u: any) => {
      if (u.email) engByEmail.set(u.email, u.id);
      const fn = String(u.display_name || '').trim().split(/\s+/)[0].toLowerCase();
      if (fn && !engByFirst.has(fn)) engByFirst.set(fn, u.id);
    });
  const haveTicket = new Set<string>();
  (await pool.query("SELECT atera_ticket_id FROM inbox_tickets WHERE atera_ticket_id IS NOT NULL")).rows
    .forEach((r: any) => haveTicket.add(String(r.atera_ticket_id)));

  const tickets = await a.getTickets(); // full history
  let imported = 0, skipped = 0, nextNum = await nextAteraTicketNumber();
  for (const t of tickets) {
    const ateraId = pick(t, ['TicketID', 'ticketId', 'id', 'Id']);
    if (!ateraId || haveTicket.has(ateraId) || isAteraDeleted(t)) { skipped++; continue; }
    const tgt = mapStatus(map, pick(t, ['TicketStatus', 'Status']));
    const custId = custByAtera.get(pick(t, ['CustomerID', 'customerId'])) || null;
    const contactId = custId ? await resolveContact(custId, pick(t, ['ContactEmail', 'EndUserEmail']),
      (pick(t, ['ContactFirstName', 'EndUserFirstName']) + ' ' + pick(t, ['ContactLastName', 'EndUserLastName'])).trim()) : null;
    const techFirst = pick(t, ['TechnicianFullName', 'TechnicianFirstName']).trim().split(/\s+/)[0].toLowerCase();
    const engId = engByEmail.get(pick(t, ['TechnicianLoginEmail']).toLowerCase()) || engByFirst.get(techFirst) || null;
    const subject = pick(t, ['TicketTitle', 'Title', 'title']) || 'Imported from Atera';
    const createdOn = parseDate(pick(t, ['TicketCreatedDate', 'CreatedOn', 'createdOn', 'Created']));
    const modifiedOn = parseDate(pick(t, ['LastModifiedOn', 'ModifiedOn', 'TicketResolvedDate'])) || createdOn;
    const closed = ['resolved', 'closed'].includes(tgt.status);
    const closedAt = closed ? parseDate(pick(t, ['LastModifiedOn', 'ModifiedOn', 'TicketResolvedDate'])) : null;

    const ins = await pool.query(
      `INSERT INTO inbox_tickets (ticket_number, source, customer_id, contact_id, assigned_user_id, status, stage, department,
         activity_status, subject, description, atera_ticket_id, created_at, updated_at, closed_at)
       VALUES ($1,'atera_import',$2,$3,$4,$5,$6,$7,'read',$8,$9,$10,$11,$12,$13) RETURNING id`,
      [`LITS-${nextNum++}`, custId, contactId, engId, tgt.status, tgt.stage, tgt.department, subject,
       nz(cleanBody(pick(t, ['Description', 'description']))), ateraId, createdOn || new Date(), modifiedOn || createdOn || new Date(), closedAt]
    );
    const ticketId = ins.rows[0].id;

    // Whole case history: pull the full comment thread. Public messages import as proper
    // conversation messages (author + timestamp + HTML so formatting carries); internal
    // comments import as internal notes. Falls back to the description + last comments if
    // the comments endpoint returns nothing.
    const esc = (s: string) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);
    const addMessage = async (dir: string, who: string, html: string, ts: Date | null, gid: string) => {
      await pool.query(
        `INSERT INTO inbox_messages (ticket_id, mailbox, message_direction, from_name, from_email, subject, body_text, body_html, has_attachments, received_at, graph_message_id, processing_status)
         VALUES ($1,'atera-import',$2,$3,NULL,$4,NULL,$5,false,$6,$7,'matched') ON CONFLICT (graph_message_id) DO NOTHING`,
        [ticketId, dir, who || null, subject, html, ts || createdOn || new Date(), gid]);
    };
    const thread = (await a.getTicketComments(ateraId).catch(() => [] as any[])).map(ateraComment).filter((c) => c.body)
      .sort((x, y) => (x.ts?.getTime() || 0) - (y.ts?.getTime() || 0));
    if (thread.length) {
      let seq = 0;
      for (const c of thread) {
        seq++;
        if (c.internal) {
          await pool.query("INSERT INTO inbox_notes (ticket_id, user_id, note_type, body, created_at) VALUES ($1,$2,'internal_note',$3,$4)",
            [ticketId, engId, '<strong>' + esc(c.who) + ':</strong> ' + c.body, c.ts || createdOn || new Date()]);
        } else {
          await addMessage(c.direction, c.who, c.body, c.ts, 'atera-' + ateraId + '-' + (c.id || seq));
        }
      }
    } else {
      const desc = cleanBody(pick(t, ['Description', 'description']));
      if (desc) await addMessage('inbound', pick(t, ['ContactFirstName', 'EndUserFirstName']) || 'Customer', desc, createdOn, 'atera-' + ateraId + '-desc');
      const eu = cleanBody(pick(t, ['LastEndUserComment']));
      if (eu) await addMessage('inbound', 'Customer', eu, parseDate(pick(t, ['LastEndUserCommentTimestamp'])), 'atera-' + ateraId + '-eu');
      const tech = cleanBody(pick(t, ['LastTechnicianComment']));
      if (tech) await addMessage('outbound', pick(t, ['TechnicianFullName']) || 'Engineer', tech, parseDate(pick(t, ['LastTechnicianCommentTimestamp'])), 'atera-' + ateraId + '-tech');
    }
    haveTicket.add(ateraId); imported++;
    if (imported % 100 === 0) await setSetting('atera', 'ticket_import_status', `Running — ${imported} imported so far…`);
  }

  await setSetting('atera', 'ticket_import_status', `Done — ${imported} imported, ${skipped} skipped at ${new Date().toLocaleString('en-GB')}`);
  await logActivity(userId, 'created', 'tickets', null, `Atera ticket import: ${imported} imported, ${skipped} skipped`);
}

// ── helpers ────────────────────────────────────────────────────────────────────────
async function nextAteraTicketNumber(): Promise<number> {
  const { rows } = await pool.query('SELECT ticket_number FROM inbox_tickets');
  let max = 100000;
  for (const r of rows) { const m = String(r.ticket_number).match(/(\d+)/); if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; } }
  return max + 1;
}
async function resolveContact(customerId: number, email: string, name: string): Promise<number | null> {
  if (email) {
    const r = await pool.query("SELECT id FROM customer_contacts WHERE customer_id=$1 AND lower(email)=lower($2) LIMIT 1", [customerId, email]);
    if (r.rows[0]) return r.rows[0].id;
  }
  if (name) {
    const r = await pool.query("SELECT id FROM customer_contacts WHERE customer_id=$1 AND lower(full_name)=lower($2) LIMIT 1", [customerId, name]);
    if (r.rows[0]) return r.rows[0].id;
  }
  if (email || name) {
    const r = await pool.query("INSERT INTO customer_contacts (customer_id, full_name, email) VALUES ($1,$2,$3) RETURNING id",
      [customerId, name || email, email || null]);
    return r.rows[0].id;
  }
  return null;
}
function parseDate(s: string): Date | null { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; }
// Normalise one Atera comment into a portal note. Field names vary across Atera versions,
// so pick defensively.
function ateraComment(c: any): { who: string; ts: Date | null; body: string; internal: boolean; direction: string; id: string } {
  const internal = c?.IsInternalComment === true || c?.IsInternal === true || c?.Internal === true;
  const body = cleanBody(pick(c, ['CommentText', 'CommentHtml', 'Comment', 'Text', 'Content', 'Body']));
  const ts = parseDate(pick(c, ['CommentTimestampUTC', 'CommentTimestamp', 'CreatedOn', 'Created', 'Date']));
  const isTech = !!pick(c, ['TechnicianContactID', 'TechnicianFullName', 'TechnicianId', 'TechnicianEmail']);
  const who = (pick(c, ['FirstName']) + ' ' + pick(c, ['LastName'])).trim()
    || pick(c, ['TechnicianFullName', 'EndUserFullName', 'AuthorFullName', 'FullName', 'Email'])
    || (isTech ? 'Engineer' : 'Customer');
  return { who, ts, body, internal, direction: isTech ? 'outbound' : 'inbound', id: pick(c, ['CommentID', 'CommentId', 'ID', 'Id']) };
}
function cleanBody(html: string): string {
  if (!html) return '';
  const cleaned = cleanInboundEmail(html);
  return cleaned.trim();
}

export default router;

import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { pool } from '../db/pool';

// ─────────────────────────────────────────────────────────────────────────────────
// Customer → Tools ▾ — tools that belong to the COMPANY rather than to one machine.
//
// First entry: User Management. It is the device page's User Management lightbox, the
// same partial and the same routes, opened from the customer and shown in its
// Active-Directory-only form — a domain's users belong to the domain, not to whichever
// device page an engineer happened to have open. Local users are deliberately absent
// here: a company has no local users, a machine does.
//
// Which machine runs it: the customer's nominated AD agent (the "AD agent" tick on the
// Agents page — the same rule every ad.* tool already follows in agent-tools.ts). With
// no nomination, any domain controller the server collector has identified; when there
// is more than one of those, the engineer picks, and the choice is remembered in the URL.
// ─────────────────────────────────────────────────────────────────────────────────

export interface DcCandidate {
  device_id: number; hostname: string | null; last_seen_at: Date | null; seen_secs: number | null;
  is_ad_agent: boolean; is_dc: boolean; domain: string | null; asset_id: number | null;
}

/** Every enrolled machine of this customer that holds Active Directory, with the asset row
 *  the tools routes key on. Nominated agent first, then most recently seen. */
export async function domainControllersFor(customerId: number): Promise<DcCandidate[]> {
  const { rows } = await pool.query(
    `SELECT ad.id AS device_id, ad.hostname, ad.last_seen_at,
            EXTRACT(EPOCH FROM (NOW() - ad.last_seen_at)) AS seen_secs,
            ad.is_ad_agent,
            (sf.server_role = 'domain controller' OR COALESCE(sf.roles,'') LIKE '%AD-Domain-Services%') AS is_dc,
            sf.domain,
            COALESCE(
              (SELECT a.id FROM customer_assets a WHERE a.agent_device_id = ad.id AND a.merged_into_id IS NULL ORDER BY a.id LIMIT 1),
              (SELECT a.id FROM customer_assets a WHERE a.customer_id = ad.customer_id AND a.merged_into_id IS NULL
                 AND ((ad.serial_number IS NOT NULL AND a.serial_number = ad.serial_number)
                   OR (ad.hostname IS NOT NULL AND LOWER(a.hostname) = LOWER(ad.hostname)))
                 ORDER BY a.id LIMIT 1)
            ) AS asset_id
       FROM agent_devices ad
       LEFT JOIN server_facts sf ON sf.device_id = ad.id
      WHERE ad.customer_id = $1 AND ad.revoked = false
        AND (ad.is_ad_agent = true OR sf.server_role = 'domain controller' OR COALESCE(sf.roles,'') LIKE '%AD-Domain-Services%')
      ORDER BY ad.is_ad_agent DESC, ad.last_seen_at DESC NULLS LAST`, [customerId]);
  return rows;
}

const router = Router();

router.get('/customers/:id/tools/users', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const id = parseInt(String(req.params.id), 10);
  if (!id) { res.status(404).render('error', { message: 'Customer not found.' }); return; }
  const customer = (await pool.query('SELECT id, name, account_number FROM customers WHERE id = $1 AND deleted_at IS NULL LIMIT 1', [id])).rows[0];
  if (!customer) { res.status(404).render('error', { message: 'Customer not found.' }); return; }

  const dcs = await domainControllersFor(id);
  const wanted = parseInt(String(req.query.dc || ''), 10);
  // Nominated agent wins; otherwise a single DC needs no choice; otherwise the engineer picks.
  let chosen: DcCandidate | null = null;
  if (Number.isInteger(wanted)) chosen = dcs.find((d) => d.device_id === wanted) || null;
  if (!chosen) chosen = dcs.find((d) => d.is_ad_agent) || (dcs.length === 1 ? dcs[0] : null);

  let asset: any = null; let agentInfo: any = null;
  if (chosen && chosen.asset_id) {
    asset = (await pool.query('SELECT id, hostname, customer_id FROM customer_assets WHERE id = $1', [chosen.asset_id])).rows[0] || null;
    agentInfo = (await pool.query('SELECT id, hostname, last_seen_at FROM agent_devices WHERE id = $1', [chosen.device_id])).rows[0] || null;
  }

  res.render('customers/tools-users', {
    user, customer, dcs, chosen, asset, agentInfo,
    // The tools partial expects these from the device page; none are used in AD-users mode.
    patches: [], patchMeta: null, agentScripts: [], csrfToken: '',
  });
});

export default router;

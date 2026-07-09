import { Router, Request, Response } from 'express';
import { getAuthCodeUrl, acquireTokenByCode } from '../auth/microsoft';
import { pool } from '../db/pool';
import { config } from '../config';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const router = Router();

async function logAttempt(email: string, ip: string, success: boolean) {
  try {
    await pool.query(
      'INSERT INTO login_attempts (email, ip, success) VALUES ($1, $2, $3)',
      [String(email || '').slice(0, 200), ip, success]   // cap length — scanners send huge payloads
    );
  } catch (e) {
    console.error('Failed to log login attempt:', e);
  }
}

// Per-IP brute-force / scanner throttle: block once an IP racks up too many failures fast.
async function tooManyAttempts(ip: string): Promise<boolean> {
  try {
    const r = await pool.query(
      "SELECT COUNT(*)::int n FROM login_attempts WHERE ip=$1 AND success=false AND created_at > NOW() - INTERVAL '15 minutes'",
      [ip]
    );
    return (r.rows[0]?.n || 0) >= 12;
  } catch { return false; }
}

function getClientIp(req: Request): string {
  // SECURITY: use Express's resolved IP (trust proxy = 1 → the address Nginx saw),
  // NOT the first x-forwarded-for entry — that element is CLIENT-SUPPLIED with the
  // standard $proxy_add_x_forwarded_for config, so parsing it ourselves let an
  // attacker spoof a fresh IP per request and sidestep the brute-force throttle.
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  return ip.replace(/^::ffff:/, '');   // normalise IPv6-mapped IPv4
}

// Tenant allow-list for multi-tenant SSO. We use the /organizations authority so customers can
// reach the login from their own Microsoft tenants, but we only admit our home tenant plus the
// customer tenants we've explicitly recorded (customers.entra_tenant_id) — NOT every tenant.
async function tenantAllowed(tid: string): Promise<boolean> {
  if (config.AZURE_MULTI_TENANT !== 'true') return true;     // single-tenant authority already restricts
  if (!tid) return false;
  const home = (config.AZURE_TENANT_ID || '').toLowerCase();
  if (home && tid.toLowerCase() === home) return true;       // our own staff tenant
  // Tenant must be RECORDED *and* portal access deliberately ENABLED for that customer — having a
  // tenant id alone (e.g. auto-filled from Giacom) does not grant login.
  const r = await pool.query(
    "SELECT 1 FROM customers WHERE deleted_at IS NULL AND portal_enabled = true AND entra_tenant_id IS NOT NULL AND lower(entra_tenant_id)=lower($1) LIMIT 1",
    [tid]
  ).catch(() => ({ rows: [] as any[] }));
  return r.rows.length > 0;
}

// One login page for everyone (staff + customers) — route by role after sign-in.
// Customers go to their own area (/my); staff land in the /m field app on phones or the full
// portal on desktop. (/m is the STAFF mobile app; /my is the CUSTOMER portal — distinct paths.)
function destFor(role: string, userAgent?: string): string {
  if (role === 'customer') return '/my';
  return /Android.*Mobile|iPhone|iPod/i.test(userAgent || '') ? '/m' : '/';
}

// Show login page
router.get('/login-page', (req: Request, res: Response) => {
  res.render('login', { error: req.query.error || null });
});

// Microsoft SSO redirect
router.get('/login', async (req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.msalState = state;
  const url = await getAuthCodeUrl(state);
  res.redirect(url);
});

// Local email/password login
router.post('/login/local', async (req: Request, res: Response) => {
  const clientIp = getClientIp(req);
  const { email, password } = req.body as { email: string; password: string };

  // Throttle scanners / brute-force: too many recent failures from this IP → hold off.
  if (await tooManyAttempts(clientIp)) {
    res.status(429).render('login', { error: 'Too many failed attempts. Please wait about 15 minutes and try again.' });
    return;
  }

  if (!email || !password) {
    res.render('login', { error: 'Email and password are required.' });
    return;
  }

  const result = await pool.query(
    'SELECT * FROM users WHERE email = $1 AND is_active = true AND password_hash IS NOT NULL LIMIT 1',
    [email.toLowerCase().trim()]
  );

  if (result.rows.length === 0) {
    await logAttempt(email, clientIp, false);
    res.render('login', { error: 'Invalid email or password.' });
    return;
  }

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);

  if (!valid) {
    await logAttempt(email, clientIp, false);
    res.render('login', { error: 'Invalid email or password.' });
    return;
  }

  await logAttempt(email, clientIp, true);

  req.session.user = {
    id:          user.id,
    email:       user.email,
    displayName: user.display_name,
    role:        user.role,
    customerId:  user.customer_id ?? null,
  };

  await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

  res.redirect(destFor(user.role, req.get('user-agent')));
});

// Microsoft SSO callback
router.get('/auth/callback', async (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query as Record<string, string>;

  if (error) {
    res.render('error', { message: error_description || 'Microsoft login failed.' });
    return;
  }

  if (state !== req.session.msalState) {
    res.render('error', { message: 'Invalid state — possible CSRF. Please try logging in again.' });
    return;
  }

  try {
    const result = await acquireTokenByCode(code);
    const claims = result.idTokenClaims as Record<string, string>;
    const email  = claims.email || claims.preferred_username || '';
    const oid    = claims.oid || '';
    const name   = claims.name || email;

    if (!email) {
      res.render('error', { message: 'Could not retrieve email from Microsoft account.' });
      return;
    }

    const clientIp = getClientIp(req);

    // Bookkeeper: an allow-listed external accountant (their own Microsoft account, NOT in our
    // Entra). A pre-created role='bookkeeper' user signs straight into the read-only expenses
    // dashboard, bypassing the tenant gate — they never touch the staff or customer portals.
    const bk = (await pool.query("SELECT * FROM users WHERE email=$1 AND role='bookkeeper' AND is_active=true LIMIT 1", [email.toLowerCase()])).rows[0];
    if (bk) {
      await logAttempt(email, clientIp, true);
      await pool.query('UPDATE users SET last_login_at=NOW(), entra_oid=$1 WHERE id=$2', [oid, bk.id]).catch(() => {});
      req.session.user = { id: bk.id, email: bk.email, displayName: name, role: 'bookkeeper', customerId: null };
      res.redirect('/bookkeeper');
      return;
    }

    // Tenant allow-list (multi-tenant mode): only our tenant + recorded customer tenants.
    const tid = (claims.tid as string) || '';
    if (!(await tenantAllowed(tid))) {
      await logAttempt(email, clientIp, false);
      res.render('error', { message: "Your organisation isn't set up for portal access yet. Please contact Lumen IT." });
      return;
    }

    const userRes = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND is_active = true LIMIT 1',
      [email.toLowerCase()]
    );
    let user = userRes.rows[0];

    // Auto-provision: anyone signing in from an ENABLED customer's tenant (not our home tenant)
    // gets a customer login created on first sign-in — no manual setup per person. Their access
    // level is then derived from their key-contact role (principal/finance/service) in /my.
    if (!user) {
      const home = (config.AZURE_TENANT_ID || '').toLowerCase();
      if (config.AZURE_MULTI_TENANT === 'true' && tid && tid.toLowerCase() !== home) {
        const cust = (await pool.query(
          "SELECT id FROM customers WHERE deleted_at IS NULL AND portal_enabled = true AND entra_tenant_id IS NOT NULL AND lower(entra_tenant_id)=lower($1) LIMIT 1",
          [tid]
        ).catch(() => ({ rows: [] as any[] }))).rows[0];
        if (cust) {
          user = (await pool.query(
            "INSERT INTO users (email, display_name, role, is_active, customer_id, entra_oid) VALUES ($1,$2,'customer',true,$3,$4) ON CONFLICT (email) DO UPDATE SET is_active=true RETURNING *",
            [email.toLowerCase(), name || email, cust.id, oid]
          ).catch(() => ({ rows: [] as any[] }))).rows[0];
        }
      }
    }

    if (!user) {
      await logAttempt(email, clientIp, false);
      res.render('error', { message: `No account found for ${email}. Contact an administrator to request access.` });
      return;
    }

    await logAttempt(email, clientIp, true);

    await pool.query(
      'UPDATE users SET last_login_at = NOW(), entra_oid = $1 WHERE id = $2',
      [oid, user.id]
    );

    req.session.user = {
      id:          user.id,
      email:       user.email,
      displayName: name,
      role:        user.role,
      customerId:  user.customer_id ?? null,
    };

    res.redirect(destFor(user.role, req.get('user-agent')));
  } catch (err) {
    console.error('Auth callback error:', err);
    res.render('error', { message: 'Login failed. Please try again.' });
  }
});

router.get('/logout', (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.redirect(
      'https://login.microsoftonline.com/common/oauth2/v2.0/logout?post_logout_redirect_uri=' +
      encodeURIComponent(config.APP_URL + '/login-page')
    );
  });
});

export default router;

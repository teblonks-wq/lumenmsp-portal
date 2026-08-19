import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getAuthCodeUrl } from '../auth/microsoft';
import { pool } from '../db/pool';
import {
  createSelfSignup, sendVerificationEmail, verifyEmailToken, reissueVerification,
  tooManySignups, alertNewSignup, ensureSelfSignupCustomer, MIN_PASSWORD,
} from '../lib/self-signup';

// ─────────────────────────────────────────────────────────────────────────────────
// Public self-registration routes. Everything here is reachable WITHOUT a session, so
// each one assumes the caller is hostile until proved otherwise.
//
// The three rules this file keeps:
//   1. The same answer every time. Whether the address is new, already registered, or
//      belongs to the managing director of our largest customer, the visitor sees the
//      identical "check your email" page. Any difference turns the form into an oracle
//      for testing who banks with us.
//   2. Nothing is matched against customer data. The company name is free text.
//   3. Nothing they type reaches a query unparameterised, and nothing they type is
//      echoed back into a page without escaping.
// ─────────────────────────────────────────────────────────────────────────────────

const router = Router();

function clientIp(req: Request): string {
  // Express's resolved ip (trust proxy = 1), NOT the raw x-forwarded-for header, which the
  // client supplies and could rotate to walk straight through the per-IP throttle.
  return String(req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

const SENT_MESSAGE =
  'Check your email. If we can set up an account for that address, a confirmation link is on its way. '
  + 'The link works for 24 hours.';

router.get('/signup', (req: Request, res: Response) => {
  res.render('signup', { error: null, values: {}, done: null });
});

/** Email + password. */
router.post('/signup', async (req: Request, res: Response) => {
  const b = req.body as Record<string, string>;
  const values = {
    name: String(b.name || '').trim().slice(0, 120),
    email: String(b.email || '').trim().slice(0, 200),
    company: String(b.company || '').trim().slice(0, 200),
  };
  const password = String(b.password || '');
  const fail = (error: string) => res.render('signup', { error, values, done: null });

  if (!values.name || !values.email || !values.company) return fail('Please fill in your name, email address and company.');
  if (password.length < MIN_PASSWORD) return fail(`Please choose a password of at least ${MIN_PASSWORD} characters.`);
  if (password !== String(b.password2 || '')) return fail('The two passwords do not match.');

  const ip = clientIp(req);
  if (await tooManySignups(ip)) {
    // Deliberately honest here rather than silent: a real person hitting this is usually a
    // colleague on the same office IP, and "try again later" is actionable where a fake
    // success page would leave them waiting for an email that never comes.
    return fail('Too many accounts have been created from your connection recently. Please try again in an hour, or email support directly.');
  }

  const r = await createSelfSignup({
    email: values.email, displayName: values.name, companyClaimed: values.company, password, ip,
  }).catch((e) => { console.error('self-signup failed:', e.message); return { created: false } as any; });

  if (r.created && r.verifyToken) {
    await sendVerificationEmail(values.email, values.name, r.verifyToken)
      .catch((e) => console.error('verification email failed:', e.message));
  }
  // Same page whether or not anything was created. See rule 1.
  res.render('signup', { error: null, values: {}, done: SENT_MESSAGE });
});

/** Start a Microsoft sign-up. The company name is captured first and parked in the session. */
router.post('/signup/microsoft', async (req: Request, res: Response) => {
  const company = String((req.body as any).company || '').trim().slice(0, 200);
  if (!company) {
    res.render('signup', { error: 'Please tell us your company name before continuing with Microsoft.',
      values: { name: String((req.body as any).name || ''), email: String((req.body as any).email || '') }, done: null });
    return;
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.msalState = state;
  req.session.signupMode = true;          // read by the shared /auth/callback
  req.session.signupCompany = company;
  res.redirect(await getAuthCodeUrl(state));
});

/** The confirmation link. */
router.get('/signup/verify', async (req: Request, res: Response) => {
  const v = await verifyEmailToken(String((req.query as any).token || ''))
    .catch(() => ({ outcome: 'invalid' as const }));

  if (v.outcome === 'ok') {
    // Only the first confirmation alerts the helpdesk — a refreshed tab must not re-notify.
    if (v.newlyVerifiedUserId) await alertNewSignup(v.newlyVerifiedUserId).catch(() => {});
    res.render('signup', { error: null, values: {}, done:
      'Thank you — your email address is confirmed. You can sign in now and raise a support request.' });
    return;
  }
  res.render('signup', {
    error: v.outcome === 'expired'
      ? 'That confirmation link has expired. Enter your email below and we will send a fresh one.'
      : 'That confirmation link is not valid. It may already have been used.',
    values: {}, done: null, resend: true,
  });
});

/** Ask for another confirmation link. Same-answer rule applies. */
router.post('/signup/resend', async (req: Request, res: Response) => {
  const email = String((req.body as any).email || '').trim();
  const again = await reissueVerification(email).catch(() => null);
  if (again) {
    await sendVerificationEmail(email, again.name, again.token)
      .catch((e) => console.error('verification resend failed:', e.message));
  }
  res.render('signup', { error: null, values: {}, done: SENT_MESSAGE });
});

/**
 * Sign in a Microsoft visitor who is NOT one of ours, creating the account if needed.
 *
 * Called from /auth/callback in two places: when the tenant allow-list rejects them, and
 * when they clear it but have no account. Both are "we do not know you" — and in signup
 * mode that is the expected state, not an error. It never links them to a customer and
 * never touches the auto-provision path, so the tenant gate keeps its full meaning for
 * everybody who did not come through the sign-up form.
 */
export async function signInAsSelfRegistered(
  req: Request, res: Response,
  who: { email: string; name: string; oid: string; ip: string },
): Promise<void> {
  const company = String(req.session.signupCompany || '').slice(0, 200);
  req.session.signupMode = undefined;
  req.session.signupCompany = undefined;

  const email = who.email.toLowerCase().trim();
  let user = (await pool.query('SELECT * FROM users WHERE lower(email)=$1 LIMIT 1', [email])).rows[0];

  if (!user) {
    if (await tooManySignups(who.ip)) {
      res.render('error', { message: 'Too many accounts have been created from your connection recently. Please try again in an hour.' });
      return;
    }
    const r = await createSelfSignup({
      email, displayName: who.name, companyClaimed: company, entraOid: who.oid, ip: who.ip,
    });
    if (!r.created) { res.render('error', { message: 'We could not create an account for that address. Please email support.' }); return; }
    user = (await pool.query('SELECT * FROM users WHERE id=$1', [r.userId])).rows[0];
    await alertNewSignup(Number(r.userId)).catch(() => {});
  } else if (!user.is_active) {
    res.render('error', { message: 'That account is not active. Please contact Lumen IT.' });
    return;
  }

  await pool.query('UPDATE users SET last_login_at=NOW(), entra_oid=COALESCE(entra_oid,$1), email_verified=true WHERE id=$2',
    [who.oid || null, user.id]).catch(() => {});

  req.session.user = {
    id: user.id, email: user.email, displayName: who.name || user.display_name,
    role: user.role, customerId: user.customer_id ?? null,
  };
  res.redirect(user.role === 'customer' ? '/my' : '/');
}

/** Called at startup so the placeholder company exists before the first visitor arrives. */
export async function bootstrapSelfSignup(): Promise<void> {
  await ensureSelfSignupCustomer().catch((e) => console.error('self-signup bootstrap:', e.message));
}

export default router;

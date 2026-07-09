import { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';

// Password-vault access: admins always; otherwise the user must have the Support
// tick box (support_group) set on their account. Checked live so toggling the box
// in Admin → Users takes effect immediately (no re-login needed).
export async function hasVaultAccess(user?: { id: number; role: string }): Promise<boolean> {
  if (!user || user.role === 'customer') return false;
  if (user.role === 'admin') return true;
  try {
    const r = await pool.query('SELECT support_group FROM users WHERE id=$1', [user.id]);
    return !!r.rows[0]?.support_group;
  } catch { return false; }
}

export async function requireVaultAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.session.user) { res.redirect('/login-page'); return; }
  if (await hasVaultAccess(req.session.user)) { next(); return; }
  res.status(403).render('error', { message: 'Password vault access is limited to support users. Ask an admin to enable the Support box on your account.' });
}

// Finance access: admins always; otherwise the user must have the Finance tick box.
// Gates the invoices module and the dashboard invoices card.
export async function hasFinanceAccess(user?: { id: number; role: string }): Promise<boolean> {
  if (!user || user.role === 'customer') return false;
  if (user.role === 'admin') return true;
  try {
    const r = await pool.query('SELECT finance_group FROM users WHERE id=$1', [user.id]);
    return !!r.rows[0]?.finance_group;
  } catch { return false; }
}

export async function requireFinance(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.session.user) { res.redirect('/login-page'); return; }
  if (await hasFinanceAccess(req.session.user)) { next(); return; }
  res.status(403).render('error', { message: 'Invoices are limited to finance users. Ask an admin to enable the Finance box on your account.' });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.user) {
    res.redirect('/login-page');
    return;
  }
  // Customer-scoped users have no access to the internal staff portal — send them to their
  // own area (/my) instead of the staff screens.
  if (req.session.user.role === 'customer') {
    res.redirect('/my');
    return;
  }
  // Bookkeeper is a read-only external role — locked to its own expenses dashboard.
  if (req.session.user.role === 'bookkeeper') {
    res.redirect('/bookkeeper');
    return;
  }
  next();
}

// Read-only bookkeeper area: the external bookkeeper role, plus staff (so Lumen can view it too).
export function requireBookkeeper(req: Request, res: Response, next: NextFunction): void {
  const u = req.session.user;
  if (!u) { res.redirect('/login-page'); return; }
  if (u.role === 'customer') { res.redirect('/my'); return; }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.user || req.session.user.role !== 'admin') {
    res.status(403).render('error', { message: 'Access denied.' });
    return;
  }
  next();
}

// Customer-portal access: gates the /my area. Requires a logged-in user whose role is
// 'customer' AND who is linked to a customer company (customerId). Staff are redirected to
// their own home; a mis-provisioned customer (no customerId) is held back rather than shown
// another company's data. Every /my query must still filter by req.session.user.customerId.
export function requireCustomer(req: Request, res: Response, next: NextFunction): void {
  const u = req.session.user;
  if (!u) { res.redirect('/login-page'); return; }
  if (u.role !== 'customer') { res.redirect('/'); return; }        // staff don't belong here
  if (!u.customerId) {
    res.status(403).render('error', { message: 'Your account is not linked to a company yet. Please contact Lumen IT.' });
    return;
  }
  next();
}

// Extend session type
declare module 'express-session' {
  interface SessionData {
    user?: {
      id: number;
      email: string;
      displayName: string;
      role: string;
      // Set only for customer-portal users; links them to their company. Undefined for staff.
      customerId?: number | null;
    };
    msalState?: string;
  }
}

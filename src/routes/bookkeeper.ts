import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { requireBookkeeper } from '../middleware/auth';
import { pool } from '../db/pool';

// Read-only bookkeeper portal. The external accountant signs in with their own Microsoft account
// (allow-listed as role 'bookkeeper' — see auth callback) and sees every expense by month with
// view-only access to each receipt. No edits, no other portal access, no email size cap.
const router = Router();

router.get('/bookkeeper', requireBookkeeper, async (req: Request, res: Response) => {
  const months = (await pool.query(
    `SELECT to_char(booked_at,'YYYY-MM') AS period, COUNT(*)::int AS n, SUM(-amount) AS total
       FROM bank_transactions WHERE amount<0 AND status<>'ignored' AND booked_at IS NOT NULL
      GROUP BY 1 ORDER BY 1 DESC`
  ).catch(() => ({ rows: [] as any[] }))).rows;
  const period = String(req.query.period || (months[0] && months[0].period) || new Date().toISOString().slice(0, 7));
  const rows = (await pool.query(
    `SELECT id, booked_at, account_name, counterparty, description, qb_account_name, amount, attachment_name
       FROM bank_transactions WHERE amount<0 AND status<>'ignored' AND to_char(booked_at,'YYYY-MM')=$1
      ORDER BY booked_at DESC`, [period]
  ).catch(() => ({ rows: [] as any[] }))).rows;
  const total = rows.reduce((a: number, r: any) => a + Math.abs(Number(r.amount) || 0), 0);
  res.render('bookkeeper/dashboard', { user: req.session.user!, months, period, rows, total });
});

// View a receipt inline (read-only) — scoped to this portal.
router.get('/bookkeeper/receipt/:id', requireBookkeeper, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const r = (await pool.query('SELECT attachment_path, attachment_name FROM bank_transactions WHERE id=$1', [id]).catch(() => ({ rows: [] as any[] }))).rows[0];
  if (!r || !r.attachment_path || !fs.existsSync(r.attachment_path)) { res.status(404).send('Receipt not available.'); return; }
  const name = String(r.attachment_name || path.basename(r.attachment_path));
  const ct = /\.pdf$/i.test(name) ? 'application/pdf' : /\.png$/i.test(name) ? 'image/png' : /\.(jpe?g)$/i.test(name) ? 'image/jpeg' : 'application/octet-stream';
  res.setHeader('Content-Type', ct);
  res.setHeader('Content-Disposition', 'inline; filename="' + name.replace(/"/g, '') + '"');
  fs.createReadStream(r.attachment_path).pipe(res);
});

export default router;

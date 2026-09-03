import { Router, Request, Response } from 'express';
import { requireAuth, requireFinance } from '../middleware/auth';
import { pool } from '../db/pool';
import { getSetting, setSetting } from '../lib/settings';
import { usageBy, usageByDay, usageTotals, biggestCalls } from '../lib/ai-meter';

// ── What the Portal is spending on AI ───────────────────────────────────────────
// Anthropic's console can only tell you an API key spent money. This tells you WHICH
// FEATURE spent it, which is the only version of the question anyone can act on.
const router = Router();
router.use(requireAuth, requireFinance);

router.get('/admin/ai-usage', async (req: Request, res: Response) => {
  const days = Math.max(1, Math.min(90, parseInt(String(req.query.days || '30'), 10) || 30));
  const [totals, byFeature, byModel, byDay, biggest] = await Promise.all([
    usageTotals(), usageBy('feature', days), usageBy('model', days), usageByDay(days), biggestCalls(15),
  ]);
  // The scheduled jobs that can spend without anyone pressing anything. This is the list
  // people forget exists, and it is where a quiet trickle comes from.
  const schedules = [
    { what: 'Invoice mailbox sync', when: 'every 15 minutes', spends: 'only if it reads a new document' },
    { what: 'Purchase anomaly sweep', when: '02:35 nightly', spends: 'judges documents unless AI matching is off' },
    { what: 'Anomaly digest email', when: 'Mondays 07:30', spends: 'no' },
    { what: 'Mail sync', when: 'every minute', spends: 'one call per new email, if ticket categorisation is on' },
  ];
  res.render('admin/ai-usage', {
    user: req.session.user!, days, totals, byFeature, byModel, byDay, biggest, schedules,
    aiMatching: (await getSetting('purchases', 'ai_matching')) !== '0',
    // The real setting the mail sync reads, not a new one — a switch that does not switch
    // anything is worse than no switch.
    ticketCategory: ((await getSetting('tickets', 'ai_category')) || '').toLowerCase() === 'on',
    monthlyBudget: Number((await getSetting('anthropic', 'monthly_budget_usd')) || 0),
    notice: req.query.msg || null, error: req.query.err || null,
  });
});

// The two switches that actually stop money leaving, in the place you look when it is.
router.post('/admin/ai-usage/settings', async (req: Request, res: Response) => {
  const b: any = req.body || {};
  await setSetting('purchases', 'ai_matching', b.ai_matching === 'on' ? '1' : '0');
  await setSetting('tickets', 'ai_category', b.ticket_category === 'on' ? 'on' : 'off');
  const budget = Math.max(0, Math.min(100000, parseFloat(String(b.monthly_budget_usd || '0')) || 0));
  await setSetting('anthropic', 'monthly_budget_usd', String(budget));
  res.redirect('/admin/ai-usage?msg=' + encodeURIComponent('Saved.'));
});

export default router;

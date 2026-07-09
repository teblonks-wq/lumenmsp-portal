import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  ERECYCLING_CATEGORIES, ERECYCLING_CONDITIONS, erecyclingPhotoUpload,
  ensureOpenBatch, loadBatch, loadBatchItems, submittedBatches, savedFirmEmail,
  addItem, deleteItem, renderManifestPdf, submitBatch,
} from '../lib/erecycling';

const router = Router();
router.use('/bureau/erecycling', requireAuth);

async function renderPage(req: Request, res: Response, batch: any) {
  const items = await loadBatchItems(batch.id);
  const history = await submittedBatches();
  const firmEmail = await savedFirmEmail();
  res.render('erecycling', {
    user: req.session.user!, batch, items, history, firmEmail,
    categories: ERECYCLING_CATEGORIES, conditions: ERECYCLING_CONDITIONS,
    notice: req.query.msg || null, error: req.query.err || null,
  });
}

// Overview — open batch + items + submitted history.
router.get('/bureau/erecycling', async (req: Request, res: Response) => {
  const batch = await ensureOpenBatch(req.session.user!.id);
  await renderPage(req, res, batch);
});

// View a specific (submitted) batch read-only.
router.get('/bureau/erecycling/:batchId(\\d+)', async (req: Request, res: Response) => {
  const batch = await loadBatch(parseInt(String(req.params.batchId), 10));
  if (!batch) { res.redirect('/bureau/erecycling'); return; }
  await renderPage(req, res, batch);
});

// Add an item (with photos) to the open batch.
router.post('/bureau/erecycling/:batchId(\\d+)/item', erecyclingPhotoUpload.array('photos', 8), async (req: Request, res: Response) => {
  const batchId = parseInt(String(req.params.batchId), 10);
  try {
    await addItem(batchId, req.body, (req.files as any[]) || [], req.session.user!.id);
    res.redirect('/bureau/erecycling?msg=' + encodeURIComponent(`${String(req.body.category || 'Item')} added`));
  } catch (e: any) {
    res.redirect('/bureau/erecycling?err=' + encodeURIComponent('Add failed: ' + (e.message || 'error')));
  }
});

// Delete an item.
router.post('/bureau/erecycling/item/:itemId(\\d+)/delete', async (req: Request, res: Response) => {
  await deleteItem(parseInt(String(req.params.itemId), 10));
  res.redirect('/bureau/erecycling');
});

// Download / view the manifest PDF.
router.get('/bureau/erecycling/:batchId(\\d+)/pdf', async (req: Request, res: Response) => {
  try {
    const { pdf, batch } = await renderManifestPdf(parseInt(String(req.params.batchId), 10));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${batch.reference}.pdf"`);
    res.send(pdf);
  } catch { res.redirect('/bureau/erecycling'); }
});

// Submit the batch: email the PDF manifest to the e-waste firm, mark submitted.
router.post('/bureau/erecycling/:batchId(\\d+)/submit', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.batchId), 10);
  try {
    const ref = await submitBatch(id, String(req.body.firm_email || '').trim(), String(req.body.notes || '').trim() || null, req.body.remember_email === 'on', req.session.user!.id);
    res.redirect('/bureau/erecycling?msg=' + encodeURIComponent(`${ref} submitted — a new batch has been started`));
  } catch (e: any) {
    res.redirect('/bureau/erecycling?err=' + encodeURIComponent(e.message || 'Submit failed'));
  }
});

export default router;

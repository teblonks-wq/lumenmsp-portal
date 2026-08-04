// Public tracking endpoints. No auth: the token in the URL is the only credential, and it
// identifies one send rather than granting access to anything.
import { Router, Request, Response } from 'express';
import {
  clientIp, findSendByPixel, logDocEvent, PIXEL_GIF, PREFETCH_WINDOW_MS, userAgent,
} from '../lib/doc-events';

const router = Router();

router.get('/e/:token.gif', async (req: Request, res: Response) => {
  // Always answer with the image, whatever happens — a tracking failure must never show
  // the recipient a broken image in an otherwise fine email.
  const serve = () => {
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.end(PIXEL_GIF);
  };
  try {
    const token = String((req.params as any).token || '').replace(/\.gif$/, '');
    const send = await findSendByPixel(token);
    if (send) {
      const ua = userAgent(req);
      // From SQL, not the Node clock: an hour of skew made every open look late, so the
      // prefetch check never fired and scanner hits were logged as genuine reads.
      const sinceSend = Math.max(0, Number(send.age_secs || 0) * 1000);
      // Fired the instant the mail landed, or by a known scanner/proxy: almost certainly
      // automated rather than a person opening it.
      const prefetch = sinceSend < PREFETCH_WINDOW_MS ||
        /GoogleImageProxy|YahooMailProxy|Barracuda|Proofpoint|Mimecast|MessageLabs|BitDefender/i.test(ua);
      await logDocEvent(send.doc_type, send.doc_id, 'email_opened', {
        customerId: send.customer_id, actor: send.actor, ip: clientIp(req), userAgent: ua,
        meta: { prefetch, secondsAfterSend: Math.round(sinceSend / 1000) },
      });
    }
  } catch (e) { console.error('[tracking] pixel failed:', (e as Error).message); }
  serve();
});

export default router;

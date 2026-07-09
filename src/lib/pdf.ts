import puppeteer, { Browser } from 'puppeteer';

// Render HTML (e.g. an EJS-rendered quote/invoice/handover) to a PDF buffer via
// headless Chrome. Closest equivalent to the legacy dompdf HTML-to-PDF approach.
//
// On the server, Puppeteer needs a Chromium install. Either let Puppeteer download
// its bundled Chromium (default) or set PUPPETEER_EXECUTABLE_PATH to a system Chrome.

let _browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!_browser || !_browser.connected) {
    _browser = await puppeteer.launch({
      headless: true,
      // --disable-dev-shm-usage is essential on small/containerised VMs: without it
      // Chromium uses /dev/shm (often only 64MB) and crashes mid-render ("Target closed"),
      // which previously made invoice PDFs fail intermittently → emails sent with no attachment.
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
  }
  return _browser;
}

export interface PdfOptions {
  format?: 'A4' | 'Letter';
  landscape?: boolean;
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  headerHtml?: string;
  footerHtml?: string;
}

async function renderOnce(html: string, opts: PdfOptions): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // networkidle0 can hang forever if a resource never settles; cap it. The logo is a
    // data-URI so the page is effectively offline — 'load' is enough and far more reliable.
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    const pdf = await page.pdf({
      format: opts.format ?? 'A4',
      landscape: opts.landscape ?? false,
      printBackground: true,
      displayHeaderFooter: Boolean(opts.headerHtml || opts.footerHtml),
      headerTemplate: opts.headerHtml ?? '<span></span>',
      footerTemplate: opts.footerHtml ?? '<span></span>',
      margin: opts.margin ?? { top: '16mm', right: '14mm', bottom: '16mm', left: '14mm' },
    });
    return Buffer.from(pdf);
  } finally {
    try { await page.close(); } catch { /* page may already be gone if browser crashed */ }
  }
}

export async function htmlToPdf(html: string, opts: PdfOptions = {}): Promise<Buffer> {
  try {
    return await renderOnce(html, opts);
  } catch (e) {
    // A crashed/disconnected Chromium ("Target closed", "Protocol error") leaves a zombie
    // browser the connected-check may not catch. Tear it down and retry once from clean.
    console.error('[pdf] render failed, relaunching Chromium and retrying once:', (e as Error).message);
    try { await closePdfBrowser(); } catch { /* ignore */ }
    return await renderOnce(html, opts);
  }
}

export async function closePdfBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

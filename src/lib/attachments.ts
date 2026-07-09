import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { config } from '../config';
import { GraphAttachment, GraphInboundAttachment } from './graph';

// Uploads for communication attachments. Files are stored under static/attachments
// (publicly served) and, when small enough, inline-attached to the outgoing email.

const dir = path.join(__dirname, '../../static/attachments');
fs.mkdirSync(dir, { recursive: true });

export const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dir),
    filename: (_req, file, cb) => {
      const safe = (file.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
      cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + safe);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
});

export interface ProcessedAttachments {
  stored: { name: string; url: string }[];
  graph: GraphAttachment[];
}

// Turns multer files into stored {name,url} (for the thread) + Graph attachments (for the email).
export function processAttachments(files: any[]): ProcessedAttachments {
  const base = (config.APP_URL || 'https://portal.lumenmsp.co.uk').replace(/\/$/, '');
  const stored: { name: string; url: string }[] = [];
  const graph: GraphAttachment[] = [];
  for (const f of files || []) {
    stored.push({ name: f.originalname, url: base + '/static/attachments/' + f.filename });
    try {
      if (f.size <= 3 * 1024 * 1024) {
        graph.push({ filename: f.originalname, contentType: f.mimetype, base64: fs.readFileSync(f.path).toString('base64') });
      }
    } catch { /* ignore unreadable file */ }
  }
  return { stored, graph };
}

// Write a raw buffer to the attachments dir and return its public {name, url}. Used for inbound
// WhatsApp media (already downloaded as bytes).
export function saveBufferAttachment(buf: Buffer, name: string): { name: string; url: string } {
  const base = (config.APP_URL || 'https://portal.lumenmsp.co.uk').replace(/\/$/, '');
  const safe = (name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
  const filename = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + safe;
  fs.writeFileSync(path.join(dir, filename), buf);
  return { name, url: base + '/static/attachments/' + filename };
}

export interface SavedInboundAttachment { name: string; url: string; isInline: boolean; contentId: string; }

// Writes inbound (Graph) attachments to disk and returns their public URLs.
// Inline images keep their contentId so cid: references in the HTML body can be rewritten.
export function saveGraphAttachments(atts: GraphInboundAttachment[]): SavedInboundAttachment[] {
  const base = (config.APP_URL || 'https://portal.lumenmsp.co.uk').replace(/\/$/, '');
  const out: SavedInboundAttachment[] = [];
  for (const a of atts || []) {
    try {
      const safe = (a.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
      const filename = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + safe;
      fs.writeFileSync(path.join(dir, filename), Buffer.from(a.base64, 'base64'));
      out.push({ name: a.name, url: base + '/static/attachments/' + filename, isInline: a.isInline, contentId: a.contentId });
    } catch (e) { console.error('[attachments] save inbound failed:', a.name, (e as Error).message); }
  }
  return out;
}

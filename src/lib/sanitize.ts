import sanitizeHtml from 'sanitize-html';

// Trims the legal disclaimer / confidentiality footer off a plain-text email body so the
// ticket Description holds just the message, not the boilerplate. Conservative: it only
// cuts from a recognised disclaimer marker (or an RFC "-- " signature delimiter) onward,
// so genuine message text is left intact.
const FOOTER_MARKERS: RegExp[] = [
  /the information contained in (?:this|or attached to this) e-?mail/i,
  /this e-?mail (?:and any attachments?|message)\s+(?:is|are|may be|contains?)/i,
  /if you are not the (?:intended|named) recipient/i,
  /this (?:e-?mail|message|communication) is intended (?:only|solely) for/i,
  /confidentiality notice/i,
  /^\s*(?:legal\s+)?disclaimer\s*:?/im,
  /please consider the environment before printing/i,
  /\bis (?:registered in england|a (?:limited )?company registered)/i,
];
export function stripEmailFooter(text: string): string {
  if (!text) return text;
  let cut = -1;
  for (const re of FOOTER_MARKERS) {
    const m = text.match(re);
    if (m && m.index !== undefined && (cut === -1 || m.index < cut)) cut = m.index;
  }
  const sig = text.search(/\n--\s*\n/); // standard signature delimiter
  if (sig >= 0 && (cut === -1 || sig < cut)) cut = sig;
  const out = cut > 0 ? text.slice(0, cut) : text;
  return out.replace(/\s+$/, '').trim();
}

// Cleans agent-authored rich text (from the comms editor) before it's stored
// and rendered as HTML. Allows basic formatting, links, lists and images.
export function cleanHtml(dirty: string): string {
  return sanitizeHtml(dirty || '', {
    allowedTags: [
      'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'a', 'ul', 'ol', 'li',
      'blockquote', 'h1', 'h2', 'h3', 'h4', 'span', 'div', 'pre', 'code', 'img',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      '*': ['style'],
    },
    allowedStyles: {
      '*': {
        'color': [/^#(0x)?[0-9a-f]+$/i, /^rgb\(/],
        'background-color': [/^#(0x)?[0-9a-f]+$/i, /^rgb\(/],
        'text-align': [/^left$/, /^right$/, /^center$/, /^justify$/],
        'font-weight': [/^bold$/, /^\d+$/],
        'font-style': [/^italic$/],
        'text-decoration': [/^underline$/, /^line-through$/],
      },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }),
    },
  });
}

// Cleans an INBOUND email body (HTML the customer's mail client produced) so it
// can be shown as the sender composed it. More permissive than cleanHtml — keeps
// tables, fonts and inline styles for layout fidelity — but still strips scripts,
// <style>/<iframe>/<object> and event handlers (sanitize-html removes those by default).
const anyStyle = [/.*/];
export function cleanInboundEmail(dirty: string): string {
  return sanitizeHtml(dirty || '', {
    allowedTags: [
      'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'sub', 'sup', 'a',
      'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
      'span', 'div', 'pre', 'code', 'img', 'font', 'center', 'small',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'col', 'colgroup',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel', 'name', 'style'],
      img: ['src', 'alt', 'width', 'height', 'style'],
      font: ['color', 'face', 'size'],
      table: ['width', 'height', 'align', 'bgcolor', 'cellpadding', 'cellspacing', 'border', 'style'],
      td: ['width', 'height', 'align', 'valign', 'bgcolor', 'colspan', 'rowspan', 'style'],
      th: ['width', 'height', 'align', 'valign', 'bgcolor', 'colspan', 'rowspan', 'style'],
      tr: ['align', 'valign', 'bgcolor', 'style'],
      col: ['width', 'span', 'style'],
      '*': ['style', 'align'],
    },
    allowedStyles: {
      '*': {
        color: anyStyle, 'background-color': anyStyle, background: anyStyle,
        'text-align': anyStyle, 'vertical-align': anyStyle,
        'font-weight': anyStyle, 'font-style': anyStyle, 'text-decoration': anyStyle,
        'font-size': anyStyle, 'font-family': anyStyle, 'line-height': anyStyle,
        width: anyStyle, 'max-width': anyStyle, height: anyStyle,
        margin: anyStyle, 'margin-top': anyStyle, 'margin-bottom': anyStyle, 'margin-left': anyStyle, 'margin-right': anyStyle,
        padding: anyStyle, 'padding-top': anyStyle, 'padding-bottom': anyStyle, 'padding-left': anyStyle, 'padding-right': anyStyle,
        border: anyStyle, 'border-color': anyStyle, 'border-width': anyStyle, 'border-style': anyStyle,
        'border-top': anyStyle, 'border-bottom': anyStyle, 'border-left': anyStyle, 'border-right': anyStyle,
        'border-radius': anyStyle, display: anyStyle,
      },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }),
    },
  });
}

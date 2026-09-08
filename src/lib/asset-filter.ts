/**
 * The asset list's sticky filter.
 *
 * Terry, 7 Sep 2026: "when looking at assets the filter needs to stay until cleared - add a
 * button if needed." The same rule the invoice list has had since 3 Sep, and for the same
 * reason: the filter lived only in the URL, so anything that came back to a bare /assets -
 * opening a device and clicking Assets to come back, finishing a batch, or the sidebar link -
 * dropped it, and narrowing eighty machines down to one customer's four laptops had to be done
 * again. Working through a filtered list one machine at a time is the normal way this page is
 * used, so that is the whole afternoon.
 *
 * The filter is remembered in the session and always written back into the URL, so the view
 * stays shareable, the back button still behaves and a bookmarked filter still means what it
 * says. Arriving with ANY filter key replaces what is remembered; ?clear=1 forgets it. That is
 * why "Clear filters" and the "devices shown" tile point at ?clear=1 rather than at a bare
 * /assets - a bare /assets now means "put my filter back".
 *
 * Kept out of routes/assets.ts so it can be tested on its own: `npm run test:asset-filters`.
 */

export const ASSET_FILTER_KEYS = [
  'q', 'customer', 'type', 'online', 'nouser', 'servers', 'agent', 'patch', 'sec',
  'make', 'model', 'cpu', 'ip', 'domain', 'rammin', 'rammax', 'tag', 'cj',
] as const;

/** The advanced conditions travel as three parallel arrays, so they are kept by position. */
export const COND_KEYS = ['cf', 'co', 'cv'] as const;

const arr = (v: any): string[] => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);

/** Exactly the filter the request is asking for, as a query string. Nothing else travels. */
export function assetFilterQuery(query: any): URLSearchParams {
  const asked = new URLSearchParams();
  for (const k of ASSET_FILTER_KEYS) {
    const v = String(query?.[k] ?? '').trim();
    // `cj` on its own is not a filter - it is how the conditions join, and it defaults to and.
    if (v && !(k === 'cj' && v.toLowerCase() === 'and')) asked.set(k, v);
  }
  // cf[i]/co[i]/cv[i] describe ONE condition between them, so they are re-emitted in index
  // order with their blanks intact. Dropping an empty operator would shift every condition
  // after it onto the wrong field, which is how a filter quietly shows the wrong machines.
  const [cf, co, cv] = COND_KEYS.map((k) => arr(query?.[k]));
  for (let i = 0; i < cf.length; i++) {
    if (!cf[i]) continue;
    asked.append('cf', cf[i]);
    asked.append('co', co[i] ?? '');
    asked.append('cv', cv[i] ?? '');
  }
  return asked;
}

export type StickyOutcome =
  /** ?clear=1 - forget the filter and send them to a clean list. */
  | { kind: 'clear' }
  /** Render now. `save` is what to remember, or null to forget what was remembered. */
  | { kind: 'use'; save: string | null }
  /** Nothing was asked for and something is remembered - put it back in the URL. */
  | { kind: 'restore'; to: string };

/**
 * What a request to /assets should do about the filter.
 *
 * `saved` is the session's remembered filter. The caller does the redirecting and the writing
 * to the session; everything that decides is here.
 */
export function stickyAssetFilter(query: any, saved: string | undefined | null): StickyOutcome {
  if (String(query?.clear ?? '') === '1') return { kind: 'clear' };

  // PRESENT, not merely non-empty. The filter form submits every control on every change, so
  // emptying the last dropdown by hand arrives as q=&customer=&type=... - an explicit "show me
  // everything". Restoring the saved filter there would make the dropdowns impossible to
  // clear. Only a request carrying NO filter key at all - a redirect, a back link, the sidebar
  // - means "put my filter back".
  const explicit = [...ASSET_FILTER_KEYS, ...COND_KEYS]
    .some((k) => Object.prototype.hasOwnProperty.call(query || {}, k));
  const asked = assetFilterQuery(query);

  if (explicit) return { kind: 'use', save: Array.from(asked.keys()).length ? asked.toString() : null };
  if (!saved) return { kind: 'use', save: null };

  const back = new URLSearchParams(saved);
  // Any message the redirect was carrying rides along, or a completed batch would lose its own
  // result on the way back to the list.
  for (const k of ['msg', 'err']) {
    const v = String(query?.[k] ?? '').trim();
    if (v) back.set(k, v);
  }
  return { kind: 'restore', to: '/assets?' + back.toString() };
}

import { getSetting } from './settings';

// Free stock-image search via Pexels (https://www.pexels.com/api/ — free key, generous limits,
// no attribution required). Key comes from the 'pexels'/'api_key' setting or env PEXELS_API_KEY.

export interface FreeImage { url: string; thumb: string; alt: string; credit: string; creditUrl: string; }

async function pexelsKey(): Promise<string> {
  return ((await getSetting('pexels', 'api_key')) || '').trim() || (process.env.PEXELS_API_KEY || '').trim();
}

export async function freeImagesConfigured(): Promise<boolean> {
  return !!(await pexelsKey());
}

export async function searchFreeImages(query: string, perPage = 12): Promise<FreeImage[]> {
  const key = await pexelsKey();
  if (!key) throw new Error('No image library connected — add a free Pexels API key in Settings → Integrations (get one at pexels.com/api).');
  const q = String(query || '').trim();
  if (!q) return [];
  let res: Response;
  try {
    res = await fetch(`https://api.pexels.com/v1/search?per_page=${perPage}&orientation=landscape&query=${encodeURIComponent(q)}`,
      { headers: { authorization: key }, signal: AbortSignal.timeout(12000) });
  } catch (e: any) {
    throw new Error('Could not reach the image library: ' + (e?.message || 'network error'));
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error('Pexels rejected the API key (401) — check it in Settings → Integrations.');
    throw new Error(`Image search error ${res.status}`);
  }
  const data: any = await res.json();
  return (data.photos || []).map((p: any): FreeImage => ({
    url: p.src?.large2x || p.src?.large || p.src?.original,
    thumb: p.src?.tiny || p.src?.small || p.src?.medium,
    alt: p.alt || '',
    credit: p.photographer || 'Pexels',
    creditUrl: p.photographer_url || p.url || 'https://www.pexels.com',
  }));
}

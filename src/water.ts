import type { LatLng } from './geo';

export interface LiveWater {
  current: { speed: number; dir: number } | null; // kn, direction the water flows towards
  tide: { height: number; station: string; km: number } | null; // m above lowest astronomical tide
}

/** Tide stations further away than this say little about the water here. */
const TIDE_MAX_KM = 50;
/** Use the lowest water over this long: a race outlasts the tide it started on. */
const TIDE_AHEAD_H = 3;

/**
 * Surface current from Open-Meteo's marine model (~8 km cells, so no eddies or harbour streams)
 * and the tide predicted for the nearest station by Open Waters. Both are free, keyless and
 * CORS-enabled. Either part is null where there is no data (lakes, far from any station).
 */
export async function fetchWater(p: LatLng, signal?: AbortSignal): Promise<LiveWater> {
  const get = async (url: URL) => {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`${url.host} returned ${res.status}`);
    return res.json();
  };
  const at = { latitude: p.lat.toFixed(4), longitude: p.lng.toFixed(4) };
  const marine = new URL('https://marine-api.open-meteo.com/v1/marine');
  marine.search = new URLSearchParams({ ...at, current: 'ocean_current_velocity,ocean_current_direction', wind_speed_unit: 'kn' }).toString();
  const tides = new URL('https://api.openwaters.io/tides/timeline');
  const now = Date.now();
  tides.search = new URLSearchParams({
    ...at,
    datum: 'LAT', // what EMODnet depths are reduced to
    start: new Date(now).toISOString(),
    end: new Date(now + TIDE_AHEAD_H * 3600e3).toISOString(),
  }).toString();

  const [m, t] = await Promise.allSettled([get(marine), get(tides)]);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const c = m.status === 'fulfilled' ? m.value?.current : null;
  const levels: number[] = t.status === 'fulfilled' ? (t.value?.timeline ?? []).map((x: { level: number }) => x.level).filter(Number.isFinite) : [];
  const near = t.status === 'fulfilled' && t.value.distance <= TIDE_MAX_KM && levels.length > 0;
  return {
    current: typeof c?.ocean_current_velocity === 'number' ? { speed: c.ocean_current_velocity, dir: c.ocean_current_direction ?? 0 } : null,
    tide: near ? { height: Math.min(...levels), station: t.value.station?.name ?? 'tide station', km: t.value.distance } : null,
  };
}

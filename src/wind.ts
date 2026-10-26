import type { LatLng } from './geo';

export interface LiveWind {
  speed: number; // kn
  dir: number; // deg, direction the wind blows from
  gusts: number; // kn
  time: string; // local ISO time of the observation
}

/** Current 10 m wind from Open-Meteo (free, no API key, CORS-enabled). */
export async function fetchWind(p: LatLng, signal?: AbortSignal): Promise<LiveWind> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: p.lat.toFixed(4),
    longitude: p.lng.toFixed(4),
    current: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    wind_speed_unit: 'kn',
    timezone: 'auto',
  }).toString();
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Weather service returned ${res.status}`);
  const data = await res.json();
  const c = data?.current;
  if (typeof c?.wind_speed_10m !== 'number') throw new Error('No wind data for this spot');
  return { speed: c.wind_speed_10m, dir: c.wind_direction_10m, gusts: c.wind_gusts_10m ?? c.wind_speed_10m, time: c.time };
}

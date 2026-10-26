export interface LatLng {
  lat: number;
  lng: number;
}

export const NM = 1852; // metres per nautical mile
const R = 6371000;
const DEG = Math.PI / 180;

/** Great-circle distance in metres. */
export function distance(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Initial true bearing from a to b, degrees 0–360. */
export function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin((b.lng - a.lng) * DEG) * Math.cos(b.lat * DEG);
  const x =
    Math.cos(a.lat * DEG) * Math.sin(b.lat * DEG) -
    Math.sin(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.cos((b.lng - a.lng) * DEG);
  return ((Math.atan2(y, x) / DEG) % 360 + 360) % 360;
}

/** Move a point by `metres` along `heading` (flat-earth, fine for a race course). */
export function offset(p: LatLng, heading: number, metres: number): LatLng {
  const north = metres * Math.cos(heading * DEG);
  const east = metres * Math.sin(heading * DEG);
  return {
    lat: p.lat + (north / R) / DEG,
    lng: p.lng + (east / (R * Math.cos(p.lat * DEG))) / DEG,
  };
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compassName = (deg: number) => POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

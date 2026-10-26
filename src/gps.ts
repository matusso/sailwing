import { KN } from './physics';
import { bearing, distance, type LatLng } from './geo';

export interface Fix {
  pos: LatLng;
  accuracy: number; // m
  sog: number | null; // kn, speed over ground
  cog: number | null; // deg, course over ground
  time: number; // ms epoch
}

/**
 * Wraps navigator.geolocation.watchPosition. Many phones report no speed/heading,
 * so SOG/COG fall back to the track between fixes once the boat has moved
 * further than the GPS noise.
 */
export class Gps {
  private watchId: number | null = null;
  private anchor: Fix | null = null;
  private derived: { sog: number; cog: number | null; time: number } | null = null;

  get active() {
    return this.watchId !== null;
  }

  start(onFix: (f: Fix) => void, onError: (msg: string) => void) {
    if (!('geolocation' in navigator)) return onError('This browser has no GPS access');
    if (!window.isSecureContext) return onError('GPS needs HTTPS — open the deployed site or run npm run dev:phone');
    this.anchor = null;
    this.derived = null;
    this.watchId = navigator.geolocation.watchPosition(
      (p) => onFix(this.toFix(p)),
      (e) => {
        onError(e.code === e.PERMISSION_DENIED ? 'Location permission denied' : `GPS: ${e.message || 'no signal'}`);
        if (e.code === e.PERMISSION_DENIED) this.stop();
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 },
    );
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  private toFix(p: GeolocationPosition): Fix {
    const c = p.coords;
    const fix: Fix = {
      pos: { lat: c.latitude, lng: c.longitude },
      accuracy: c.accuracy,
      sog: c.speed !== null && !Number.isNaN(c.speed) ? c.speed / KN : null,
      cog: c.heading !== null && !Number.isNaN(c.heading) ? c.heading : null,
      time: p.timestamp,
    };
    const a = this.anchor;
    if (!a) {
      this.anchor = fix;
      return fix;
    }
    const moved = distance(a.pos, fix.pos);
    const dt = (fix.time - a.time) / 1000;
    if (moved > Math.max(8, fix.accuracy) && dt > 0) {
      this.derived = { sog: moved / dt / KN, cog: bearing(a.pos, fix.pos), time: fix.time };
      this.anchor = fix;
    } else if (dt > 20) {
      // Barely moving for a while: we're stopped.
      this.derived = { sog: 0, cog: null, time: fix.time };
      this.anchor = fix;
    }
    // Between track updates, keep showing the last derived values for a while.
    const d = this.derived;
    if (d && fix.time - d.time < 15000) {
      fix.sog ??= d.sog;
      fix.cog ??= d.cog;
    }
    return fix;
  }
}

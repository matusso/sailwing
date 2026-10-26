# Sailwing

Wind on the map, sails in your hands.

- **Map (left):** click the water to place the boat. Live wind for that spot loads from [Open-Meteo](https://open-meteo.com). Set the wind yourself with the compass dial and speed slider.
- **Trim (right):** steer and sheet the main and jib, then read boat speed, apparent wind, VMG, heel and per-sail trim hints. *Auto-trim* finds the fastest sheet angles, and the polar shows the whole picture.
- **Plan:** pick a bearing, or switch the map to *Race track* and drop marks. Each leg gets the fastest strategy (direct, tacking or gybing), headings, sheet angles and an ETA. *Simulate* sails the course on the map.

- **GPS:** on a phone, tap **GPS**. The boat follows your real position, course and speed over ground. The sails stay auto-trimmed to your actual course, wind refreshes every 10 minutes, and the screen stays awake.
- **Race:** set up a course, then tap **Race**. The navigator works out how to reach the next mark fastest from where you are:
  - sail direct, or hold your tack until the optimal tack/gybe point, with a countdown and distance;
  - **Prepare** and **Tack now** alerts, with vibration on phones;
  - head-up / bear-away corrections and target speed vs. your speed;
  - laylines on the map, ETAs to the mark and the finish, and automatic mark rounding within 30 m.
  
  Tacks cost 10 s and gybes 6 s, so short legs aren't zig-zagged. **Simulate** races the course on autopilot using the same navigator. The course is saved on the device.

- **Land and depth:** the planner and the race navigator keep the boat off land and out of water shallower than your draft + 0.5 m, plus a margin off the shore and shoals (set both under *Plan → Safety*). Legs are routed around islands, headlands and shoals, tacks are placed on the side that has water, and a narrow channel gets short tacks. While racing, the navigator steers for the next detour waypoint, re-plans if you stray, and warns (with vibration) about land or shallows on the bow. On the map, red is too shallow and amber is too close to shore.
  - Land: OpenStreetMap water polygons via [OpenFreeMap](https://openfreemap.org) vector tiles (worldwide, lakes included, piers count as land).
  - Depth: [EMODnet Bathymetry](https://emodnet.ec.europa.eu/en/bathymetry) (~115 m grid, European seas only). Lakes and other seas have no depth data, so there you only get the shore margin.
  - This is not a nautical chart. Small rocks, moorings and anything newer than the data are missing, so keep a lookout.

Keyboard: `←` / `→` steer (hold Shift for 10°), `T` tack or gybe, `A` auto-trim.

## Develop

```sh
npm install
npm run dev     # http://localhost:5173
npm run dev:phone  # HTTPS on your LAN, for testing GPS on a phone (accept the self-signed cert)
npm test        # physics, navigator and routing unit tests
npm run build   # static site in dist/
```

## Deploy to Cloudflare Pages

It's a static site with no server code, live at **https://sailwing.burso.eu**.

- **GitHub Actions** (`.github/workflows/deploy.yml`): every push to `main` is tested, built and deployed to production. Pull requests get a preview URL. The first run creates the `sailwing` Pages project and attaches the custom domain.
  - Repo secrets: `CLOUDFLARE_API_TOKEN` (permission *Account → Cloudflare Pages → Edit*) and `CLOUDFLARE_ACCOUNT_ID`.
  - DNS: in the `burso.eu` zone, add a proxied `CNAME sailwing → sailwing.pages.dev`. If the zone is on the same Cloudflare account, the dashboard may offer to create it for you.
- **CLI:** `npm run deploy` (runs `wrangler pages deploy dist` using `wrangler.toml`).

`public/_headers` sets long-lived caching for hashed assets.

## The model

`src/physics.ts` is a simplified velocity-prediction model of a 7 m keelboat:

- Sails use lift/drag curves with stall and luffing.
- The hull has viscous, wave and leeway drag.
- Heel reduces drive.

Boat speed is the equilibrium where drive equals resistance. It's tuned for plausible numbers, not for racing a real boat.

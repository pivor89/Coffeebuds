# ☕ CoffeeBuds

Meet people nearby over coffee to learn together. Say you want to learn something, or offer to teach it, and CoffeeBuds invites everyone within 15 miles of the coffee shop who has the opposite role on that topic.

## Stack
Node.js (>=18) + Express 5 · SQLite through **sql.js** (WASM, so there's nothing native to build; the database is saved to `data/coffeebuds.sqlite`) · bcryptjs password hashing · express-session cookies · vanilla JS SPA · Leaflet + OpenStreetMap (Nominatim geocoding, Overpass café search with a Nominatim fallback) · Inter + Fraunces.

## Run
```bash
npm install
npm start            # http://localhost:3000  (PORT env var to change)
npm test             # matching unit tests (node:test)
npm run e2e          # end-to-end HTTP checks against a running server
npm run screenshots  # Playwright screenshots → screenshots/ (needs: npx playwright install chromium)
```
On first start the app seeds 8 users around Tampa, FL, plus 4 coffee shops.
**Demo login:** `demo@coffeebuds.app` / `coffee123`. Every seed user has the password `coffee123` (maya@, jordan@, priya@, sam@, lena@, diego@, grace@example.com).
To reset, delete `data/coffeebuds.sqlite`.

## Matching rule
`src/matching.js` → `findRecipients()`: candidates are users who have a home lat/lng and whose normalized topic (lowercased, trimmed, spaces collapsed) equals the invite's topic with the **opposite** role (learn ↔ teach). The creator is excluded. A candidate is invited if their haversine distance **from the coffee shop** is ≤ 15 miles.

## Env vars
`PORT`, `SESSION_SECRET` (required in prod), `DB_PATH`, `NODE_ENV=production` (secure cookies), `OVERPASS_URL`.

## Deploy
The app is a single Node process that needs a persistent disk for the SQLite file.
- **Render**: New Web Service → build `npm install`, start `npm start`. Add a Disk mounted at `/var/data` and set `DB_PATH=/var/data/coffeebuds.sqlite` and `SESSION_SECRET`.
- **Railway**: deploy the repo, add a Volume at `/data`, and set `DB_PATH=/data/coffeebuds.sqlite` and `SESSION_SECRET`.
- **Fly.io**: `fly launch` (Node), `fly volumes create data`, mount it at `/data` in `fly.toml`, set `DB_PATH` and `fly secrets set SESSION_SECRET=...`.
Sessions use the in-memory store, so logins reset on restart. For multiple instances or durable sessions, use a persistent session store (e.g. connect-sqlite3 or Redis), and/or move to Postgres.

## Limitations
- sql.js keeps the DB in memory and rewrites the file after each write. That's fine for small and medium use, but it runs as a single instance.
- Public OSM endpoints are rate-limited; for real traffic, self-host them or use a provider. The app falls back to saved shops plus manual entry.
- Notifications are in-app only (30s polling); no email or push.

## Photo credits
Free-license photos from [Unsplash](https://unsplash.com/license) (Unsplash License: free to use, attribution appreciated), stored in `public/images` and resized to WebP. Each page gets its own photo, plus a blurred `-blur.webp` variant for the full-page background under a cream overlay:
| Page | File | Unsplash photo |
|---|---|---|
| Login / sign up hero | `login.webp` | friends chatting over coffee at a café table: https://unsplash.com/photos/1543269865-cbf427effbad |
| Invites inbox | `inbox.webp` | three friends laughing at a café table: https://unsplash.com/photos/1522202176988-66273c2fd55f |
| New meetup | `new.webp` | busy coffee shop with people talking: https://unsplash.com/photos/1525610553991-2bede1a236e2 |
| My meetups | `meetups.webp` | group of friends at a sunny café table: https://unsplash.com/photos/1528605248644-14dd04022da1 |
| Profile | `profile.webp` | people talking around a wooden table in warm light: https://unsplash.com/photos/1517048676732-d65bc937f952 |
| Notifications | `notifications.webp` | small group meeting at a café table: https://unsplash.com/photos/1521737604893-d14cc237f11d |

## Themes
**Bright Parisian café** (`paris`) is the default look for every visitor: airy ivory and cream with soft caramel, italic Playfair Display headings, photos of sunny Paris-style café terraces. No cookie is needed. Old `theme` cookies set to `classic` or `lounge` (and any `?theme=` value) are ignored, so everyone sees Paris.

The classic (warm coffee and caramel) and Luxury lounge (espresso, burgundy and gold) styles remain in the code but are currently unused.

A small inline script in `index.html` always adds `data-theme="paris"` to `<html>` before first paint. Theme styles live at the end of `public/style.css`. Run `node scripts/theme-screenshots.js` to take mobile screenshots of both themes (`screenshots/theme-*.png`).

### Theme photo credits
Free-license photos from [Pexels](https://www.pexels.com/license/) (Pexels License) and [Unsplash](https://unsplash.com/license) (Unsplash License), resized to WebP, each with a blurred `-blur.webp` variant for the page background.

**Paris** (`public/images/paris/`)
| Page | File | Photo |
|---|---|---|
| Login / sign up | `login.webp` | people at a sunny Parisian café terrace, by Markus Winkler (Unsplash): https://unsplash.com/photos/IAqkfmX6K1M |
| Invites inbox | `inbox.webp` | two friends laughing over coffee at a sidewalk café (Pexels): https://www.pexels.com/photo/5047023/ |
| New meetup | `new.webp` | people chatting at a Paris street café (Pexels): https://www.pexels.com/photo/24415132/ |
| My meetups | `meetups.webp` | busy Parisian café terrace in summer (Pexels): https://www.pexels.com/photo/28179772/ |
| Profile | `profile.webp` | two friends talking over coffee in a bright café (Pexels): https://www.pexels.com/photo/36765287/ |
| Notifications | `notifications.webp` | two men talking over coffee on a café terrace (Pexels): https://www.pexels.com/photo/11284053/ |

**Lounge** (`public/images/lounge/`)
| Page | File | Photo |
|---|---|---|
| Login / sign up | `login.webp` | women talking in a plush hotel lounge with velvet armchairs (Pexels): https://www.pexels.com/photo/3926224/ |
| Invites inbox | `inbox.webp` | three women chatting in an upscale lounge (Pexels): https://www.pexels.com/photo/3926221/ |
| New meetup | `new.webp` | conversation on velvet armchairs in a warmly lit lounge (Pexels): https://www.pexels.com/photo/3926226/ |
| My meetups | `meetups.webp` | friends chatting at a lamp-lit table in an elegant salon (Pexels): https://www.pexels.com/photo/3926216/ |
| Profile | `profile.webp` | couple relaxing in a stylish lounge with leather seating (Pexels): https://www.pexels.com/photo/30271475/ |
| Notifications | `notifications.webp` | friends talking in an upscale lounge, seen up close (Pexels): https://www.pexels.com/photo/3926223/ |

## Deploying on Render (free tier)

`render.yaml` is included (Blueprint). Manual settings: Runtime **Node**, Build `npm install`, Start `npm start`, Plan **Free**, env `NODE_ENV=production`, `SESSION_SECRET=<random>` (optionally `NODE_VERSION=20`). The app listens on `process.env.PORT` and binds `0.0.0.0`.

**Data is ephemeral:** Render free has no persistent disk. The SQLite file (`DB_PATH`, default `data/coffeebuds.sqlite`) is wiped on every redeploy, restart and spin-down (after ~15 min idle). On each fresh start the app auto-seeds demo data, so it always works — login `demo@coffeebuds.app` / `coffee123` — but user-created accounts/posts will not survive. Sessions also reset.

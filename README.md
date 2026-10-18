# ☕ CoffeeBuds

Meet people nearby over coffee to learn together. Say you want to learn something, or offer to teach it, and CoffeeBuds invites everyone within 15 miles of the coffee shop who has the opposite role on that topic.

## Stack
Node.js (>=18) + Express 5 · **Postgres** (via `pg`, e.g. a free [Neon](https://neon.tech) database) when `DATABASE_URL` is set, otherwise SQLite through **sql.js** (WASM, so there's nothing native to build; the database is saved to `data/coffeebuds.sqlite`) · bcryptjs password hashing · express-session cookies · vanilla JS SPA · Leaflet + OpenStreetMap (Nominatim geocoding, Overpass café search with a Nominatim fallback) · Inter + Fraunces.

## Run
```bash
npm install
npm start            # http://localhost:3000  (PORT env var to change)
npm test             # matching unit tests (node:test)
npm run e2e          # end-to-end HTTP checks against a running server
npm run screenshots  # Playwright screenshots → screenshots/ (needs: npx playwright install chromium)
```
On first start the app seeds 8 users around Tampa, FL, plus 4 coffee shops.
**Local dev seed data:** when `NODE_ENV` is not `production`, an empty DB is seeded with test users (`demo@coffeebuds.app`, maya@/jordan@/… @example.com, password `coffee123`). Production never seeds, and on startup deletes the seeded `demo@coffeebuds.app` account if it still has the seed password.
To reset, delete `data/coffeebuds.sqlite` (SQLite mode) or drop the tables (Postgres mode). Seeding runs only when the `users` table is empty, so restarts never duplicate or overwrite real data.

## Matching rule
`src/matching.js` → `findRecipients()`: candidates are users who have a home lat/lng and whose normalized topic (lowercased, trimmed, spaces collapsed) equals the invite's topic with the **opposite** role (learn ↔ teach). The creator is excluded. A candidate is invited if their haversine distance **from the coffee shop** is ≤ 15 miles.

## Env vars
`PORT`, `SESSION_SECRET` (required in prod), `DATABASE_URL`, `DB_PATH`, `NODE_ENV=production` (secure cookies), `OVERPASS_URL`, `PG_POOL_MAX` (default 5).

### Database: `DATABASE_URL`
- **Set** (e.g. `postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require`): all app data **and** sessions live in Postgres. On startup the app creates the tables and indexes (`CREATE TABLE IF NOT EXISTS`), and `connect-pg-simple` creates the `session` table. SSL is on with `rejectUnauthorized: false`; any `sslmode` in the URL is ignored in favor of that. `localhost` URLs (or `sslmode=disable`) connect without SSL, for local testing.
- **Unset**: SQLite via sql.js at `DB_PATH` (default `data/coffeebuds.sqlite`), with sessions in the same file. Local dev and tests use this mode.

To get a free Neon database: create a project at neon.tech, copy the connection string, and set it as `DATABASE_URL`.

## Deploy
The app is a single Node process. It needs either `DATABASE_URL` (Postgres) or a persistent disk for the SQLite file.
- **Render (free tier, via `render.yaml`)**: the free tier's filesystem is wiped on restart, so set `DATABASE_URL` to your Neon connection string in the dashboard (it's declared with `sync: false` in `render.yaml`). `SESSION_SECRET` is generated automatically.
- **Render with a disk (paid)**: alternatively add a Disk at `/var/data` and set `DB_PATH=/var/data/coffeebuds.sqlite`.
- **Railway**: deploy the repo, add a Volume at `/data`, and set `DB_PATH=/data/coffeebuds.sqlite` and `SESSION_SECRET`.
- **Fly.io**: `fly launch` (Node), `fly volumes create data`, mount it at `/data` in `fly.toml`, set `DB_PATH` and `fly secrets set SESSION_SECRET=...`.
Sessions are stored in the database (Postgres `session` table or the SQLite `sessions` table), so logins survive restarts.

## Limitations
- In SQLite mode, sql.js keeps the DB in memory and rewrites the file after each write. That's fine for small and medium use, but it runs as a single instance. Use Postgres mode for durability.
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
| Login / sign up | `login.webp` | three friends of different backgrounds chatting and laughing over coffee at a bistro table outside a street café, by William Fortunato (Pexels): https://www.pexels.com/photo/6140394/ |
| Invites inbox | `inbox.webp` | mixed group of friends laughing over coffee in a bright café, by RDNE Stock project (Pexels): https://www.pexels.com/photo/4920887/ |
| New meetup | `new.webp` | people chatting at a Paris street café (Pexels): https://www.pexels.com/photo/24415132/ |
| My meetups | `meetups.webp` | diverse friends catching up over coffee in a cozy café, by RDNE Stock project (Pexels): https://www.pexels.com/photo/4921513/ |
| Profile | `profile.webp` | two women of different backgrounds chatting over coffee in a bright café, by Alexander Suhorucov (Pexels): https://www.pexels.com/photo/6457519/ |
| Notifications | `notifications.webp` | multiethnic friends chatting over coffee, by John Diez (Pexels): https://www.pexels.com/photo/7388884/ |
| Photos (Meetups wall) | `wall.webp` | multicultural friends meeting over coffee in a café (Pexels): https://www.pexels.com/photo/8067743/ |
| Admin | `admin.webp` | four women of diverse backgrounds chatting on a coffee break, by Yan Krukau (Pexels): https://www.pexels.com/photo/8837203/ |

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

**Data is ephemeral:** Render free has no persistent disk. The SQLite file (`DB_PATH`, default `data/coffeebuds.sqlite`) is wiped on every redeploy, restart and spin-down (after ~15 min idle). Production does not seed demo data; use DATABASE_URL (Postgres) for persistence. Sessions also reset.

# gh-dashboard (Nudgebox)

**Nudgebox** at **gh.bioinfolder.com**: the Jeong Lab's GitHub inbox for pull requests
and issues, on a Mac browser and an iPhone home screen, with push notifications.

- What it does: [`SPEC.md`](SPEC.md)
- Why it is built this way: [`docs/decisions.md`](docs/decisions.md)

## Status

Works against real GitHub (read-only check: `npm run live-check`). Not deployed yet:
the GitHub App and the bioinfolder-srv setup come next.

| Path | What |
|---|---|
| `src/app.ts` | HTTP routes, linking GitHub, actions, webhooks, push, sync and stale digest |
| `src/inbox.ts` | which section a PR is in (SPEC 5) |
| `src/store.ts` | SQLite: linked people (tokens sealed), PRs, devices, notified marks |
| `src/github.ts` | the interface to GitHub; `src/octokit-github.ts` is the real one |
| `src/server.ts` | production entry: config.yaml + .env, two listeners, timers |
| `src/public.ts` | the public listener: webhook + static files only |
| `public/` | the web app: page, script, service worker, manifest, icons |

## Running

```sh
cp .env.example .env    # fill in (GitHub App, TOKEN_KEY, VAPID keys); chmod 600
docker build -t gh-dashboard .
```

Two ports, on purpose (see `src/server.ts`):

- **8080, the app.** Only the Keycloak sidecar may reach it, because the app trusts the
  sidecar's identity headers. Never publish it on the host.
- **8081, public.** Only `POST /webhook` (GitHub-signed) and the static files. nginx
  sends GitHub's webhooks and the manifest/icons here.

## Tests

```sh
npm install
npx playwright-core install chromium-headless-shell   # once, for the page tests
scripts/get-omnidiff.sh   # once: the pinned omnidiff at bin/omnidiff (SPEC 15)
npm test            # acceptance, adapter and page (tests/ui) tests, no network (fake GitHub)
npm run typecheck
npm run live-check  # read-only: real open PRs via your gh login, mapped and sectioned
```

Tests are numbered by SPEC section (e.g. `5. inbox sections and order`).

To look at the page with example data and no accounts: `node --import tsx scripts/demo.ts 8099`,
then open http://127.0.0.1:8099/. `node scripts/shots.mjs http://127.0.0.1:8099/ /tmp/nudgebox`
saves desktop and phone screenshots, light and dark.

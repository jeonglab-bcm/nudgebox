# Nudgebox

**Nudgebox**: one GitHub inbox for a lab's pull requests and issues, on a desktop
browser, the desktop app and an iPhone home screen, with push notifications and
AI-guided review. The Jeong Lab runs it at **gh.bioinfolder.com**; any lab can run its
own (see [Run your own](#run-your-own)).

- What it does: [`SPEC.md`](SPEC.md)
- Why it is built this way: [`docs/decisions.md`](docs/decisions.md)

## Code

| Path | What |
|---|---|
| `src/app.ts` | HTTP routes, linking GitHub, actions, webhooks, push, sync and stale digest |
| `src/inbox.ts` | which section a PR is in (SPEC 5) |
| `src/store.ts` | SQLite: linked people (tokens sealed), PRs, devices, notified marks |
| `src/conflicts.ts` | resolving a PR's conflicts: what to take, merge (`git merge-file`) or show with markers (SPEC 16) |
| `src/github.ts` | the interface to GitHub; `src/octokit-github.ts` is the real one |
| `src/server.ts` | production entry: config.yaml + .env, two listeners, timers |
| `src/config.ts` | reads and checks config.yaml (`deploy/config.example.yaml` shows every key) |
| `src/llm.ts` | the AI providers: OpenAI, Anthropic, OpenAI-compatible (SPEC 20) |
| `src/public.ts` | the public listener: webhook + static files only |
| `public/` | the web app: page, script, service worker, manifest, icons |

## Run your own

You need a machine with Docker, a domain with HTTPS in front of it, and admin rights
on the GitHub organization whose PRs you want.

1. **Get the code:** `git clone https://github.com/jeonglab-bcm/nudgebox && cd nudgebox/deploy`
2. **Create the GitHub App** Nudgebox reads PRs through. This writes `.env` and
   `github-app.pem` here, with fresh `TOKEN_KEY` and VAPID keys:
   ```sh
   npm install   # in the repository root, once
   node ../scripts/create-github-app.ts . --site https://review.example.org --org example-lab \
     --name "Example Lab Nudgebox" --contact mailto:you@example.org
   ```
   Open the printed address, click **Create on GitHub**, then install the App on your
   organization (all repositories).
3. **Create a GitHub OAuth App for sign-in** (organization Settings → Developer
   settings → OAuth Apps), with the callback `https://review.example.org/oauth2/callback`.
   Add the `SIGNIN_*` lines from `../.env.example` to `.env` with its client id and
   secret, your organization, and a cookie secret.
4. **Configure:** `cp config.example.yaml config.yaml` and set `origin`, `orgs`,
   `admins` (your GitHub login) and, if you want, `llm`.
5. **Start:** `docker compose up -d --build`, and point your HTTPS proxy (Caddy,
   nginx, Cloudflare Tunnel…) at `127.0.0.1:4180`.
6. **Open your site**, sign in with GitHub, connect GitHub once, and turn on
   notifications in Settings. An admin can choose the AI provider in **Settings → AI**:
   OpenAI, Anthropic, or any OpenAI-compatible server such as Ollama or vLLM.

Sign-in goes through oauth2-proxy and only members of `SIGNIN_GITHUB_ORG` get in. The
app takes who you are from oauth2-proxy's headers, so it has two ports, on purpose:

- **8080, the app.** Only the sign-in sidecar may reach it, because the app trusts the
  sidecar's identity headers. Never publish it on the host.
- **8081, public.** Only `POST /webhook` (GitHub-signed) and the static files.

The Jeong Lab's own deployment uses Keycloak instead of GitHub sign-in (in the private
bioinfolder-srv repository); both send the same headers.

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

## Desktop app (SPEC 18)

`desktop/` is the Tauri app for Mac and Linux. It opens a Nudgebox site and shows
notifications from the server's live stream (`/api/events`). Build locally with
`cd desktop && npx @tauri-apps/cli@2.12.4 build`. To release, push a tag `app-v<version>`:
`.github/workflows/desktop.yml` builds the Mac `.dmg`s and the Linux `.AppImage`/`.deb`
and attaches them to a GitHub Release.

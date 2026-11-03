# gh-dashboard

**gh.bioinfolder.com**: one inbox for the Jeong Lab's open pull requests, on a Mac
browser and an iPhone home screen, with push notifications.

- What it does: [`SPEC.md`](SPEC.md)
- Why it is built this way: [`docs/decisions.md`](docs/decisions.md)

## Status

The app passes all acceptance tests against a fake GitHub. Not deployed yet: the real
GitHub adapter (Octokit), the server entry point and the Docker/nginx setup come next.

| Path | What |
|---|---|
| `src/app.ts` | HTTP routes, linking GitHub, actions, webhooks, push, sync and stale digest |
| `src/inbox.ts` | which section a PR is in (SPEC 5) |
| `src/store.ts` | SQLite: linked people (tokens sealed), PRs, devices, notified marks |
| `src/github.ts` | the interface to GitHub |
| `public/` | the web app: page, script, service worker, manifest, icons |

## Tests

```sh
npm install
npm test          # acceptance tests (tests/acceptance), no network: a fake GitHub
npm run typecheck
```

Tests are numbered by SPEC section (e.g. `5. inbox sections and order`).

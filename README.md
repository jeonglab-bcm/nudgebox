# gh-dashboard

**gh.bioinfolder.com**: one inbox for the Jeong Lab's open pull requests, on a Mac
browser and an iPhone home screen, with push notifications.

- What it does: [`SPEC.md`](SPEC.md)
- Why it is built this way: [`docs/decisions.md`](docs/decisions.md)

## Status

Spec and acceptance tests only. The tests define the app and all fail until it is
built (`src/app.ts` is a stub).

## Tests

```sh
npm install
npm test          # acceptance tests (tests/acceptance), no network: a fake GitHub
npm run typecheck
```

Tests are numbered by SPEC section (e.g. `5. inbox sections and order`).

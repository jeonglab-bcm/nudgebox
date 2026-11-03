# gh-dashboard decisions

Change this file by PR. The spec is [`SPEC.md`](../SPEC.md); this file records why.

## 2026-11-02: What and for whom (from the interview)

Dr. Jeong's answers:

- Pain: can't see all PRs at once, don't know what needs me, CI status.
- Users: Dr. Jeong and lab members, each with their own view.
- Repos: jeonglab-bcm for everyone, plus hyunhwan-bcm for Dr. Jeong.
- Show **all** open PRs, not only review requests ("someone might not ask to review").
- Main view: an inbox with "needs you" first.
- Actions: show plus simple actions (merge, approve, re-run, comment), nothing destructive.
- Notifications: iPhone and Mac push only. Slack via Alpy was chosen, then dropped.
- Stale after 3 days, configurable.
- New repo, running on anjanda.

## 2026-11-02: Build our own instead of adopting a tool

Existing tools each cover part of it, none the whole:

- **github.com/pulls**: GitHub's cross-repo PR list. No "needs me" grouping, no push.
- **GitHub Mobile**: iOS push, but per-repo and noisy; no lab-wide inbox.
- **gh-dash** (`dlvhdr/gh-dash`): a well-used terminal PR dashboard. Terminal only, no phone.
- **Gitify**: macOS menu-bar notifications. No iPhone, no inbox.
- **Graphite**: PR inbox with stack support. Hosted; needs org-wide access granted to
  a third party.

What is missing is one view behind the lab's own login, on Mac and iPhone.

## 2026-11-02: How it is built, with evidence

- **TypeScript on Node 24, tests with `node:test` via `tsx`**: same as labbot, so one
  toolchain in the lab.
- **Octokit** (`@octokit/app`, `@octokit/webhooks`): GitHub's official SDK. Handles
  App auth, installation and user tokens, and webhook signature checks.
- **A lab-owned GitHub App**, not a personal token or another vendor's app. The two
  apps already on jeonglab-bcm (Slack's and Claude's) belong to their vendors; their
  access and webhooks cannot be used by us. A GitHub App gives org webhooks plus
  per-user tokens, so actions are attributed to the person who clicked.
- **User tokens expire** (8 h, refresh token 6 months, per GitHub's docs on GitHub App
  user access tokens), so a leaked token is short-lived; stored encrypted anyway.
- **Visibility via the user's own token** (`GET /user/installations/{id}/repositories`
  returns repos both the App and the person can access). One rule covers private lab
  repos and hyunhwan-bcm without a separate permission table.
- **Web Push** with the `web-push` library (VAPID). iOS supports Web Push for web apps
  added to the Home Screen since iOS 16.4 (WebKit, "Web Push for Web Apps on iOS and
  iPadOS", 2023); Safari on macOS since 16. No App Store app needed.
- **SQLite** (`better-sqlite3`): one file, enough for a lab; easy to back up with the
  rest of anjanda.
- **Keycloak via the oauth2-proxy sidecar**: the pattern every bioinfolder app uses.
- **Webhooks plus a 10-minute sync**: GitHub does not retry failed deliveries
  automatically, so a periodic sync is the safety net.

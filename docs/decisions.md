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
- **SQLite** (`node:sqlite`, built into Node 24): one file, enough for a lab; easy to
  back up with the rest of anjanda. Chosen over `better-sqlite3` while building
  (2026-11-02): no native module to compile, and it ran without an experimental
  warning on Node 24.18.
- **Keycloak via the oauth2-proxy sidecar**: the pattern every bioinfolder app uses.
- **Webhooks plus a 10-minute sync**: GitHub does not retry failed deliveries
  automatically, so a periodic sync is the safety net.

## 2026-11-02: Two listeners, so identity can only come from the sidecar

The app trusts `X-Forwarded-*` from the Keycloak sidecar. GitHub's webhooks and the
web-app manifest/icons must be reachable without signing in, and if they shared the
app's port, anything that can reach that port could forge identity headers. So the
app listens twice (`src/server.ts`): the full app on a port only the sidecar can reach
(compose network, never published), and a public port that serves only `POST /webhook`
and static files and strips identity headers (`src/public.ts`, tested). Same idea as
llm-proxy's unpublished trusted `:8081` in bioinfolder-srv.

## 2026-11-02: No build step

Node 24 runs TypeScript directly when it uses only erasable syntax
(`erasableSyntaxOnly` in tsconfig enforces it), so the image runs `node src/server.ts`
and tsx/typescript stay dev-only.

## 2026-11-03: Tabs, hiding old PRs, and issues (after first use)

First use: AURORA's only open PR was in the inbox but buried under ~40 others in one
long list. Dr. Jeong's answers:

- Status tabs (Needs you · WIP · CI failing · All; "WIP" was "Waiting", renamed as clearer) plus a repo filter, rather than
  one tab per repo (too many repos for a row of tabs on a phone).
- Auto-fold PRs with no activity for 30 days into "Old"; configurable.
- Hide = until something changes, not a fixed snooze, so nothing is lost silently.
- Hidden and old items send no push and skip the stale digest.
- Issues: a separate tab, all open issues, **read-only**; push when assigned,
  @mentioned, or someone comments on an issue you opened or are assigned to.

The App needs the `issues` webhook event added (it already has Issues: read, so no
installation has to re-approve).

## 2026-11-03: Named "Nudgebox"

"Lab PRs" stopped fitting once issues were added. Dr. Jeong wanted something with
character that still reads as an inbox, and chose **Nudgebox** (the box that nudges
you: the needs-you tab plus push). "Octobox" was avoided: it is an existing GitHub
notifications product. The GitHub App is renamed to match; the repo name and the
gh.bioinfolder.com address stay.

## 2026-11-03: AI summary through the lab LLM

Dr. Jeong asked for an AI summary using llm.bioinfolder.com. His answers: summarize
**each PR and each issue** (no whole-inbox digest), **on click** only, cached until the
item changes, rather than pre-generating for every open item. The lab LLM keeps private
repo content in the lab; a test call answered in ~1.4 s. Nudgebox gets its own `bif_`
token (portal.bioinfolder.com/tokens) so its use is separate from labbot's.

## 2026-11-03: Triage list, "Glass" look

Dr. Jeong found the GitHub-style cards generic. He chose a **dense triage list**
(one line per item, keyboard-driven, like a mail client) over an editorial briefing
or a bold branded look. Three skins of the same list were then built side by side
with the `modern-web-design` skill (freshtechbro/claudedesignskills): bold minimal,
glass, and a lab-notebook look; he picked **glass** (dark first, frosted bars).
Fonts (Outfit, IBM Plex Mono, both OFL) are served by Nudgebox so the private app
makes no requests to Google.

## 2026-11-04: Bold minimal look

After a day with the glass look, Dr. Jeong asked to switch Nudgebox to the **bold
minimal** skin from the 2026-11-03 comparison: monochrome with a coral accent and big
tab counts, light first. The list's structure and keys are unchanged. Fonts are now
Inter, Space Grotesk and JetBrains Mono, still served by Nudgebox.

# Nudgebox decisions

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

## 2026-11-04: Diffs with omnidiff

Dr. Jeong asked for a better diff than GitHub's, pointing at omnidiff
(github.com/ivankovic/omnidiff, v0.3.0 of 2026-11-01, one author). Proof of concept
before building: on this repo's own `public/app.js` (about 550 lines) it took 0.09 s and
73 MB, and its `--mode json` gives per-side hunks (insert, delete, update, move with a
target) with byte columns, which Nudgebox turns into UTF-16 columns for the page.
Accuracy figures are the author's own. It is AGPL-3.0; Nudgebox runs the unmodified
release as a separate program inside its private image, pinned by version and SHA-256.
It does not parse Markdown (diffed as plain text); rendered Markdown diffs are
Nudgebox's own work. He chose "any two files" for compare and rendered `.md` files.

## 2026-11-05: Binary diffs, and drawing PDF pages

Dr. Jeong asked for diffs of binary files. omnidiff's JSON already compares them by
content (proof of concept on a PNG, a ZIP and a PDF pair: under 0.01 s each), but it
gives facts, not pictures: changed areas of a picture, and the members (files, glyphs,
pages) of a container. So Nudgebox draws them: pictures from a new `/api/file`
(type from the bytes only, sandbox CSP), and, as he chose, changed PDF pages with pdf.js
6.5.438 (Mozilla, Apache-2.0, vendored, loaded only for a PDF). Binary files go to
10 MB (through the git blob API above 1 MB); text diffs stay at 1 MB.

## 2026-11-05: The PR page

Dr. Jeong asked for "the GitHub PR page, but OmniDiff": GitHub itself has no way to use
another diff viewer, and a browser extension that rewrites github.com would break with
each GitHub change, so Nudgebox has its own PR page instead. He chose GitHub's layout
and buttons ("the same button and user interface") in Nudgebox's own look; the
Conversation, Commits, Checks and Files changed tabs; inline review on the omnidiff
view; Viewed; the sidebar; the merge box with conflicts; and a Close button (so SPEC 6
now allows Close and Reopen, still no delete branch, force-push or edits). Enter and a
tap on a title now open this page; `g` opens GitHub.

- **Read as the person**, not the App: a pending review and Viewed ticks belong to each
  reader, and GitHub only shows them to their owner.
- **Line comments only where GitHub takes them**: GitHub anchors review comments to the
  PR's unified diff hunks, which are not omnidiff's hunks, so the + comes from the
  patch's hunk ranges, not from omnidiff's marks.
- **Pending reviews live on GitHub** (as on github.com), so a review started in Nudgebox
  can be finished on GitHub or on another device.
- **Conflicts**: there is no GitHub API for its conflict editor. Nudgebox merges each
  file with `git merge-file` (installed in the image), lets the person resolve, then
  writes one merge commit with the Git Data API and moves the branch only as a
  fast-forward, so it never overwrites a push made meanwhile. Rename and delete
  conflicts and binary files are left to the command line, as on GitHub.


## 2026-11-06: Phone diff, icon, Explain

Dr. Jeong found the diff hard to follow on a phone: the whole old file, then the whole
new one below it. Three working layouts were built and shown side by side as phone
screenshots (unified column, a Before/After switch, change-by-change cards); he chose the
**unified column**, as GitHub shows on a phone, with omnidiff's in-line marks kept. On
a phone a line number is tapped to comment (the + buttons covered the numbers), and the
open file's row stays at the top. Computers keep before and after side by side.

The icon was GitHub's own pull-request symbol in green, which said nothing about
Nudgebox and clashed with the coral look. Of four designs in Nudgebox's palette, shown
at tab and Home Screen size, he chose the **triage list**: three rows, the top one
marked with the coral dot.

**Explain** asks the lab LLM about one file's changes, per file (he first picked per
change, then corrected it to per file). The server reads both file versions itself and
sends only the changed runs with 3 lines around them, so a large file still fits and the
page cannot put text in front of the model.

## 2026-11-06: Desktop app, and the rename to Nudgebox

Web push in Chrome on Dr. Jeong's Mac reached the browser and Chrome reported the
notification shown, but macOS never showed it. Rather than chase each browser's
notification settings, he asked for a standalone app for Mac and Linux, built with
Tauri. Tauri uses the system's WebKit view, which cannot receive web push at all, so
the app gets its notifications over a **live stream** (`/api/events`, Server-Sent
Events) from the server and shows them itself. He chose the stream with a menu-bar/tray
app that keeps running when its window is closed, over a plain window (notifications
would stop when it closed). Trade-off: no notifications while the app is not running;
web push to the iPhone covers that.

The app opens the real site rather than bundling the page, so the lab sign-in, the
page and its updates stay in one place. Releases are built by GitHub Actions (a Mac
build needs a Mac), unsigned for now: no Apple Developer ID yet.

The repository, package and deployment are renamed from gh-dashboard to **nudgebox**,
the product's name. The address stays gh.bioinfolder.com. The `ghd-*` keys in the
browser's storage keep their names so nobody loses their saved theme and view.

## 2026-11-06: Guided review

Dr. Jeong finds big PRs hard to review and asked how tools like CodeRabbit use agents.
He wants a human in the loop with as little tedium as possible. The design: the agent
prepares (noise hidden, steps in reading order, draft comments), the person decides
with one key each, and a push only brings back the steps whose files changed.

He chose the **lab LLM** for preparation, with a later **Deep review** button that
sends one PR to Claude, and running it **inside the Nudgebox server**. The first
version is the queue with drafts; tool-using context gathering and asking about a step
come later.

Each draft is checked by a second call that tries to prove it wrong. Tried on PR #28
with qwen3.8-flash: the first prompts gave 5 drafts, 4 of them speculative ("no error
handling if the server sends bad data"), and the check kept them. With both prompts
naming what is not a problem (own data, guesses about unseen code, missing handling
without a failure) and the check told to answer false when in doubt, the speculative
ones are dropped. The lab model will rarely find subtle bugs; that is what Deep review
is for. Planning the steps worked well on the first try (5 steps, sensible order,
valid JSON, about 7 s).

## 2026-11-07: AI settings with OpenAI, Anthropic or OpenAI-compatible

Dr. Jeong wants other labs to be able to run their own Nudgebox outside bioinfolder
(issue #33), and asked how they would choose an LLM. Not every lab has its own model
server, so the LLM is chosen on the settings page by an admin rather than only in
`config.yaml`. Three providers, as Dr. Jeong asked: **OpenAI**, **Anthropic**, and
**OpenAI-compatible** for everything with that API (the lab LLM, Ollama, vLLM,
OpenRouter). Ollama is not its own choice: it is an OpenAI-compatible address.

Anthropic goes through its own Messages API with the official SDK, not its
OpenAI-compatible endpoint, so Claude's own features (adaptive thinking, refusal
fallback, later the tools Deep review needs) work. Models that take it get Anthropic's
server-side fallback on a refusal. Note: SDK 1.x sends the API key as
`Authorization: Bearer`, not `x-api-key`.

Until now every request carried Qwen's `chat_template_kwargs`, which OpenAI refuses.
It is now sent only when the "Qwen: turn thinking off" box (`noThinking`) is on; the
lab's `config.yaml` sets it. For OpenAI itself, requests use `max_completion_tokens`
and no `temperature`, which its reasoning models require.

The key is stored with the same AES-GCM sealing as GitHub tokens. Admins are listed in
`config.yaml`, because there was no admin role before and the settings page is the
first thing that needs one.


## 2026-11-09: Guided review: a list of steps, then one step alone

Dr. Jeong after using it on real PRs: "still not usable", "the layout is a joke and not
convenient", and reviewing as text is tiring. The first layout put everything on one
long page under the PR's header and tabs: the step, its drafts and every file's whole
diff, with the decisions far below.

Now the tab is a **list of steps** to take in at a glance (title, one sentence, size,
what is left to decide), and a step opens **alone**, without the PR's header, tabs or
the top bar, with its own bar at the top and the decisions fixed at the bottom. Files
are rows to tick off (**Viewed**, key `v`) with the model's note on each; only a small
step opens all its diffs at once. A step has its own address (`…/guide/<k>`), so the
browser's Back goes to the list.

A new or a deleted file is no longer drawn as a diff with every line marked: there is
nothing to compare, so it is shown as plain text with one line number.

The comment box no longer takes the cursor back on every redraw (it had `autofocus`);
with it, Escape sometimes did not close the box.

Not done here, and still a proposal: a picture of how the changed files depend on each
other (issue #40), for reviews that are less text.


## 2026-11-09: Guided review: ask the AI about a step

Dr. Jeong: "can you make us ask follow-up questions, so that I can ask further" (issue
#43). A step now has **Ask** (key `a`): a box over the bar at the bottom with the
questions and answers of the step, where the next question is asked with the ones
before it.

- **What the model gets.** The same changes it reviewed the step from, read again from
  GitHub when asked, with the notes and drafts of the step and the earlier questions.
  When a step is too big for one prompt, the file the question is about is given whole
  and the others are cut, since one answer cannot be made in parts.
- **Yours only.** Questions are kept per person and never go to GitHub. An answer
  becomes a comment only through **Use as comment**, which opens the usual comment box
  with the answer in it to edit.
- **Kept with the step as its files are.** After a push an unchanged step keeps its
  questions and a changed step starts with none: an old answer under new code would
  mislead.
- **The everyday model**, not the one for Deep review: a question should be answered in
  seconds.

Not done here: the same box under an **Explain** answer on Files changed (the rest of
#43), which follows on its own.

## 2026-11-09: Explain: questions under an explanation

The rest of #43. An explanation was one answer with no way to ask further.

- **A box under the explanation, not a panel.** Explain sits above one file's diff, so
  the questions stay there too, between the explanation and the diff. No dock as in
  Guided review: there is no bar of buttons to sit on, and several files can be open.
- **The explanation is shared; the questions are not.** An explanation is kept per file
  version pair for everyone. Questions are kept per person under the same pair, as in
  Guided review, so nobody reads what another person asked.
- **Only after Explain.** The model answers from the changes, the explanation and the
  earlier questions. Asking with no explanation would need a second way to start, for
  one click saved.
- **No "Use as comment" here.** On Files changed the comment boxes are on the lines; in
  Guided review the answer could go to the draft it was about. It can follow if wanted.
- `render()` now keeps the cursor in a box being typed in on every page (it did only on
  the PR page), since Compare has this box too.

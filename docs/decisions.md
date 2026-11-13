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

## 2026-11-09: Syntax colours in diffs

Dr. Jeong asked for syntax highlighting (issue 44). Diffs were one colour of text with
omnidiff's marks; a long change in Python or R was hard to scan.

**highlight.js** (BSD-3-Clause, one pinned release in `public/vendor/`), not
tree-sitter or Shiki: it is one small file with no build step and no WebAssembly, it
covers every language the lab writes, and it runs in the browser on the text the page
already has, so the server and the kept diffs do not change. Tree-sitter grammars are
more exact but are one WebAssembly file per language to build and ship; the colours
here only help reading, they decide nothing.

The languages were chosen from the lab's repos on 2026-11-09 (Python in 25, shell 14,
TeX 8, R 7, Nextflow 6, then Makefile, JavaScript, TypeScript, Dockerfile, C++, Rust,
MATLAB, Lua, Julia, C): the common set of highlight.js plus LaTeX, Groovy (for
Nextflow), Dockerfile, MATLAB and Julia. The language comes from the file name only;
guessing from the text is slow and often wrong.

A whole file is coloured once (about 0.1 s for 200,000 characters) and kept, then cut
into lines, so a string or a comment that runs over lines is right on every line. A
token has a colour and no background, so the marks show through; the colours were
checked for contrast on every mark, in both themes. Files over 200,000 characters stay
plain so a huge data file does not stall a phone.

Not done here: colours inside the code blocks of rendered Markdown and of the AI's
answers.

## 2026-11-09: Go to definition, with real language servers

Dr. Jeong asked to move from file to file through a function, "LSP" (issue 45). The
first plan was a small index of names built by Nudgebox itself. Dr. Jeong called that
inventing a wheel, rightly: a name index cannot tell two functions of the same name
apart, knows nothing of imports, and would need work per language for ever.

So the answers come from the servers editors use: **Pyright** (Python) and
**TypeScript's own server** (`tsc --lsp`, TypeScript and JavaScript). Both are npm
packages, pinned in `package.json`, so the Docker image gets them with `npm ci` and
there is nothing to install or configure anywhere; the image grows by about 60 MB.
The languages are the lab's: Python is in 25 of its repos; TypeScript and JavaScript
are Nudgebox's own and its sister tools'. R is next in the lab's list, but its language
server needs an R installation in the image; it waits until someone asks.

Measured on the lab's repos on 2026-11-09 against GitHub: the first click on a commit
(download, unpack, server start, answer) took about 0.8 s (labbot, 84 files; nudgebox,
65 files); later clicks about 6 ms.

How the code gets there: one tarball of the commit from GitHub, not a `git clone` (no
credentials on disk, no history, one request). A server lives per commit and
is stopped after 10 minutes idle; at most 3 at a time, each limited to 1.5 GB of memory.

A PR is somebody's code, so **nothing from it is run**: only source files are unpacked
(no links, no `node_modules`, no `pyproject.toml` or `pyrightconfig.json`, which can
point the server at a program or a path), the servers get an empty `PATH`, and a place
outside the commit's folder is never sent to the page. A repo without a `tsconfig.json`
gets a plain one written by Nudgebox, since TypeScript only finds every use inside a
project. Pyright is asked only after it has said it found the repo's files; before
that it knows the open file alone and "used in" would be short.

On the page a click opens a **panel** and does not leave the diff: a reviewer wants to
look something up and continue where they were. Only the new side is clickable: the
servers know one commit, and it is the code that is going to be merged. One click, not
Ctrl+click, so that it works on a phone; a double click still selects the word.

Not done here: the old side of a diff; "open this file's diff" from the panel; R,
shell and the other languages; names in rendered Markdown and in the AI's answers.

## 2026-11-10: Guided review: the waiting screen could stay for ever

After the deploy of 2026-11-09 Dr. Jeong opened a 77-file PR on the phone and the page
said "checking step 2 of 9" for ten minutes. The review had been ready after three. The
page asked for the progress in a chain, each answer starting the next question; one
failed request (a phone asleep) or a look at another tab broke the chain, and nothing
started it again. Now the view itself starts the asking whenever it is not running, and
a failed request is tried again.

The wait itself came from the deploy: the kept reviews were in the old form, so every
PR was prepared again when first opened. Now the server prepares them in the background
after a start (PRs active in the last 14 days, one at a time, so a paid LLM is not
asked about 45 PRs at once or about PRs nobody looks at).

## 2026-11-10: Ask the AI: a box on the pull request, open

Dr. Jeong, after the follow-up questions were live: "no further chat function". They
were there, but only inside one step of a guided review, behind **Ask** in the bottom
bar, and the review of the PR at hand was still being prepared. A function that needs
a finished review and a button to be found is not there for whoever opens the PR.

- The box is on the PR page itself, open, at the top of Conversation (where a PR
  opens) and of Guided review. No button to find it.
- It asks about the whole PR and needs no prepared review, so the wait for a review
  is no longer dead time. With a review, its steps and drafts go along.
- Three questions to ask with one click, because an empty box does not say what it is
  good for.
- A big PR does not fit one prompt: the files the question names go first and whole,
  the rest is cut evenly. Whole-repository answers are not promised; the model says
  what it cannot see.
- In a step, a line "Ask the AI about this step…" under the summary opens the step's
  questions. The step's box stays closed until asked for: open, it would cover a third
  of a phone's screen over the code.
- A floating chat button over every page was not built: the bottom of the page is taken
  (the step's bar, the compare tray, the key hints), and a box in the flow is found
  without it.

## 2026-11-09: A switch that leaves only code and docs

Dr. Jeong asked for a way to filter out JSON and other non-code, with Markdown kept
(issue 54). fossil#36 changes 80 files; 22 of them are code or Markdown.

- A file's kind comes from its path alone (`src/filekind.ts`): code, doc, other. No
  file is read for it, so the list costs nothing more.
- HTML and CSS count as code: in most repositories they are written by hand. Settings
  (JSON, YAML, TOML, `nextflow.config`, `requirements.txt`) count as other: that is
  what was asked for, and the line under the switch names what is hidden.
- Off until used. A review tool that hides files without being asked hides the one
  change that mattered. Once used, the choice stays in the browser for every PR.
- On Guided review the switch folds whole steps, not files inside a step: a step is
  the AI's unit, and a step half shown would not match its summary.
- No switch when it would hide nothing or everything.

## 2026-11-09: The dependency graph is drawn, from the text alone

Dr. Jeong asked to see the dependency graph (issue 40 had it as "shown and fed to the
planner"). Built: shown. Tried on fossil#36: 21 code files, 38 links.

- Links come from reading the changed files (`src/depgraph.ts`): imports, and a file's
  name written in another. No language server: the graph is wanted the moment the page
  opens, for Nextflow, shell and batch files too, and those have no server. No model:
  it would cost money on every push and could invent a link.
- Only links between files of the PR. The question on a review is how the changed
  parts hang together, and the rest of the repository would be most of the drawing.
- Documents are chips, not boxes. On fossil#36 two READMEs named 20 files each and
  turned the drawing into a fan; and code that writes "see README.md" made circles. So
  a document's links show on a tap, and code naming a document is no link.
- A file sits just above its first user, not as high as it can: with every leaf in the
  top row, the top row was 11 files wide and the arrows ran the whole height.
- Its own endpoint, kept in memory per head commit. The stored guided review is not
  touched, so no PR is prepared again (that costs model calls).
- The planner is not fed the graph, and the files are not reordered by it (issue 50
  waits for a word). Both change what the AI writes; the drawing changes nothing.
- Folds, and stays folded: on a phone it is a screen high.

## 2026-11-10: The dependency graph is a tree, of real uses only

Dr. Jeong, on the graph of the day before: it "doesn't show me a real dependency", and
asked for something like a tree. Both were right.

- **The links were wrong.** A file's name in a comment or a docstring made a link. On
  dejavu#27 to #29 about 85 of 139 links were of that kind ("see `loader.py`", "called
  by `run.py`"). On fossil#36 `build_results.py` wrote `main.nf` into a metadata
  string, which closed a circle with the pipeline that runs it.
- Comments and docstrings are now blanked before the search (`live()` in
  `src/depgraph.ts`). Strings of the code are kept: `subprocess.run(["python",
  "worker.py"])` and `script: "bash step.sh"` are real uses and are only there as
  strings. It is a reader of comment marks per language, not a parser: enough to tell
  code from prose, and it runs on any file the moment the page opens.
- Two files that name each other: the import counts; otherwise the runner (Nextflow,
  Snakemake, shell, batch, Makefile, WDL) uses the other. A script that carries its
  pipeline's name is describing itself, not calling the pipeline.
- After: dejavu#29 has 6 links by name, each a real call; fossil#36 has 37 links and
  no circle.
- **A tree, not a drawing.** The drawing had the used files at the top and arrows
  crossing; nobody reads a review from the leaves up. The tree starts at what is run
  (`run_skyriver.sbatch`, then `main.nf`, then its scripts, then their modules), which
  is the order the question "what does this PR do" is asked in.
- A graph is not a tree: a module is used in many places. It is shown in each, and its
  own files once, with ↑ ↓ at the others. Repeating the whole branch each time made
  fossil#36 several screens long.
- Files with nothing under them share a line. One line per file made the tree 1800px
  high on a phone; now fossil#36 is about one and a half screens.
- "By name" is a dashed outline, not a word on every line: under `main.nf` every line
  carried the word.
- A tap marks the files that use the tapped one, not the ones it uses: those are
  already under it.
- The endpoint and its answer are as before; the stored guided reviews are not
  touched, so no PR is prepared again.

## 2026-11-10: The tree beside the code

Dr. Jeong asked for the tree and the code side by side.

- On Files changed, from 1100px: the tree in a column at the left that stays in view,
  the files at the right. A tap on a file in the tree opens its diff there. It is the
  layout of an editor, and of GitHub's own file tree; the tree above the list meant a
  scroll up and down for every file.
- The page is as wide as the screen there (up to 1600px), not 1120px: the tree takes
  260 to 360px, and a diff with before and after beside each other needs the rest.
- The open file's row sticks under the bar, as it already does on a phone: with the
  tree as the way in, the name of what is being read must stay on the screen.
- The page is built anew on every change, so the column's scroll place is put back
  after each one; without it the tree jumped to its top on every tap.
- Not on a phone: 390px has no room for two columns. Not on Guided review: its tree is
  on the page of the steps, where no code is shown; a step's files are few.
- Folding the graph gives the files the full width back; that is the switch.

## 2026-11-10: The tree where the review is done

Dr. Jeong, an hour after the tree went live: "I don't see the graph where?" The
request log showed why. The review was done in Guided review, step by step, and there
the tree stood under all the steps and not at all in a step. The side-by-side layout
had been built for Files changed only, on the guess that a step's files are few. The
guess was about the wrong thing: the tree is not there to find a file among a step's
few, but to see where the file being read stands in the whole PR.

- Guided review on a computer: the tree is the left column on the page of the steps
  and in every step. A tap opens the file in its step, also from another step.
- In a step the files of that step carry a filled number: "you are here".
- Sent to one file, the step opens that file alone. A small step otherwise opens all
  its files, and their diffs load one after the other and push the wanted one down.
- On a phone the tree moved from under the steps to above them. Under them it was
  three screens down on a PR with 29 steps. A step on a phone stays the code alone.
- A PR whose code files do not use each other said nothing, which reads as "the graph
  is broken". It now says so in one line, when there are at least two code files.
- With the code panel open under 1500px the tree gives way: three columns do not fit.
- Still open: a closed or merged PR has no changed files in Nudgebox at all, so no
  tree either.

## 2026-11-11: Easiest review first

Dr. Jeong asked for "a function to sort which PR is easy to review" (#62). The list
knew one order, newest activity, and a row did not say how big a PR is.

- **Easy = little to read.** The measure is the changed lines of code and documents,
  by the rule the "Code and docs" switch already uses. The total of GitHub is no use
  here: of the open PRs that day lncFit#126 had 31,843 changed lines in 4 files, almost
  all of it data. Counting only what is read puts it where it belongs.
- Not the planner's opinion and not a score. A model's "this is easy" costs money per
  PR, changes between runs and cannot be checked. A line count can be read off the
  row and argued with.
- **The row shows the number**, so the order explains itself, and the number is of use
  in the Newest order too.
- The size comes in the sync's one query (`additions deletions changedFiles
  files(first: 100)`): no call per PR, and the cost of the query on GitHub's meter
  stayed 1. A PR with more than 100 files has the rest counted as lines to read: it
  is big in any case, and it must never be called easy by mistake.
- The stored PRs get their size at the next sync after the deploy; until then they
  show none and go last.
- Checks, review state and conflicts do not enter the order: the tabs already sort by
  them, and "easy" would stop meaning one thing.

## 2026-11-12: Conflicts handed to Claude, with a comment

Dr. Jeong asked for "a menu for fixing conflict to claude" (#64), and of the ways to
hand them over chose the comment on GitHub: Nudgebox posts "@claude ..." on the PR as
the person, and a workflow in the repository does the work.

- **Not the stock `@claude` mention.** Read in the source of claude-code-action: in
  mention mode Claude commits through its own file tools and never makes a merge
  commit. The files would lose their markers and GitHub would still call the PR
  conflicted. So the repositories get a workflow of their own
  (`claude-fix-conflicts.yml`) that does the merge itself and gives Claude only the
  editing. It answers only a comment that starts with "@claude fix the merge
  conflicts". No repository of the lab has the stock Claude workflow today (searched).
  One that gets it later would answer these words as well, since they hold "@claude",
  and the two would push against each other: such a repository must leave PR comments
  to this workflow.
- **The merge is git's, the edits are Claude's.** The workflow starts the merge, lists
  the files that conflict, and Claude may use Read, Edit, Write, search and read-only
  git: no shell, no commit, no push. When Claude stops, a script checks that no marker
  is left (and sends Claude back up to three times), makes the merge again from the two
  commits, takes only those files from Claude, commits and pushes. The second merge is
  needed: the action replaces `CLAUDE.md`, `.claude/` and a few more from the base
  branch before Claude starts, which damages a merge in progress.
- **All or nothing.** A conflict that is not text inside one file (delete against
  change, rename, binary), or in a workflow file or one of those settings files, and
  Claude is not started: half a merge leaves the PR as conflicted as before.
- **Who may ask** is asked of GitHub (the commenter's permission on the repository),
  not read off the comment: the comment's "author association" is wrong for members
  whose membership is private.
- **Two tokens.** The Claude app is installed on some of the lab's repositories only.
  Where it is, its token pushes and the checks run. Where it is not, the action is run
  again with the workflow's own token; GitHub starts no checks for such a push, and
  the comment says so.
- **The key** is a repository secret that only its owner enters
  (`scripts/set-claude-secret.sh`, hidden prompt). The lab's organization is on the
  free plan, which has no organization secrets for private repositories, hence one per
  repository and a script.
- **The comment back is fixed text** plus Claude's own last few sentences (cut to 1500
  characters, mentions and anything shaped like a token removed). Output of git is
  never posted.
- Nudgebox posts nothing where nobody would answer: it looks for the workflow file on
  the repository's default branch first.
- **Tested / not tested.** The workflow's shell steps run in the tests on scratch
  repositories with a stand-in for Claude (`tests/workflow/`). What cannot be tested
  before a repository has the key: Claude's own step, and whether GitHub lets either
  token push a merge that brings in a workflow-file change from the base (it refuses
  such changes from apps; the comment has a sentence ready for it).
- Rollout: nudgebox first. The other repositories get the file after it has worked
  once there.


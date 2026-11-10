# Nudgebox (gh.bioinfolder.com) — spec

One inbox for the lab's open pull requests, on a Mac browser and an iPhone home
screen, with push notifications. Change this file by PR; the reasons are in
[`docs/decisions.md`](docs/decisions.md).

## 1. Problem

GitHub shows pull requests one repository at a time. With many repositories it is
hard to see every open PR, to tell which ones are waiting on *me*, and to notice
failing CI.

## 2. Who uses it

Jeong Lab members with a lab (Keycloak) login. Each person sees their own view.

## 3. Sign-in

1. **Lab login gets you in.** gh.bioinfolder.com sits behind the same Keycloak
   sign-in (oauth2-proxy sidecar) as every other bioinfolder app. The app trusts the
   sidecar's identity headers and nothing else: `X-Forwarded-Preferred-Username`,
   else `X-Forwarded-User` (what oauth2-proxy's GitHub sign-in sends: the GitHub
   login), else `X-Forwarded-Email`. A request without them gets 401. A lab running
   its own copy signs in with GitHub through the same sidecar (section 9).
2. **Link GitHub once.** The first visit asks the person to connect GitHub through
   the lab's own GitHub App ("Sign in with GitHub" for that App). The app stores
   their user token (encrypted) and refreshes it. Actions on PRs run **as that
   person**, never as the App.
3. Unlinking deletes the stored token.

## 4. What each person sees

- Repositories: every repo in **jeonglab-bcm**, plus **hyunhwan-bcm** for its owner.
- One rule decides visibility: a PR is shown only if the person's own GitHub token
  can access its repository. So hyunhwan-bcm repos appear only for Hyun-Hwan, and a
  private lab repo appears only for people with access to it.
- All open PRs are shown, not only ones where a review was requested.

## 5. The inbox (main page)

A switch at the top chooses **PRs** or **Issues** (issues: section 11).

PRs are grouped by status, shown as **tabs across the top**, each with a count:

| Tab | A PR is here when |
|---|---|
| **Needs you** | a review is requested from you (or a team you are in); or it is your PR and it is ready to merge (checks passed, not blocked, approved or no review required); or it is your PR and changes were requested; or it is your PR and it has merge conflicts |
| **WIP** | it is your PR and it is a draft, or it waits for a review or for running checks |
| **CI failing** | any visible PR whose latest checks failed (yours first) |
| **All** | every open, visible PR (the three above plus everything else) |

A PR belongs to the first status that matches. A **repo filter** next to the tabs
narrows every tab to one repository. Each row shows repo, number, title, author,
age, review state, checks state, and draft status. Newest activity first.

**Old and hidden (both per person, both quiet):**

- A PR with no activity for `oldDays` days (`config.yaml`, default 30) moves to an
  **Old** group at the bottom, folded by default.
- **Hide** on a row hides that PR for you until something new happens on it (a
  comment, push, review or CI change bumps its activity time); then it is back by
  itself. Hidden PRs are listed in a folded **Hidden** group with **Unhide**.
- Old and hidden PRs send no push and are left out of the stale digest.

## 6. Actions

From a PR row, as the signed-in person:

- **Merge**: asks for confirmation first; uses the repo's default merge method.
- **Approve**.
- **Re-run failed checks** (GitHub Actions jobs that failed on the head commit).
- **Comment**.

The PR page (section 16) adds more, all as the signed-in person: reviews with line
comments, replies and resolving threads, merge with a chosen method, Update branch,
resolving conflicts, Ready for review / Convert to draft, Viewed, reviewers,
assignees, labels and milestone, and **Close** (asks first) / **Reopen** (Dr. Jeong,
2026-11-05).

Nothing else destructive: no delete branch, force-push, or edit of the title or
description. A commit Nudgebox makes (resolving conflicts) only adds to the branch. GitHub still
enforces branch protection and permissions; the app shows GitHub's error if it
refuses.

## 7. Notifications

iPhone and Mac push (Web Push from the installed web app), and the Nudgebox desktop
app for Mac and Linux (section 18). Each person turns web push on per device and can
see which devices are on. A device the push service reports as
gone is removed. Triggers:

1. **Review requested** from you.
2. **Your PR's CI finished**: one push per head commit, "passed" or "failed".
3. **Stale PRs**: once a day (09:00 America/Chicago), one push per person listing
   PRs they author or are asked to review with no activity for `staleDays` days.
   `staleDays` is set in `config.yaml` (default 3).

Hidden and old items (section 5) send nothing. Issue notifications: section 11.

**Unread count.** The Nudgebox icon on the Home Screen (and the Dock on a Mac) shows how
many notifications you got since you last opened Nudgebox. Each notification to you
adds one, counted per person (not per device). Opening Nudgebox, on any of your
devices, resets it to zero and clears the icon on that device; your other devices
show the right number again with their next notification (iOS allows no silent push
to clear them sooner).

**Delivery.** Review requests go out as high-urgency pushes, which iOS delivers even in
Low Power Mode. Each push is logged with the push service and its answer (never the
device address), so a missing notification can be traced.

No Slack, no email.

## 8. Freshness

GitHub webhooks (from the lab's GitHub App) update the data as events happen. A full
sync at start-up and every 10 minutes catches anything a webhook missed. Webhook
requests must carry a valid GitHub signature or are rejected.

## 9. Where it runs

Docker on anjanda, like the other bioinfolder apps: nginx + Keycloak sidecar in front,
`/webhook` reachable without the sidecar (GitHub cannot sign in) but signature-checked.
The vhost and sidecar live in `bioinfolder-srv`; this repo holds the app.

**Anywhere else** (issue #33): `deploy/docker-compose.yml` runs the app with
oauth2-proxy signing in with GitHub, limited to one organization's members, and
`deploy/config.example.yaml` shows every setting (`src/config.ts` reads them; unknown
keys are logged). Nothing about the Jeong Lab is built into the code: no site address,
LLM address or timezone (default UTC). The README's "Run your own" walks through it.

## 10. Out of scope (for now)

Slack/Alpy, email, self-hosted runner health, stacked-PR tools, a native phone app,
acting on issues.

## 11. Issues

- **Issues** (the switch at the top) lists every open issue (not PRs) in the
  repositories you can see (same rule as section 4), newest activity first, with the
  same repo filter, **Hide**, **Old** and **Hidden** behaviour as PRs.
- **Read-only**: nothing on an issue can be changed from here (Hide is only your view).
- **Push** (unless the issue is hidden or old for you), to linked lab members who can
  see the repo:
  1. **Assigned to you.**
  2. **@mentioned** in the issue's text or a new comment.
  3. **A new comment on an issue you opened or are assigned to.**

  Never for your own action (your own comment, assigning yourself). One push per
  event per person, even if several triggers match.
- Kept current like PRs: webhooks (`issues`, `issue_comment`) plus the 10-minute sync.

## 12. AI summary

- A **Summarize** button on every PR and issue row. Nothing is generated until it is
  clicked.
- The summary is made by the LLM chosen in Settings → AI (section 20), or else the one
  in `config.yaml`. At the lab that is its own LLM at `llm.bioinfolder.com`, so private
  repo content stays on lab hardware. With no LLM set up the button is not shown.
- What the model reads: **PR**: title, description, changed files and their diffs,
  review and conversation comments. **Issue**: title, description, comments. Input is
  cut to a fixed size so very large PRs still work.
- What it writes, in ASD-STE100 Simplified Technical English (one topic per sentence,
  at most 25 words, active voice, simple tenses, no idioms, one term for one meaning):
  **What** it is about (1 or 2 sentences); **Key points**: 2 to 4 concrete facts
  (results and numbers, files, decisions, open questions); **Status** (checks,
  reviews, blockers); **Next**: who has to do what, by @name. Shown as labelled rows,
  key points as a list, plain text, readable on a phone. (Summaries kept in an older
  format are made again in this one.)
- Only for items you can see (section 4). Read-only: nothing is posted to GitHub.
- A summary is kept until the item changes (new activity, or a new head commit for a
  PR); clicking again before that shows the kept one without asking the model. It is
  shared by everyone who can see the item.
- If the LLM fails, the error is shown and nothing is kept, so the next click tries
  again.
- **Streamed:** the summary appears as the model writes it. First the row says
  "Reading the PR…" (or issue) while Nudgebox fetches it from GitHub, then the text
  grows line by line. A kept summary appears at once. Two people asking for the same
  summary at the same time share one model call and both see it grow.
- The item's text is treated as data, never as instructions to the model.

## 13. Triage list

The inbox (sections 5 and 11) is a compact list for clearing a queue quickly, not a
stack of cards.

- **One line per item** on a computer: repo and number, title (cut with … when long),
  draft/conflict flags, checks, review state, age, author. On a phone each item takes
  two lines (title and age; repo, checks and review). The page never scrolls sideways.
- **Checks and review are symbols** with a text label for screen readers: checks ✓
  passed, ✗ failed, ● running, – none; review ✓ approved, ✎ changes requested, ○
  review required.
- **Stale:** an item with no activity for `staleDays` (`config.yaml`, the same setting
  as the stale digest) shows its age in the warning colour.
- On the **All** tab, PRs that would be in **Needs you** carry a small "you" mark.
- **One row is selected.** Its details (checks and review in words, AI summary) and its
  buttons (Files for a PR (section 15), Re-run failed when checks failed, Summarize,
  Hide/Unhide) show under it only
  when it is opened; other rows show no buttons. Approve, Merge, Comment and Open have
  no buttons (Dr. Jeong, 2026-11-04: fewer buttons); they stay on the keyboard, and a tap
  on the title of the selected row opens the PR page (section 16), or an issue on GitHub. A tap or click selects
  and opens a row; tapping it again closes it.
- **Keyboard** (computers only; ignored while typing in a field or with Ctrl, Cmd or
  Alt held):

  | Key | Does |
  |---|---|
  | `j` / `↓`, `k` / `↑` | next / previous row |
  | `x` or space | open / close the selected row |
  | `Enter` or `o` | open the PR page (section 16); an issue on GitHub |
  | `g` | open on GitHub |
  | `a` | approve |
  | `m` | merge (still asks first) |
  | `r` | re-run failed checks |
  | `c` | comment |
  | `f` | the PR page on Files changed (sections 15, 16) |
  | `s` | AI summary |
  | `h` | hide / unhide |
  | `1`–`4` | Needs you, WIP, CI failing, All |
  | `p` / `i` | PRs / Issues |
  | `/` | repo filter |
  | `?` | list of keys |

  A key that does not apply (approving your own PR, re-running with no failed checks)
  does nothing to GitHub and says why. A hint line with the main keys sits at the
  bottom on computers, not on phones.
- **Icon** (browser tab, Home Screen, notifications): the triage list, three rows with
  the top one marked by the coral dot (Dr. Jeong, 2026-11-06).
- **Look:** "bold minimal": monochrome with one coral accent for what needs you, the
  tab counts as large numerals, light by default with a dark version that follows the
  system setting (Settings can fix either, section 14). Fonts are served by Nudgebox,
  not a third party. Motion is off when the system asks for reduced motion.

## 14. Settings

A gear in the header opens **Settings** (address `#settings`); Back, the browser's back
or `Escape` returns to the list. List keys (section 13) do nothing on this page.

- **Appearance:** theme **System** (follows the device), **Dark** or **Light**. Kept per
  device; the page opens in the chosen theme without a flash of the other one.
- **Notifications on this device:** says plainly whether they are **on**, **off**, or
  **not possible here and why** (on iPhone in Safari: add Nudgebox to the Home Screen
  and open it from there; blocked: where to allow them). One button for the next
  step: Turn on, or Send a test and Turn off. **Send a test** sends one notification
  to this device only; it does not count as unread (section 7). It then says which
  part failed, if any: the browser **received** the test and asked the system to show
  it (if nothing appeared, the computer's own notification settings or Focus hide
  it, and where to look), the browser received it but **could not show** it (with the
  reason), or the browser **did not receive** it within 15 seconds.
- **Your devices:** every device with notifications on, by kind (Apple: iPhone, iPad
  or Mac Safari; Chrome; Firefox; Edge) and since when, this device marked. Any other
  one can be removed.
- **What notifies you:** the triggers of sections 7 and 11, in one line each.
- **GitHub account:** which GitHub login and lab login are connected, and
  **Disconnect GitHub** (asks first; the stored token is deleted). It is no longer at
  the bottom of the list.
- **AI** (admins only): the provider and models, section 20.

**Header bell.** Next to the gear, a bell shows this device's notification state at a
glance: a plain bell when on, a crossed-out bell with a dot when off, a crossed-out
grey bell when not possible here. It opens the notifications part of Settings.

## 15. Files and diffs

**Files** on an opened PR (key `f`) shows the PR's changed files, compared with the
point where the PR's branch left its base (as GitHub's "Files changed" does): status
(added, modified, removed, renamed), path, and lines added and removed. `Escape` or Back
returns to the list. Files is the **Files changed** tab of the PR page (section 16); the
old address `#files/<owner>/<repo>/<number>` still works.

A file opens its diff, made by **omnidiff** (github.com/ivankovic/omnidiff, a pinned
release run on the server) from the file's two whole versions:

- **Only the changed parts are marked**, not whole lines: removed (before), added
  (after), changed (both), and **moved** code marked as moved, with the line it moved
  to or from. Unchanged lines more than 3 lines from a change fold into "N unchanged
  lines".
- **Before and after** side by side on a computer. **On a phone, one unified column**
  (Dr. Jeong, 2026-11-06): unchanged lines once, each run of removed lines (red, old line
  number) directly above the lines that replace it (green, new line number), with
  omnidiff's marks inside the lines. A rendered Markdown file and a binary file keep
  their own views.
- A note when omnidiff names the shape of the change: only whitespace, only comments,
  only moved code, a new file, a deleted file.
- **Code is coloured by its language** (issue 44): keywords, strings, numbers, comments
  and names each in their own colour, in the light and the dark theme. The language
  comes from the file's name (`.py`, `.R`, `.ts`, `Makefile`, `Dockerfile`, …); the
  languages are the ones the lab writes: Python, R, TypeScript and JavaScript, shell,
  LaTeX, Nextflow, C and C++, Rust, MATLAB, Julia, Lua, JSON, YAML, TOML, Makefile,
  Dockerfile, HTML and CSS, Markdown source, and the other common ones. The colours
  sit **under** omnidiff's marks: a changed part keeps its mark and its colour, and
  the text is never altered. The same colours are in the phone's one column, in the
  code above a review thread, in the AI's draft comments (section 19) and in Compare.
  A file of an unknown kind, and a file over 200,000 characters, stay plain. The
  highlighter (highlight.js) is served by Nudgebox, not a third party, and loads when
  the first diff opens.
- **A new or a deleted file is shown plain**: its one version in one column with one
  line number, no marks and no colour on every line, as there is nothing to compare.
- Text files over 1 MB are not diffed; the view says so and links to GitHub.
- **Binary files are diffed by what they hold** (omnidiff), up to 10 MB:
  - **Pictures** (PNG, JPEG, GIF, WebP, BMP, ICO): before and after side by side with
    each changed area outlined, plus **Difference** (the changed pixels lit up) and
    **Slider** (wipe from before to after); format, size, share of pixels changed and
    number of areas. An added or removed picture shows alone; for an animation, how its
    frames changed.
  - **Archives, fonts, cursors, translation catalogs and PDFs**: what changed inside,
    each file, glyph, page or message as added, removed or changed, with how (lines
    added and removed; pixels changed and where). **Changed PDF pages are drawn**
    before and after with the changed areas outlined.
  - Any other binary file: says there is no content diff for its kind, with a link
    to GitHub.
  - The page gets the bytes from Nudgebox, only for repos you can see, served so that
    a browser can only show them as a picture or a PDF to draw, never run them.
- Only for PRs and repos you can see (section 4). Read-only. The same two versions are
  diffed once and kept.

**Markdown files** (`.md`, `.markdown`) open **rendered**: before and after as formatted
text (headings, lists, links, code, tables), each block that has a change marked
(removed on the before side, added or changed on the after side, moved), with one block
of context around each change and longer runs of unchanged blocks folded. A switch shows the plain diff instead. The
rendered text is cleaned first: no scripts, event handlers or embedded frames from the
file run in Nudgebox; links open in a new tab.

**Compare two files.** Each file in a Files view has **Pick**. Picked files, from one PR
or from different PRs and repos, wait in a bar at the bottom (at most two; a third pick
replaces the oldest; × drops one), kept while you move around Nudgebox in this tab.
**Compare** diffs the first pick (before) against the second (after), each at the
version its PR has now (a removed file: its last version), the same way as above,
Markdown rendered included. **Swap** turns the comparison around. The address is
`#compare`; Back returns.

## 16. The PR page

A PR opens in Nudgebox as a page laid out like GitHub's own PR page, with the same
buttons, so a PR can be read, reviewed and merged without going to github.com. Every
diff on it is made by omnidiff (section 15). Dr. Jeong, 2026-11-05: "the same button
and user interface".

The address is `#pr/<owner>/<repo>/<number>` (Conversation), `…/commits`, `…/checks` and
`…/files`.
`Enter`, `o` or a tap on the selected row's title opens it from the list; `f` opens it
on Files changed; `Escape` or Back returns to the list. **Open on GitHub** is in the
header, and `g` on the list. Only for PRs in repos you can see (section 4). The page
is read with your own GitHub token, so it shows what GitHub shows you (your pending
review, your Viewed ticks).

**Header.** The title and number; a state badge (Open, Draft, Merged, Closed); "*author*
wants to merge *N* commits into *base* from *head*"; tabs **Conversation**, **Commits**,
**Checks**, **Files changed** and **Guided review** (section 19), each with its count; lines added and removed.

**Sidebar** (beside the tabs on a computer, above them on a phone):

- **Reviewers**: each requested person or team, and each person who reviewed with
  their latest state (approved, changes requested, commented). The gear lists people
  who can be asked (the repo's assignable people, not the author); ticking one requests
  a review, unticking removes the request. **Re-request review** beside someone who
  reviewed. "Still in progress? Convert to draft" under it.
- **Assignees**: gear with the repo's assignable people; "No one — assign yourself".
- **Labels**: gear with the repo's labels, in their colours.
- **Milestone**: gear with the repo's open milestones, or none.

**Conversation tab.** The description first (as a comment by the author), then, oldest
first: comments, reviews (who, approved / requested changes / commented, the review's
text and its line comments), commits pushed, and events (labels, assignees, review
requests, ready for review, converted to draft, force-pushed). A review's line comments
show as a thread: the file and line, the code around it, the comments, a **Reply**
box, and **Resolve conversation** / **Unresolve conversation**; a resolved thread is
folded. Outdated threads (their line has changed since) say so.

Under the timeline, the **merge box**, as on GitHub:

- Review state: "Changes approved", "Changes requested" or "Review required".
- Checks: "All checks have passed", "Some checks were not successful" or "Some checks
  haven't completed yet", with **Show all checks** (the Checks tab).
- Branch state, one of:
  - Draft: "This pull request is still a work in progress" and **Ready for review**.
  - Conflicts: "This branch has conflicts that must be resolved", the conflicting
    files, and **Resolve conflicts** (below).
  - Behind its base: "This branch is out-of-date with the base branch" and **Update
    branch** (merges the base into it, as GitHub does).
  - Otherwise: "This branch has no conflicts with the base branch".
- **Merge pull request** with a menu of the methods the repo allows (Create a merge
  commit, Squash and merge, Rebase and merge); the choice is remembered per repo on
  this device. It opens a confirm step with the commit title and message (not for
  rebase), then **Confirm merge** or **Cancel**. Not offered on a draft or with
  conflicts. GitHub's refusal (branch protection, failing required checks) is shown.

Then a comment box with **Comment** and **Close pull request** ("Close with comment"
when the box has text), which asks first. A closed PR shows **Reopen pull request**
instead; a merged one neither.

**Commits tab.** The PR's commits, oldest first, grouped by day ("Commits on Nov 2"):
first line of the message, author, short sha and time. A commit opens its changed files
(`…/commits/<sha>`), each diffed by omnidiff against the commit's first parent, as in
section 15. Back returns to the list of commits.

**Checks tab.** Each check on the head commit: name (and workflow), state (passed,
failed, running, queued, skipped, cancelled), how long it took, and **Details** (its
log on GitHub). **Re-run failed jobs** when some failed (section 6).

**Files changed tab.** The Files view of section 15 (omnidiff, rendered Markdown,
binary diffs, Pick), plus GitHub's review tools:

- **Line comments.** A line GitHub can take a comment on (a line inside the PR's diff
  hunks, as on GitHub) shows **+** by its number on a computer; on a phone its line
  number is tappable (underlined) instead, and tapping it does the same. Other lines
  take no comment. **+** opens a box
  with **Add single comment** (posted now) and **Start a review** (or **Add review
  comment** once one is started), which adds it to your **pending review** on GitHub,
  seen by no one else until submitted. A line on the before side comments on the old
  line, on the after side the new line.
- **Comment on file** in each file's header, for a comment that is not about one line.
- **Threads** show under their line in the diff, with Reply and Resolve as in
  Conversation; pending comments are marked Pending.
- **Viewed** tick per file, the same tick as GitHub's (kept by GitHub). A viewed file
  folds; the header says "*n* / *m* files viewed".
- **Review changes** (with the number of pending comments) opens the review form: a
  summary, then **Comment**, **Approve** or **Request changes**, and **Submit review**.
  Approve and Request changes are not offered on your own PR. **Cancel review** drops
  your pending review and its comments, after asking.

**On a phone** the open file's row stays at the top of the screen while its diff
scrolls, and the page header scrolls away.

**Resolving conflicts** (`#pr/<owner>/<repo>/<number>/conflicts`), like GitHub's
conflict editor:

- Each file changed on both the PR's branch and the base since they split, whose changes
  overlap, opens in an editor with the conflict markers GitHub uses
  (`<<<<<<< head-branch`, `=======`, `>>>>>>> base-branch`).
- Above each conflict: **Accept current change** (the PR's), **Accept incoming change**
  (the base's), **Accept both changes**; the text can also be edited by hand.
- **Mark as resolved** once a file has no markers left. When every file is resolved,
  **Commit merge** makes one merge commit on the PR's branch ("Merge branch '*base*'
  into *head*", as GitHub writes it), with the PR's head and the base's head as its
  parents. Files changed only on the base are taken as they are; files changed on both
  sides without overlapping are merged as git would.
- Conflicts the editor cannot show (a file deleted on one side and changed on the other,
  a rename against a change, a binary file) are listed with "Resolve this on the
  command line" and Commit merge is not offered, as on GitHub.
- If the branch moved while you were resolving, nothing is committed and the page says
  to reload.

**Fresh.** After each action the page reads the PR again; it also does when the
window comes back to the front.

## 17. Explain a file's diff

An **Explain** button on each file's diff (Dr. Jeong, 2026-11-06), above the diff, on a
computer and a phone. It works wherever a text diff is shown: Files changed, a commit,
and Compare.

- The explanation is made by the lab's LLM, as the AI summary is (section 12). Without
  an LLM the button is not shown.
- What the model reads: the file's path, the PR's title when there is a PR, and the
  file's changes: each changed run of lines, old and new, with 3 unchanged lines around
  it, cut to a fixed size. Nudgebox reads both versions of the file from GitHub itself;
  the page only names the repo, the two versions and the path. Only for repos you can
  see (section 4). Not for binary files.
- What it writes: 2 to 4 sentences in ASD-STE100 Simplified Technical English: what
  the file's changes do, and their effect. Plain text with `code` names, shown above the
  diff.
- Streamed as it is written, like the summary. An explanation is kept per file version
  pair (they never change), shared by everyone who can see it; asking again shows the
  kept one. If the LLM fails, the error is shown and nothing is kept.
- The file's text is data, never instructions to the model.

**Questions about it** (issue 43). Under an explanation is a box to ask about the file's
changes, and your questions with their answers above it, the newest last. On a computer
Enter sends and Shift+Enter makes a new line; on a phone the **Ask** button sends.

- The model reads what Explain read, the explanation, and your earlier questions on this
  diff with its answers (the newest that fit), and your question last. It is told to say
  so when the answer needs code that is not in the diff. The answer is short, in
  Markdown, and streamed as it is written.
- Questions are yours only: kept per person with the explanation, shown again when you
  open it later, and never sent to GitHub. The explanation itself stays shared.
- A question has at most 2,000 characters, and one is answered at a time. If the LLM
  fails or gives no answer, the error is shown, nothing is kept, and the question stays
  in the box.
- The box is there only under a whole explanation, so not without an LLM.

## 18. Desktop app (Mac and Linux)

A small **Nudgebox** app for macOS and Linux (Tauri), for notifications that do not
depend on the browser's push. It opens a Nudgebox site in its own window, behind that
site's sign-in (section 3); the sign-in is kept between launches.

- **Which site.** On first launch a small window asks for the server's address,
  filled in with gh.bioinfolder.com. `review.example.org` becomes
  `https://review.example.org/`; anything but https is refused with the reason. The
  choice is kept, and **Change server…** in the menu bar or tray asks again (the app
  restarts on the new site). Only the chosen site may call the app (notifications,
  badge, opening links); its sign-in pages on sibling addresses (e.g.
  auth.bioinfolder.com next to gh.bioinfolder.com) and GitHub's sign-in stay in the
  window, and every other link opens in the browser.

- **Live stream.** The page in the app holds one `GET /api/events` stream
  (Server-Sent Events). Every notification of sections 7 and 11 goes to all of that
  person's open apps, alongside web push, and counts once as unread. Nobody else's
  notifications reach it. The stream sends a heartbeat every 25 seconds so proxies
  keep it open; if it closes for good (the sign-in expired), the page reloads.
- **Native notifications.** The app shows each one with the system's notifications
  (Notification Center on a Mac, the desktop's notifications on Linux) and sets the
  unread count on its Dock icon. Opening Nudgebox clears it, as in section 7.
- **Stays running.** Closing the window keeps the app in the menu bar (Mac) or tray
  (Linux), so notifications keep coming; Quit there ends it. Notifications arrive
  only while the app runs.
- **Settings** (section 14) in the app says notifications are on in the desktop app;
  there is no Turn on or Turn off. **Send a test** goes to this app only, does not
  count as unread, and says whether the app received it and whether the system showed
  it (with the reason if not).
- **Release.** A tag `app-v<version>` builds the app on GitHub Actions: a `.dmg` for
  Apple silicon and Intel Macs, and an `.AppImage` and `.deb` for Linux, attached to a
  GitHub Release. The Mac app is not signed yet: the first open is right-click → Open.

## 19. Guided review

Big pull requests are tedious to review (Dr. Jeong, 2026-11-06: "human in the loop,
minimizing tediousness"). Nudgebox prepares the review and the person decides, with one
key per decision, and never sees again what they already reviewed.

**Prepared** once per head commit of a PR, in the background (when a PR is opened,
pushed to, reopened or marked ready, and otherwise when someone first asks), and shared
by everyone who can see the repo (section 4):

1. **Noise is hidden**: lockfiles, generated or minified files, and files omnidiff
   finds have only whitespace, comment or moved-code changes. Each says why.
2. **Steps.** The lab LLM groups the other files into steps, one logical change each,
   in reading order (the core change, then its callers, then tests, then documents),
   with a title and one sentence on what the step does, and one sentence on the whole
   PR. At most 12 steps, however big the PR. A plan is repaired, not thrown away: a
   file it names twice stays in its first step, a name not in the PR or a noise file
   is dropped, and the files it left out follow as one step each, in path order. Only
   an answer that is no plan at all (not JSON, cut off) gives one step per file, in
   path order, with a line in the server log.
3. **Data to skim.** Files nobody reads line by line are steps of their own, after the
   others, marked **skim**; the model does not review them. Figures, tables of numbers,
   archives and files that are binary or too large to show are grouped by folder (at
   most 3 such steps) without asking the model, each saying how many files of which
   kind it has. The plan can also mark a step skim (results a program wrote, logs).
4. **Draft comments.** For each step to read, the model gets every file whole, in as
   many calls as it takes to fit (a big step is not cut to the first lines of each
   file), and writes one note on what changes in each file and draft review comments on
   real problems only (not style, not guesses about code it cannot see, not a version
   or date that is new to it: it is told what day it is), each on a line GitHub takes a
   comment on (section 16). An answer that is not JSON is asked for once more. A draft
   that argues with itself or runs on is dropped. Each other draft is then checked by a
   second call that tries to prove it wrong; only drafts that pass are shown, each with
   the lines of code it points at. The repo's dropped drafts (below) are given to the
   model so it does not suggest them again.

**After a push** the review builds on the one of the push before, so only what changed
is read again. The plan is kept: a file that is gone leaves its step, a new file joins
the step that has the most files of its folder (else a last step, "Added since the
last push"), and the model plans again only when little of the old plan is left or more
than a fifth of the files (and more than 3) are new. A step whose files are all as they
were keeps its summary, notes and drafts; the model reviews only the other steps. Pushes
in a row wait their turn: the review of a push waits for the one under way and builds
on it, and is not made at all if a newer push came meanwhile.

Without an LLM there are no drafts and each file is a step; the page says so. If the
model fails, the error is shown, nothing is kept, and **Try again** prepares it again.
While it is prepared (minutes, on a big PR) the page says what is going on and since
when: waiting for the review of the push before, reading the changed files, grouping
*n* files into steps, reviewing step *k* of *n* (its title), checking that step's draft
comments, with a bar for the steps; and whether it is updating after a push.
The page keeps asking until the review is there: a request that fails (a phone asleep, no
network) or a look at another tab does not stop it.

After a restart of the server, the reviews that are not kept are prepared in the
background, before anybody opens them: the PRs active in the last 14 days, the latest
first, one at a time. An older PR is prepared when somebody opens it.

**Per person:**

- **Looks good** marks a step reviewed, by the content of its files. **Viewed** marks
  one file; a step with every file viewed is reviewed.
- **Keep** puts a draft, as the person edited it, in their **pending review** on GitHub
  (section 16); submitting it is the review form of section 16. **Drop** hides the
  draft for them and remembers it for the repo's later reviews.
- **After a push** a step whose files did not change stays reviewed. A step with a file
  the person reviewed in an older version is **changed**; the page says how many, and
  the files of it they viewed in this version stay viewed.

**On the PR page**, a **Guided review** tab (`#pr/<owner>/<repo>/<number>/guide`, with
the number of steps left) has two views (Dr. Jeong, 2026-11-09: the layout must be
convenient, and less text to read through).

**The list of steps** is the whole review at a glance: the PR's one-sentence summary,
"*k* of *n* steps reviewed" with a bar, "*n* steps changed since your review" after a
push, and one row per step: its number (a check when reviewed), title, sentence, how
many files and lines, how many AI comments are still to decide, and a bar for its size
next to the other steps. One button, **Start review** or **Continue with step *k***
(`Enter`), opens the first changed step, else the first not reviewed; a row opens its
step. The hidden noise is folded below, with why. With every step reviewed: "All *n*
steps reviewed", the number of pending comments, and **Submit review**, which opens the
review form of section 16 with the PR's summary as its text. Submit review is there as
soon as a step is reviewed or a comment is pending.

**One step** (`…/guide/<k>`) has the page to itself: the PR's header, tabs and the top
bar are not shown. A bar stays at the top with **‹ Steps** (back to the list; `Esc` and
the browser's Back do the same), "Step *k* of *n*" and how many are reviewed. Below it:
the step's title and sentence; one line on what the AI did (how many files it read, how
many lines it flagged); its draft comments, each with the lines of code it points at,
the next open one marked; then its files. Each file is one row with the model's note on
what changes in it, its counts, a **Viewed** box and **Comment**; a file that changed
since the person viewed it says **Changed**. A row opens to the file's diff (omnidiff,
with + to comment on a line as on Files changed). A small step (at most 8 files and 400
changed lines to read) opens with its files open, a bigger one with only the first file
to read open, a skim step with all folded. **Viewed** folds the file and opens the next
one to read. A bar with the decisions stays at the bottom; one key each:

| Key | Does |
|---|---|
| `y` | Looks good: mark the step reviewed, go to the next one not reviewed (else the list) |
| `v` | Viewed: mark the file being read, open the next |
| `k` | Keep the marked draft as it is |
| `e` | Edit the marked draft, then Keep |
| `x` | Drop the marked draft |
| `c` | Comment on the file being read yourself |
| `a` | Ask the AI about the step |
| `s` | Skip to the next step without marking it |
| `b` | Back one step |

A decided draft leaves the queue at once, so the next key goes to the next one. Past
the last step, and before the first, is the list. Each key is also a button; on a phone
the bar has Back, Ask, Skip, Viewed and Looks good, the page never scrolls sideways, and
Comment is on each file's row.

**Ask** (Dr. Jeong, 2026-11-09: "ask follow-up questions, so that I can ask further").
In a step the person can ask the AI about what they are reading, and ask again. Each
question goes to the model for Guided review (section 20) with the step's title and
sentence, the changes of its files, the notes and draft comments made when the step was
prepared, and the person's earlier questions on the step with the answers. A question
is about the whole step (`a`, or **Ask** in the bar), about one file (**Ask** on its
row) or about one AI draft (**Ask** on the draft). The file asked about is given whole
when it fits; the other files share the room that is left, and a file that is cut says
so. The model answers in a few sentences and says which code it cannot see rather than
guess.

The questions open in a box over the bar at the bottom: the step's questions and
answers in order, the answer written as it comes in, and a box for the next question.
On a computer `Enter` sends and `Shift`+`Enter` is a new line; on a phone `Enter` is a
new line, the button sends, and the box takes the place of the bar. One question at a
time. `Esc` or ✕ closes the box; **Ask** in the bar says how many questions the step
has. **Use as comment** under an answer starts a comment with the answer as its text,
to edit: on the line of the draft the question was about, else on the file it was
about (or the file being read). Nothing is sent until the person adds the comment
(section 16).

Questions and answers are the person's own: nobody else sees them, and nothing goes to
GitHub. They are kept with the step as its files are: after a push, a step whose files
did not change keeps them, and a changed step starts with none, because the answers
were about code that is gone. A question of more than 2,000 characters is refused. If
the model fails or gives no answer, the page says so, nothing is kept and the question
stays in the box. Without an LLM there is no Ask.

The PR's text, files and comments are data, never instructions to the model.

## 20. AI settings

Which LLM Nudgebox uses, set on the settings page so a lab running its own copy (or
this one, later) can change it without editing files or restarting.

- An **AI** section in Settings, shown only to **admins**: the lab users listed under
  `admins:` in `config.yaml`. Everyone else gets 403 from its API.
- **Provider**: Off, **OpenAI**, **Anthropic** or **OpenAI-compatible**.
  - OpenAI and Anthropic always use their own address. Anthropic is called through its
    own Messages API (`@anthropic-ai/sdk`), not an OpenAI-compatible endpoint.
  - OpenAI-compatible takes an **address** (the lab LLM, Ollama, vLLM, LM Studio,
    OpenRouter, …); its key is optional, and a **"Qwen: turn thinking off"** box sends
    `chat_template_kwargs`. Other providers get no vendor-specific fields.
- **API key**: stored encrypted with `TOKEN_KEY`, like GitHub tokens, and never sent
  back to the page, which only says that one is saved. Leaving it empty keeps the
  saved key.
- **Two models**: one for summaries, Explain and Guided review (runs often, should be
  cheap), and one for Deep review (on request; empty means the same). The model fields
  offer the provider's own model list, and any name can be typed.
- **Test** sends one tiny prompt with what is typed (not saved) and shows how long the
  answer took, or the provider's error message (for example a wrong key).
- **Save** applies at once, without a restart; the next Summarize uses it. **Off** hides
  every AI button and makes no LLM calls.
- `config.yaml` (`llm: provider, baseUrl, model, deepModel, noThinking`) with
  `LLM_API_KEY` in `.env` is the server's own setting, used until an admin saves one on
  the page. The page says which one is in use.

## 21. Go to definition

In a diff, a click on a name (a function, a class, a variable) shows what it is, where
it is defined and where it is used, without leaving the page (Dr. Jeong, 2026-11-09,
issue 45). It works on Files changed, a commit, Compare and Guided review, on a
computer and a phone.

- **Which code.** The new side of a diff: the After pane, and the unchanged and added
  lines of the one-column diff. The old side and deleted lines are not clickable.
  **Python**, **TypeScript** and **JavaScript** files; other files are as before.
- **The click.** One click (or tap) on a name. A name under the mouse is underlined.
  Comments, strings, numbers and keywords do nothing. A double click selects the word
  and a drag selects text, as ever.
- **The code panel** opens beside the page on a computer and over the whole screen on a
  phone. It shows:
  - the name, its signature and its documentation, as the language server gives them;
  - **Definition**: the file where the name is defined, whole, at that line, with the
    line marked and its path and line number above it;
  - **Used in N places**: every use in the repository, per file, each with its line
    number and its line of code. A use opens its file at that line.
  - A name that is defined outside the repository (the language itself, a library) has
    no file to show: the panel says so and still lists its uses in the repository.
  - A click on the definition itself opens the list of uses.
- **Further.** Names in the panel's code can be clicked in the same way. **Back** in
  the panel returns to the name before. Escape or ✕ closes the panel; on a phone the
  browser's Back closes it too. The page under the panel does not move or reload.
- **How it is answered.** By real language servers on the Nudgebox server: Pyright for
  Python, and TypeScript's own server for TypeScript and JavaScript. Both come with
  `npm ci`; nobody installs or sets up anything, in the lab's repos or on the server.
  - For a question about a commit, Nudgebox gets that commit's files from GitHub once
    (one archive), keeps them in a temporary folder, and starts the language server on
    them. The first click on a commit takes about a second; later ones are immediate.
  - After 10 minutes without a question the server is stopped and the folder is
    removed. At most 3 commits are kept at a time; the least recently asked goes first.
  - **Nothing from the repository is run.** Only code files of these languages,
    `package.json` and `tsconfig`/`jsconfig` files are unpacked: no links, no
    `node_modules`, no file over 2 MB, no settings file that could name a program. The
    language servers start with an empty `PATH`. A repository over 20,000 such files or
    300 MB gets "too large for go to definition".
  - Only for repos you can see (section 4): the check is made before anything is
    fetched. A location outside the commit's folder is never shown, only counted.
- Without the language servers (`code` not set up) nothing is clickable and the diffs
  are as before.

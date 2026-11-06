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
   sidecar's `X-Forwarded-Email` / `X-Forwarded-Preferred-Username` headers and
   nothing else; a request without them gets 401.
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

iPhone and Mac push only (Web Push from the installed web app). Each person turns it
on per device and can see which devices are on. A device the push service reports as
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

## 10. Out of scope (for now)

Slack/Alpy, email, self-hosted runner health, stacked-PR tools, a native app, acting
on issues.

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
- The summary is made by the lab's own LLM at `llm.bioinfolder.com` (OpenAI-compatible
  API, model set in `config.yaml`), so private repo content stays on lab hardware.
  Without an LLM key the button is not shown.
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
**Checks** and **Files changed**, each with its count; lines added and removed.

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

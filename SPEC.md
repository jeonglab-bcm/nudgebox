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

Nothing destructive: no close, delete branch, force-push, or edit. GitHub still
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
  on the title of the selected row opens it on GitHub. A tap or click selects
  and opens a row; tapping it again closes it.
- **Keyboard** (computers only; ignored while typing in a field or with Ctrl, Cmd or
  Alt held):

  | Key | Does |
  |---|---|
  | `j` / `↓`, `k` / `↑` | next / previous row |
  | `x` or space | open / close the selected row |
  | `Enter` or `o` | open on GitHub |
  | `a` | approve |
  | `m` | merge (still asks first) |
  | `r` | re-run failed checks |
  | `c` | comment |
  | `f` | Files and diffs (section 15) |
  | `s` | AI summary |
  | `h` | hide / unhide |
  | `1`–`4` | Needs you, WIP, CI failing, All |
  | `p` / `i` | PRs / Issues |
  | `/` | repo filter |
  | `?` | list of keys |

  A key that does not apply (approving your own PR, re-running with no failed checks)
  does nothing to GitHub and says why. A hint line with the main keys sits at the
  bottom on computers, not on phones.
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
returns to the list; the address is `#files/<owner>/<repo>/<number>`.

A file opens its diff, made by **omnidiff** (github.com/ivankovic/omnidiff, a pinned
release run on the server) from the file's two whole versions:

- **Only the changed parts are marked**, not whole lines: removed (before), added
  (after), changed (both), and **moved** code marked as moved, with the line it moved
  to or from. Unchanged lines more than 3 lines from a change fold into "N unchanged
  lines".
- **Before and after** side by side on a computer, one above the other on a phone.
- A note when omnidiff names the shape of the change: only whitespace, only comments,
  only moved code, a new file, a deleted file.
- Binary files and files over 1 MB are not diffed; the view says so and links to
  GitHub.
- Only for PRs and repos you can see (section 4). Read-only. The same two versions are
  diffed once and kept.

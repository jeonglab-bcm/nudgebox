# gh.bioinfolder.com — spec

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

One list, phone-friendly, in four sections, in this order:

| Section | A PR is here when |
|---|---|
| **Needs you** | a review is requested from you (or a team you are in); or it is your PR and it is ready to merge (checks passed, not blocked, approved or no review required); or it is your PR and changes were requested; or it is your PR and it has merge conflicts |
| **Waiting on others** | it is your PR and it waits for a review or for running checks |
| **CI failing** | any visible PR whose latest checks failed (yours first) |
| **Everything else** | every other open, visible PR |

A PR appears once, in the first section that matches. Each row shows repo, number,
title, author, age, review state, checks state, and draft status. Sorted newest
activity first within a section.

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

Issues, Slack/Alpy, email, self-hosted runner health, stacked-PR tools, a native app.

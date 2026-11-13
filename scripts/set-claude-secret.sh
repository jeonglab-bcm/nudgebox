#!/usr/bin/env bash
# SPEC 16: gives repositories the Claude key that "Fix with Claude" needs.
#
# Run it yourself, in your own terminal. The key is pasted at a hidden prompt and goes
# straight to GitHub as an encrypted repository secret. It is not shown, not written to a
# file, and not part of any command line. Nobody can read it back, GitHub included: to
# change it, run this again.
#
#   scripts/set-claude-secret.sh owner/repo [owner/repo ...]
#   scripts/set-claude-secret.sh --all [org]     every repository of the org that is not
#                                                archived (default: jeonglab-bcm)
#
# The key is one of:
#   an Anthropic API key (sk-ant-api...), from console.anthropic.com > API keys
#   a Claude subscription token (sk-ant-oat...), from running: claude setup-token
set -euo pipefail

die() { echo "$1" >&2; exit 1; }
command -v gh > /dev/null || die "This needs the GitHub CLI (gh)."
[ $# -gt 0 ] || die "Which repositories? Give owner/repo names, or --all."

if [ "$1" = --all ]; then
	org=${2:-jeonglab-bcm}
	mapfile -t repos < <(gh repo list "$org" --no-archived --limit 1000 --json nameWithOwner --jq '.[].nameWithOwner' | sort)
	[ "${#repos[@]}" -gt 0 ] || die "No repositories found in $org."
else
	repos=("$@")
fi
for repo in "${repos[@]}"; do
	[[ "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "Not a repository name: $repo (want owner/repo)."
done

[ -t 0 ] || die "Run this in a terminal, so the key can be pasted at a hidden prompt."
echo "The Claude key goes to ${#repos[@]} repositor$([ "${#repos[@]}" -eq 1 ] && echo y || echo ies):"
printf '  %s\n' "${repos[@]}"
read -rsp "Paste the key (nothing is shown), then Enter: " key
echo
key=${key//[[:space:]]/}
case "$key" in
	sk-ant-oat*) name=CLAUDE_CODE_OAUTH_TOKEN ;;
	sk-ant-*) name=ANTHROPIC_API_KEY ;;
	"") die "No key given. Nothing was changed." ;;
	*) die "That does not look like a Claude key (they start with sk-ant-). Nothing was changed." ;;
esac

failed=0
for repo in "${repos[@]}"; do
	if printf '%s' "$key" | gh secret set "$name" -R "$repo" > /dev/null 2>&1; then
		echo "  set     $repo"
	else
		echo "  FAILED  $repo (do you administer it?)"
		failed=$((failed + 1))
	fi
done
unset key
echo "$name: $(( ${#repos[@]} - failed )) of ${#repos[@]} repositories."
[ "$failed" -eq 0 ]

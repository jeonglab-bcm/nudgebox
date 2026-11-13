#!/usr/bin/env bash
# SPEC 16: the shell steps of .github/workflows/claude-fix-conflicts.yml, run on scratch
# repositories. Claude is a stand-in here (lines that edit files), and so are GitHub (a
# bare repository, a stub gh) and what Claude's runner does to the checkout before Claude
# starts. tests/acceptance/claude-workflow.test.ts cuts the steps out of the workflow
# file and runs this.
set -u
STEPS=${1:?"a directory with pr.sh merge.sh push.sh say.sh, cut out of the workflow"}
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/steps" "$ROOT/home"
cp "$STEPS"/*.sh "$ROOT/steps/"
pass=0; failn=0
ok() { pass=$((pass+1)); echo "  ok   $1"; }
no() { failn=$((failn+1)); echo "  FAIL $1"; }
is() { if [ "$2" = "$3" ]; then ok "$1"; else no "$1: got [$2] want [$3]"; fi; }
has() { case "$2" in *"$3"*) ok "$1" ;; *) no "$1: [$2] lacks [$3]" ;; esac; }
hasnt() { case "$2" in *"$3"*) no "$1: [$2] has [$3]" ;; *) ok "$1" ;; esac; }
G() { HOME="$ROOT/home" GIT_CONFIG_NOSYSTEM=1 git -c user.name=t -c user.email=t@example.invalid -c init.defaultBranch=main -c commit.gpgsign=false "$@"; }

new() { # new NAME: origin with main, a seed clone on main
  D="$ROOT/$1"; mkdir -p "$D/tmp" "$D/bin"
  G init -q --bare "$D/origin.git"
  G init -q "$D/seed"; cd "$D/seed"; G remote add origin "$D/origin.git"
  cat > "$D/bin/gh" <<'GH'
#!/usr/bin/env bash
case "$1 $2" in
  "api -X") exit 0 ;;
  "api "*) echo "${STUB_PERMISSION:-write}" ;;
  "pr view") echo "$STUB_PR" ;;
  "pr comment") cat > "$STUB_OUT/comment" ;;
esac
GH
  chmod +x "$D/bin/gh"
  # the push step's URL leads to this scenario's origin instead of github.com
  printf '[url "%s"]\n\tinsteadOf = https://x-access-token:tok@github.com/lab/repo.git\n' "$D/origin.git" > "$ROOT/home/.gitconfig"
  : > "$D/env"; : > "$D/out"
}
checkout() { # like actions/checkout with fetch-depth 0 on the head branch
  G clone -q "$D/origin.git" "$D/ws"; cd "$D/ws"; G checkout -q feature
}
step() { # step NAME [VAR=VALUE...]
  local name=$1; shift
  ( cd "$D/ws" 2>/dev/null || cd "$D"
    env -i PATH="$D/bin:$PATH" HOME="$ROOT/home" GIT_CONFIG_NOSYSTEM=1 RUNNER_TEMP="$D/tmp" GITHUB_ENV="$D/env" \
      GITHUB_OUTPUT="$D/out" GITHUB_WORKSPACE="$D/ws" PR=7 REPO=lab/repo GH_TOKEN=tok WHO=someone COMMENT=1 \
      HAS_KEY="${HAS_KEY:-true}" STUB_OUT="$D" STUB_PERMISSION="${STUB_PERMISSION:-write}" \
      STUB_PR="${STUB_PR:-{\"state\":\"OPEN\",\"isCrossRepository\":false,\"headRefName\":\"feature\",\"baseRefName\":\"main\"\}}" \
      WORK="$D/tmp/claude-conflicts" HEAD_REF=feature BASE_REF=main RUN_URL=https://example.invalid/run "$@" \
      bash --noprofile --norc -eo pipefail "$ROOT/steps/$name.sh" ) > "$D/$name.log" 2>&1
}
restore() { # what the action does to the checkout before Claude starts
  cd "$D/ws"
  local paths=(.claude .mcp.json .claude.json .gitmodules .ripgreprc CLAUDE.md CLAUDE.local.md .husky)
  mkdir -p .claude-pr; echo x > .claude-pr/x; echo "/.claude-pr/" >> .git/info/exclude
  rm -rf "${paths[@]}"
  for p in "${paths[@]}"; do G checkout origin/main -- "$p" 2>/dev/null || true; done
  G reset -q -- "${paths[@]}" >/dev/null 2>&1 || true
}
finish() { ( cd "$D/ws"; env -i PATH="$PATH" HOME="$ROOT/home" GIT_CONFIG_NOSYSTEM=1 "${@:2}" bash "$D/tmp/claude-conflicts/finish.sh" "$1" ) > "$D/finish.log" 2>&1; }
W() { echo "$D/tmp/claude-conflicts"; }

# ---------------------------------------------------------------------------------
echo "1. two text conflicts, a file with marker lines of its own, settings files, odd names"
new one
mkdir -p src .claude "dir with space"
printf 'a\nb\nc\n' > src/a.txt; printf 'x\ny\nz\n' > "dir with space/é b.txt"
printf 'test = `\n<<<<<<< ours\nfoo\n=======\nbar\n>>>>>>> theirs\n`\nline\n' > src/markers.test.ts
echo '{"v":1}' > .claude/settings.json; echo base > CLAUDE.md; echo keep > other.txt
G add -A; G commit -qm base; G push -q origin main
G checkout -qb feature
printf 'a\nB-feature\nc\n' > src/a.txt; printf 'x\nY-feature\nz\n' > "dir with space/é b.txt"
sed -i 's/^line$/line-feature/' src/markers.test.ts; echo feature > CLAUDE.md; echo '{"v":"feature"}' > .claude/settings.json
G add -A; G commit -qm feature; G push -q origin feature
G checkout -q main
printf 'a\nB-main\nc\n' > src/a.txt; printf 'x\nY-main\nz\n' > "dir with space/é b.txt"
sed -i 's/^line$/line-main/' src/markers.test.ts; echo main-only > new-on-main.txt; mkdir -p .husky; echo hook > .husky/pre-commit
G add -A; G commit -qm main; G push -q origin main
checkout
step pr; step merge
is "merge step: go" "$(grep -c '^go=true' "$D/out")" 2
is "files handed to Claude" "$(tr '\0' '|' < "$(W)/files")" "dir with space/é b.txt|src/a.txt|src/markers.test.ts|"
has "prompt names the files" "$(cat "$D/out")" "- src/a.txt"
has "prompt names the branches" "$(cat "$D/out")" 'is what `feature` (the pull request) has'
restore
finish hook; is "hook, nothing resolved: sends Claude back" "$?" 2
has "hook names what is left" "$(cat "$D/finish.log")" "- src/a.txt"
# Claude: resolves two, leaves one, touches things it should not
cd "$D/ws"
printf 'a\nB-feature+main\nc\n' > src/a.txt
printf 'test = `\n<<<<<<< ours\nfoo\n=======\nbar\n>>>>>>> theirs\n`\nline-feature-main\n' > src/markers.test.ts
echo junk > junk.txt; echo changed > other.txt
finish hook; is "hook, one left: sends Claude back" "$?" 2
hasnt "hook no longer names a resolved file" "$(cat "$D/finish.log")" "- src/a.txt"
hasnt "hook accepts a file's own marker lines" "$(cat "$D/finish.log")" "markers.test.ts"
printf 'x\nY-both\nz\n' > "dir with space/é b.txt"
finish hook CLAUDE_CONFLICTS_TOKEN=app; is "hook, all resolved: pushes" "$?" 0
is "pushed with" "$(cat "$(W)/pushed")" app
tip=$(G --git-dir="$D/origin.git" rev-parse feature)
is "origin has the merge" "$tip" "$(cat "$(W)/merge-sha")"
is "merge has two parents" "$(G --git-dir="$D/origin.git" rev-list --parents -n1 feature | wc -w)" 3
is "second parent is main" "$(G --git-dir="$D/origin.git" rev-parse feature^2)" "$(G --git-dir="$D/origin.git" rev-parse main)"
show() { G --git-dir="$D/origin.git" show "feature:$1"; }
is "a.txt is Claude's" "$(show src/a.txt | sed -n 2p)" "B-feature+main"
is "odd name is Claude's" "$(show "dir with space/é b.txt" | sed -n 2p)" "Y-both"
is "markers file is Claude's" "$(show src/markers.test.ts | tail -1)" "line-feature-main"
is "untouched file is as before" "$(show other.txt)" keep
is "main's new file came in" "$(show new-on-main.txt)" main-only
is "main's hook dir came in" "$(show .husky/pre-commit)" hook
is "settings file keeps the branch's change" "$(show .claude/settings.json)" '{"v":"feature"}'
is "CLAUDE.md keeps the branch's change" "$(show CLAUDE.md)" feature
is "no junk committed" "$(G --git-dir="$D/origin.git" ls-tree -r --name-only feature | grep -c -E 'junk|claude-pr')" 0
is "author" "$(G --git-dir="$D/origin.git" log -1 --format='%an <%ae>' feature)" "claude[bot] <209825114+claude[bot]@users.noreply.github.com>"
has "message" "$(G --git-dir="$D/origin.git" log -1 --format=%B feature)" "Merge branch 'main' into feature"
finish push; is "push after: nothing to do" "$?" 0
is "origin not moved" "$(G --git-dir="$D/origin.git" rev-parse feature)" "$tip"
printf '[{"type":"system"},{"type":"result","result":"Kept both in a.txt. Thanks @someone, token ghs_abcdefghijklmnopqrstuvwxyz0123."}]' > "$D/log.json"
step say LOG1="$D/log.json" LOG2=
c=$(cat "$D/comment")
has "comment: what was merged" "$c" 'Merged `main` into `feature`'
has "comment: the files" "$c" '- `src/a.txt`'
has "comment: Claude's words" "$c" "> Kept both in a.txt."
hasnt "comment: no mention" "$c" "@someone"
hasnt "comment: no token" "$c" "ghs_abc"
hasnt "comment: app push needs no note on checks" "$c" "starts no checks"
hasnt "comment does not start a new run" "$(head -c 7 "$D/comment")" "@claude"

echo "2. Claude never resolves: three tries, then a plain reason; nothing pushed"
new two
echo a > f.txt; G add -A; G commit -qm base; G push -q origin main
G checkout -qb feature; echo feature > f.txt; G commit -qam f; G push -q origin feature
G checkout -q main; echo main > f.txt; G commit -qam m; G push -q origin main
checkout; step pr; step merge; restore
before=$(G --git-dir="$D/origin.git" rev-parse feature)
for i in 1 2 3; do finish hook; is "try $i sends Claude back" "$?" 2; done
finish hook; is "fourth time lets it stop" "$?" 0
step push; is "push step does not fail the job" "$?" 0
is "nothing pushed" "$(G --git-dir="$D/origin.git" rev-parse feature)" "$before"
printf '[{"type":"result","result":"gave up"}]' > "$D/log.json"
step say LOG1="$D/log.json" LOG2=
has "comment says why" "$(cat "$D/comment")" "Claude could not fix the conflicts. Claude stopped before every conflict was resolved. Nothing was pushed. [What happened](https://example.invalid/run)"

echo "3. Claude never started (no session record)"
step say LOG1= LOG2=
has "comment blames the key" "$(cat "$D/comment")" "Claude did not start. The Claude key of this repository may be wrong or out of credit."

echo "4. hook cannot push; the push step does, with the workflow's token"
new four
echo a > f.txt; G add -A; G commit -qm base; G push -q origin main
G checkout -qb feature; echo feature > f.txt; G commit -qam f; G push -q origin feature
G checkout -q main; echo main > f.txt; G commit -qam m; G push -q origin main
checkout; step pr; step merge; restore
cd "$D/ws"; echo both > f.txt; G remote set-url origin "$D/nowhere.git"
finish hook CLAUDE_CONFLICTS_TOKEN=app; is "hook lets Claude stop" "$?" 0
has "reason kept" "$(cat "$(W)/error")" "GitHub refused the push."
step push
is "pushed with" "$(cat "$(W)/pushed" 2>/dev/null)" workflow
is "origin has Claude's file" "$(G --git-dir="$D/origin.git" show feature:f.txt)" both
printf '[{"type":"result","result":"Kept both."}]' > "$D/log.json"
step say LOG1= LOG2="$D/log.json"
has "comment notes the checks" "$(cat "$D/comment")" "GitHub starts no checks for this push"

echo "5. the branch moved while Claude worked"
new five
echo a > f.txt; G add -A; G commit -qm base; G push -q origin main
G checkout -qb feature; echo feature > f.txt; G commit -qam f; G push -q origin feature
G checkout -q main; echo main > f.txt; G commit -qam m; G push -q origin main
checkout; step pr; step merge; restore
cd "$D/seed"; G checkout -q feature; echo more > g.txt; G add -A; G commit -qm more; G push -q origin feature
moved=$(G rev-parse HEAD)
cd "$D/ws"; echo both > f.txt
finish hook; step push
is "the newer commit stays" "$(G --git-dir="$D/origin.git" rev-parse feature)" "$moved"
printf '[{"type":"result","result":"x"}]' > "$D/log.json"; step say LOG1="$D/log.json" LOG2=
has "comment says ask again" "$(cat "$D/comment")" '`feature` got new commits while Claude was working. Ask again.'

echo "6. conflicts Claude is not given"
new six
echo a > gone.txt; echo a > t.txt; printf '\x00\x01a' > b.bin; mkdir -p .github/workflows; echo a > .github/workflows/ci.yml; echo a > CLAUDE.md
G add -A; G commit -qm base; G push -q origin main
G checkout -qb feature; G rm -q gone.txt; echo f > t.txt; printf '\x00\x01f' > b.bin; echo f > .github/workflows/ci.yml; echo f > CLAUDE.md
G add -A; G commit -qm f; G push -q origin feature
G checkout -q main; echo m > gone.txt; echo m > t.txt; printf '\x00\x01m' > b.bin; echo m > .github/workflows/ci.yml; echo m > CLAUDE.md
G add -A; G commit -qm m; G push -q origin main
checkout; step pr; step merge
r=$(cat "$(W)/result" 2>/dev/null)
has "says they need a person" "$r" "Claude left these conflicts alone"
has "deleted" "$r" '- `gone.txt`: one side deleted or renamed it'
has "binary" "$r" '- `b.bin`: it is not text'
has "workflow" "$r" '- `.github/workflows/ci.yml`: it is a workflow file'
has "settings" "$r" '- `CLAUDE.md`: it is one of the settings files'
hasnt "the plain one is not blamed" "$r" 't.txt'
is "Claude is not started" "$(grep -c '^go=true' "$D/out")" 1
is "merge undone" "$(cd "$D/ws" && ls .git/MERGE_HEAD 2>/dev/null)" ""
is "checkout clean" "$(cd "$D/ws" && G status --porcelain)" ""
step say LOG1= LOG2=
has "comment is that message" "$(cat "$D/comment")" "Resolve them in Nudgebox or by hand."

echo "7. no conflicts; already merged"
new seven
echo a > f.txt; G add -A; G commit -qm base; G push -q origin main
G checkout -qb feature; echo f > g.txt; G add -A; G commit -qm f; G push -q origin feature
G checkout -q main; echo m > h.txt; G add -A; G commit -qm m; G push -q origin main
checkout; step pr; step merge
has "clean merge" "$(cat "$(W)/result")" '`feature` has no conflicts with `main` now'
is "nothing left behind" "$(cd "$D/ws" && G status --porcelain; ls "$D/ws/.git/MERGE_HEAD" 2>/dev/null)" ""

echo "8. who may ask, and what stops it early"
new eight; mkdir -p "$D/ws"
STUB_PERMISSION=read step pr
is "reader: no answer" "$(cat "$D/out")" ""
new nine; mkdir -p "$D/ws"
HAS_KEY=false step pr
has "no key" "$(cat "$(W)/result")" "the repository has no Claude key"
is "asked, not go" "$(cat "$D/out")" "asked=true"
new ten; mkdir -p "$D/ws"
STUB_PR='{"state":"OPEN","isCrossRepository":true,"headRefName":"feature","baseRefName":"main"}' step pr
has "fork" "$(cat "$(W)/result")" "branch is in a fork"
new eleven; mkdir -p "$D/ws"
STUB_PR='{"state":"MERGED","isCrossRepository":false,"headRefName":"feature","baseRefName":"main"}' step pr
has "not open" "$(cat "$(W)/result")" "is not open"

echo; echo "pass $pass, fail $failn"
[ "$failn" -eq 0 ]

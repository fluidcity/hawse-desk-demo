#!/usr/bin/env bash
# Presence-only leak check. For each secret env var that is SET in this shell, report whether its
# VALUE occurs in git history (all refs + reflog), the working tree (incl. gitignored data/), or stashes.
# Prints only the var name and match/no-match, never the value. Exit 1 on any match.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2
revs=$(git rev-list --all --reflog | sort -u)
hit=0
for n in HELIUS_API_KEY HELIUS_WEBHOOK_AUTH ODDS_API_KEY ODDS_API_KEY_PAID TRADOVATE_USERNAME TRADOVATE_PASSWORD TRADOVATE_SECRET \
         JUPITER_API_KEY ALCHEMY_API_KEY INFURA_API_KEY PYTH_API_KEY DUNE_API_KEY; do
  v="${!n:-}"
  if [ -z "$v" ]; then echo "$n: unset"; continue; fi
  if [ ${#v} -lt 6 ]; then echo "$n: set, too short to scan meaningfully"; continue; fi
  h=no; [ -n "$revs" ] && git grep -qF -e "$v" $revs -- 2>/dev/null && h=MATCH
  w=no; grep -rqF --exclude-dir=.git --exclude-dir=node_modules -e "$v" . 2>/dev/null && w=MATCH
  s=no; if git stash list | grep -q .; then git stash list --format=%H | while read -r c; do git show -p "$c" | grep -qF -e "$v" && exit 3; done; [ $? -eq 3 ] && s=MATCH; fi
  echo "$n: history=$h worktree=$w stash=$s"
  [ "$h$w$s" != "nonono" ] && hit=1
done
echo "revisions scanned: $(printf '%s\n' "$revs" | grep -c .)"
exit $hit

#!/usr/bin/env bash
# Fails when an internal domain or identity reaches the public tree or history.
# Terms are split so this script never matches itself.
set -euo pipefail

terms=("si""flow" "scitix-""inner" "算""秩")
patterns=()
message_patterns=()
for t in "${terms[@]}"; do
  patterns+=(-e "$t")
  message_patterns+=(--grep="$t")
done
status=0

if git grep -I -n -i -F "${patterns[@]}" HEAD -- .; then
  echo "::error::internal identifiers in tracked files"
  status=1
fi

hits=$(git log HEAD -i -F "${message_patterns[@]}" --format='%h %s')
if [[ -n $hits ]]; then
  echo "$hits"
  echo "::error::internal identifiers in commit messages"
  status=1
fi

hits=$(git log HEAD --format='%h %an <%ae> / %cn <%ce>' | grep -i -F "${patterns[@]}" || true)
if [[ -n $hits ]]; then
  echo "$hits"
  echo "::error::internal identifiers in commit authors or committers"
  status=1
fi

exit $status

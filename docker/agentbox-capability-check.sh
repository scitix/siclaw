#!/bin/sh
# Build-time assertion: every command the AgentBox tool surface ADVERTISES must exist in this image.
#
# The AgentBox is the only execution context whose binaries we control — node_exec runs in the
# node's namespaces and pod_exec inside the target container, so their whitelists can never be
# availability promises. Here it can be one, and this makes it enforceable at build time instead of
# surfacing as exit 127 in front of an agent. `yq` and `column` were advertised for a long time
# while no image shipped them; that is the failure this prevents from recurring.
#
# The list comes from the built code (agentboxRequiredCommands) so it cannot drift from the
# whitelist it is derived from.
set -eu

commands=$(node -e "
import('/app/dist/tools/infra/command-sets.js')
  .then((m) => console.log(m.agentboxRequiredCommands().join(' ')))
  .catch((err) => { console.error('capability-check: cannot read the command table:', err.message); process.exit(1); });
")

[ -n "$commands" ] || { echo "capability-check: derived an empty command list — refusing to pass" >&2; exit 1; }

missing=""
for cmd in $commands; do
  command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"
done

if [ -n "$missing" ]; then
  echo "capability-check FAILED — whitelisted and advertised, but absent from this image:$missing" >&2
  echo "Either install them in Dockerfile.agentbox or stop advertising them in the tool descriptions." >&2
  exit 1
fi

echo "capability-check: all advertised commands present ($(echo "$commands" | wc -w) checked)"

# `yq` on PATH must be the WRAPPER, not the real binary. Presence is not the property that matters
# here: yq's expression language opens files on its own, so an image where /usr/local/bin/yq is the
# plain binary hands every reader of this image an unrestricted file-read primitive. Asserted by
# behaviour rather than by inspecting the file, so it also fails if the wrapper stops forcing the
# switches or the flags are renamed upstream.
#
# All three assertions are needed, and the first is what keeps the other two honest: "load_str
# produced no output" is also what a stub, a wrapper with a typo, or a non-executable binary
# produces, so without proving yq still WORKS the refusal checks would pass by failing.
if command -v yq >/dev/null 2>&1; then
  if ! printf 'a: 1\n' | yq '.a' 2>/dev/null | grep -qx '1'; then
    echo "capability-check FAILED — yq on PATH does not evaluate a trivial expression." >&2
    echo "The wrapper is broken or is not passing arguments through; a yq that errors on everything" >&2
    echo "would silently satisfy the refusal checks below." >&2
    exit 1
  fi

  canary=$(mktemp)
  echo "capability-check-canary" > "$canary"
  if printf '{}' | yq "load_str(\"$canary\")" 2>/dev/null | grep -q "capability-check-canary"; then
    rm -f "$canary"
    echo "capability-check FAILED — yq on PATH can read arbitrary files via load_str." >&2
    echo "Install the real binary as /usr/local/lib/yq-real and expose the wrapper that forces" >&2
    echo "--security-disable-file-ops --security-disable-env-ops (see Dockerfile.agentbox)." >&2
    exit 1
  fi
  rm -f "$canary"

  if printf '{}' | SICLAW_CAPCHECK_ENV=capability-check-env yq 'env(SICLAW_CAPCHECK_ENV)' 2>/dev/null \
     | grep -q "capability-check-env"; then
    echo "capability-check FAILED — yq on PATH can read the environment via env()." >&2
    echo "The wrapper must force --security-disable-env-ops as well as --security-disable-file-ops." >&2
    exit 1
  fi

  echo "capability-check: yq evaluates expressions but refuses file and env operators"
fi

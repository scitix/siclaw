#!/bin/sh
set -eu

KBC_TEST_ROOT=$(git rev-parse --show-toplevel)
KBC_TEST_CONTEXT=$(mktemp -d "${TMPDIR:-/tmp}/siclaw-kbc-permissions.XXXXXX")
KBC_TEST_IMAGE=${KBC_PERMISSION_TEST_IMAGE:-siclaw-kbc-box:permission-smoke}
KBC_TEST_CONTAINER=

cleanup() {
  if [ -n "$KBC_TEST_CONTAINER" ]; then
    docker rm -f "$KBC_TEST_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "$KBC_TEST_CONTEXT" ] && [ -d "$KBC_TEST_CONTEXT" ]; then
    rm -rf -- "$KBC_TEST_CONTEXT"
  fi
}
trap cleanup EXIT HUP INT TERM

cp -R "$KBC_TEST_ROOT/kbc/." "$KBC_TEST_CONTEXT/"

# Reproduce a checkout/build context created under a restrictive umask. Docker
# can read these files as the builder user, but USER kbc must not depend on the
# original host modes after COPY.
find "$KBC_TEST_CONTEXT" -type d -exec chmod 0700 {} +
find "$KBC_TEST_CONTEXT" -type f -exec chmod 0600 {} +

docker build \
  -f "$KBC_TEST_CONTEXT/platform/pod/Dockerfile" \
  -t "$KBC_TEST_IMAGE" \
  "$KBC_TEST_CONTEXT"

docker run --rm --entrypoint python "$KBC_TEST_IMAGE" -c '
import os
from pathlib import Path

assert os.getuid() == 1000, f"expected uid 1000, got {os.getuid()}"
unreadable = []
for path in Path("/app").rglob("*"):
    if not path.is_file():
        continue
    try:
        with path.open("rb") as handle:
            handle.read(1)
    except OSError as exc:
        unreadable.append(f"{path}: {exc}")
assert not unreadable, "unreadable application files:\n" + "\n".join(unreadable)
import compile_box  # noqa: F401
'

KBC_TEST_CONTAINER=$(docker run -d -p 127.0.0.1:0:3000 "$KBC_TEST_IMAGE")
KBC_TEST_ADDRESS=$(docker port "$KBC_TEST_CONTAINER" 3000/tcp | sed -n '1p')

attempt=0
while [ "$attempt" -lt 30 ]; do
  if curl -fsS "http://$KBC_TEST_ADDRESS/health" >/dev/null; then
    echo "KBC image permission smoke passed as uid 1000 at $KBC_TEST_ADDRESS"
    exit 0
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$KBC_TEST_CONTAINER")" != true ]; then
    echo "KBC container exited before becoming healthy" >&2
    docker logs "$KBC_TEST_CONTAINER" >&2 || true
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 1
done

echo "KBC container did not become healthy within 30 seconds" >&2
docker logs "$KBC_TEST_CONTAINER" >&2 || true
exit 1

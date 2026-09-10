#!/usr/bin/env bash
set -euo pipefail
# The caller builds Dockerfile.script-sandbox-e2b and supplies its image name.
: "${SICLAW_E2B_SMOKE_IMAGE:?E2B template image is required}"
cert_dir=$(mktemp -d)
trap 'rm -rf "$cert_dir"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
  -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' \
  -keyout "$cert_dir/key.pem" -out "$cert_dir/cert.pem" >/dev/null 2>&1
chmod 600 "$cert_dir/key.pem"
docker run --rm --network none --user 0:0 --entrypoint /usr/local/bin/python3 \
  --mount "type=bind,source=$cert_dir,target=/test-certs,readonly" \
  --mount "type=bind,source=$PWD/scripts/smoke/e2b-relay.py,target=/test.py,readonly" \
  "$SICLAW_E2B_SMOKE_IMAGE" -I -B -u /test.py

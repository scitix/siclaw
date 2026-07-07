# platform/forge — local Forgejo (the git forge substrate for L3)

L3 platformization moves kbc from a "local command-line tool" onto the network. The substrate = a **git forge (Forgejo)**,
which provides out of the box: website + git storage + issues (adjudicate contradictions) / PRs (merge KB changes) + multi-tenancy.
kbc only builds a bridge on top of it (`platform/forge_client.py` / `bridge.py` / `worker.py`) and **does not rewrite any of these**.

See `design/L3-platform.md`.

## Up / down / clean

```bash
docker compose -f platform/forge/docker-compose.yml up -d      # up
docker compose -f platform/forge/docker-compose.yml down       # down (keeps data)
docker compose -f platform/forge/docker-compose.yml down -v    # clean (deletes data too, back to a clean state)
```

## Access / credentials (local development only)

- Web: <http://localhost:3300>
- Admin: `kbc` / `kbc-dev-2026` (email `kbc@local.dev`)
- Ports: web 3300 (local 3000/3001 are taken), ssh 2222

> ⚠️ This is a **throwaway local development environment**; the credentials are hardcoded in the docs. Do not use this configuration on any real environment.

## First-time initialization (run once after starting the container)

See `platform/forge/bootstrap.sh`: create the admin, create an API token, create the test repo `aliyun-fc` and push the conflicting corpus into it.

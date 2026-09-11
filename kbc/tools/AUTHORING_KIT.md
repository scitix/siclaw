# Local authoring kit

Export the compiler's deterministic checker and its reading standards for a local
coding-agent workspace:

```sh
python3 kbc/tools/authoring_kit.py /path/to/workspace/.local-kb --locale en
```

The kit contains the actual `selfcheck.py`, its source classification module,
compiler playbook/role, constitution, OKF citation guidance and consumer role.
`kit-manifest.json` records every file's SHA256 and the supported OKF version.
`local-consumer-role.md` adapts only the original consumer role's workspace path
to `candidate/`; the original role is retained separately.

A platform integration can combine this kit with a pinned workspace containing
`raw/`, `candidate/`, `authoring/` and `eval/`, then import
`checker/selfcheck.py` and call `run_layer1(workspace)`. The checker needs Python
3.11+ and PyYAML. Use a fresh Python process with only the checker directory added
to its import path; source content should never supply executable modules.

Use compiler instructions as content/quality standards. Cloud-only tools named
in the compiler role require adaptation to the local platform workflow. Local
consumer experiments should receive question text and Wiki access without
reference answers or Raw, then be assessed separately against those sources.

Local reports are development evidence. Proposal review, canonical versioning,
platform verification and publication remain the integrating platform's job.
Use a Siclaw checkout aligned with that platform's compiler release: matching OKF
versions alone does not prove matching compiler builds. The exporter preserves
existing kit files; create a new workspace when updating compiler versions.

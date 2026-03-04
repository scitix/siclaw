#!/bin/bash
set -euo pipefail

# Fuzzy-match Kubernetes nodes by keyword.

[[ "${1:-}" == "--keyword" ]] && shift
KEYWORD="${1:?Usage: find-node.sh --keyword <keyword>}"

kubectl get nodes -o wide 2>/dev/null | grep -iE "(NAME|$KEYWORD)"

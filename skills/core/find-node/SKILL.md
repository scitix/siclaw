---
name: find-node
description: >-
  Fuzzy-match Kubernetes nodes by keyword.
  Equivalent to `kubectl get nodes -o wide | grep <keyword>`, with header preserved.
  Use this instead of listing all nodes to keep context minimal.
---

# Find Node

## Usage

```bash
bash skills/core/find-node/scripts/find-node.sh <keyword>
```

## Examples

```bash
bash skills/core/find-node/scripts/find-node.sh gpu
bash skills/core/find-node/scripts/find-node.sh 192.168.1
bash skills/core/find-node/scripts/find-node.sh 061
```

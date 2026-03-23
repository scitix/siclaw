---
name: rbac-debug
description: >-
  Diagnose RBAC permission failures (Forbidden errors, service account cannot access resources,
  missing Role/ClusterRole bindings). Checks role bindings, permission grants, and auth verification.
---

# RBAC Permission Diagnosis

When API calls fail with `Forbidden` or `Unauthorized`, pods cannot access the API server, or service accounts lack expected permissions, follow this flow to identify the RBAC misconfiguration.

**Scope:** This skill is for **diagnosis only**. Once you identify the missing permission or binding, report it to the user and stop. Do NOT attempt to create or modify Roles, ClusterRoles, or bindings.

## Diagnostic Flow

### 1. Identify the failing identity

Determine who is making the failing request:

**For pod service account issues:**

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='serviceAccount={.spec.serviceAccountName}'
```

```bash
kubectl get serviceaccount <sa-name> -n <ns> -o yaml
```

**For user permission issues, check auth identity:**

```bash
kubectl auth whoami
```

### 2. Reproduce and confirm the permission error

Test if the identity can perform the action:

```bash
kubectl auth can-i <verb> <resource> --as=system:serviceaccount:<ns>:<sa-name> -n <target-ns>
```

Examples:

```bash
kubectl auth can-i get pods --as=system:serviceaccount:default:my-sa -n kube-system
kubectl auth can-i list secrets --as=system:serviceaccount:monitoring:prometheus -n default
kubectl auth can-i create deployments --as=user@example.com -n production
```

For a comprehensive check:

```bash
kubectl auth can-i --list --as=system:serviceaccount:<ns>:<sa-name> -n <target-ns>
```

### 3. Find RoleBindings for the identity

**Namespace-scoped bindings:**

```bash
kubectl get rolebinding -n <target-ns> -o json | jq '.items[] | select(.subjects[]? | (.kind == "ServiceAccount" and .name == "<sa-name>" and .namespace == "<ns>") or (.kind == "User" and .name == "<username>") or (.kind == "Group" and .name == "<group>")) | {name: .metadata.name, role: .roleRef}'
```

**Cluster-wide bindings:**

```bash
kubectl get clusterrolebinding -o json | jq '.items[] | select(.subjects[]? | (.kind == "ServiceAccount" and .name == "<sa-name>" and .namespace == "<ns>") or (.kind == "User" and .name == "<username>") or (.kind == "Group" and .name == "<group>")) | {name: .metadata.name, role: .roleRef}'
```

### 4. Inspect the bound Role/ClusterRole

If a binding was found, check what permissions it grants:

```bash
kubectl describe role <role-name> -n <ns>
```

or:

```bash
kubectl describe clusterrole <clusterrole-name>
```

Look at the **Rules** section — each rule has:
- **apiGroups** — the API group (e.g., `""` for core, `"apps"` for deployments)
- **resources** — resource types (e.g., `pods`, `deployments`, `secrets`)
- **verbs** — allowed actions (`get`, `list`, `watch`, `create`, `update`, `delete`, `patch`)
- **resourceNames** — (optional) specific resource names the rule applies to

### 5. Match pattern and conclude

---

#### No RoleBinding or ClusterRoleBinding found for the identity

The service account or user has no bindings at all — they only have the default permissions (usually none beyond basic discovery).

Report that the identity lacks any role binding and needs one created with the required permissions.

---

#### Binding exists but Role lacks the required verb

The binding points to a Role/ClusterRole, but that role doesn't include the verb the identity needs (e.g., role has `get` and `list` but the request needs `create`).

Report the existing role's rules and what additional verb/resource is needed.

---

#### Binding exists but Role lacks the required resource type

The role grants permissions on some resources but not the one being accessed (e.g., role allows `pods` but the request is for `pods/exec` or `pods/log`).

Note: Sub-resources like `pods/exec`, `pods/log`, `pods/portforward` are separate resources in RBAC.

---

#### RoleBinding in wrong namespace

A RoleBinding only grants permissions in its own namespace. If the binding is in namespace `A` but the identity needs access to namespace `B`, it won't work.

```bash
kubectl get rolebinding -A -o json | jq '.items[] | select(.subjects[]? | .name == "<sa-name>") | {namespace: .metadata.namespace, name: .metadata.name, role: .roleRef}'
```

Report which namespace the binding is in vs. which namespace the access is needed for.

---

#### ClusterRole bound via RoleBinding — limited to one namespace

A ClusterRole bound via a **RoleBinding** (not ClusterRoleBinding) only grants permissions in the RoleBinding's namespace. This is a common pattern for reusable roles.

If cluster-wide access is needed, a **ClusterRoleBinding** is required instead.

---

#### Aggregated ClusterRole missing a component

Some ClusterRoles use label-based aggregation (e.g., `admin`, `edit`, `view`). The expected permissions come from other ClusterRoles that match the aggregation selector.

```bash
kubectl get clusterrole <role> -o jsonpath='{.aggregationRule}'
```

If the aggregation rule exists, check which sub-roles contribute:

```bash
kubectl get clusterrole -l <label-selector> -o custom-columns='NAME:.metadata.name'
```

A missing sub-role means the aggregated role lacks those permissions.

---

#### Service account token not mounted

The pod may not have the service account token mounted. Check:

```bash
kubectl get pod <pod> -n <ns> -o jsonpath='{.spec.automountServiceAccountToken}'
```

If `false`, the pod cannot authenticate to the API server. Also check the ServiceAccount:

```bash
kubectl get serviceaccount <sa-name> -n <ns> -o jsonpath='{.automountServiceAccountToken}'
```

## Notes

- `kubectl auth can-i --list` shows all permissions for an identity — useful for a full audit.
- Service accounts are namespaced: `system:serviceaccount:<namespace>:<name>`. The namespace matters in RoleBinding subjects.
- The `system:authenticated` and `system:unauthenticated` groups have default ClusterRoleBindings — check those for baseline permissions.
- Some controllers use impersonation. If you see a user identity that's actually a controller, check if the controller's SA has `impersonate` permissions.
- For pods that access the API via client libraries (not kubectl), the same RBAC rules apply — the service account token is at `/var/run/secrets/kubernetes.io/serviceaccount/token`.

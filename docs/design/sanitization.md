---
title: "Output Sanitization Architecture"
sidebarTitle: "Sanitization"
description: "How command output is sanitized before reaching the LLM agent, and why."
---

# Output Sanitization Architecture

> **Purpose**: Document the multi-layer output sanitization strategy that prevents
> sensitive data from reaching the LLM agent's context window.
>
> **Audience**: Anyone modifying `output-sanitizer.ts`, `kubectl-sanitize.ts`,
> `restricted-bash.ts`, or adding new tools/skills that handle sensitive output.

---

## 1. Design Intent

The agent executes shell commands that may produce output containing credentials,
tokens, or other sensitive data. The sanitization system ensures this data is
**redacted before it enters the LLM's context** — preventing the model from
learning or leaking secrets.

### Two Complementary Strategies

The security pipeline uses **pre-execution blocking** and **post-execution
redaction** as complementary strategies. Understanding which strategy applies
to what is essential:

| What's protected | Strategy | Mechanism | Example |
|-----------------|----------|-----------|---------|
| Sensitive **paths** (credential files, /proc/environ) | **Pre-execution blocking** | Pass 6 in `command-validator.ts` | `cat ~/.ssh/id_rsa` → blocked before execution |
| Dangerous **operations** (writes, redirections, injection) | **Pre-execution blocking** | Passes 1-5 in `command-validator.ts` | `kubectl delete pod` → blocked |
| Sensitive **resource types** (Secret, ConfigMap, Pod envs) | **Post-execution redaction** | `output-sanitizer.ts` | `kubectl get secret -o yaml` → runs, output redacted |
| Environment **variables** in output | **Post-execution redaction** | `output-sanitizer.ts` | `env` output → sensitive vars stripped |
| File **content** with credentials | **Post-execution redaction** | `output-sanitizer.ts` | `cat /etc/config` on remote node → credentials redacted |

**Why not block sensitive resources pre-execution?** The command `kubectl get secret`
itself is safe to run — it's the *output* that contains sensitive data. Blocking
the command entirely would prevent legitimate diagnostic workflows (e.g., checking
if a Secret exists, viewing its metadata). Instead, we let it run and redact the
sensitive fields from the output.

---

## 2. The Three Sanitization Layers

Output sanitization has three independent layers. Each layer catches cases
that earlier layers might miss:

```
Command executes → stdout captured
        │
        ▼
┌─────────────────────────────────────────────────────┐
│ Layer 1: analyzeOutput() — Pre-analysis             │
│                                                       │
│ Before execution, determines if output will need      │
│ sanitization. Returns an OutputAction with a          │
│ sanitize function, or null if no sanitization needed. │
│                                                       │
│ Lookup: OUTPUT_RULES[binary](args)                    │
│ Registered: kubectl, cat, head, tail, grep, env, ...  │
└─────────────────────┬───────────────────────────────┘
                      │ OutputAction
                      ▼
┌─────────────────────────────────────────────────────┐
│ Layer 2: applySanitizer() — Post-execution          │
│                                                       │
│ Applies the sanitize function from Layer 1 to the     │
│ actual command output.                                │
│                                                       │
│ Redaction methods (selected by Layer 1):              │
│ • sanitizeJSON() — structural: removes data/stringData│
│   from Secret JSON, envs from Pod/ConfigMap JSON      │
│ • redactSensitiveContent() — line-level: regex match  │
│   on KEY=VALUE and KEY: VALUE patterns                │
│ • redactEnvOutput() — specialized for env/printenv    │
│ • sanitizeCrictlInspect() — JSON env array redaction  │
└─────────────────────┬───────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│ Layer 3: Pipeline Fallback — Safety net             │
│ (restricted-bash.ts only)                            │
│                                                       │
│ For MULTI-COMMAND pipelines containing kubectl        │
│ get/describe on a sensitive resource:                 │
│ Apply redactSensitiveContent() to the FINAL output,  │
│ regardless of what the last command in the pipe is.   │
│                                                       │
│ Example: kubectl get secret -o yaml | grep -v metadata│
│ → grep has no registered OUTPUT_RULE                  │
│ → Layer 3 applies line-level redaction to grep output │
│                                                       │
│ This layer catches cases where sensitive data flows   │
│ through a pipe to a command without its own sanitizer.│
└─────────────────────────────────────────────────────┘
```

### Why Three Layers?

- **Layer 1+2** (analyzeOutput + applySanitizer): Handle single commands and the
  *first* command in a pipeline. Precise — selects the right sanitization method
  based on the command and its arguments.

- **Layer 3** (pipeline fallback): Handles the case where `kubectl get secret -o yaml`
  is piped to `jq .data` or `grep password` — the last command in the pipeline
  determines stdout, but it has no OUTPUT_RULE. Without Layer 3, the sensitive
  data would pass through unsanitized.

---

## 3. OUTPUT_RULES Reference

Registered sanitization rules by command:

| Command | Trigger condition | Sanitization method |
|---------|------------------|-------------------|
| `kubectl get` | Resource is Secret, ConfigMap, or Pod | JSON format → `sanitizeJSON()`; YAML/other → `redactSensitiveContent()` |
| `kubectl describe` | Resource is ConfigMap or Pod (not Secret — describe shows byte counts only) | `redactSensitiveContent()` |
| `cat`, `head`, `tail`, `less`, `more` | Always (when in remote context where these are allowed) | `redactSensitiveContent()` |
| `grep`, `egrep`, `fgrep` | Always | `redactSensitiveContent()` |
| `strings`, `zcat`, `zgrep` | Always | `redactSensitiveContent()` |
| `env`, `printenv` | Always | `redactEnvOutput()` (specialized KEY=VALUE redaction) |
| `crictl inspect` | Subcommand is `inspect`, `inspecti`, or `inspectp` | `sanitizeCrictlInspect()` (JSON env array redaction) |

**Source**: `OUTPUT_RULES` in `src/tools/infra/output-sanitizer.ts`

---

## 4. Redaction Patterns

### Sensitive Key Name Patterns

Matched against KEY in `KEY=VALUE` or `KEY: VALUE` output lines:

```
*_API_KEY, *_SECRET*, *_TOKEN*, *_PASSWORD*, *_CREDENTIAL*
*_PRIVATE_KEY, *_ACCESS_KEY, *_AUTH*
ANTHROPIC_*, OPENAI_*, SICLAW_LLM_*
DATABASE_URL, REDIS_URL, MONGODB_URI, CONNECTION_STRING
```

**Source**: `SENSITIVE_ENV_NAME_PATTERNS` in `src/tools/infra/kubectl-sanitize.ts`

### Sensitive Value Patterns

Matched against the value content regardless of key name:

```
JWT tokens (eyJ...), PEM blocks (-----BEGIN), base64-encoded certs
Connection strings (postgres://, mysql://, mongodb://, redis://)
Known API key prefixes (sk-ant-, sk-proj-, xoxb-, ghp_, ghu_)
Bearer tokens, Basic auth headers
```

**Source**: `SENSITIVE_VALUE_PATTERNS` in `src/tools/infra/kubectl-sanitize.ts`

---

## 5. Skill Script Exemption

Skill scripts executed via `local_script` are **NOT sanitized** by this framework.

**Rationale**: Skill scripts are trusted code — they go through a 3-gate approval
process (static analysis → AI semantic review → human approval) before reaching
production. Sanitizing their output would:
1. Break scripts that legitimately need to parse Secret/ConfigMap data
2. Add overhead with no security benefit (the script author controls what's output)

**The security boundary for skills is the approval gate, not runtime sanitization.**

However, ad-hoc commands that skill scripts *depend on* (e.g., the agent running
`kubectl get configmap` between skill calls) DO go through sanitization. This is
an important distinction when modifying sanitization rules.

---

## 6. Cross-Cutting Concerns

### ⚠️ When Modifying Sanitization Rules

Changes to `output-sanitizer.ts` or `kubectl-sanitize.ts` can affect:

1. **Core skills**: Skills that parse `kubectl get` output may break if the
   sanitizer removes fields they expect. However, skill scripts run through
   `local_script` (exempt from sanitization), so only ad-hoc kubectl calls
   between skill invocations are affected.

2. **Deep investigation sub-agents**: Sub-agents use `restricted_bash` and are
   subject to sanitization. Changing what gets redacted can alter investigation
   quality.

3. **Pipeline behavior**: Adding a new OUTPUT_RULE for a command that commonly
   appears after a pipe may cause double-sanitization (Layer 2 + Layer 3).
   Test with multi-command pipelines.

### When Adding New Commands to the Whitelist

If the new command can produce sensitive output:
1. Add an `OUTPUT_RULES` entry in `output-sanitizer.ts`
2. Use `redactSensitiveContent()` for line-level redaction, or write a custom
   sanitizer for structured output (JSON, XML)
3. Add test cases in `output-sanitizer.test.ts`

### Relationship to Other Security Layers

```
Layer 1 (OS isolation)    → sandbox user cannot READ credential files
Layer 2 (command whitelist) → blocks DANGEROUS commands pre-execution
Layer 5 (env sanitization)  → strips secrets from PROCESS environment
This doc (output sanitization) → redacts secrets from COMMAND OUTPUT
```

Each layer is independent. Output sanitization is the **last line of defense**
before data enters the LLM context window.

---

## 7. Key Files

```
src/tools/infra/output-sanitizer.ts      OUTPUT_RULES, analyzeOutput(), applySanitizer()
src/tools/infra/kubectl-sanitize.ts      sanitizeJSON(), detectSensitiveResource(), redaction patterns
src/tools/shell/restricted-bash.ts       Pipeline fallback (Layer 3), isSkillScript()
src/tools/infra/output-sanitizer.test.ts Test coverage for sanitization rules
src/tools/infra/kubectl-sanitize.test.ts Test coverage for kubectl-specific sanitization
```

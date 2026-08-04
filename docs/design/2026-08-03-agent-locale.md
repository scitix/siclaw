# Per-agent language and timezone

**Status**: implemented.

An agent can be given a reply language and a timezone in Portal. This records
what must hold for those two values, and why they are delivered the way they
are.

---

## The problem each one solves

**Timezone.** Asked "今天是几号", a coordinator answered "我无法直接获取当前日期",
and it was right. `prompt.ts` carries no date and cannot: `systemPromptOverride`
is a thunk the resource loader evaluates at load/reload, not per turn, and a
pooled box (`SICLAW_AGENTBOX_IDLE_TIMEOUT=0`) keeps a session alive for days — a
date fixed there goes stale and is then stated *confidently*, which is worse
than not knowing. A coordinator also has no shell: its capability set omits
`run_commands` deliberately, so `date` is not a fallback for it.

**Language.** Detection reported `"English"` for two different things — "this is
English" and "I cannot tell". A Chinese conversation therefore flipped to
English the moment someone sent `1`, `ok`, or a pasted command.

---

## Contracts

### 1. The floor is the CONVERSATION, not the agent and not a user

An AgentBox is keyed by agent alone — `podName()` is `agentbox-{agentId}-{instance}` — so one box,
and one agent config, serves every user of that agent. An agent-level reply language therefore
answers one person in another person's language, which is the original bug pointed at someone
else.

A per-user store cannot be the fix either: `userId` reaches the box on the Portal-web, API-key and
cron paths, but **channel messages carry none** — the sender's `open_id` exists at ingestion and is
deliberately not forwarded; the session registry records the binding's owner. That is the surface
with the most people per agent.

The session is the scope that works everywhere and needs no identity at all. Portal sessions are
per-person; a Feishu `per_user` group keys the session by sender; a Feishu `shared` group gives the
whole room one session — where one language for the room is the intended behaviour. So:

```
language:  detected this turn        ?? this conversation ?? agent default ?? English
timezone:  reported by the client    ?? this conversation ?? agent default ?? UTC
```

`resolveLocale` is the single function implementing both ladders. They differ only in their top
rung — language has per-turn detection, timezone has a per-turn report — so resolving one and
forgetting the other is not something a caller can do.

### 2. Only live signals are remembered

`rememberLocaleSignals` writes what the user wrote and what their client reported. It never writes
the agent's default: recording a default as though the conversation had revealed it would freeze it
in place and defeat the point of it being a default. It reports whether anything changed so an
ordinary turn costs no I/O.

The store is `.locale-state.json` in the session dir, alongside `.model-route-state.json` and
copying it exactly (atomic tmp+rename, writes serialized per session). It is read back as untrusted
input — a corrupt or hand-edited value degrades to "nothing remembered".

**Remembering a language must never be able to fail a turn.** The state object is healed if absent
rather than asserted, and a failed write warns and moves on.

### 3. The agent's two settings keep narrower jobs

`agents.language` is the language a conversation *opens* in, before anything readable has been
said. That is a real need — a Chinese team's agent should not open in English — with no multi-user
hazard, because turn 1 has no history for it to override and the first readable message replaces
it.

`agents.timezone` does two things that genuinely are agent-level: it sets the pod's own `TZ` (one
process, one clock) and it is the fallback for turns whose sender has no client to ask — every
channel message, scheduled task and API call. The two halves take effect at different times (the
pod's clock on its next restart, the fallback on the next message) and the UI says so.

### 4. Delivery is per prompt

Both values ride `ResolvedModelBinding`, fetched on every prompt, plus a per-turn `clientTimezone`.
Never the spawn environment: that is read once at cold spawn, so on a resident pod a saved setting
would need a recycle. It is also the only way a date can be correct on a box whose session outlives
it — `systemPromptOverride` is a load-time thunk, so a date fixed there goes stale and is then
stated *confidently*.

**There are two independent readers of agent config, and that has already bitten.**
`gateway/agent-model-binding.ts` goes through the control-plane RPC; `portal/chat-gateway.ts` reads
the DB directly and serves Portal web chat and a2a. Both fields are optional, so a SELECT that
forgets them compiles, passes every test, and is silently `undefined` on whichever path was missed.
It shipped exactly that way once. `binding-locale-invariants.test.ts` pins every binding-hydrating
SELECT, the same way `model-api-invariants.test.ts` pins `api_type` after the same class of bug.

### 5. The time reminder never throws

It runs on every turn, so a zone it cannot use degrades to UTC rather than taking the turn with it.
`isValidTimezone` at write time keeps a bad zone out of the agent row; every candidate in the
ladder is validated on the way through, including the remembered and reported ones.

The reminder names both the zone and its offset. That is not decoration: an SRE agent also sees UTC
timestamps in logs and from `date`, and the only way it can reconcile them is if the line says which
clock it is quoting.

### 6. Every turn gets both, including the ones built inside the session

A sub-agent's briefing and a background job's completion turn are built after the HTTP handler
returned, so they have no request body and no agent defaults — the conversation's memory is their
whole input. Both go through one builder so neither can silently lose the reminder; each is read by
the user exactly like an interactive answer.

### 7. No reply-language instruction is derived from PROFILE.md

`PROFILE.md` lives at `user-data/agents/{agentId}` — shared by every user of the agent, and updated
with whoever wrote last. Deriving *"this user's preferred language is X, start conversations in X"*
from it therefore instructed user B in user A's language, and did so from a load-time thunk that
could be days stale. Removed.

**Still true and NOT fixed here:** the file's whole content — name, role, infrastructure — is
injected as context for every user of the agent. Language was only the part that also became an
instruction. Making PROFILE.md per-user is a larger change and needs its own decision.

### 8. UI: the offered languages are the detectable ones

The picker lists only languages detection can also return. Offering French — for which detection
reports `"English"`, since both are Latin script — would be a setting that silently loses to the
very messages it exists to govern.

The timezone list comes from the browser (`Intl.supportedValuesOf`) so it tracks tzdata without
anyone maintaining it, **with `UTC` prepended**: the spec returns canonical zones only, so the list
contains neither `UTC` nor any `Etc/*` link. Without that, the one zone the runtime falls back to,
names in its own reminder, and accepts from the API would be the one zone an operator could not
pick.

## Cross-repo

For agents driven by an upstream control plane, that control plane answers
`config.getModelBinding` with its own payload. Reading two new optional keys is
backward-compatible — a control plane that does not send them behaves exactly as
before — but **its agents get neither setting until it adds the fields and the
UI on its side.**

---

## Non-goals

- Re-detecting or re-deriving the language mid-turn. One decision per turn,
  taken from the prompt text.
- Applying the ladder to a steer. A steer joins a turn that already carries its
  directive, and the conversation context is what keeps it in language.
- Making PROFILE.md per-user (see contract 7).
- A per-user locale store. It would miss every channel sender, which is the
  population it would most need to serve.

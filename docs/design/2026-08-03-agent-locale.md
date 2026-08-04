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

### 1. Both values ride the prompt, not the spawn environment

`ResolvedModelBinding` is fetched on every prompt and already carries non-model
agent settings, so the two fields travel with it and reach the AgentBox in the
request body of each turn.

This is the load-bearing choice. The spawn environment is evaluated once, at
cold spawn; with resident pods a settings change would then need a pod recycle
to take effect. Delivering per prompt means **a save is live on the next
message**, and it is also the only way a date can be correct on a box whose
session outlives it.

Consequence for `reloadResources`: there is nothing to push. Warm sessions are
not invalidated by a language or timezone change.

### 2. Detection wins; configuration is the floor

`resolveReplyLanguage(detected, configured)` = `detected ?? configured ?? English`.

Text whose language can be read is answered in that language, so a bilingual
user who switches is followed rather than corrected. The configured value
decides **only** the turns detection cannot read. This is why
`detectScriptLanguage` returns `null` rather than `"English"` for text with no
letters in it — collapsing those two answers is what the bug was.

Latin script resolves to `"English"`, deliberately: it is weak evidence (dozens
of languages share it) but it is the only evidence there is, and treating it as
absent would answer an English question in the agent's configured language,
inverting the rule above. The practical limit this imposes is stated in the UI
contract below.

### 3. The time reminder never throws

`renderTimeReminder` runs on every turn, so a zone it cannot use degrades to UTC
rather than taking the turn with it. `isValidTimezone` at write time is what
stops a bad zone being stored; the degrade is the backstop for a value that got
in another way (a control plane that does not validate, a hand-edited row).

The reminder names both the zone and its offset. That is not decoration: an SRE
agent also sees UTC timestamps in logs and from `date`, and the only way it can
reconcile them is if the line says which clock it is quoting.

### 4. Every turn gets both, including the ones built inside the session

Three kinds of turn exist and all three must carry the reminder and the
directive:

- an HTTP `/prompt` turn, which has the values in its body;
- a spawned sub-agent's briefing, which runs in its own session;
- a background job's completion turn, which is synthetic.

The last two are built after the HTTP handler returned, so the resolved values
are remembered on the managed session and reused. A synthetic turn's text is
machine-generated, so detection has nothing to read there and the configured
language is all there is.

### 5. The timezone has two halves with different timing

The model's answers change on the **next message**. The instance's own clock —
what `date` in an agent's shell reads — follows on that instance's **next
restart**, because that half is delivered by mapping `timezone` to the pod's
`TZ` at spawn. The UI has to say this; an operator who changes the zone and then
checks `date` would otherwise report it as broken.

### 6. UI: the offered languages are the detectable ones

The picker lists only languages detection can also return. Offering French — for
which detection reports `"English"`, since both are Latin script — would be a
setting that silently loses to the very messages it exists to govern.

The timezone list comes from the browser (`Intl.supportedValuesOf`) so it tracks
tzdata without anyone maintaining it, **with `UTC` prepended**: the spec returns
canonical zones only, so the list contains neither `UTC` nor any `Etc/*` link.
Without that, the one zone the runtime falls back to, names in its own reminder,
and accepts from the API would be the one zone an operator could not pick.

---

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
- Applying the configured language to a steer. A steer joins a turn that already
  carries its directive, and the conversation context is what keeps it in
  language.
- Recording the agent's configured language in the user's PROFILE.md. Only the
  *detected* language is a fact about the user; writing the configured one there
  would let an operator's setting rewrite someone's profile.

# Exec classification and operand quoting

Four defects, one shared shape: **the tool told the agent something that was not true**, and the
agent acted on it. A filter that matched nothing was reported as an upstream failure; a successful
early-exit pipeline as an incomplete read; a legitimate regex as a path; a missing metric as a
missing object. Each one costs turns — the agent abandons a correct conclusion and retries, or
routes around a command that was never wrong.

Evidence: the review backlog on `builtin_tool/bash` (126 findings, 190 mentions, high severity,
first reported 2026-08-20, still growing 2026-09-01), plus the production traces those findings
cite. Every defect below was reproduced locally before being changed.

## Contracts

### Aligning per-stage status with the shell's own segments

`PIPESTATUS` describes **one** pipeline — the last one bash actually executed. Command text may hold
several, joined by `;`, `&`, `&&` or `||`. Attributing statuses to commands therefore requires
answering "which pipeline do these belong to", and that question has no answer in some cases.

- Segmentation uses the **same quote-aware splitter as command validation** (`extractPipeline`).
  There is one splitter for this, not two: a `|` inside a grep alternation (`'a|b'`) is not a stage
  boundary, and a second implementation would drift from the first.
- `PipelineSegment.sep` records the operator that preceded a segment. `piped` cannot substitute for
  it: `&&` and `||` short-circuit, so a pipeline written after one may never have run, while `;` and
  `&` always execute what follows.
- Alignment succeeds only when **exactly one** candidate pipeline has the right stage count.
  Candidates are the trailing group plus, transitively, any group reachable backwards through
  `&&`/`||`. Otherwise it returns nothing.
- **Returning nothing is a correct answer.** For `a || b` with a single status, "a succeeded and b
  never ran" fits exactly as well as "a failed and b succeeded". Callers degrade; they do not guess.
- Never take the last N segments as a shortcut. For `echo a | grep -q zzz && echo yes` the statuses
  are `[0, 1]` and the trailing two segments have the right **length** and the wrong **meaning** — a
  length check would then certify a mapping that is entirely wrong.

What each judgment may rely on:

| Judgment | Needs alignment? | Why |
|---|---|---|
| A stage was ended by SIGPIPE benignly | **No** | Derivable from statuses alone — see below |
| An upstream stage really failed | No | A non-zero, non-SIGPIPE status is a failure whoever produced it |
| The final stage was cut short | No | Position, not identity |
| A filter matched nothing | **Yes** | Requires knowing the stage *is* a filter — safety property, see below |
| Naming a stage in the annotation | Yes | Cosmetic; degrades to a bare position |

### SIGPIPE is answered by the statuses, not by the stage text

SIGPIPE reaches a writer only when the **read end closed**, so the statuses downstream settle it: if
the first stage below that was not itself killed exited 0, it closed the pipe and then finished
normally, which is how `head`, `grep -q` and `grep -m N` end a pipeline. A non-zero, non-SIGPIPE
status down there is the real failure and is reported instead.

**SIGPIPE cascades**, and reading only the adjacent stage gets this wrong. When the consumer at the
end of a pipeline stops reading, every stage above it is killed, not just the one feeding it:
`seq … | cat | head -1` and `seq … | grep -v zzz | head -1` both report `[141, 141, 0]`. Judging the
first 141 against its neighbour made it an ordinary failure, so `kubectl logs pod | grep -v noise |
head -20` — one of the commonest shapes there is — came back carrying the very sentence this change
removes.

This used to check the next stage's text against a list of early-exit consumers, which made a benign
SIGPIPE depend on an alignment that cannot always be delivered. Deriving it from statuses removes
the dependency: the verdict survives even when no stage can be attributed at all. That matters —
`seq … | head -2 && echo x | cat` is unalignable by construction, and reporting it as an error would
break a command that works.

### A filter that matched nothing is not an upstream failure

`kubectl logs pod | grep X | tail -20` gives `PIPESTATUS [0, 1, 0]`. The middle `1` is grep saying
"no match", which is the **result**. Reporting it as a failure was the largest single group in the
backlog, and its wording asserted the opposite of the truth: *"an empty result here means the EARLIER
stage failed, not that nothing matched."*

- Only exit **1** from a command whose exit 1 means "found nothing" is relaxed. grep's exit 2 (bad
  pattern, unreadable input) stays a failure.
- The stage's binary is resolved the same way the rest of the file resolves one, so `LC_ALL=C grep`
  and `/bin/grep` are recognised. A bare whitespace split would have made the relaxation inert for
  both.
- **The relaxation requires alignment, and that is a safety property, not a nicety.** With the old
  text split, `echo "a | grep -v x" | kubectl get pods | jq .items` put `grep` at subscript 1;
  relaxing without alignment would silently downgrade kubectl's real failure to "no match" — the
  false success this whole mechanism exists to remove.

### A missing metric is not a missing object

`kubectl top node X` against a cluster with no metrics data was reported two different wrong ways: a
NotFound from the metrics API became "this object does not exist" (while the same trace had just read
that node from the API), and a ServiceUnavailable became "the target never ran the command".

- Metrics answers are recognised **before** any `Error from server` branch. `ServiceUnavailable` is a
  channel marker with no context guard, so anything placed after that check is unreachable.
- Recognition is by the `metrics.k8s.io` group, not by enumerating resource kinds. The string appears
  as `nodemetrics.metrics.k8s.io`, `podmetrics.metrics.k8s.io` **and** `nodes.metrics.k8s.io`
  depending on whether the aggregation layer is registered; enumerating the singular forms missed the
  plural one, which is the commonest case. Same principle as reading the client's own refusal instead
  of curating a flag list.
- The class is "the target reported failure": the request reached a server and got an answer, so it
  is not a transport fault — but the answer is not data either, so it is not "no match", whose
  contract is *the query succeeded and the answer is none*.
- **One message, two causes, and it must not pick one.** `nodemetrics… "X" not found` is returned both
  for a node that does not exist and for one that exists but has not been scraped. The annotation
  names both and gives the call that settles it. Asserting either is a new untruth in place of the
  old one.

### Quoting decides whether an argument becomes a path

Stdin-only text commands may not read files. The rule works by a quota: the leading positionals are
the **expression** (grep's pattern, jq's filter, tr's SETs) and are exempt, because a regex
legitimately contains `$`, `[` and `/`; everything else is screened for path shape.

- **Option arity is part of that quota.** A flag's value is neither an expression nor a positional.
  Consuming it is what stops `grep -m 5 PATTERN` from spending the pattern quota on `5`; screening it
  is what stops `grep -m /etc/shadow` from hiding a path there. Both halves are load-bearing. Arity
  can exceed one (`jq --arg NAME VALUE`).
- **The expression slot is exempt from the path rule, not from expansion.** It used to be exempt from
  everything, so an unquoted glob placed there reached the command as an expanded list of paths — the
  first becoming the pattern, the rest becoming files it reads. This applied to every command with an
  expression slot and to pattern-supplying flags (`-e`, `--regexp`), attached or separated.
- **Quoting is the discriminator, and it is per character.** In `'$CRED'/clusters/*` the `$` is inert
  and the `*` is not. Single quotes and `$'…'` suppress everything; double quotes suppress globbing
  but **not** parameter substitution — `"$HOME/x"` really does become a path. A `$` is only live when
  something expandable follows: `grep "error$"` and `grep "^$"` are literals, and reading every `$`
  in double quotes as live refuses two of the most common things anyone greps for. Characters reached
  through a backslash are inert wherever they appear, double quotes included.
- **No expansion check is added to the operand slot, and none is needed.** Its character class is a
  strict superset of the expansion metacharacters and it matches after quotes are stripped, so
  anything the expansion rule would catch there is already refused. That is what makes this
  relaxation safe by construction rather than by test coverage.
- **An unquoted expansion is refused, not tolerated.** The narrower alternative — refuse only when the
  argument also contains `/` — would couple a security rule to the fact that credentials currently sit
  two levels below the working directory, and would fail silently if that ever changed. It also
  refuses `grep '^/var/log/.*$'`, an ordinary regex.
- The refusal is machine-readable (`rejected_by: "unquoted_expansion"`, `matched`, `hint`) and the
  hint carries the corrected command. An unquoted regex is a latent bug in its own right: a matching
  filename in the working directory silently replaces the pattern.
- **`blockedFlags` names a switch, which is not always where the capability lives.** GNU grep spells
  recursion both `-r` and `-d recurse`; blocking only the former left the identical capability one
  synonym away, and a recursive grep started at `.` walks the working directory while naming no path
  at all — bypassing every rule above. Values that re-enable a blocked capability are refused
  alongside the flags.

  Scope, stated precisely because it is easy to overstate: this is a defence-in-depth layer, not the
  boundary. The credential tree is `agentbox`-owned and mode 0750 while child processes run as
  `sandbox`, so a recursive grep cannot read or even list it. What it does reach is the rest of the
  working directory. The boundary remains filesystem permissions — see security.md §4.6.

- **A denylist keyed on full option spellings is two characters from useless.** `getopt_long` accepts
  any unambiguous prefix, so real GNU grep runs `--recursi` as `--recursive` and `--di=recurse` as
  `--directories=recurse`. Blocked long options are therefore matched by prefix. The resolution is
  one-sided — an abbreviation is only ever mapped **onto** something already blocked — so a prefix
  that cannot mean a blocked flag (`--reg` for `--regexp`) is unaffected, and an ambiguous one that
  real grep would refuse anyway is refused here too.

## Agent-visible changes

Annotation text and outcome change for these shapes. Anything reading tool outcomes should expect
fewer failures, not different ones.

| Shape | Before | After |
|---|---|---|
| `… \| grep X \| tail` (no match) | `pipeline_upstream_failed`, error | `no_match`, not an error |
| `… \| head -N` inside a `&&`/`\|\|` chain | `pipeline_upstream_failed`, error | `success` |
| Upstream failure in an unalignable chain | named the wrong stage | reported without naming a stage |
| `kubectl top` with no metrics data | `no_match` / `channel_error` | `target_reported_failure`, both causes named |
| `grep -A 5 '<regex>'`, `yq -o json '<filter>'`, `jq --arg k v '<filter>'` | refused as a file operand | runs |
| Unquoted glob in an expression slot | ran, reading files | refused with a corrected command |
| Unquoted `jq`/`yq` filter containing brackets (`jq .items[]`, `.items[0]`, `.spec.containers[].name`) | ran | refused; quote the filter |
| `… \| grep -v X \| head -N` (cascaded SIGPIPE) | `pipeline_upstream_failed`, error | `success` |
| `grep -d recurse` | ran | refused |

## Non-goals

- `yq -ojson '<filter>'` (attached form) is refused by the per-letter scan of blocked flags, because
  `json` contains `s`. Only the separated form is addressed here.
- `sort -t / -k 2` fails for the same arity reason but is not covered; even with arity declared, the
  value is screened as an operand and `/` is refused there.
- A bare relative filename (`grep pat somefile`) still passes the operand rule. Closing it needs
  per-command operand knowledge rather than a text rule.
- Bracketless unquoted filters (`jq .metadata.name`, `jq -r .status.phase`) are unaffected; only a
  filter carrying an expansion metacharacter is refused. This is the highest-frequency shape in the
  new refusals, which is why it is named in the table above rather than left to be discovered.
- `grep -D read` is left alone: `-d read` on a directory fails at the source, so it is not the same
  vector as `-d recurse`.
- Option arity is now declared in two places for two different questions — whether a value beginning
  with `-` may follow a flag, and how many tokens a flag consumes in the stdin-only layer. Unifying
  them into one per-command table is deliberate follow-up, kept out of this change so a security fix
  and a cross-command refactor are not reviewed together.

## Deployment

All three modified files ship inside the **agentbox image**. A runtime rollout does not pick them up:
rebuild the image, repoint `SICLAW_AGENTBOX_IMAGE`, and recycle pods. `imagePullPolicy: Always` only
pulls on pod **create**, so a live pod keeps the old code and verifying against an existing session
proves nothing.

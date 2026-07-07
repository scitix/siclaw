# This KB's adjudication discipline (constitution) — starter template, adapt to your KB

> This is **the rule set loaded into the compiler**. The compiler adjudicates strictly by what's here; it does not fabricate.
> Below are common defaults; **add/remove/edit** them for your KB's domain — they are not universal law, they are your KB's conventions.

## Invariants (recommended to keep)

- **Provenance**: every conclusion can be linked back to a specific location in the raw sources.
- **Boundary honesty**: anything not findable in the KB → answer "not covered"; don't patch it with outside-the-KB common sense.
- **Do not hard-code the doubtful**: when the information is insufficient to decide, don't write it as fact; escalate and ask.

## Contradiction rulings (the compiler acts on these: auto-adjudicate what can merge, escalate what cannot)

- **Can coexist side by side**: the same metric has multiple values, but under different conditions (convention / version / configuration / point in time)
  → keep each value side by side, each hung on its condition, **do not escalate**.
- **Typo**: an obvious typesetting / unit typo → mark the correction directly, **do not escalate**.
- **All other genuine conflicts** (the same fact contradicts itself and can't be merged by the above) → **escalate**, ask a domain expert.

## Knobs (optional, turn on as needed)

- **Sensitive**: if the documents contain credentials / privacy / customer data, declare the red lines here (what must not enter the output).
- **Evidence level**: if the same assertion has multi-tier sources (measured / vendor-stated / hearsay), set the priority here.
- **Leave-blank**: for blocks that are "not to be compiled for now", declare it here; the compiler marks them "not covered" rather than hard-coding.

## Investigation Patterns (learned)

- User is actively discussing (asking questions, giving feedback) → use propose_hypotheses to align direction before committing to deep_search
- User gives an open-ended request ("help me look into X") → do triage first, then communicate your findings and proposed direction before going deep
- User gives a specific directive ("validate H1 and H3") → execute immediately, no need to re-confirm
- deep_search fails or returns insufficient results → discuss with the user and adjust hypotheses before retrying; do not repeatedly call deep_search autonomously
- Simple issue becomes apparent during triage → present findings directly, suggest ending investigation early rather than forcing the full workflow
- propose_hypotheses is a communication tool, not a gate → use it whenever presenting investigation thinking to the user, regardless of whether DP mode is active

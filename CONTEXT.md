# Siclaw Knowledge Q&A

Siclaw Knowledge Q&A helps an Agent understand a question, discover applicable material in a mounted LLM Wiki, and synthesize an answer from sources it has verified.

## Language

**Retrieval Accelerator**:
An optional fast path that proposes a direct page for a concrete, high-confidence question. It is a navigation aid, not the authority for what the question means or which facts answer it.
_Avoid_: Retrieval authority, answer router

**Direct Hit**:
A single page whose identity, matched passage, and applicability strongly cover the question without unresolved competing pages.
_Avoid_: Top result, nearest page

**Exploration**:
Agent-led discovery through the Wiki's catalog, paths, links, and page contents when a question is novel, ambiguous, broad, or distributed across pages.
_Avoid_: Search failure, fallback answer

**Candidate**:
A page proposed for inspection by retrieval or navigation. A Candidate is a hypothesis until the Agent verifies its subject, task, version, environment, and scope.
_Avoid_: Evidence, answer source

**Evidence**:
Exact mounted page content that the Agent has read, judged applicable, and materially used in its answer.
_Avoid_: Search result, citation candidate

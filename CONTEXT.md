# Knowledge Runtime

This context covers compiled knowledge packages and the runtime path that routes an Agent from a question to supporting pages.

## Language

**Knowledge Label**:
A typed, human-readable routing signal attached to one knowledge page, with optional query aliases. It helps locate evidence but is not itself evidence.
_Avoid_: Tag, keyword

**Label Facet**:
The role a Knowledge Label plays: entity, topic, task, component, environment, or version.
_Avoid_: Category, namespace

**Label Catalog**:
The runtime-derived, queryable union of Knowledge Labels and aliases across one mounted knowledge package.
_Avoid_: Global tag prompt, taxonomy dump

**Knowledge Wiki Catalog**:
The complete root `index.md`, injected as page titles, paths, and one-line descriptions so unlabeled and labeled packages share one navigation baseline.
_Avoid_: Index prefix, sampled catalog

**Knowledge Resolver**:
The labels-only runtime boundary that maps a question to candidate pages and explains which canonical values or aliases matched. It never searches page bodies and never returns answer evidence.
_Avoid_: Search wrapper, vector router, content index

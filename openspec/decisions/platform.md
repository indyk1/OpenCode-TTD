# Platform decisions

The human's answers to "which technology does the application use for ...?" - where it runs, how it stores data, how people sign in, live updates, access for other systems and AI assistants.

- The platform agent writes the first entries during `/setup`. The senior-dev agent appends new ones, only to record an answer the human gave at a checkpoint - in their words.
- Every agent follows these decisions. A capability not covered here is asked about in plain English before anything is built.
- `In place` says whether it has been built yet; the change that builds it sets `yes`.
- Never edit or delete a decision's meaning. To change one, add a new decision that supersedes it.

<!--
Entry format:

## P-001: <topic, e.g. Hosting>
- **Date**: YYYY-MM-DD
- **Question**: <the question as the human saw it>
- **Decision**: <their answer, in plain words> - <what it means technically>
- **Why**: <their reasoning, if given>
- **In place**: no | yes
- **Supersedes**: <P-### or none>
-->

No decisions yet - `/setup` records the first ones.

# Shared business knowledge decisions

The human's answers to "should this business rule be shared between slices?".

- The senior-dev agent reads this file before planning and cites a decision (D-###) instead of asking the same question again.
- Only the senior-dev agent appends here, and only to record an answer the human gave at a checkpoint - in their words.
- Never edit or delete a decision. To change one, add a new decision that supersedes it.

<!--
Entry format:

## D-001: <the rule in plain words>
- **Date**: YYYY-MM-DD
- **Change**: <change-name>
- **Question**: Do <slice A> and <slice B> change together, for the same business reason?
- **Decision**: Shared - `src/<App>/Shared/Domain/<Name>` | Kept separate in each slice | Reuse `<path>`
- **Why**: <the human's reasoning>
- **Applies to**: <Area/Slice>, <Area/Slice>
- **Supersedes**: <D-### or none>
-->

No decisions yet.

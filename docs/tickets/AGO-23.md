# AGO-23 - US-069 Mark retrieved content as untrusted data

Ticket: https://stratyge.atlassian.net/browse/AGO-23
PRs: https://github.com/CodeEx24/ai-agent-office/pull/80
Related: blocked by AGO-145 (context builder, done) · unblocks AGO-24 (quarantined reader), AGO-187 (webhooks) · live-model red team is AGO-129 (follow-up)
Type: Feature · Risk: High · Status: In review

## Overview
Epic EP-17, wave 3. Web, email and note (vault) text that reaches a model prompt must be marked as data, not instructions, in every prompt. AGO-145 already built the first layer (`apps/worker/src/context/untrusted.ts`: one wrapper, tag escaping, system rule) and AGO-167 routes tool results through it as `retrieved` items. This ticket hardens and proves that layer:

1. A **per-prompt random boundary** the content cannot forge (today the tag is static and only defended by escaping).
2. **Source kinds** (`web`, `email`, `note`, `tool`) on every retrieved item, so each wrapped block is labeled with what it is, and AGO-24 / AGO-187 plug in through the same wrapper.
3. A **builder-level invariant test** that proves "wrapped in every prompt" without spot checks.
4. An **injection corpus** and a fake-model test that shows injected text never changes which tools are called, and never appears outside a labeled block.

## Implementation details
Assumptions (source):
1. There is exactly one prompt-assembly path: `ContextBuilder.build` -> `ModelProvider.complete` in `agent-loop.ts` (code: grep of `provider.complete`, `build(`). A test pins this, so a future second path fails CI.
2. The tool-execution seam (AGO-71) is untouched; this ticket changes only what text the model sees (brief).
3. No real model calls (brief, money rule). The fake model does not reason, so the structural defence is what the tests prove (see below).
4. Owner skills stay trusted in `system`; pack skills, task text, vault map and retrieved content stay untrusted in the user message (AGO-145 decision, CLAUDE.md "pack text is untrusted data").
5. Tool results stay wrapped as untrusted retrieved items (AGO-167 decision).

**Boundary.** `build()` creates one random id per call (injected `createBoundaryId`, default 128 bits from `crypto.randomBytes`, so tests stay deterministic). Every block is `<untrusted_data id="<boundary>" source="<label>">` ... `</untrusted_data id="<boundary>">`. The system rule says a block ends only at the closing tag carrying the same id, and that anything else claiming to end it is data. The AGO-145 escaping of tag look-alikes stays as the second layer; content containing the id string has it removed (2026-11-17 deviation: removed rather than regenerating the id, which is simpler and just as safe because the id is random and unknown to content). The id is at least 96 bits (hex, checked), never derived from content or run ids. The id is never logged or put in run events.

**Spotlighting.** Delimiting plus random boundary plus the system rule. No datamarking (open question q2).

**Source kinds.** `retrievedItemSchema` gains an optional `kind` (`web | email | note | tool`, additive in `packages/shared/src/context/`). The label becomes `kind:ref` (for example `email:msg-123`). Items with no kind keep working. Helper `retrievedSource(kind, ref)` is the one way callers build labels; AGO-24 and AGO-187 call it and never build tags.

**Size caps and truncation.** Unchanged from AGO-145: per-item truncation on raw text before wrapping, marked `[truncated]`, closing tag always present, cuts reported as counts and source labels only.

**Invariants.** Wrapping never reads or changes policy, capabilities or tool offers. Policy check stays before every tool call.

**Files.** `apps/worker/src/context/untrusted.ts`, `context-builder.ts`, `packages/shared/src/context/context-schemas.ts` (additive), tests under `apps/worker/src/context/`, injection corpus `apps/worker/src/context/__fixtures__/injection-corpus.ts`, `docs/features/untrusted-content.md`.

## Boundaries
- **Always:** one wrapper for all untrusted text; scope by workspace_id; policy check before every tool call; no real model calls.
- **Ask first:** touching `apps/worker/src/agent/**` beyond prompt assembly, any schema change.
- **Never:** build `<untrusted_data` tags outside `untrusted.ts`; log or emit the boundary id or content; let wrapping change tool permissions.

## Acceptance criteria (verbatim)
- Injection test samples do not change which tools are called
- Wrapped content is labeled in every prompt
- Tests pass, no regressions, PR reviewed and merged, docs updated (see Definition of Done).

## What a fake model can and cannot prove
Can: the exact text sent to the provider has every non-owner string inside a labeled block with the run's boundary; forged or split closers cannot end a block; the system rule is present; the scripted model's tool calls (and the policy decisions for them) are identical with and without injected content, because content never reaches the policy or tool seam. Cannot: that a real model refuses to obey the text. That is a live red-team run, AGO-129 (follow-up).

## API changes
None (worker-internal). Shared: additive optional `kind` on `retrievedItemSchema`.

## Database changes
None.

## Dependencies on other tickets
AGO-145 (context builder, done). AGO-167 (tool results as retrieved items). Unblocks AGO-24, AGO-187.

## Testing notes
- `untrusted.test.ts`: boundary id in open and close tags; forged closers (wrong id inert); look-alike escaping kept.
- `untrusted-invariant.test.ts`: for every section (task, pack skill, vault map, retrieved of each kind) every untrusted string appears only inside a block; removing all blocks leaves only trusted text; id differs between builds and is not in any content.
- Prompt-path walk: scans `apps/worker/src` for `.complete(` call sites and hand-built `untrusted_data` tags; fails on any outside the allowed files.
- Injection corpus (direct override, fake tool-call JSON, forged boundary/closing tags, role-play, unicode/homoglyph and zero-width, markdown/HTML comments, instructions split across chunks) through the real agent loop with a scripted model: tool calls identical with and without each sample.
- Explicit file-level timeout (`vi.setConfig`) on the corpus file.

## Decisions
| decision | options | choice | who / when |
|---|---|---|---|
| Owner skills vs pack skills | all untrusted / owner trusted, pack untrusted | owner trusted, pack untrusted | AGO-145 record, kept |
| Tool results | trusted / wrapped | wrapped | AGO-167 record, kept |
| Record accepted | accept / changes | accepted (q1) | owner (standing rule: go with the recommendation), 2026-11-17 |
| Boundary format | static tag + escaping / per-prompt random id | per-prompt random id, escaping kept for any tag-like sequence whatever id it carries (q2) | owner, 2026-11-17 |
| Datamarking | none / mark whitespace in web and email text | none; possible follow-up only if the AGO-129 red team shows a need (q3) | owner, 2026-11-17 |
| Boundary id strength | - | at least 96 bits of crypto randomness per prompt, never derived from content or run ids; not in logs or run_events beyond what is already stored for the prompt | owner build note, 2026-11-17 |

## Known limitations
A fake model cannot prove a real model's obedience; AGO-129 covers that. AGO-24 / AGO-187 are not built yet, so `web` and `email` kinds are exercised by tests only.

## Follow-up tasks
AGO-129 live-model injection red team.

## Outcome
Filled at merge.

# Wave plan: AGO (APPLIED)

Generated 2026-11-04 by /plan-waves from Jira (all 200 issues: 20 epics, 180 stories, all To Do).
Status: **APPLIED** 2026-11-06. The 8 label moves below are live in Jira.

## Validation
- Dependencies: 315 Blocks links, identical to the "Blocked by" text in descriptions. No cycles, no dangling links.
- Current labels: every story has exactly one `wave-N` label, matching its description. **0 backward dependencies.**
- After the proposed moves: 0 backward dependencies.
- Critical path (15 tickets): AGO-57 → AGO-61 → AGO-67 → AGO-82 → AGO-107 → AGO-128 → AGO-145 → AGO-167 → AGO-30 → AGO-21 → AGO-183 → AGO-175 → AGO-171 → AGO-33 → AGO-105

## Proposed changes (8 label moves, no new links, no priority changes)
| Ticket | Title | Wave | Why |
|---|---|---|---|
| [AGO-66](https://stratyge.atlassian.net/browse/AGO-66) | US-080 Add CSP, input validation and rate limits | 4 → **2** | CSP, Zod validation and rate limits must be live before the approvals UI and agent runs ship |
| [AGO-71](https://stratyge.atlassian.net/browse/AGO-71) | US-112 Build the per-run sandbox | 5 → **3** | per-run sandbox before agents do real work in wave 3 |
| [AGO-65](https://stratyge.atlassian.net/browse/AGO-65) | US-110 Add the egress proxy with allowlist | 5 → **3** | egress allowlist with the sandbox |
| [AGO-68](https://stratyge.atlassian.net/browse/AGO-68) | US-111 Allowlist and pin tool servers | 5 → **3** | pin tool servers before tools reach real data |
| [AGO-81](https://stratyge.atlassian.net/browse/AGO-81) | US-113 Enforce agent-to-agent rules | 5 → **3** | agent-to-agent rules before the Manager splits work across agents (AGO-117) |
| [AGO-85](https://stratyge.atlassian.net/browse/AGO-85) | US-114 Gate risky capabilities on prerequisites | 5 → **3** | risky capabilities gated on sandbox and egress, same wave |
| [AGO-180](https://stratyge.atlassian.net/browse/AGO-180) | US-101 Use signed expiring URLs for private assets | 4 → **3** | signed expiring URLs ship with deliverable download (AGO-158) |
| [AGO-129](https://stratyge.atlassian.net/browse/AGO-129) | US-159 Build the red-team suite in CI | 6 → **4** | red-team CI as soon as the guardrails it tests exist |

Legend: **batch** = parallel batch inside the wave (0 starts first). **S** = schema ticket (one at a time). **$** = may cost money (needs your OK when it runs).

## Wave 1: Foundations & Identity: monorepo, CI, auth, schema, RLS, asset spikes (19)
| Batch | Ticket | Title | Pri | Depends on | Note |
|---|---|---|---|---|---|
| 0 | [AGO-53](https://stratyge.atlassian.net/browse/AGO-53) | US-003 Spike: generate one character concept sheet with Higgsfield | p0 | — | $ Higgsfield credits |
| 0 | [AGO-57](https://stratyge.atlassian.net/browse/AGO-57) | US-004 Scaffold the monorepo | p0 | — |  |
| 1 | [AGO-28](https://stratyge.atlassian.net/browse/AGO-28) | US-001 Write the art direction and style guide | p0 | 53 |  |
| 1 | [AGO-61](https://stratyge.atlassian.net/browse/AGO-61) | US-005 Set up Next.js 16 on a patched release | p0 | 57 |  |
| 1 | [AGO-78](https://stratyge.atlassian.net/browse/AGO-78) | US-010 Set up Supabase, local dev and migrations | p0 | 57 | S |
| 1 | [AGO-111](https://stratyge.atlassian.net/browse/AGO-111) | US-016 Configure lint, format, typecheck and unit test tooling | p0 | 57 |  |
| 2 | [AGO-49](https://stratyge.atlassian.net/browse/AGO-49) | US-002 Spike: image to 3D mesh, rig and animation in three.js | p0 | 28, 61 | $ image-to-3D generation service |
| 2 | [AGO-67](https://stratyge.atlassian.net/browse/AGO-67) | US-007 Implement sign-in with email, Google and GitHub | p0 | 61, 78 |  |
| 2 | [AGO-70](https://stratyge.atlassian.net/browse/AGO-70) | US-008 Define environments and validated env config | p0 | 61 |  |
| 2 | [AGO-74](https://stratyge.atlassian.net/browse/AGO-74) | US-009 Create the core schema migrations | p0 | 78 | S |
| 2 | [AGO-92](https://stratyge.atlassian.net/browse/AGO-92) | US-012 Create the CI pipeline and dependency alerts | p0 | 111 |  |
| 2 | [AGO-115](https://stratyge.atlassian.net/browse/AGO-115) | US-017 Initialize shadcn/ui and design tokens | p0 | 61 |  |
| 3 | [AGO-64](https://stratyge.atlassian.net/browse/AGO-64) | US-006 Spike: shared skeleton and animation retargeting | p0 | 49 |  |
| 3 | [AGO-82](https://stratyge.atlassian.net/browse/AGO-82) | US-011 Create workspaces and memberships with roles | p0 | 67, 74 | S |
| 3 | [AGO-102](https://stratyge.atlassian.net/browse/AGO-102) | US-014 Make run_events append-only | p0 | 74 | S |
| 3 | [AGO-118](https://stratyge.atlassian.net/browse/AGO-118) | US-018 Add the Playwright end-to-end harness | p1 | 92 |  |
| 3 | [AGO-122](https://stratyge.atlassian.net/browse/AGO-122) | US-019 Add seed data and fixtures | p2 | 74 | S |
| 4 | [AGO-107](https://stratyge.atlassian.net/browse/AGO-107) | US-015 Apply row-level security on every table | p0 | 74, 82 | S |
| 5 | [AGO-96](https://stratyge.atlassian.net/browse/AGO-96) | US-013 Add department hooks and layered policy table | p0 | 74, 107 | S |

## Wave 2: Agent Runtime + Guardrails: catalog, skills, wizard, tool loop, policy engine, approvals (36)
| Batch | Ticket | Title | Pri | Depends on | Note |
|---|---|---|---|---|---|
| 0 | [AGO-66](https://stratyge.atlassian.net/browse/AGO-66) | US-080 Add CSP, input validation and rate limits | p1 | 61@w1 | was wave 4 |
| 0 | [AGO-125](https://stratyge.atlassian.net/browse/AGO-125) | US-020 Build the capability catalog | p0 | 74@w1, 107@w1 |  |
| 0 | [AGO-128](https://stratyge.atlassian.net/browse/AGO-128) | US-021 Build the skill library with versions | p0 | 74@w1, 107@w1 |  |
| 0 | [AGO-143](https://stratyge.atlassian.net/browse/AGO-143) | US-025 Create the worker service skeleton | p0 | 57@w1, 70@w1 |  |
| 1 | [AGO-104](https://stratyge.atlassian.net/browse/AGO-104) | US-051 Add error tracking and structured log shipping | p1 | 61@w1, 143 | $ error-tracking plan (free tier first) |
| 1 | [AGO-141](https://stratyge.atlassian.net/browse/AGO-141) | US-024 Build the agent creation wizard | p0 | 82@w1, 115@w1, 125, 128 |  |
| 1 | [AGO-145](https://stratyge.atlassian.net/browse/AGO-145) | US-026 Build the context builder | p0 | 128, 143 |  |
| 1 | [AGO-151](https://stratyge.atlassian.net/browse/AGO-151) | US-028 Add the pg-boss job queue | p0 | 74@w1, 143 | S |
| 1 | [AGO-164](https://stratyge.atlassian.net/browse/AGO-164) | US-032 Build the typed run event emitter | p0 | 102@w1, 143 |  |
| 2 | [AGO-89](https://stratyge.atlassian.net/browse/AGO-89) | US-048 Edit, duplicate and archive agents | p1 | 141 |  |
| 2 | [AGO-136](https://stratyge.atlassian.net/browse/AGO-136) | US-022 Add the eight role templates | p0 | 141 |  |
| 2 | [AGO-138](https://stratyge.atlassian.net/browse/AGO-138) | US-023 Add the trifecta lint to the agent wizard | p0 | 125, 141 |  |
| 2 | [AGO-148](https://stratyge.atlassian.net/browse/AGO-148) | US-027 Issue per-agent identity and short-lived scoped credentials | p0 | 74@w1, 125, 151 | S |
| 2 | [AGO-160](https://stratyge.atlassian.net/browse/AGO-160) | US-031 Implement task claims with expiry | p0 | 151 | S |
| 2 | [AGO-167](https://stratyge.atlassian.net/browse/AGO-167) | US-034 Implement the agent tool loop | p0 | 145, 151, 164 |  |
| 2 | [AGO-191](https://stratyge.atlassian.net/browse/AGO-191) | US-171 Define the agent pack JSON schema (v1) | p0 | 125, 128, 141 | S |
| 3 | [AGO-30](https://stratyge.atlassian.net/browse/AGO-30) | US-037 Add checkpoint, pause and resume | p0 | 167 |  |
| 3 | [AGO-34](https://stratyge.atlassian.net/browse/AGO-34) | US-038 Build the deterministic policy engine | p0 | 125, 167, 96@w1 |  |
| 3 | [AGO-40](https://stratyge.atlassian.net/browse/AGO-40) | US-040 Enforce budgets with hard stops | p0 | 164, 167 |  |
| 3 | [AGO-86](https://stratyge.atlassian.net/browse/AGO-86) | US-047 Add human-only pause, resume and stop | p0 | 82@w1, 167 |  |
| 3 | [AGO-94](https://stratyge.atlassian.net/browse/AGO-94) | US-049 Add per-agent model routing | p1 | 167 |  |
| 3 | [AGO-154](https://stratyge.atlassian.net/browse/AGO-154) | US-029 Protect prompts, skills, policies and boot files from agent edits | p0 | 128, 148 |  |
| 3 | [AGO-157](https://stratyge.atlassian.net/browse/AGO-157) | US-030 Build the credential broker | p0 | 70@w1, 148 |  |
| 3 | [AGO-166](https://stratyge.atlassian.net/browse/AGO-166) | US-033 Add loop detection and run guard rails | p0 | 167 |  |
| 3 | [AGO-192](https://stratyge.atlassian.net/browse/AGO-192) | US-172 Export agents and their skills to a pack file | p0 | 191 |  |
| 3 | [AGO-193](https://stratyge.atlassian.net/browse/AGO-193) | US-173 Validate a pack and preview changes before import (dry run) | p0 | 138, 191 |  |
| 4 | [AGO-21](https://stratyge.atlassian.net/browse/AGO-21) | US-035 Build the approval request flow | p0 | 34, 30 |  |
| 4 | [AGO-25](https://stratyge.atlassian.net/browse/AGO-25) | US-036 Filter ungranted tools from the model | p0 | 34 |  |
| 4 | [AGO-43](https://stratyge.atlassian.net/browse/AGO-43) | US-041 Add the autonomy dial | p0 | 34 |  |
| 4 | [AGO-84](https://stratyge.atlassian.net/browse/AGO-84) | US-046 Implement the kill switch and drill | p0 | 148, 86 |  |
| 5 | [AGO-37](https://stratyge.atlassian.net/browse/AGO-37) | US-039 Build the approvals inbox and card UI | p0 | 21, 115@w1 |  |
| 5 | [AGO-47](https://stratyge.atlassian.net/browse/AGO-47) | US-042 Bind approvals to a payload hash, single-use and expiring | p0 | 21 |  |
| 5 | [AGO-51](https://stratyge.atlassian.net/browse/AGO-51) | US-043 Guarantee timeout means deny | p0 | 21 |  |
| 5 | [AGO-58](https://stratyge.atlassian.net/browse/AGO-58) | US-045 Make approval routes human-only | p0 | 21, 148 |  |
| 5 | [AGO-99](https://stratyge.atlassian.net/browse/AGO-99) | US-050 Start new agents in Strict with human promotion | p0 | 43, 89 |  |
| 6 | [AGO-54](https://stratyge.atlassian.net/browse/AGO-54) | US-044 Render approval cards on the server with consequence summary first | p0 | 37, 47 |  |

## Wave 3: Core Value: goals, tasks, vault, office store, flat view, packs, execution isolation (31)
| Batch | Ticket | Title | Pri | Depends on | Note |
|---|---|---|---|---|---|
| 0 | [AGO-23](https://stratyge.atlassian.net/browse/AGO-23) | US-069 Mark retrieved content as untrusted data | p0 | 145@w2 |  |
| 0 | [AGO-68](https://stratyge.atlassian.net/browse/AGO-68) | US-111 Allowlist and pin tool servers | p0 | 157@w2 | was wave 5 |
| 0 | [AGO-71](https://stratyge.atlassian.net/browse/AGO-71) | US-112 Build the per-run sandbox | p0 | 167@w2 | was wave 5 |
| 0 | [AGO-81](https://stratyge.atlassian.net/browse/AGO-81) | US-113 Enforce agent-to-agent rules | p0 | 34@w2, 148@w2 | was wave 5 |
| 0 | [AGO-113](https://stratyge.atlassian.net/browse/AGO-113) | US-053 Build the goal inbox | p0 | 82@w1, 115@w1 |  |
| 0 | [AGO-121](https://stratyge.atlassian.net/browse/AGO-121) | US-055 Build the vault service | p0 | 70@w1, 74@w1, 154@w2 | S |
| 0 | [AGO-124](https://stratyge.atlassian.net/browse/AGO-124) | US-056 Publish the event contracts for the office | p0 | 164@w2 |  |
| 0 | [AGO-194](https://stratyge.atlassian.net/browse/AGO-194) | US-174 Import a pack safely into a workspace | p0 | 43@w2, 89@w2, 99@w2, 136@w2, 154@w2, 192@w2, 193@w2 |  |
| 1 | [AGO-24](https://stratyge.atlassian.net/browse/AGO-24) | US-070 Build the quarantined reader | p1 | 23 |  |
| 1 | [AGO-65](https://stratyge.atlassian.net/browse/AGO-65) | US-110 Add the egress proxy with allowlist | p0 | 71 | was wave 5 |
| 1 | [AGO-109](https://stratyge.atlassian.net/browse/AGO-109) | US-052 Back up the database and vault before shared writes are enabled | p0 | 121 |  |
| 1 | [AGO-117](https://stratyge.atlassian.net/browse/AGO-117) | US-054 Let the Manager split goals into tasks | p0 | 113, 167@w2, 136@w2, 160@w2 |  |
| 1 | [AGO-126](https://stratyge.atlassian.net/browse/AGO-126) | US-057 Add realtime delivery with cursor catch-up | p0 | 107@w1, 124 |  |
| 1 | [AGO-144](https://stratyge.atlassian.net/browse/AGO-144) | US-060 Add the vault write tool with checkpoints and run receipts | p0 | 121, 167@w2 |  |
| 1 | [AGO-165](https://stratyge.atlassian.net/browse/AGO-165) | US-068 Record provenance on every change | p0 | 121 | S |
| 1 | [AGO-195](https://stratyge.atlassian.net/browse/AGO-195) | US-175 Add a CLI for pack export and import | p1 | 194 |  |
| 1 | [AGO-197](https://stratyge.atlassian.net/browse/AGO-197) | US-177 Test pack round trip and hostile packs | p0 | 194 |  |
| 1 | [AGO-198](https://stratyge.atlassian.net/browse/AGO-198) | US-178 Include skills and starter notes in packs | p1 | 121, 194 |  |
| 2 | [AGO-85](https://stratyge.atlassian.net/browse/AGO-85) | US-114 Gate risky capabilities on prerequisites | p0 | 47@w2, 65, 71, 157@w2 | was wave 5 |
| 2 | [AGO-140](https://stratyge.atlassian.net/browse/AGO-140) | US-058 Add the Reviewer review lane | p0 | 58@w2, 117 |  |
| 2 | [AGO-142](https://stratyge.atlassian.net/browse/AGO-142) | US-059 Build the office store | p0 | 126 |  |
| 2 | [AGO-163](https://stratyge.atlassian.net/browse/AGO-163) | US-067 Add proposals for shared-note edits | p0 | 58@w2, 121, 165 |  |
| 2 | [AGO-196](https://stratyge.atlassian.net/browse/AGO-196) | US-176 Bootstrap a new workspace from a pack in the repo | p1 | 122@w1, 195 |  |
| 3 | [AGO-27](https://stratyge.atlassian.net/browse/AGO-27) | US-071 Build the activity feed | p1 | 142 |  |
| 3 | [AGO-146](https://stratyge.atlassian.net/browse/AGO-146) | US-061 Build the task board | p0 | 113, 142 |  |
| 3 | [AGO-150](https://stratyge.atlassian.net/browse/AGO-150) | US-062 Build agent cards with six states | p0 | 115@w1, 142 |  |
| 3 | [AGO-153](https://stratyge.atlassian.net/browse/AGO-153) | US-063 Build the run view | p0 | 40@w2, 142 |  |
| 4 | [AGO-155](https://stratyge.atlassian.net/browse/AGO-155) | US-064 Build task detail | p0 | 146 |  |
| 5 | [AGO-158](https://stratyge.atlassian.net/browse/AGO-158) | US-065 Save deliverables to the vault and allow download | p0 | 144, 155 |  |
| 6 | [AGO-162](https://stratyge.atlassian.net/browse/AGO-162) | US-066 Phase 1 gate: goal runs end to end with one bound approval | p0 | 51@w2, 54@w2, 140, 150, 158 |  |
| 6 | [AGO-180](https://stratyge.atlassian.net/browse/AGO-180) | US-101 Use signed expiring URLs for private assets | p1 | 158 | S; was wave 4 |

## Wave 4: Live 3D Office, Alerts & Observability (37)
| Batch | Ticket | Title | Pri | Depends on | Note |
|---|---|---|---|---|---|
| 0 | [AGO-29](https://stratyge.atlassian.net/browse/AGO-29) | US-072 Produce the character set | p1 | 64@w1 | $ asset generation |
| 0 | [AGO-32](https://stratyge.atlassian.net/browse/AGO-32) | US-073 Produce the 12 named animation clips | p1 | 64@w1 | $ asset generation |
| 0 | [AGO-36](https://stratyge.atlassian.net/browse/AGO-36) | US-074 Produce the room and prop assets | p1 | 28@w1 | $ asset generation |
| 0 | [AGO-39](https://stratyge.atlassian.net/browse/AGO-39) | US-075 Build the audit log viewer | p1 | 153@w3 |  |
| 0 | [AGO-42](https://stratyge.atlassian.net/browse/AGO-42) | US-076 Create the client-only 3D canvas and camera | p1 | 61@w1, 142@w3 |  |
| 0 | [AGO-56](https://stratyge.atlassian.net/browse/AGO-56) | US-077 Build the usage and cost dashboard | p1 | 40@w2 |  |
| 0 | [AGO-59](https://stratyge.atlassian.net/browse/AGO-59) | US-108 Produce flat-view assets | p2 | 28@w1 |  |
| 0 | [AGO-60](https://stratyge.atlassian.net/browse/AGO-60) | US-078 Build the vault browser and editor | p1 | 121@w3, 115@w1 |  |
| 0 | [AGO-69](https://stratyge.atlassian.net/browse/AGO-69) | US-081 Add dry-run mode | p1 | 37@w2 |  |
| 0 | [AGO-75](https://stratyge.atlassian.net/browse/AGO-75) | US-083 Add full-text search over notes | p1 | 121@w3 |  |
| 0 | [AGO-80](https://stratyge.atlassian.net/browse/AGO-80) | US-085 Add global search | p1 | 121@w3, 146@w3 |  |
| 0 | [AGO-91](https://stratyge.atlassian.net/browse/AGO-91) | US-086 Add approval metrics and prompt rate limits | p1 | 37@w2 |  |
| 0 | [AGO-100](https://stratyge.atlassian.net/browse/AGO-100) | US-088 Create the asset manifest, CDN and optimization rules | p1 | 64@w1 |  |
| 0 | [AGO-110](https://stratyge.atlassian.net/browse/AGO-110) | US-090 Build the notification service with quiet hours | p1 | 21@w2 |  |
| 0 | [AGO-129](https://stratyge.atlassian.net/browse/AGO-129) | US-159 Build the red-team suite in CI | p0 | 58@w2, 65@w3, 68@w3, 71@w3 | was wave 6 |
| 0 | [AGO-176](https://stratyge.atlassian.net/browse/AGO-176) | US-097 Add undo for reversible actions | p1 | 37@w2 |  |
| 0 | [AGO-179](https://stratyge.atlassian.net/browse/AGO-179) | US-100 Add private scratch folders with promote-to-shared | p1 | 163@w3 |  |
| 1 | [AGO-44](https://stratyge.atlassian.net/browse/AGO-44) | US-104 Add the command palette and onboarding tour | p2 | 80, 141@w2 |  |
| 1 | [AGO-46](https://stratyge.atlassian.net/browse/AGO-46) | US-105 Send the morning brief and daily digest | p2 | 110 |  |
| 1 | [AGO-55](https://stratyge.atlassian.net/browse/AGO-55) | US-107 Add email notifications | p2 | 110 | $ email provider |
| 1 | [AGO-72](https://stratyge.atlassian.net/browse/AGO-72) | US-082 Add the flat-mode switch and weak-device fallback | p1 | 42, 150@w3 |  |
| 1 | [AGO-97](https://stratyge.atlassian.net/browse/AGO-97) | US-087 Load characters with the shared skeleton and mixer | p1 | 29, 32, 42 |  |
| 1 | [AGO-106](https://stratyge.atlassian.net/browse/AGO-106) | US-089 Build the office layout schema and loader | p1 | 36, 42, 100 | S |
| 1 | [AGO-174](https://stratyge.atlassian.net/browse/AGO-174) | US-096 Add Telegram approval pings | p1 | 54@w2, 110 | $ Telegram bot (free) |
| 1 | [AGO-177](https://stratyge.atlassian.net/browse/AGO-177) | US-098 Add failure and budget alerts with forecast | p1 | 40@w2, 110 |  |
| 1 | [AGO-182](https://stratyge.atlassian.net/browse/AGO-182) | US-102 Build the vault map for agents | p1 | 75, 145@w2 |  |
| 2 | [AGO-50](https://stratyge.atlassian.net/browse/AGO-50) | US-106 Add camera presets and a mini-map | p2 | 97 |  |
| 2 | [AGO-62](https://stratyge.atlassian.net/browse/AGO-62) | US-109 Chat with the office through Telegram | p2 | 174, 113@w3 |  |
| 2 | [AGO-63](https://stratyge.atlassian.net/browse/AGO-63) | US-079 Add 3D accessibility | p1 | 72 |  |
| 2 | [AGO-77](https://stratyge.atlassian.net/browse/AGO-77) | US-084 Build the agent drawer | p1 | 97, 153@w3 |  |
| 2 | [AGO-114](https://stratyge.atlassian.net/browse/AGO-114) | US-091 Add A* pathfinding between rooms | p1 | 106 |  |
| 2 | [AGO-168](https://stratyge.atlassian.net/browse/AGO-168) | US-093 Add speech bubbles, name tags and status rings | p1 | 97 |  |
| 2 | [AGO-170](https://stratyge.atlassian.net/browse/AGO-170) | US-092 Build the event-to-place-and-pose state machine | p1 | 106, 142@w3 |  |
| 2 | [AGO-172](https://stratyge.atlassian.net/browse/AGO-172) | US-095 Make the flat view mobile-friendly with push approvals | p1 | 150@w3, 174 |  |
| 3 | [AGO-22](https://stratyge.atlassian.net/browse/AGO-22) | US-103 Drag a task card onto an agent to assign | p2 | 77, 146@w3 |  |
| 3 | [AGO-169](https://stratyge.atlassian.net/browse/AGO-169) | US-094 Meet the performance budget | p1 | 170 |  |
| 3 | [AGO-178](https://stratyge.atlassian.net/browse/AGO-178) | US-099 Add right-click controls | p1 | 77, 86@w2 |  |

## Wave 5: Team, Departments & Integrations (46)
| Batch | Ticket | Title | Pri | Depends on | Note |
|---|---|---|---|---|---|
| 0 | [AGO-26](https://stratyge.atlassian.net/browse/AGO-26) | US-138 Add the quarantine state | p1 | 34@w2, 86@w2 |  |
| 0 | [AGO-48](https://stratyge.atlassian.net/browse/AGO-48) | US-145 Add the public API and API keys | p2 | 113@w3, 66@w2 |  |
| 0 | [AGO-73](https://stratyge.atlassian.net/browse/AGO-73) | US-147 Add squads | p2 | 34@w2, 89@w2 |  |
| 0 | [AGO-76](https://stratyge.atlassian.net/browse/AGO-76) | US-148 Add feature flags and staged rollout of templates | p2 | 136@w2 |  |
| 0 | [AGO-79](https://stratyge.atlassian.net/browse/AGO-79) | US-149 Add goal templates | p2 | 113@w3 |  |
| 0 | [AGO-83](https://stratyge.atlassian.net/browse/AGO-83) | US-150 Add the health page | p2 | 143@w2, 151@w2 |  |
| 0 | [AGO-87](https://stratyge.atlassian.net/browse/AGO-87) | US-151 Add hiring approvals | p2 | 21@w2, 99@w2 |  |
| 0 | [AGO-88](https://stratyge.atlassian.net/browse/AGO-88) | US-115 Add read-only integrations through MCP | p1 | 68@w3, 157@w2 |  |
| 0 | [AGO-90](https://stratyge.atlassian.net/browse/AGO-90) | US-152 Add export and import actions to the agents screen | p1 | 89@w2, 192@w2, 194@w3 |  |
| 0 | [AGO-93](https://stratyge.atlassian.net/browse/AGO-93) | US-116 Add schedules with isolated runs | p1 | 47@w2, 151@w2, 110@w4 |  |
| 0 | [AGO-95](https://stratyge.atlassian.net/browse/AGO-95) | US-153 Add time-lapse replay of a finished run | p2 | 39@w4, 170@w4 |  |
| 0 | [AGO-112](https://stratyge.atlassian.net/browse/AGO-112) | US-120 Add workspaces, members and invites | p1 | 82@w1, 107@w1 |  |
| 0 | [AGO-119](https://stratyge.atlassian.net/browse/AGO-119) | US-156 Add the stand-up in the meeting room | p2 | 46@w4, 170@w4 |  |
| 0 | [AGO-133](https://stratyge.atlassian.net/browse/AGO-133) | US-125 Check outbound messages for secrets and personal data | p1 | 54@w2, 85@w3 |  |
| 0 | [AGO-181](https://stratyge.atlassian.net/browse/AGO-181) | US-126 Require passkey confirmation for Tier 4 | p1 | 47@w2 |  |
| 0 | [AGO-185](https://stratyge.atlassian.net/browse/AGO-185) | US-132 Build the secrets manager UI | p1 | 157@w2 |  |
| 0 | [AGO-189](https://stratyge.atlassian.net/browse/AGO-189) | US-136 Add canary notes and tokens | p1 | 110@w4, 121@w3 |  |
| 1 | [AGO-31](https://stratyge.atlassian.net/browse/AGO-31) | US-139 Scan the vault and logs for key patterns | p1 | 121@w3, 93 |  |
| 1 | [AGO-35](https://stratyge.atlassian.net/browse/AGO-35) | US-141 Link tasks to GitHub and Jira issues | p2 | 88 |  |
| 1 | [AGO-45](https://stratyge.atlassian.net/browse/AGO-45) | US-144 Show teammate presence in the office | p2 | 112, 170@w4 |  |
| 1 | [AGO-108](https://stratyge.atlassian.net/browse/AGO-108) | US-119 Build departments and teams | p1 | 96@w1, 112 |  |
| 1 | [AGO-183](https://stratyge.atlassian.net/browse/AGO-183) | US-130 Add operator and approver roles | p1 | 21@w2, 112 |  |
| 1 | [AGO-187](https://stratyge.atlassian.net/browse/AGO-187) | US-134 Add webhooks | p1 | 23@w3, 93 |  |
| 2 | [AGO-38](https://stratyge.atlassian.net/browse/AGO-38) | US-142 Expose an MCP endpoint for the workspace | p2 | 183 |  |
| 2 | [AGO-98](https://stratyge.atlassian.net/browse/AGO-98) | US-117 Evaluate layered policy | p0 | 34@w2, 108 |  |
| 2 | [AGO-101](https://stratyge.atlassian.net/browse/AGO-101) | US-154 Add department zones in the 3D office | p2 | 108, 106@w4 |  |
| 2 | [AGO-103](https://stratyge.atlassian.net/browse/AGO-103) | US-118 Build approval chains | p1 | 21@w2, 108 |  |
| 2 | [AGO-116](https://stratyge.atlassian.net/browse/AGO-116) | US-121 Add change windows | p2 | 108 |  |
| 2 | [AGO-120](https://stratyge.atlassian.net/browse/AGO-120) | US-122 Build the department dashboard | p1 | 56@w4, 91@w4, 108 |  |
| 2 | [AGO-123](https://stratyge.atlassian.net/browse/AGO-123) | US-157 Add a read-only visitor link | p2 | 72@w4, 183 |  |
| 2 | [AGO-132](https://stratyge.atlassian.net/browse/AGO-132) | US-124 Add data labels and clearances | p1 | 75@w4, 108 |  |
| 2 | [AGO-175](https://stratyge.atlassian.net/browse/AGO-175) | US-129 Add organization roles and delegated admin | p1 | 108, 183 |  |
| 2 | [AGO-186](https://stratyge.atlassian.net/browse/AGO-186) | US-133 Add human-created standing approvals | p1 | 37@w2, 183 |  |
| 2 | [AGO-199](https://stratyge.atlassian.net/browse/AGO-199) | US-179 Sign and verify packs | p2 | 183, 192@w2, 194@w3 |  |
| 3 | [AGO-20](https://stratyge.atlassian.net/browse/AGO-20) | US-137 Add department vault spaces | p1 | 108, 132 |  |
| 3 | [AGO-52](https://stratyge.atlassian.net/browse/AGO-52) | US-146 Add agent scorecards | p2 | 120 |  |
| 3 | [AGO-127](https://stratyge.atlassian.net/browse/AGO-127) | US-158 Send the weekly department report | p2 | 46@w4, 120 |  |
| 3 | [AGO-130](https://stratyge.atlassian.net/browse/AGO-130) | US-123 Add department settings | p1 | 43@w2, 98 |  |
| 3 | [AGO-171](https://stratyge.atlassian.net/browse/AGO-171) | US-127 Enforce separation of duties | p0 | 103, 175 |  |
| 3 | [AGO-173](https://stratyge.atlassian.net/browse/AGO-173) | US-128 Build the policy editor | p1 | 98 |  |
| 3 | [AGO-184](https://stratyge.atlassian.net/browse/AGO-184) | US-131 Add backup approver and away mode | p1 | 103 |  |
| 3 | [AGO-188](https://stratyge.atlassian.net/browse/AGO-188) | US-135 Add cross-department requests and grants | p1 | 81@w3, 132 |  |
| 3 | [AGO-200](https://stratyge.atlassian.net/browse/AGO-200) | US-180 Make pack import department-aware | p2 | 98, 108, 194@w3 |  |
| 4 | [AGO-33](https://stratyge.atlassian.net/browse/AGO-33) | US-140 Require two approvers for Tier 4 and finance actions | p1 | 103, 171 |  |
| 4 | [AGO-41](https://stratyge.atlassian.net/browse/AGO-41) | US-143 Turn result feedback into proposed skill improvements | p2 | 52, 154@w2 |  |
| 5 | [AGO-105](https://stratyge.atlassian.net/browse/AGO-105) | US-155 Add department starter packs | p2 | 33, 108, 136@w2 |  |

## Wave 6: Hardening & Ecosystem (11)
| Batch | Ticket | Title | Pri | Depends on | Note |
|---|---|---|---|---|---|
| 0 | [AGO-131](https://stratyge.atlassian.net/browse/AGO-131) | US-160 Move long approvals to a durable workflow engine | p2 | 30@w2, 93@w5 |  |
| 0 | [AGO-134](https://stratyge.atlassian.net/browse/AGO-134) | US-161 Add offline run replay and regression evals | p2 | 76@w5, 167@w2 |  |
| 0 | [AGO-137](https://stratyge.atlassian.net/browse/AGO-137) | US-163 Make the audit log tamper-evident | p2 | 102@w1 |  |
| 0 | [AGO-147](https://stratyge.atlassian.net/browse/AGO-147) | US-165 Add retention and deletion rules | p2 | 132@w5 |  |
| 0 | [AGO-159](https://stratyge.atlassian.net/browse/AGO-159) | US-169 Add workspace export and import | p2 | 90@w5, 121@w3 |  |
| 0 | [AGO-161](https://stratyge.atlassian.net/browse/AGO-161) | US-170 Add consolidation and decay | p3 | 75@w4, 163@w3 |  |
| 1 | [AGO-135](https://stratyge.atlassian.net/browse/AGO-135) | US-162 Create an eval set for each starter role | p2 | 134, 136@w2 |  |
| 1 | [AGO-139](https://stratyge.atlassian.net/browse/AGO-139) | US-164 Build the incident view | p2 | 84@w2, 134 |  |
| 1 | [AGO-149](https://stratyge.atlassian.net/browse/AGO-149) | US-166 Add skill tests and trigger-precision checks | p2 | 128@w2, 134 |  |
| 1 | [AGO-152](https://stratyge.atlassian.net/browse/AGO-152) | US-167 Add signed audit exports | p2 | 137 |  |
| 1 | [AGO-156](https://stratyge.atlassian.net/browse/AGO-156) | US-168 Add agent versions with quality snapshots | p2 | 89@w2, 134 |  |

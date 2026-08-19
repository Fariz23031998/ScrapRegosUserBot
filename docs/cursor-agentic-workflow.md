# Cursor agentic workflow (context-safe)

Use this when a goal needs several agent runs. The point is to finish the work **without** watching the context ring, and **without** letting any single agent pass **50%** of its context window (quality drops above ~50–60%).

Cursor has no “stop at 50%” setting. The only reliable cap is: **one agent lifetime = one plan checkbox**. Durable state lives in markdown, not in chat history.

```text
Goal (markdown)
  → Plan with small checkboxes (markdown)
    → Worker 1 (new agent, empty context) → marks item done → exits
    → Worker 2 (new agent, empty context) → marks item done → exits
    → …
  → Goal done when every checkbox and acceptance check is green
```

## Rules

1. **Do not** implement a whole goal in one chat, one Cloud Agent, or one `agent.send()` follow-up chain.
2. **Do not** click “Build entire plan” for a multi-slice plan.
3. **Do not** use `/summarize` as the main strategy. Start a new agent instead.
4. Subagents are fine **inside** a slice (explore/search). They do **not** protect a parent that does many slices in one conversation.
5. If a worker would need more than ~8–12 tool rounds, **split the checkbox**. That is a planning bug, not a context-management task.

## File layout

```text
docs/goals/<goal-id>.md
docs/plans/<goal-id>.md
```

- Goal file: outcome and acceptance criteria (what “done” means).
- Plan file: ordered, independently completable slices. This is the queue.

Use a short `goal-id` (`print-queue`, `sms-retry`, `admin-auth`). One goal ↔ one plan.

## 1. Write the goal

Copy `docs/goals/_template.md` (or the template below) to `docs/goals/<goal-id>.md`.

Fill in:

- Outcome in one paragraph
- Acceptance checks (commands that must pass, behavior that must exist)
- Out of scope

Workers read this file. Do not rely on chat memory for “what done means.”

## 2. Write the plan (small slices)

Use **Plan Mode** (`Shift+Tab`) to research and draft, then **Save to workspace** as `docs/plans/<goal-id>.md`.

Or write the plan by hand from `docs/plans/_template.md`.

Each checkbox must be small enough that a **fresh** agent can finish it under ~50% of a 256K window (~128K tokens):

| Too big (will blow context) | Right size |
|---|---|
| Implement the feature end to end | Add TCP listener and protocol parser |
| Refactor the whole module | Extract `X` from `file.ts` and add tests |
| Explore the repo and then implement | Implementation only; exploration is a separate slice or a subagent |

Sizing checklist per slice:

- Touches about **1–3 files**, or one vertical cut
- Names the files or area to change
- Names the command that proves it (`npm test -- <file>`, `dotnet test`, …)
- Can complete in roughly **8–12 tool rounds**
- Does not require the previous slice’s chat — only the files and the plan

If blocked, the worker writes `BLOCKED: …` on that line and **exits**. The next agent (or a human) unblocks it. Do not sit in the same thread exploring for dozens of turns.

## 3. Run workers until the plan is empty

For each unchecked item, start a **new** agent (New Chat, Agents Window, or Cloud Agent). Paste the worker prompt below. The agent must stop after that item.

Do not continue the same conversation for the next checkbox.

### Worker prompt (paste every time)

```text
Read docs/goals/<goal-id>.md and docs/plans/<goal-id>.md.

Do ONLY the first unchecked slice in the plan.

- Implement that slice and run its verification command.
- Check the box in the plan. Add a one-line note of what changed.
- If blocked, write BLOCKED: <reason> on that line and stop.
- Do not start the next slice.
- Stop when the slice is done or blocked.
```

Replace `<goal-id>` with the real id.

### How to start each worker

| Surface | What to do |
|---|---|
| IDE chat | New Chat → Agent mode → paste the worker prompt |
| Agents Window | New agent per checkbox (not one agent for the whole plan) |
| Cloud Agent | New cloud agent per checkbox |
| Cursor SDK | `Agent.prompt(...)` once per checkbox — never `agent.send()` for the next item |

### Optional: SDK loop (fully unattended)

Each `Agent.prompt(...)` is a new empty context. Loop until the plan has no unchecked items and the goal’s acceptance checks pass. Do not resume the same agent for the next slice.

## 4. Confirm the goal is done

When every plan checkbox is ticked:

1. Run the acceptance commands from the goal file.
2. If they fail, add new slices to the plan (do not reopen a fat chat).
3. Archive or leave the goal/plan files as a record of what shipped.

## Templates

### Goal — `docs/goals/_template.md`

```markdown
# Goal: <short title>

**Id:** `<goal-id>`
**Status:** queued | in-progress | done | blocked

## Outcome

<One paragraph: what exists when this is finished.>

## Acceptance

- [ ] <command, e.g. `npm test`>
- [ ] <observable behavior>
- [ ] <files or API that must exist>

## Out of scope

- <explicit non-goals>

## Notes

<Links, constraints, related PRs.>
```

### Plan — `docs/plans/_template.md`

```markdown
# Plan: <same title as goal>

**Goal:** `docs/goals/<goal-id>.md`
**Status:** queued | in-progress | done

Slice rules: one checkbox = one new agent. Touch ~1–3 files. Name a verify command. Stop after the item.

## Slices

- [ ] **S1 — <title>**
  - Area: `<path or files>`
  - Verify: `<command>`
  - Done when: <one sentence>
  - Notes:

- [ ] **S2 — <title>**
  - Area:
  - Verify:
  - Done when:
  - Notes:

- [ ] **S3 — <title>**
  - Area:
  - Verify:
  - Done when:
  - Notes:
```

## Project conventions (optional)

To make this automatic in-repo (so you do not re-explain it):

- **Rule** (`.cursor/rules`): never implement more than one plan checkbox in this conversation; after updating the plan, stop.
- **Skill** (e.g. `/next-task`): read the plan, do the next box, stop.
- **Subagent** (`.cursor/agents/slice-runner.md`): isolated window for one checkbox; parent only receives done / blocked / files changed.

The parent that launches slice-runners must still be short-lived. If one orchestrator chat launches many slices, its summaries will pass 50%. Prefer a new orchestrator chat every few slices, or the SDK loop.

## Anti-patterns

- One mega-chat for a multi-day feature
- “Also do the next three items while you’re here”
- Attaching large folders or whole-repo diffs to every worker
- Resuming a Cloud Agent / SDK agent to start the next checkbox
- Using `/loop` in the same chat to grind through a plan (same context window)
```

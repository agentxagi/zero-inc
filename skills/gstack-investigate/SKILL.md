---
name: gstack-investigate
description: >
  Systematic debugging with root cause investigation. Four phases: investigate,
  analyze, hypothesize, implement. Iron Law: no fixes without root cause.
  Trigger on "debug this", "fix this bug", "why is this broken",
  "investigate this error", or "root cause analysis".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Systematic Debugging

## Iron Law

**NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

Fixing symptoms creates whack-a-mole debugging. Every fix that doesn't address root cause makes the next bug harder to find. Find the root cause, then fix it.

## Completion Status

When completing a debug session, report status using one of:
- **DONE** — Root cause found, fix applied, verified
- **DONE_WITH_CONCERNS** — Fixed but cannot fully verify (e.g., intermittent bug)
- **BLOCKED** — Root cause unclear after investigation, escalated

---

## Phase 1: Root Cause Investigation

Gather context before forming any hypothesis.

1. **Collect symptoms:** Read the error messages, stack traces, and reproduction steps. If context is missing, ask ONE question at a time via AskUserQuestion.

2. **Read the code:** Trace the code path from the symptom back to potential causes. Use Grep to find all references, Read to understand the logic.

3. **Check recent changes:**
   ```bash
   git log --oneline -20 -- <affected-files>
   ```
   Was this working before? What changed? A regression means the root cause is in the diff.

4. **Reproduce:** Can you trigger the bug deterministically? If not, gather more evidence before proceeding.

Output: **"Root cause hypothesis: ..."** — a specific, testable claim about what is wrong and why.

---

## Phase 2: Pattern Analysis

Check if this bug matches a known pattern:

| Pattern | Signature | Where to look |
|---------|-----------|---------------|
| Race condition | Intermittent, timing-dependent | Concurrent access to shared state |
| Nil/null propagation | NoMethodError, TypeError | Missing guards on optional values |
| State corruption | Inconsistent data, partial updates | Transactions, callbacks, hooks |
| Integration failure | Timeout, unexpected response | External API calls, service boundaries |
| Configuration drift | Works locally, fails in staging/prod | Env vars, feature flags, DB state |
| Stale cache | Shows old data, fixes on cache clear | Redis, CDN, browser cache |

Also check:
- `git log` for prior fixes in the same area — **recurring bugs in the same files are an architectural smell**, not a coincidence

---

## Phase 3: Hypothesis Testing

Before writing ANY fix, verify your hypothesis.

1. **Confirm the hypothesis:** Add a temporary log statement, assertion, or debug output at the suspected root cause. Run the reproduction. Does the evidence match?

2. **If the hypothesis is wrong:** Return to Phase 1. Gather more evidence. Do not guess.

3. **3-strike rule:** If 3 hypotheses fail, **STOP**. Use AskUserQuestion:
   ```
   3 hypotheses tested, none match. This may be an architectural issue.

   A) Continue investigating — I have a new hypothesis
   B) Escalate for human review
   C) Add logging and wait — instrument the area and catch it next time
   ```

**Red flags** — if you see any of these, slow down:
- "Quick fix for now" — there is no "for now." Fix it right or escalate.
- Proposing a fix before tracing data flow — you're guessing.
- Each fix reveals a new problem elsewhere — wrong layer, not wrong code.

---

## Phase 4: Implementation

Once root cause is confirmed:

1. **Fix the root cause, not the symptom.** The smallest change that eliminates the actual problem.

2. **Minimal diff:** Fewest files touched, fewest lines changed. Resist the urge to refactor adjacent code.

3. **Write a regression test** that:
   - **Fails** without the fix (proves the test is meaningful)
   - **Passes** with the fix (proves the fix works)

4. **Run the full test suite.** No regressions allowed.

5. **If the fix touches >5 files:** Use AskUserQuestion to flag the blast radius.

---

## Phase 5: Verification & Report

**Fresh verification:** Reproduce the original bug scenario and confirm it's fixed. This is not optional.

Output a structured debug report:
```
DEBUG REPORT
════════════════════════════════════════
Symptom:         [what was observed]
Root cause:      [what was actually wrong]
Fix:             [what was changed, with file:line references]
Evidence:        [test output, reproduction showing fix works]
Regression test: [file:line of the new test]
Status:          DONE | DONE_WITH_CONCERNS | BLOCKED
════════════════════════════════════════
```

## Important Rules

- **3+ failed fix attempts → STOP and question the architecture.**
- **Never apply a fix you cannot verify.** Run the tests.
- **Never say "this should fix it."** Verify and prove it.
- **If fix touches >5 files → flag blast radius** before proceeding.

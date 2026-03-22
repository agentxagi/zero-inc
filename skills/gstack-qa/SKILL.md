---
name: gstack-qa
description: >
  Systematically QA test a web application and fix bugs found. Runs QA testing,
  then iteratively fixes bugs in source code, committing each fix atomically and
  re-verifying. Three tiers: Quick (critical/high only), Standard (+ medium),
  Exhaustive (+ cosmetic). Produces before/after health scores and fix evidence.
  Trigger on "qa", "QA", "test this site", "find bugs", or "test and fix".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - AskUserQuestion
  - WebSearch
---

# /gstack-qa: Test → Fix → Verify

You are a QA engineer AND a bug-fix engineer. When you find bugs, fix them in source code with atomic commits, then re-verify. Produce a structured report.

## Setup

**Parse the user's request:**

| Parameter | Default | Override example |
|-----------|---------|-----------------:|
| Target URL | (auto-detect or required) | `https://myapp.com`, `http://localhost:3000` |
| Tier | Standard | `--quick`, `--exhaustive` |
| Mode | full | `--regression <baseline>` |
| Scope | Full app (or diff-scoped) | `Focus on the billing page` |

**Tiers determine which issues get fixed:**
- **Quick:** Fix critical + high severity only
- **Standard:** + medium severity (default)
- **Exhaustive:** + low/cosmetic severity

**Check for clean working tree:**

```bash
git status --porcelain
```

If dirty, **STOP** and use AskUserQuestion:
- A) Commit my changes, then start QA
- B) Stash my changes
- C) Abort

## Phases 1-4: QA Testing

### Phase 1: Initialize

1. Detect running app — check common ports:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 2>/dev/null && echo "Found :3000" || \
   curl -s -o /dev/null -w "%{http_code}" http://localhost:4000 2>/dev/null && echo "Found :4000"
   ```
2. Create output directory: `mkdir -p .gstack/qa-reports`

### Phase 2: Authenticate (if needed)

If the user specified auth credentials, use AskUserQuestion for OTP/2FA codes when needed. Handle CAPTCHA by asking the user to complete it.

### Phase 3: Orient

Get a map of the application. Read the codebase to understand routes, pages, and navigation structure.

```bash
# For web apps: check routes
git diff main...HEAD --name-only 2>/dev/null | head -20
```

### Phase 4: Explore

Visit pages systematically. At each page:
1. Check page loads (HTTP status)
2. Check for console errors (if browser available)
3. Test interactive elements (forms, buttons, navigation)
4. Test edge cases (empty states, error states, boundary values)
5. Check responsiveness (if relevant)

**Quick mode:** Only homepage + top 5 navigation targets.

## Phase 5: Document Issues

Document each issue **immediately when found**.

For each issue:
- **Severity:** Critical / High / Medium / Low
- **Category:** Functional / Visual / UX / Performance / Content / Accessibility
- **Repro steps:** Exact steps to reproduce
- **Expected vs Actual:** What should happen vs what happens
- **File references:** Source files likely responsible (from Grep/Glob)

## Phase 6: Wrap Up

1. Compute health score using the rubric below
2. Write "Top 3 Things to Fix"
3. Save baseline: `.gstack/qa-reports/baseline.json`

## Health Score Rubric

| Category | Weight | Scoring |
|----------|--------|---------|
| Functional | 30% | Start at 100. -25 per critical, -15 per high, -8 per medium, -3 per low |
| UX | 15% | Same deduction scale |
| Performance | 10% | Same deduction scale |
| Content | 5% | Same deduction scale |
| Accessibility | 10% | Same deduction scale |
| Console errors | 15% | 0 errors=100, 1-3=70, 4-10=40, 10+=10 |
| Links | 15% | 0 broken=100, -15 per broken link |

`score = sum(category_score * weight)`

## Phase 7: Triage

Sort by severity, decide which to fix based on tier:
- **Quick:** Critical + high only
- **Standard:** + medium
- **Exhaustive:** All

## Phase 8: Fix Loop

For each fixable issue, in severity order:

### 8a. Locate source
Use Grep/Glob to find the source file responsible.

### 8b. Fix
Read the source code, understand context. Make the **minimal fix**. Do NOT refactor surrounding code.

### 8c. Commit
```bash
git add <only-changed-files>
git commit -m "fix(qa): ISSUE-NNN — short description

Co-Authored-By: ZeroInc <noreply@zeroinc.ing>"
```
One commit per fix. Never bundle.

### 8d. Re-test
Verify the fix works. Check for regressions.

### 8e. Write regression test (if framework detected)

If a test framework exists:
1. Read 2-3 existing test files to match conventions
2. Write a test that:
   - Sets up the precondition that triggered the bug
   - Performs the action that exposed it
   - Asserts correct behavior
3. Run the test. Passes → commit. Fails → fix once. Still fails → delete, defer.

### 8f. Self-Regulation (STOP AND EVALUATE)

Every 5 fixes (or after any revert), compute WTF-likelihood:
```
Start at 0%
Each revert:                +15%
Each fix touching >3 files: +5%
After fix 15:               +1% per additional fix
All remaining Low severity: +10%
```

**If WTF > 20%:** STOP. Show what you've done. Ask whether to continue.
**Hard cap: 50 fixes.**

## Phase 9: Final QA

1. Re-run QA on all affected areas
2. Compute final health score
3. If final score is WORSE than baseline: **WARN prominently**

## Phase 10: Report

Write report to `.gstack/qa-reports/qa-report-{domain}-{YYYY-MM-DD}.md`

**Summary section:**
- Total issues found
- Fixes applied (verified: X, best-effort: Y, reverted: Z)
- Deferred issues
- Health score delta: baseline → final

**PR Summary:** One-line summary suitable for PR descriptions:
> "QA found N issues, fixed M, health score X → Y."

## Important Rules

1. **Repro is everything.** Every issue needs evidence.
2. **Verify before documenting.** Retry to confirm it's reproducible.
3. **Never include credentials.** Write `[REDACTED]`.
4. **Write incrementally.** Append each issue as you find it.
5. **Never delete output files.** Reports accumulate intentionally.
6. **Clean working tree required.** If dirty, offer commit/stash/abort.
7. **One commit per fix.** Never bundle multiple fixes.
8. **Revert on regression.** If a fix makes things worse, revert immediately.
9. **Self-regulate.** Follow the WTF-likelihood heuristic.

---
name: gstack-review
description: >
  Pre-landing PR review. Analyzes diff against the base branch for SQL safety, LLM trust
  boundary violations, conditional side effects, and other structural issues. Uses Fix-First
  approach: auto-fix obvious issues, batch-ask for judgment calls. Trigger on "review this PR",
  "code review", "pre-landing review", or "check my diff".
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - AskUserQuestion
---

# Pre-Landing PR Review

Analyze the current branch's diff against the base branch for structural issues that tests don't catch.

## Step 0: Detect base branch

Determine which branch this PR targets. Use the result as "the base branch" in all subsequent steps.

1. Check if a PR already exists for this branch:
   `gh pr view --json baseRefName -q .baseRefName`
   If this succeeds, use the printed branch name.

2. If no PR exists, detect the repo's default branch:
   `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`

3. If both fail, fall back to `main`.

## Step 1: Check branch

1. Run `git branch --show-current` to get the current branch.
2. If on the base branch, output: **"Nothing to review — you're on the base branch."** and stop.
3. Run `git fetch origin <base> --quiet && git diff origin/<base> --stat`. If no diff, stop.

## Step 1.5: Scope Drift Detection

Before reviewing code quality, check: **did they build what was requested?**

1. Read PR description (`gh pr view --json body --jq .body 2>/dev/null || true`).
   Read commit messages (`git log origin/<base>..HEAD --oneline`).
2. Identify the **stated intent**.
3. Run `git diff origin/<base> --stat` and compare against stated intent.
4. Evaluate:

   **SCOPE CREEP:** Files changed unrelated to stated intent.
   **MISSING REQUIREMENTS:** Requirements not addressed in the diff.

5. Output:
   ```
   Scope Check: [CLEAN / DRIFT DETECTED / REQUIREMENTS MISSING]
   Intent: <1-line summary>
   Delivered: <1-line summary>
   ```

## Step 2: Get the diff

```bash
git fetch origin <base> --quiet
git diff origin/<base>
```

## Step 3: Two-pass review

Apply the checklist against the diff in two passes:

1. **Pass 1 (CRITICAL):** SQL & Data Safety, Race Conditions & Concurrency, LLM Output Trust Boundary, Enum & Value Completeness
2. **Pass 2 (INFORMATIONAL):** Conditional Side Effects, Magic Numbers & String Coupling, Dead Code & Consistency, Test Gaps

**Enum & Value Completeness requires reading code OUTSIDE the diff.** When the diff introduces a new enum value, status, tier, or type constant, use Grep to find all files that reference sibling values, then Read those files to check if the new value is handled.

## Step 4: Fix-First Review

**Every finding gets action — not just critical ones.**

Output: `Pre-Landing Review: N issues (X critical, Y informational)`

### 4a: Classify each finding

For each finding, classify as AUTO-FIX or ASK:
- Critical findings → ASK
- Informational findings → AUTO-FIX

### 4b: Auto-fix all AUTO-FIX items

Apply each fix directly. Output: `[AUTO-FIXED] [file:line] Problem → fix`

### 4c: Batch-ask about ASK items

Present remaining ASK items in ONE AskUserQuestion:
- List each with number, severity, problem, recommended fix
- Options per item: A) Fix  B) Skip
- Include overall RECOMMENDATION

### 4d: Apply user-approved fixes

### Verification of claims

Before producing the final review output:
- If you claim "this pattern is safe" → cite the specific line proving safety
- If you claim "this is handled elsewhere" → read and cite the handling code
- If you claim "tests cover this" → name the test file and method
- Never say "likely handled" or "probably tested" — verify or flag as unknown

**Rationalization prevention:** "This looks fine" is not a finding. Either cite evidence it IS fine, or flag it as unverified.

## Step 5: Documentation staleness check

Cross-reference the diff against documentation files (README.md, ARCHITECTURE.md, etc.):
- If code changed but doc wasn't updated, flag as INFORMATIONAL.

## Important Rules

- **Read the FULL diff before commenting.** Do not flag issues already addressed.
- **Fix-first, not read-only.** AUTO-FIX items applied directly. ASK items only after user approval.
- **Be terse.** One line problem, one line fix. No preamble.
- **Only flag real problems.** Skip anything that's fine.
- **Never commit, push, or create PRs** — that's /gstack-ship's job.

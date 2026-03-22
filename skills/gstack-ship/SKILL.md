---
name: gstack-ship
description: >
  Ship workflow: detect base branch, merge it, run tests, review diff, bump version,
  update changelog, commit, push, create PR. Non-interactive — runs straight through.
  Trigger on "ship", "deploy", "push to main", "create a PR", or "merge and push".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
  - WebSearch
---

# Ship: Automated Ship Workflow

You are running the `/gstack-ship` workflow. This is a **non-interactive, fully automated** workflow. Run straight through and output the PR URL at the end.

**Only stop for:**
- On the base branch (abort)
- Merge conflicts that can't be auto-resolved
- Test failures
- Pre-landing review ASK items that need user judgment
- MINOR or MAJOR version bump needed (ask user)

**Never stop for:**
- Uncommitted changes (always include them)
- MICRO/PATCH version bump choice (auto-pick)
- CHANGELOG content (auto-generate from diff)
- Commit message approval (auto-commit)

---

## Step 0: Detect base branch

1. `gh pr view --json baseRefName -q .baseRefName` — use this if it succeeds.
2. `gh repo view --json defaultBranchRef -q .defaultBranchRef.name` — fallback.
3. `main` — final fallback.

## Step 1: Pre-flight

1. Check current branch. If on base branch, **abort**.
2. Run `git status`. Uncommitted changes are always included.
3. `git diff <base>...HEAD --stat` and `git log <base>..HEAD --oneline`.

## Step 2: Merge the base branch

```bash
git fetch origin <base> && git merge origin/<base> --no-edit
```

If merge conflicts: try auto-resolve simple ones (VERSION, CHANGELOG ordering). If complex, **STOP** and show conflicts.

## Step 3: Run tests

Run the project's test suite. Detect framework and command:
```bash
# Detect test framework
[ -f package.json ] && grep -q '"test"' package.json && echo "NPM_TEST"
[ -f Gemfile ] && echo "RUBY_TEST"
```

**If any test fails:** Show the failures and **STOP**.

## Step 3.5: Pre-Landing Review

Review the diff for structural issues tests don't catch:

1. Run `git diff origin/<base>` to get the full diff.
2. Apply review in two passes:
   - **Pass 1 (CRITICAL):** SQL & Data Safety, LLM Output Trust Boundary, Race Conditions
   - **Pass 2 (INFORMATIONAL):** Conditional Side Effects, Dead Code, Test Gaps
3. Classify findings as AUTO-FIX or ASK.
4. Auto-fix all AUTO-FIX items.
5. If ASK items remain, present in ONE AskUserQuestion.
6. If any fixes were applied, commit and **STOP** — tell user to run `/gstack-ship` again.

## Step 4: Version bump (auto-decide)

1. Read the `VERSION` file (4-digit format: `MAJOR.MINOR.PATCH.MICRO`).
2. Auto-decide based on diff size:
   - **MICRO** (4th digit): < 50 lines changed, trivial tweaks
   - **PATCH** (3rd digit): 50+ lines changed, bug fixes, small features
   - **MINOR/MAJOR:** **ASK the user** — only for major features or breaking changes
3. Write new version to `VERSION`.

## Step 5: CHANGELOG (auto-generate)

1. Read `CHANGELOG.md` header for format.
2. Auto-generate entry from ALL commits on the branch.
3. Categorize: Added / Changed / Fixed / Removed.
4. Insert after file header, dated today.
5. Format: `## [X.Y.Z.W] - YYYY-MM-DD`

## Step 6: Commit (bisectable chunks)

1. Group changes into logical commits. Each commit = one coherent change.
2. **Order:** Infrastructure → Models/Services → Controllers/Views → VERSION + CHANGELOG
3. **Rules:**
   - A model and its test go in the same commit
   - Migrations are their own commit
   - If total diff < 50 lines across < 4 files, single commit is fine
4. **Final commit** (VERSION + CHANGELOG) gets co-author trailer:
   ```
   Co-Authored-By: ZeroInc <noreply@zeroinc.ing>
   ```

## Step 6.5: Verification Gate

If ANY code changed after Step 3's test run, re-run tests before pushing.
"If tests fail here: STOP. Do not push."

## Step 7: Push

```bash
git push -u origin <branch-name>
```

## Step 8: Create PR

```bash
gh pr create --base <base> --title "<type>: <summary>" --body "$(cat <<'EOF'
## Summary
<bullet points from CHANGELOG>

## Pre-Landing Review
<findings from Step 3.5, or "No issues found.">

## Test plan
- [x] All tests pass

Co-Authored-By: ZeroInc <noreply@zeroinc.ing>
EOF
)"
```

**Output the PR URL.**

## Important Rules

- **Never skip tests.** If tests fail, stop.
- **Never skip the pre-landing review.**
- **Never force push.** Use regular `git push` only.
- **Never ask for confirmation** except for MINOR/MAJOR version bumps and review ASK items.
- **Always use the 4-digit version format.**
- **Split commits for bisectability.**
- **Never push without fresh verification evidence.**

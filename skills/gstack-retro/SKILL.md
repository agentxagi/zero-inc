---
name: gstack-retro
description: >
  Engineering retrospective. Analyzes commit history, work patterns,
  and code quality metrics with trend tracking. Team-aware: breaks down
  per-person contributions. Trigger on "weekly retro", "what did we ship",
  or "engineering retrospective".
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - AskUserQuestion
---

# /gstack-retro — Engineering Retrospective

Generates a comprehensive engineering retrospective analyzing commit history, work patterns, and code quality metrics. Team-aware: identifies contributors with per-person analysis.

## Arguments
- `/gstack-retro` — last 7 days
- `/gstack-retro 24h` — last 24 hours
- `/gstack-retro 14d` — last 14 days
- `/gstack-retro 30d` — last 30 days
- `/gstack-retro compare` — compare current window vs prior same-length window

## Detect default branch

`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`
Fall back to `main` if this fails.

---

## Step 1: Gather Raw Data

Fetch origin and identify the current user:
```bash
git fetch origin <default> --quiet
git config user.name
git config user.email
```

Run ALL of these in parallel:

```bash
# 1. All commits with timestamps, subject, hash, author, stats
git log origin/<default> --since="<window>" --format="%H|%aN|%ae|%ai|%s" --shortstat

# 2. Per-commit test vs production LOC breakdown
git log origin/<default> --since="<window>" --format="COMMIT:%H|%aN" --numstat

# 3. Commit timestamps for session detection
git log origin/<default> --since="<window>" --format="%at|%aN|%ai|%s" | sort -n

# 4. Files most frequently changed (hotspot analysis)
git log origin/<default> --since="<window>" --format="" --name-only | grep -v '^$' | sort | uniq -c | sort -rn

# 5. PR numbers from commit messages
git log origin/<default> --since="<window>" --format="%s" | grep -oE '#[0-9]+' | sort -n | uniq

# 6. Per-author file hotspots
git log origin/<default> --since="<window>" --format="AUTHOR:%aN" --name-only

# 7. Per-author commit counts
git shortlog origin/<default> --since="<window>" -sn --no-merges

# 8. Test file count
find . -name '*.test.*' -o -name '*.spec.*' -o -name '*_test.*' -o -name '*_spec.*' 2>/dev/null | grep -v node_modules | wc -l
```

## Step 2: Compute Metrics

| Metric | Value |
|--------|-------|
| Commits to main | N |
| Contributors | N |
| PRs merged | N |
| Total insertions | N |
| Total deletions | N |
| Net LOC added | N |
| Test LOC (insertions) | N |
| Test LOC ratio | N% |
| Active days | N |
| Detected sessions | N |
| Avg LOC/session-hour | N |
| Test Health | N total tests · M added this period |

Show a **per-author leaderboard**:
```
Contributor         Commits   +/-          Top area
You (name)               32   +2400/-300   src/
```

## Step 3: Commit Time Distribution

Show hourly histogram. Identify peak hours, dead zones, bimodal patterns.

## Step 4: Work Session Detection

Detect sessions using **45-minute gap** threshold. Classify:
- **Deep sessions** (50+ min)
- **Medium sessions** (20-50 min)
- **Micro sessions** (<20 min)

## Step 5: Commit Type Breakdown

Categorize by conventional commit prefix (feat/fix/refactor/test/chore/docs). Flag if fix ratio exceeds 50%.

## Step 6: Hotspot Analysis

Top 10 most-changed files. Flag files changed 5+ times (churn hotspots).

## Step 7: Focus Score + Ship of the Week

- **Focus score:** % of commits touching the single most-changed top-level directory
- **Ship of the week:** Single highest-LOC PR in the window

## Step 8: Team Member Analysis

For each contributor:
1. Commits and LOC
2. Areas of focus (top 3 directories)
3. Commit type mix
4. Session patterns
5. Test discipline
6. Biggest ship

**For the current user:** Full deep-dive with personal metrics.

**For each teammate:** 2-3 sentences + specific praise + growth suggestion.

## Step 9: Streak Tracking

Count consecutive days with at least 1 commit. Display team and personal streak.

## Step 10: Save Retro History

```bash
mkdir -p .context/retros
```

Save JSON snapshot with metrics, authors, version range, streak days.

## Step 11: Write the Narrative

Structure:
- **Tweetable summary** (first line)
- Summary Table
- Trends vs Last Retro (if prior retros exist)
- Time & Session Patterns
- Shipping Velocity
- Code Quality Signals
- Focus & Highlights
- Your Week (personal deep-dive)
- Team Breakdown (skip if solo)
- Top 3 Team Wins
- 3 Things to Improve
- 3 Habits for Next Week

## Tone

- Encouraging but candid
- Specific — always anchor in actual commits
- Skip generic praise — say exactly what was good
- Frame improvements as leveling up
- Never compare teammates negatively
- Keep total output around 3000-4500 words

## Important Rules

- ALL narrative output goes to the user in the conversation. The ONLY file written is `.context/retros/` JSON.
- Use `origin/<default>` for all git queries.
- Display timestamps in local timezone.
- If the window has zero commits, say so.
- Round LOC/hour to nearest 50.

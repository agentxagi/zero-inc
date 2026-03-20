# Contributing to ZeroInc

Thanks for wanting to contribute to ZeroInc — the AI agent orchestration platform with built-in quality gates and review pipelines.

## Quick Start

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes
4. Run tests: `pnpm test`
5. Build: `pnpm build`
6. Open a Pull Request

## Two Paths to Get Your PR Accepted

### Path 1: Small, Focused Changes (Fastest)
- Pick **one** clear thing to fix/improve
- Touch the **smallest possible number of files**
- Make sure all automated checks pass
- No new lint/test failures

### Path 2: Bigger or Impactful Changes
- **First**, open an issue describing what you want to do and why
- Once there's rough agreement, build it
- In your PR include:
  - Clear description of what & why
  - Proof it works (tests passing, manual testing notes)
  - All review comments addressed

## General Rules
- Write clear commit messages
- One PR = one logical change
- Run tests locally before pushing
- Be kind in discussions

## ZeroInc-Specific: Quality Gates

ZeroInc has automatic quality gates that verify task completion. When contributing:
- All tests must pass
- New features should include tests
- Code that touches the quality gate or review pipeline needs extra review

## PR Thinking Path

Include a thinking path at the top of your PR that explains your reasoning:

> - ZeroInc orchestrates AI agents for zero-human companies
> - [Context about the problem]
> - [Why it matters]
> - This PR [what you did]
> - The benefit is [expected outcome]

Questions? Open an issue — we're happy to help.

Happy hacking! 🧪

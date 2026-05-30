# Changelog

All notable changes to this project. Updated with every commit.

Format: each entry has a date, short description, and category. Most recent first.

---

## [Unreleased]

### Added
- Project design documentation (`docs/`)
  - High-level design doc (`project-hld.md`)
  - Architecture principles (`architecture-principles.md`)
  - Testing principles (`testing-principles.md`)
  - Customer experience flows and wireframes (`customer-experience.md`)
  - Execution plan with 9 LLDs across 6 phases (`execution-plan.md`)
- Agent personas (`.claude/agents/`)
  - CEO — strategic decisions and priorities
  - Architect — writes LLDs
  - Design Reviewer — validates LLDs against principles
  - Implementer — codes against approved LLDs
  - Code Reviewer — reviews implementation correctness and security
  - QA — validates features against CX doc
- `DEVELOPMENT.md` — development workflow guide with persona invocation and communication protocol
- `CHANGELOG.md` — this file

### Changed
- Updated `CLAUDE.md` — slimmed to orientation file, moved commands/conventions to DEVELOPMENT.md

---

<!--
## Entry Template

## [YYYY-MM-DD] — Short title

### Added
- New feature or file

### Changed
- Modification to existing behavior or file

### Fixed
- Bug fix

### Removed
- Deleted code, file, or feature

### Notes
- Context, decisions made, or anything worth calling out
-->

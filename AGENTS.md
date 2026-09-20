# AGENTS.md

Agent-facing conventions for `four-keys-metrics-viewer`.

## Agent skills

The engineering skills from [mattpocock/skills](https://github.com/mattpocock/skills) live in
`.claude/skills/`. See `.claude/skills/ENGINEERING-SKILLS.md` for what each one does.

### Issue tracker

Issues live in this repo's GitHub Issues, driven through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each used verbatim as its label string. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root, both created lazily when needed. See `docs/agents/domain.md`.

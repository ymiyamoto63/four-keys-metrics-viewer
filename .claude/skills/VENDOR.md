# Vendored skills: mattpocock/skills — `skills/engineering`

These skill folders are copied from Matt Pocock's public skills repository.

- **Source**: https://github.com/mattpocock/skills/tree/main/skills/engineering
- **Commit**: `c55ee46073ed923f86ce59a5eb3b6d895095d1b7`
- **Imported**: 2026-09-20
- **License**: MIT (see [LICENSE](./LICENSE), © 2026 Matt Pocock)

## What was changed on import

- `skills/engineering/**` was taken; `misc/`, `in-progress/` and `deprecated/` were left out.
- From `productivity/`, only `grilling/` and `grill-me/` were taken: the engineering skills depend on
  `grilling` (`grill-with-docs`, `wayfinder`, `triage` and `improve-codebase-architecture` all call it),
  and `grill-me` is its no-working-directory entry point. The rest of `productivity/` was left out.
- Each skill's `agents/openai.yaml` (Codex-specific config) was dropped, since this repo drives them through Claude Code.
- The upstream `skills/engineering/README.md` is kept here as [ENGINEERING-SKILLS.md](./ENGINEERING-SKILLS.md) — it is the index of what each skill does.

Everything else (`SKILL.md` and supporting files) is byte-identical to upstream.

## First-time setup

Run `/setup-matt-pocock-skills` once in this repo. It asks which issue tracker to
use, which triage labels you apply, and where domain docs (`CONTEXT.md`, ADRs)
should live — the other skills read that configuration.

## Updating

Re-run the import against a newer upstream commit:

```bash
git clone --depth 1 https://github.com/mattpocock/skills.git /tmp/mp-skills
rsync -a --delete --exclude 'agents/' --exclude 'README.md' /tmp/mp-skills/skills/engineering/ .claude/skills/
rsync -a --exclude 'agents/' /tmp/mp-skills/skills/productivity/grilling /tmp/mp-skills/skills/productivity/grill-me .claude/skills/
```

Then restore `ENGINEERING-SKILLS.md`, `LICENSE` and this file, and update the
commit SHA above. Local edits to these skills will be overwritten — upstream
intends them to be hacked on, so review the diff rather than applying blind.

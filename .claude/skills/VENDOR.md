# Vendored skills: mattpocock/skills — `skills/engineering`

These skill folders are copied from Matt Pocock's public skills repository.

- **Source**: https://github.com/mattpocock/skills/tree/main/skills/engineering
- **Commit**: `c55ee46073ed923f86ce59a5eb3b6d895095d1b7`
- **Imported**: 2026-09-20
- **License**: MIT (see [LICENSE](./LICENSE), © 2026 Matt Pocock)

## What was changed on import

- Only `skills/engineering/**` was taken; `productivity/`, `misc/`, `in-progress/` and `deprecated/` were left out.
- Each skill's `agents/openai.yaml` (Codex-specific config) was dropped, since this repo drives them through Claude Code.
- The upstream `skills/engineering/README.md` is kept here as [ENGINEERING-SKILLS.md](./ENGINEERING-SKILLS.md) — it is the index of what each skill does.

### Exception: `grilling`

[`grilling/`](./grilling/SKILL.md) comes from `skills/productivity/`, not
`skills/engineering/`, at the same pinned commit. It is the interview primitive —
rounds of numbered questions across a design tree, each with a recommended
answer — that several of the engineering skills delegate to via the Skill tool:

- `grill-with-docs` (its entire body is "call `grilling` and `domain-modeling`")
- `triage`, `wayfinder`, `improve-codebase-architecture`

Without it those skills reference a skill that does not exist. It is not listed in
`ENGINEERING-SKILLS.md`, because that file is upstream's `engineering/README.md`
verbatim.

## First-time setup

Run `/setup-matt-pocock-skills` once in this repo. It asks which issue tracker to
use, which triage labels you apply, and where domain docs (`CONTEXT.md`, ADRs)
should live — the other skills read that configuration.

## Updating

Re-run the import against a newer upstream commit:

```bash
git clone --depth 1 https://github.com/mattpocock/skills.git /tmp/mp-skills
rsync -a --delete --exclude 'agents/' --exclude 'README.md' --exclude 'grilling/' \
  /tmp/mp-skills/skills/engineering/ .claude/skills/
rsync -a --exclude 'agents/' \
  /tmp/mp-skills/skills/productivity/grilling/ .claude/skills/grilling/
```

The `--exclude 'grilling/'` matters: without it, `--delete` removes the vendored
`grilling/` folder, because it is not under upstream's `engineering/`.

Then restore `ENGINEERING-SKILLS.md`, `LICENSE` and this file, and update the
commit SHA above. Local edits to these skills will be overwritten — upstream
intends them to be hacked on, so review the diff rather than applying blind.

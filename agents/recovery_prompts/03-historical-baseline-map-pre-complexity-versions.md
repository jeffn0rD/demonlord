Map the historical baseline versions needed to restore sane command behavior.

Objectives:
- Use git history to identify the last known good or simpler versions of the command and orchestration files.
- Produce a concise restore matrix for the next sessions.
- Do not rewrite production files in this session unless a tiny supporting note file is needed.

Primary targets to analyze:
- `.opencode/commands/implement.md`
- `.opencode/commands/creview.md`
- `.opencode/commands/phreview.md`
- `.opencode/plugins/orchestrator.ts`
- `.opencode/tools/cycle_runner.ts`
- `.opencode/tools/run_review.ts`

Historical questions to answer:
- Which commit is the best restore source for `/implement`?
- Which commit is the best restore source for `/creview`?
- Which commit is the best restore source for `orchestrator.ts` before `/run-review` interception?
- Which commit first introduced `run_review` complexity?
- Which commit first introduced `cycle_runner`?
- Which current behaviors should be preserved vs explicitly discarded?

Deliverable:
- Create a short recovery note under `agents/recovery_prompts/` or another non-`.opencode` documentation area containing:
  - file
  - recommended source commit
  - rationale
  - risks of restoring from that point
  - follow-up session that should consume the result

Constraints:
- This is a historical mapping session, not a rewrite session.
- Do not revert unrelated project work.

Verification:
- Ensure the restore matrix references concrete commit hashes.

Output expectations:
- Report the chosen baseline commit(s) for each file.
- Call out any cases where no clean baseline exists.

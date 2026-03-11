---
description: Execute the next available Subphase from the tasklist
agent: build
---

Please execute the next available Subphase from `/agents/$1_Tasklist.md`.

**Instructions:**
1. Look up the `$1_Tasklist.md` and find the FIRST Subphase that has uncompleted tasks (boxes not checked `[x]`).
2. Read the corresponding Phase details in `/agents/$1_Plan.md` to build your context.
3. Check for any dependencies or blockers listed in the entry criteria. If there is a dependency on another agent's tasklist, read that tasklist to verify if the required task is marked as `[x]`. If it is NOT marked as `[x]`, HALT execution and inform me of the blocker.
4. Use the `read` tool on any files you are instructed to modify *before* making edits. Do not assume file contents.
5. Execute the tasks in the Subphase sequentially. Ensure all tasks in the Subphase are completed.
6. Do NOT execute beyond the current Subphase.
7. Verify your work compiles by running `npm run build` in the `/frontend` directory or running appropriate test commands.
8. Once verified, update `/agents/$1_Tasklist.md` to mark the tasks you just completed as `[x]`.
9. Create ONE local git commit with all your changes. Use the exact commit message specified under the Subphase's "Commit Message" heading. Do NOT push the commit.
10. Stop. Provide a brief summary of the completed subphase, and output a "Manual Test List" containing 2-4 specific actions I should take in the browser dashboard to confirm your changes work correctly.

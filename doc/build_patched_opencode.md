How to build/run your patched OpenCode
From /home/jeff0r/work/opencode:
Patch reference (preserved):
- See `doc/opencode_command_noReply_patch.md` for the exact local core diff and verification steps.

1) Install deps
- bun install
2) Fastest way to run patched version (no full build)
- bun dev /home/jeff0r/work/demonlord
- This launches the local dev OpenCode against your project directory.
3) Build standalone local binary
- ./packages/opencode/script/build.ts --single
  - If execute bit fails, use:
  - bun ./packages/opencode/script/build.ts --single
4) Run built binary in your project root
- From anywhere:
  - /home/jeff0r/work/opencode/packages/opencode/dist/opencode-linux-x64/bin/opencode /home/jeff0r/work/demonlord
- Or from project root:
  - /home/jeff0r/work/opencode/packages/opencode/dist/opencode-linux-x64/bin/opencode .
5) Optional convenience for current shell
- export PATH="/home/jeff0r/work/opencode/packages/opencode/dist/opencode-linux-x64/bin:$PATH"
- Then run:
  - opencode .
If you want, after you run implement/review, I can help you write a tiny smoke-test checklist specifically for /pipeline status|off|on|approve.

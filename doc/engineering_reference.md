OpenCode Engineering Reference: System Architecture, APIs, and Agent Grounding

1. Architectural Blueprint: The Autonomous Software Factory

OpenCode functions as the central agentic environment designed to transform traditional software development into a highly automated "software factory" model. By providing an abstraction layer over manual orchestration, it enables the deployment of specialized AI agents within parallel, isolated environments. This architecture is strategically designed to replace unreliable LLM-based loops with deterministic workflow gates, ensuring that the transition from a conceptual plan to production-ready code is governed by rigorous, programmatically enforced standards rather than probabilistic chance.

Core Technology Stack The platform is built on a high-performance stack utilizing Node.js, TypeScript, and Bun. Bun serves as the high-speed runtime for executing plugins and managing shell operations via the Bun.$ utility. The OpenCode SDK provides the type-safe interface for system extensions, while the system remains fundamentally stack-agnostic; it relies on generic package.json scripts (e.g., npm run test, npm run lint) to enforce quality across any repository.

The Directory Strategy Efficiency in a parallelized environment depends on a strict directory convention. OpenCode utilizes specific hidden directories and Git primitives to separate concerns:

* demonlord.config.json: Centralized configuration file for Discord personas, worktree locations, and orchestration controls (enabled/mode/approval/abort policy/event verbosity).
* .opencode/: Houses project-level configurations, agent definitions (in opencode.jsonc or as markdown files in agents/), plugins, skills, and custom tools.
* Git Worktrees: Rather than standard branching, the system utilizes spawn_worktree.sh to generate isolated sibling directories.

Strategic Impact: This structure prevents branch collisions and file-locking, allowing multiple "minion" agents to work on tasks simultaneously in a headless state while sharing a single local repository history.

The Event-Driven Pipeline The software factory operates through event-driven orchestration via OpenCode plugins that ensures quality at every transition. Pipeline progress is tracked in explicit persisted state rather than inferred from session title text:

1. Triage: A Planner Agent analyzes GitHub issues, uses built-in tools like glob and grep to identify target code areas, and generates a .md plan file.
2. Implementation: Specialized minions execute tasks within their assigned worktrees, spawned via the OpenCode SDK (`client.session.create()`). In V1, role/tier routing is sourced from explicit tasklist metadata (`execution.role`, `execution.tier`) rather than orchestrator complexity inference.
   - Parser contract: task metadata is read from adjacent markdown comments (`<!-- TASK:... -->` then `<!-- EXECUTION:{...} -->`) in `*_Tasklist.md` files using persisted task traversal context (`taskRef`, `tasklistPath`) as source of truth.
   - Title parsing policy: session/request titles are diagnostic only and are not authoritative routing lookup keys.
   - Missing metadata behavior: emit warning-level routing event and fall back to legacy defaults (`implementation`, `task_routing.default_tier`, `minion`).
   - Unresolvable pools: transition is deterministically blocked with explicit reason logging.
   - Config read failure behavior: if `.opencode/opencode.jsonc` cannot be parsed/read, agent resolution fails closed and emits `task_blocked` reason context.
   - Spec-first enforcement: ambiguous or requirement-heavy requests route through `spec-expert` first, and coding sessions only start after a valid spec handoff marker is written.
   - Spec-handoff continuity: once handoff validates, orchestrator resumes using the pre-resolved execution target (`taskRef`, `role`, `tier`, `agentID`, `skill`) for implementation spawn.
3. Deterministic Gates (The "Black Box"): This is a critical quality intercept. Agents are stripped of native git commands and must call a TypeScript custom tool, submit_implementation(). This tool programmatically runs lints and tests; if they fail, the function intercepts the stack trace and feeds it back to the agent for auto-correction.
4. Review: Upon `session.idle` event, a plugin triggers the Reviewer Agent to analyze the output before posting a Discord notification for human-in-the-loop approval via slash commands (`/approve`, `/party`, `/continue`, `/halt`, `/focus`, `/add-agent`, `/export`) with fail-closed user/role/channel allowlist authorization.
   - Deterministic review runner contract: `/run-review` is intercepted in orchestrator `command.execute.before`, executes `*review` commands (`creview`, `mreview`, `phreview`, future review commands) through the shared review executor, parses cycle markers, and persists round-versioned artifacts to `_bmad-output/cycle-state/reviews/` for auditability and phase-closeout gates.
   - Compatibility contract: direct `/creview`, `/mreview`, and `/phreview` command contracts remain callable and are not blocked by `/run-review` interception.

V1 role/tier families and compatibility:

* planning: `planner-lite` | `planner-pro` (optional pool variants)
* implementation: `minion-lite` | `minion-standard` | `minion-pro`
* review: `reviewer-lite` | `reviewer-pro`
* backward compatibility: if pools or tier IDs are unavailable, deterministic fallback resolves to `planner`, `minion`, `reviewer`.
* fallback chain: requested tier -> `task_routing.default_tier` -> legacy singleton -> blocked state when no configured agent exists.
* fail-closed invariant: unreadable/invalid configured-agent source (`.opencode/opencode.jsonc`) must block deterministically rather than treating all pool IDs as valid.

Orchestration Modes and Controls

The orchestration runtime supports three deterministic operating modes configured in `demonlord.config.json`:

* `off`: disables transitions/spawns/recovery prompts.
* `manual` (default): transitions are explicit operator actions only.
* `auto`: event-driven transitions stay enabled with guardrails.

Operational control is exposed via `/pipeline` commands:

* `/pipeline status [session]`: inspect root/child topology, stage, worktree, and routing.
* `/pipeline advance <triage|implementation|review> [session]`: apply explicit stage transition.
* `/pipeline stop [session]` and `/pipeline off`: halt one pipeline or disable orchestration globally.
* `/pipeline approve [session]`: approve spawn without requiring Discord connectivity.

When slash-command handling is limited by core hook behavior, operators can use local shell control:

* `pipelinectl status [session]`
* `pipelinectl off|on`
* `pipelinectl advance <triage|implementation|review> [session]`
* `pipelinectl approve [session]`
* `pipelinectl stop [session]`

The orchestrator plugin injects deterministic shell context via `shell.env` (`OPENCODE_SESSION_ID`, `OPENCODE_WORKTREE`, `OPENCODE_ORCHESTRATION_STATE`, `OPENCODE_ORCHESTRATION_COMMAND_QUEUE`) and prepends worktree tool paths so `pipelinectl` runs without manual session/worktree copy-paste.

Discord command-center reliability is fixed for this cycle: retries are bounded (`max_attempts=3`) with deterministic backoff (`0ms`, `250ms`, `1000ms`) and no jitter, dedupe retention remains in-memory TTL (`10m`), and startup validation fails fast when required Discord env/config keys are absent.

V1 constrained parallel dispatch and visibility:

* Stage model remains `triage -> implementation -> review`.
* Implementation tasks may run in controlled parallel only when `execution.depends_on` is satisfied.
* Scheduler enforces `orchestration.parallelism.max_parallel_total`, `orchestration.parallelism.max_parallel_by_role`, and `orchestration.parallelism.max_parallel_by_tier`.
* Queue behavior is deterministic FIFO within the same stage/group; capacity shortfalls queue tasks, unresolved dependencies block tasks with explicit reasons.
* Concise machine-readable execution graph events are written to `_bmad-output/execution-graph.ndjson` when enabled.


--------------------------------------------------------------------------------


2. Agent Skills: Reusable Behavior Definitions

Skills represent a paradigm shift from static, bloated prompts to on-demand reusable instructions. By allowing agents to discover and load content only when relevant, the system reduces context window noise and improves task focus.

File System Discovery & Hierarchy OpenCode searches for skills by walking up from the current working directory to the git worktree root, prioritizing local definitions over global overrides.

Scope	Standard Path	Alternative Path (Claude/Agent)
Local (Project)	.opencode/skills/<name>/SKILL.md	.claude/skills/ or .agents/skills/
Global (User)	~/.config/opencode/skills/	~/.claude/skills/ or ~/.agents/skills/

The SKILL.md Specification Every skill must be defined in a SKILL.md file (strictly uppercase). The file must include YAML frontmatter with specific validation rules:

* name (required): 1–64 characters. Must match the directory name.
  * Regex Constraints: Lowercase alphanumeric with single hyphen separators. Must not start/end with - and cannot contain consecutive --.
* description (required): 1–1024 characters. Must be specific enough for the agent to select correctly.

Skill Loading Mechanism OpenCode exposes a "native skill tool" to the agent. At session start, the agent sees an <available_skills> section containing only names and descriptions. The agent does not see the full instruction content until it explicitly calls the tool. If the skill tool is disabled in the agent configuration, this section is omitted entirely.


--------------------------------------------------------------------------------


3. Custom Tool Implementation & Schema Design

Custom tools are the primary bridge between LLM reasoning and the local system. They provide the mechanism for agents to perform domain-specific actions—like database migrations or semantic routing—with strict type-safety.

The tool() Helper & Type-Safe Definitions Tools are authored in TypeScript/JavaScript using the tool() helper from "@opencode-ai/plugin" and Zod for schema validation.

* Naming Convention: The filename (e.g., db.ts) becomes the tool name.
* Multiple Tools per File: Exporting multiple functions results in a <filename>_<exportname> convention (e.g., math.ts exporting add creates the math_add tool).
* Precedence: Custom tools override built-in tools of the same name.

Context Awareness Every tool receives a context object, ensuring environmental integrity across parallel sessions:

* context.directory: Identifies the session’s current working directory.
* context.worktree: Provides the root of the active git worktree.

Review tooling convention: review commands should emit deterministic `CYCLE_*_RESULT` markers, and automation should route through `run_review.ts` so marker payloads are persisted as JSON artifacts before downstream orchestration decisions.

Cross-Language Execution Patterns While definitions are TypeScript, the logic can be in any language. The Bun.$ utility facilitates this by invoking external scripts (e.g., Python) and handling the asynchronous output.


--------------------------------------------------------------------------------


4. The Plugin Ecosystem & Event Lifecycle

Plugins extend the event-driven architecture of OpenCode, allowing for deterministic intervention in a probabilistic LLM flow. A plugin is a module that exports functions which return event hooks.

Plugin Structure & Loading Order To enforce enterprise-level governance, the system follows a 4-stage hierarchy:

1. Global Config (~/.config/opencode/opencode.json)
2. Project Config (opencode.jsonc)
3. Global Plugin Directory (~/.config/opencode/plugins/)
4. Project Plugin Directory (.opencode/plugins/)

Event Subscription Reference Plugins can subscribe to various lifecycle events:

* Command/Tool: command.executed, tool.execute.before, tool.execute.after.
* File/LSP: file.edited, lsp.client.diagnostics.
* Session: session.created, session.idle, experimental.session.compacting.

Strategic Significance of Compaction: The experimental.session.compacting event is fired before the LLM generates a continuation summary. This allows developers to inject "knowledge anchors"—domain-specific context or state—ensuring that critical information is not lost during context window reduction.

Dependency Management By placing a package.json in the .opencode/ directory, OpenCode automatically triggers bun install at startup, managing all local plugin and custom tool dependencies.


--------------------------------------------------------------------------------


5. Model Context Protocol (MCP) & The Dual-Mode Matchmaker

MCP provides a standardized, local-first interface for external tools. This ensures sensitive data remains within the local environment while granting agents access to external documentation.

Local vs. Remote Configuration Defined in opencode.jsonc, MCP servers allow for flexible capability extension:

Field	Local MCP	Remote MCP
type	"local"	"remote"
command	Required (Array for process start)	N/A
url	N/A	Required (HTTP/SSE endpoint)
headers	Optional	Optional

The Dual-Mode Matchmaker Tool
To avoid heavy Python/ML dependencies natively, semantic knowledge base and agent routing are handled by a custom .opencode/tools/matchmaker.ts tool.
* Mode 1 (LLM Routing): Uses a fast, inexpensive LLM via the OpenCode SDK to read the SKILL.md keys and dynamically match them to task requirements.
* Mode 2 (Local Embeddings): For fully offline semantic search, utilizing lightweight Node-based vector engines (e.g., voy-search) to embed and query available skills.
* Heuristic weighting: `## Routing Hints` sections are weighted above general skill body text to improve deterministic routing.
* Exclusions: routing can explicitly exclude skills (for example, selecting a non-spec implementation skill after spec handoff).

Authentication Flows OpenCode supports Dynamic Client Registration (RFC 7591). If a remote server returns a 401, the system initiates an OAuth flow. Credentials and tokens are stored securely in ~/.local/share/opencode/mcp-auth.json.


--------------------------------------------------------------------------------


6. Programmatic Control: The OpenCode SDK

The OpenCode SDK is a type-safe client generated from OpenAPI specifications, providing programmatic control over agents and sessions. It is fundamentally used by the Discord Plugin to enable two-way conversation and slash-command orchestration.

Client Initialization Patterns

* Full Instance: Starts both server and client (configurable via hostname, port, timeout).
* Client Only: Connects to an existing instance via baseUrl.

Key API Reference Categories

* Sessions:
  * session.prompt: Allows plugins to send context or commands directly to an active session (e.g., client.session.prompt({ body: { text: "/approve" } })). Supports outputFormat for JSON and the noReply: true option.
  * session.create: Used by the Orchestrator to programmatically spawn a minion agent in an isolated worktree directory.
  * session.command: Used by orchestration control plugins to execute deterministic slash-command flows (`/pipeline status`, `/pipeline advance`, `/pipeline stop`, `/pipeline off`, `/pipeline approve`).
* Files: Provides find.symbols and find.text. Searches support a limit parameter (1–200) to optimize performance and context usage.
* TUI: Control the terminal UI via tui.showToast or tui.appendPrompt.

Structured Output Engineering The SDK enforces json_schema for validated agent responses. Developers can specify a retryCount (default 2); if validation fails after retries, the SDK throws a StructuredOutputError. Precise property descriptions in the schema are essential for guiding the LLM toward reliable extraction.


--------------------------------------------------------------------------------


7. Governance: Permissions, Configuration, and Security

Governance ensures that autonomous agents operate within safety boundaries, preventing unauthorized file access or execution in an enterprise environment. Agents are defined natively in opencode.jsonc.

The Permission Matrix Permissions are evaluated based on patterns in the opencode.jsonc:

Permission	Behavior
allow	Access granted immediately.
deny	Access rejected; tool/skill is hidden from the agent.
ask	System pauses for manual user approval.

Strategic Wildcards: Using wildcards like internal-* allows for broad security policies. By explicitly setting "bash": { "git push": "deny" } in the global configuration, the factory forces agents to use the custom submit_implementation deterministic gate tool.

Override Hierarchy & Troubleshooting Security follows a strict path: Global Config -> Agent Config in opencode.jsonc. For troubleshooting grounding issues, engineers should utilize this checklist:

1. Case Sensitivity: Confirm SKILL.md is all caps.
2. Naming Collisions: Ensure skill names are unique across local and global paths.
3. Hidden Files: Ensure .opencode and .agents are not ignored by the system's file watcher.
4. Frontmatter: Verify both name and description are present and valid (regex-compliant).

By combining deterministic workflow gates with granular permissions and type-safe tools, OpenCode provides a robust, production-grade environment for autonomous software engineering.

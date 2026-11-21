# Delegates

A standalone Pi extension that runs configurable subagents for research, code review, coding, and verified PR delivery. It is separate from Pi's example `subagent` extension.

## Install

```sh
pi install git:github.com/stephenchestnut/delegates
```

Restart Pi or run `/reload`, then use `/delegates config` to check that it loaded. To try the package from a local checkout, run `pi install "$PWD"` from the repo root instead. To update the Git install, run `pi update git:github.com/stephenchestnut/delegates`.

Delegates runs on macOS and Linux. Use a current Pi with codemode, structured tool results, and nested tool hooks (tested with Pi 1.6.0). Git is required for installation from Git and for clone workspaces. `gh` and GitHub authentication are required for GitHub PR review and delivery. If the default models aren't available in your Pi setup, use `/delegates models` to select models or inherit the current session model.

**Host execution only.** A clone is not a sandbox. `runtime: "container"` is not supported; neither are worktrees, microVMs, detached execution across Pi shutdown, or automatic merging.

## Profiles

| Profile | Workspace | Runtime | Tool policy | Delegation | Completion |
| --- | --- | --- | --- | --- | --- |
| `thinker` | Caller workspace | Host | Read-only | None | Research report |
| `thinktank` | Caller workspace | Host | Read-only | Thinkers | Synthesized research report |
| `worker` | Caller workspace | Host | Read/write | Thinkers | Changes and report |
| `prmanager` | Private clone | Host | Read/write | Workers and thinkers | Verified PR |
| `crmanager` | Private clone | Host | Read-only | None | Code review report |

A worker launched by a prmanager shares **the prmanager's clone**, never the original checkout. One coding worker owns writes in a shared workspace at a time; its caller must yield writes until it finishes. Independent prmanagers can run concurrently in independent clones. Thinkers can research concurrently, but may observe files changing unless asked to review a finalized candidate.

Models are configurable per profile. Thinker, thinktank, prmanager, and crmanager default to `openai-codex/gpt-6.1-sol:high`; worker uses `openai-codex/gpt-6-luna:medium`. These are preferences, not a hard-coded model-strength ordering. Exact `provider/model` IDs, an optional thinking suffix, and `inherit` are supported. Inherited nested models use the caller delegate's resolved model.

## Migrate from the dotfiles installation

Install the Git package, then remove the old `~/.pi/agent/extensions/delegates` symlink before restarting or reloading Pi. If you use `PI_CODING_AGENT_DIR`, check its `extensions/` directory instead. Confirm the link points to the dotfiles copy before unlinking it. If you configured that copy directly in Pi's settings, remove its path there instead. Skip the old delegates installer in dotfiles setup so it doesn't recreate the link. Disable any earlier dotfiles `subagents` installation as well, but leave unrelated extensions alone.

Keep your existing `delegates` settings and jobs. Legacy `subagents` preferences are read without writing settings; run `/delegates migrate` to translate supported settings and create a backup. `delegates` settings take precedence when both namespaces exist. Unsafe shell allowlists, worker recursion, old clone-root settings, and implicit publication permission are **not** migrated.

### Renaming `manager` to `prmanager`

Use **`prmanager`** for new delegation calls. Existing `delegates.profiles.manager` settings and `extends: "manager"` / `role: "manager"` references are read as `prmanager`; explicitly configured `prmanager` values win when both names exist. `/delegates migrate` also handles this rename even if there is no old `subagents` namespace. Reading settings does not rewrite them.

Historical manager jobs are normalized on read and can be continued using `profile: "prmanager"`. Their frozen verification/publication policy is preserved. The old `manager` name is not exposed as a launch-tool alias.

### Old → new interface

| Old | New |
| --- | --- |
| `thinker_subagent` | `delegate` with profile `thinker` |
| `worker_subagent` | `delegate` with profile `worker` |
| `thinker_parallel` | `delegate_parallel` with thinker tasks |
| `/branch-worker` | Ask the agent to use `delegate` with profile `prmanager` |
| `/worker`, `/thinker` | Ask the agent to use the corresponding profile |
| `/subagents-models` | `/delegates models` |
| `/branch-workers` | `/delegates list` |
| `/branch-worker-cancel <id>` | `/delegates cancel <id>` |

Names remain required, normalized, 1–60 characters, with control characters rejected. A new clone uses `delegates/<name-slug>-<short-job-id>` (for example `delegates/shared-transcript-pager-f96660e4`). Names with no letters or numbers use `job` as the slug. Continuing a job keeps its original branch, even if the display name changes. Job IDs are UUIDs. Old transcript entries remain historical data; the new extension does not replay them or restore old in-memory jobs.

## Tools and codemode

### Single task

```json
{
  "profile": "thinker",
  "name": "auth-review",
  "task": "Trace authentication and identify likely failure points. Cite files."
}
```

Pass this to `delegate`. Optional invocation fields:

- `model`: exact model reference or `inherit`.
- `base`: committed Git reference for a new clone. By default the parent must be clean. An explicit base intentionally excludes dirty changes and reports that fact.
- `continue`: existing clone job ID to revise. Supply its original profile, a name, and the new task. Only the top-level caller can continue retained jobs.

### Read-only code review with a crmanager

Install [pi-review](https://github.com/earendil-works/pi-review) with `pi install git:github.com/earendil-works/pi-review`. Delegates locates the standard Git installation in the Pi agent directory. For a different installation, set `delegates.reviewExtension` to the absolute path of its `review.ts` in **user** settings.

```js
const result = await tools.delegate({
  profile: "crmanager",
  name: "review feature",
  base: "feature",
  task: "/review branch main\nFocus on error handling and missing tests.",
});
text(result.success ? result.summary : result.error);
```

Start the task with one of these commands, followed by optional review focus on separate lines:

| Command | What it reviews |
| --- | --- |
| `/review commit REF` | One commit, resolved locally from a SHA or ref |
| `/review branch BASE` | The selected head (caller HEAD by default; set `base` to another local ref) against its merge base with BASE |
| `/review pr NUMBER_OR_URL` | A GitHub PR in the checkout's `origin` repository; fetches the identified head and base into the clone without publishing |
| `/review uncommitted` | A snapshot of staged, unstaged, and nonignored untracked files; ignored files are not copied |

The harness prepares the review snapshot, then runs pi-review's command in the headless child. The reviewer gets file-reading tools and a bounded, read-only diff tool. It has no Bash, edit, write, nested delegates, extra extension tools, or delivery tools. Project setup and tests do not run. The caller gets prioritized findings and recommendations in `summary`, not code changes, PR comments, or pushes. Start a fresh job for re-review; inspect or discard old clones as usual.

### Research coordination with a thinktank

```js
const report = await tools.delegate({
  profile: "thinktank",
  name: "cat-breed-history",
  task: "Use multiple thinkers to research Siamese, Persian, Maine Coon, and Abyssinian breed histories. Use web search, distinguish documented history from legends, and synthesize a comparison with source URLs."
});
text(report.summary);
```

Thinktanks have read-only tools plus `delegate`/`delegate_parallel`, restricted to thinker children. They cannot start workers, prmanagers, crmanagers, or other thinktanks, and cannot call verification/submission tools. Ordinary thinkers still cannot delegate.

No clone, clean checkout, Git repository, test/lint configuration, or publication authorization is required. Completion is a report, not a commit or PR. Thinktanks use top-level concurrency slots, not the leaf `maxThinkers` budget; their thinkers share the usual bounded thinker budget. Cancellation stops and joins the research children.

Web search still requires an **approved search extension** in `delegates.extensions` (see below). Selecting thinktank does not automatically inherit the parent's tools or grant network access. Without configured web tools, it reports that limitation rather than inventing sources.

### Parallel tasks

```js
const results = await tools.delegate_parallel({
  tasks: [
    { profile: "thinker", name: "security", task: "Review authentication security." },
    { profile: "thinker", name: "tests", task: "Review authentication test coverage." }
  ]
});
text(results.map(r => ({ name: r.name, success: r.success, summary: r.summary })));
```

Parallel prmanagers get separate clones based on **one pinned commit**. Results preserve input order and successful siblings survive a failed task. Invalid task schemas fail before launching the batch. A batch cannot contain multiple writable shared-workspace workers or continuation jobs. Use prmanagers or a candidate-only prmanager profile for parallel coding.

Use `delegate_parallel` rather than independent `delegate` calls when you need a shared base snapshot. Separate calls through `Promise.allSettled` are supported but are not a common-base batch.

### Structured results

Results include `id`, `name`, `profile`, `model`, `success`, `execution`, `summary`, `error`, `workspace`, `verification`, `delivery`, `usage`, `changedFiles`, and `logDir`. Some fields are absent when not applicable. `changedFiles` is a workspace snapshot, **not attribution of individual edits** in a shared checkout; clones are compared against their starting commit.

Launch/argument/authorization failures may reject the call. Once a job is established, execution and delivery failures are generally returned as structured unsuccessful results. **A resolved promise is not proof of success.** Check `success` and the component statuses.

Both launch tools are directly callable and callable from codemode, including `codemode.mode: "only"`. Child Pi processes explicitly load their own codemode. Children can reach only tools permitted by their profile; hiding a declaration is not treated as authorization. Thinker codemode cannot write or delegate. Thinktank codemode can call thinkers and approved research tools, but cannot write or publish. Worker codemode can delegate to thinkers; prmanager codemode can delegate to workers/thinkers and call delivery tools. Crmanager codemode can read the prepared review diff and inspect files, but cannot edit or publish.

Always `await` delegate calls. Ending a codemode script or reaching its deadline cancels outstanding calls; avoid short generic script deadlines around long prmanager tasks. Pi disallows a script directly starting another codemode script, but **parent codemode → delegate subprocess → child codemode** is supported and covered by a real-Pi smoke test.

Codemode's separate classifier/image `models` API remains available under Pi's normal credential/network/cost behavior. This extension does not claim to impose separate per-model network restrictions or a strict dollar cap on that API.

## Configuration

User settings: `<agent-dir>/settings.json`. Trusted project defaults: `<cwd>/.pi/settings.json`. Configuration is resolved and copied at launch, so an agent changing project configuration cannot weaken the running job's policy.

```json
{
  "delegates": {
    "version": 1,
    "profiles": {
      "thinker": { "model": "inherit" },
      "thinktank": { "model": "inherit" },
      "worker": { "model": "inherit" },
      "prmanager": { "model": "inherit", "timeoutMs": 1800000 },
      "experiment": {
        "extends": "prmanager",
        "delivery": "candidate"
      }
    },
    "maxParallel": 3,
    "maxThinkers": 6,
    "maxSubmissions": 3,
    "maxOutputBytes": 50000,
    "maxTaskBytes": 100000,
    "showStatusWidget": true,
    "display": "compact"
  }
}
```

Custom profiles extend one of the five built-in roles. Allowed fields: `role`, `model`, `workspace`, `runtime`, `permissions`, `delegation`, `timeoutMs`, `delivery`; `extends` is used only in configuration. Roles impose ceilings: thinkers are shared/read-only and cannot delegate; thinktanks are shared/read-only and may delegate only to thinkers; workers may delegate only to thinkers; prmanagers require a writable clone and cannot spawn prmanagers; crmanagers require a read-only clone and cannot delegate. You can narrow capabilities, not evade these ceilings through a custom name.

`workspace` is `shared` or `clone`; `runtime` currently must be `host`. Only prmanagers have `candidate` or `pr` delivery. Other roles use `none`. Arrays replace rather than concatenate. Unknown fields and unsupported combinations fail clearly.

Project settings cannot configure executable extension loading or authorize publication. They cannot increase user concurrency/output/task/submission budgets, broaden delegation or read-only permissions, increase profile timeouts, replace required user checks, or broaden an explicit user file scope. Prmanager and crmanager default to 30 minutes; the other roles default to 10 minutes.

### Project environment

Configure required checks explicitly; the extension does not guess them from a model report:

```json
{
  "delegates": {
    "environment": {
      "setup": [
        { "name": "dependencies", "command": "npm ci", "timeoutMs": 600000 }
      ],
      "checks": [
        { "name": "lint", "command": "npm run lint", "timeoutMs": 120000 },
        { "name": "tests", "command": "npm test", "timeoutMs": 600000 }
      ],
      "allowedPaths": ["src/", "tests/", "package.json", "package-lock.json"]
    }
  }
}
```

Commands run in the preserved caller subdirectory. Setup runs once for a new clone; continuation does not rerun setup. Setup that changes tracked/nonignored candidate content stops the job for inspection rather than silently adding those changes. Local execution, dependency caches, ports, and external services are **not isolated** by a clone.

`allowedPaths` is optional: exact repo-relative file names or directory prefixes ending in `/`. If omitted, any nonignored file within the clone may enter the candidate; review changes and use `.gitignore` for secrets/artifacts. An empty list permits no changed paths. Paths outside an explicit scope block submission. Git symlinks are committed as links; submodules/nested Git repositories are rejected for managed delivery.

If there truly are no automated checks, configure `environment.exemption` with an explicit reason. An empty check list alone is blocked. Checks that auto-fix source produce **stale** verification; inspect and verify again. Verification fingerprints the tracked/nonignored Git candidate tree, not ignored dependencies, databases, or the complete host environment. All configured local checks are required; supplementary checks can be run by the agent separately.

### GitHub authorization (user scope only)

```json
{
  "delegates": {
    "publication": {
      "repository": "OWNER/REPO",
      "remote": "origin",
      "baseBranch": "main",
      "requiredChecks": ["lint", "test"],
      "ciTimeoutMs": 600000,
      "allowUnpublishedBase": false
    }
  }
}
```

This is explicit permission for prmanager jobs to publish branches/PRs to that repository. Only github.com, same-repository branches are supported currently; fork PRs and GitHub Enterprise are not. The clone remote must match the authorized repository. Embedded credentials in HTTP remote URLs are rejected. Git credentials/identity and `gh` authentication must already work non-interactively.

`requiredChecks` must be explicit. Use `[]` to require no remote checks, while still requiring the local policy. Named remote checks are inspected for the exact submitted SHA; missing/pending checks are not green, and skipped/neutral/failing checks are failures. Concurrent systems using the same check name can be ambiguous; use unique check names.

Without authorization, a prmanager using PR delivery stops before implementation. Use `experiment`/candidate delivery for local-only alternatives. Publication also blocks when the starting commit is not contained in the target base branch, unless the user explicitly enables `allowUnpublishedBase`; this prevents accidentally including unrelated local commits.

### Approved tools and provider extensions

Children do **not** inherit every installed extension or MCP server. Built-in tools plus delegates/codemode load explicitly. To enable trusted research/provider integrations:

```json
{
  "delegates": {
    "extensions": [
      { "path": "npm:pi-web-search", "tools": ["web_search"], "readOnly": true },
      { "path": "/absolute/path/custom-provider.ts", "tools": [], "readOnly": true }
    ]
  }
}
```

Paths can use Pi's explicit extension/package syntax. Custom providers must also be registered in the parent so model references can be validated before launch. Review these extensions: `readOnly` is your assertion about trusted extension behavior, not proof. Unknown/missing tool registrations fail closed in children. MCP servers are disabled in child processes. A trusted Bash sandbox extension may be explicitly loaded for writable profiles; thinkers and thinktanks never receive Bash. The implementation does not rely on registration order between competing Bash overrides to establish thinker policy.

## PR manager delivery workflow

1. Prepare the owned clone and execute trusted setup.
2. Implement directly or through a worker; use thinkers for research.
3. Call `delegate_verify({})`. Fix failures and rerun.
4. Call `delegate_submit({ summary, acceptanceNotes, limitations })`.
5. Inspect delivery status. Repair CI failures, verify, and resubmit within the attempt budget.
6. Return the final report, candidate SHA, and PR URL. Do not edit after successful submission.

Submission takes exclusive workspace ownership, checks scope and final verification, commits locally, and—only for an authorized PR workflow—pushes the assigned branch, finds/creates/updates its PR, and checks CI. Git hooks and commit signing are disabled for managed Git operations; put required checks in the verification policy. Git identity still uses normal configuration. Pushes are never forced. The original checkout is not modified or merged.

There is no automatic commit/push when an agent exits, fails, is cancelled, or Pi shuts down. A successful process exit without required delivery is an unsuccessful prmanager result. No-change work is reported explicitly, not as a fabricated PR. A lost PR-creation response is retried by repository/head/base lookup rather than duplicate creation.

Execution, verification, and delivery are separate states. `candidate-ready` is local-only success; `delivered` means the configured PR contract passed; `pr-open` can still mean CI failed. Cancellation does not roll back an existing push/PR. Changes after finalization invalidate success.

## Commands, state, and recovery

- `/delegates config`: effective configuration.
- `/delegates models`: select a profile/model interactively, with settings backup.
- `/delegates list`: persisted job results, including interrupted runs.
- `/delegates inspect <id>`: result, status, workspace and log references.
- `/delegates cancel <id>`: cancel a job running in this session and its attached descendants.
- `/delegates recover <id>`: clear a dead owner's lease and mark unfinished execution interrupted. Refuses to steal from a live process.
- `/delegates discard <id>`: confirm deletion of an inactive owned clone. Retains result/log records; never deletes remote branches/PRs.
- `/delegates migrate`: explicitly migrate legacy settings with a backup.

Continue using `delegate({ profile, name, task, continue: "job-id" })`. This starts a fresh agent context in the same retained clone with the **original frozen check policy**, recorded commit/PR, and a fresh bounded attempt budget. Current publication authorization must still match. Continuation refuses changed HEAD/branch/remote identities rather than resetting or discarding work. If interrupted between committing and recording the commit, inspect/reconcile the retained repository manually; the extension fails closed rather than guessing ownership.

Jobs live in `<agent-dir>/delegates/jobs/<uuid>/` with `job.json`, logs, and an owned `workspace/` for clones. Leases prevent concurrent continuation/discard of the same job across sessions. There is no background daemon or automatic restart/republish. Reload/shutdown cancels tracked work. A crash may leave a lease requiring explicit recovery. A retained `running` manifest with no owner is not evidence that work remains active.

Attached jobs and subprocess trees are supervised with bounded termination escalation. Deliberately daemonized processes and unrelated host processes are outside this guarantee. Locks coordinate known delegates within one coordinator; they do not prevent unrelated Pi sessions or host programs from editing a shared checkout. Empty/failed workspaces are retained conservatively; cleanup is explicit in this release.

## Running display

The default `delegates.display: "compact"` shows task names at the end, with useful activity, elapsed time, and children grouped underneath their parent:

```text
Delegates
● [thinktank] · Coordinating · 3 turns · 20k tok · 2/4 finished · 42s · Cat breed history
  ✓ [thinker] · Done · 2 turns · 12k tok · 12s · Siamese
  ● [thinker] · Searching · 3 turns · 15k tok · 18s · Persian
  ✓ [thinker] · Done · 2 turns · 10k tok · 15s · Maine Coon
  ● [thinker] · Running · 1 turns · 8k tok · 11s · Abyssinian
```

The **text of profile labels** is colored: thinker blue, thinktank purple, worker gold, prmanager orange, and crmanager teal, with light/dark variants. Custom profiles inherit their resolved role's color in the live display. Status symbols/text independently use theme colors: active accent, success green, warning amber, failure red, and cancellation/interruption muted. Task names stay neutral. No colored-circle emoji or decorative badges are added.

- Thinkers, thinktanks, crmanagers, and ordinary workers do not show irrelevant `not-run` / `not-requested` placeholders. PR workflows show meaningful phases such as `Verifying`, `Publishing`, and `Waiting for CI`.
- Specific activity labels come from observed tools, not guessed model behavior. Children running means `Coordinating`, not necessarily an idle parent. `2/4 finished` counts the children launched so far; failed/cancelled children get explicit counts instead.
- Compact rows include the delegate's own turns and estimated context tokens rounded to the nearest thousand (e.g. `12k tok`) where space permits; model and full IDs remain hidden. Duplicate sibling/root names get a short ID suffix for distinction, **not** an abbreviation accepted by commands.
- `delegates.display: "detailed"` adds ID/model, self and final subtree turns, and context estimate as space permits. `?` means unknown; older manifests without self usage never treat aggregate turns as self turns.
- Context is Pi's per-child `getContextUsage()` estimate, not cumulative token usage or a sum across descendants. It is sampled at turn boundaries and after compaction, can lag during streaming/tools, and may be unknown after compaction or if telemetry fails. A completed/history row shows the last available snapshot, not a live measurement; continuation starts fresh. The displayed token count is rounded to the nearest thousand; the context window is not shown. Narrow terminals may hide metadata; errors take precedence.
- The widget is bounded to eight lines. Active/problem jobs take priority over completed successes, parents remain attached to visible children, and an overflow line counts omitted jobs. Names and optional metadata shorten at narrow widths instead of wrapping arbitrarily. Errors take priority over diagnostic metadata.
- Completed children remain available while their parent runs. The completed tree remains visible for about five seconds, then leaves the widget; results and history remain. Continuation has a fresh display run, so previous children are not counted again.
- Tool progress is scoped to that invocation/batch and its descendants. The global widget shows the session's current/recent jobs. `/delegates list` provides readable history with full UUIDs; `/delegates inspect <full-id>` retains full JSON evidence. Structured tool results are unchanged even when their human presentation is compact.
- The TUI-only clock redraws at most once per second and never writes manifests, adds transcript messages, or increments usage. JSON/print/RPC use plain progress without a widget timer. `showStatusWidget: false` still hides the widget.
- Theme changes are reflected on rendering. `NO_COLOR` disables styling; `TERM=dumb` uses plain status symbols/separators. Color and symbols are never the sole indication of status.

Profile palettes are selected for dark/light appearance, while status colors follow the active theme. Custom terminal palettes and 256-color approximations may vary; the profile labels and explicit status text remain authoritative. Expanded tool results and inspect output retain fields omitted by compact rendering.

## Agent-facing guidance

The top-level tools carry concise profile-selection and concurrency instructions plus namespace documentation discoverable through codemode. Each child receives profile-specific instructions generated from resolved capabilities. Thinktanks receive research decomposition, source evaluation, and synthesis guidance. PR managers additionally receive verification/submission and honest-completion requirements. Agents do not need to discover and read this README before using the extension.

## Security boundaries

- A clone isolates source files/Git metadata, **not operating-system authority**.
- Thinker, thinktank, and crmanager read-only behavior is a tool-level allowlist with direct/nested-call checks, not an OS sandbox. Trusted extensions still execute as your user.
- Host workers/prmanagers have shell access and can access paths, credentials, Keychain helpers, and network services available to your user. Central publication tools provide reliability, not a security boundary against a malicious same-user agent.
- The private control socket and per-job tokens coordinate jobs; they do not protect against unrestricted code running as the same user.
- Job logs contain model/tool output and may contain sensitive project data. Protect the agent directory; no log redaction can guarantee removal of secrets emitted by arbitrary tools.
- Future container execution must run the whole child Pi process inside the boundary. Mounting only Bash into Docker is not equivalent. No container support is implied by the runtime interface.

## Development and validation

The extension entry point is `src/index.ts`; tests live in `tests/`. Run these commands from the repo root with Node 26. The deterministic tests use temporary repositories, local bare remotes, fake Pi children, and a stubbed `gh`. They do not use your credentials or publish anything:

```sh
npm test
```

Opt in to the real-Pi package and codemode smoke tests. They use an isolated Pi configuration and a local fake OpenAI-compatible SSE server (no paid model requests):

```sh
PI_DELEGATES_TEST_PI="$(command -v pi)" npm test
```

Type checking resolves Pi's supplied types from its installed distribution rather than bundling another runtime copy:

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run typecheck
```

Use `PI_DELEGATES_PI_ROOT` for a non-managed Pi package directory, or `PI_DELEGATES_TSC` for an existing `typescript/bin/tsc`. Pi supplies all runtime dependencies; there is no separate build or npm install step for users.

Real GitHub acceptance testing remains an explicit manual step in a disposable repository: authorize it, configure checks, exercise successful delivery and failed-CI repair, inspect retry behavior, and remove the test PR/branch deliberately. It is never run by the default test suite.

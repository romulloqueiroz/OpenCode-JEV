# OpenCode JEV

An evaluator-optimizer harness for OpenCode. Choose your usual generation model,
ask for code, and let JEV critique private drafts before the selected result
reaches your files and main conversation.

```text
Your request → private draft → JEV evaluation → revision → evaluation
                                                        ↓
                                       apply selected edits + final answer
```

This is an external review loop, not a change to the model's internal reasoning.
Both proposed file edits and code snippets returned in chat are evaluated.

## Quick start

Requirements: OpenCode, Python 3.10+, and a Typesafe API key for JEV. Tests require
Node.js 22.18+ (it runs the TypeScript sources directly). There are no runtime
dependencies; OpenCode loads the TypeScript plugin without a build step. Tested with OpenCode
1.18.32; experimental hooks may change in later versions.

Clone this repository, then add its absolute entry-point path to your coding
project's `opencode.json`. Merge with any existing plugin list:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-jev/index.ts"]
}
```

1. Set `TYPESAFE_API_KEY` in the OpenCode process environment or your coding
   project's `.env` file. See [.env.example](.env.example).
2. Restart OpenCode in that project. The plugin installs **jev** as the default
   agent. Select it explicitly if an existing session still has Build selected.
3. Select your generation model normally and send your request. No separate
   optimization command or manual feedback step is needed.

The worker inherits your selected model and OpenCode provider credentials. JEV
uses its separately pinned judge model. Build and Plan remain available, but
their turns do not use this harness. Set `enabled: false` in the configuration
below and restart OpenCode to disable it.

Keep the clone in place: TypeScript modules and the Python bridge load relative
to its entry point. Inside this repository, `.opencode/plugins/jev.ts` loads the
plugin automatically; do not also add it to a plugin list.

## How it works

First, JEV answers one yes/no question: does your latest message need code
written or changed? If not (an explanation, a plan, a question, small talk), the
worker answers once, with read-only access to the project, and there is no
grading loop. Code requests, including code snippets, go through the loop below.
If this check fails, the turn fails; it never falls back to an ungraded answer.

For code, before the visible agent starts generating its response, a private child session
first lists 1–8 specific checks the task requires, favoring edge and error cases
(for example, "an empty list returns 0"). The list is fixed for the whole run. JEV grades each check yes/no
alongside the general rubric, so when it is unsure, the feedback names the checks
it doubts instead of only a probability. A malformed checklist goes back to the
worker, like a malformed draft. The same session then drafts the answer. The worker explores the project itself with read-only tools
(`read`, `grep`, `glob`), so large repositories work: only what it opens is sent
to the model. It returns an answer plus proposed changes, usually as exact
search/replace edits. The harness applies those edits in memory and sends JEV the
changed files, the files the worker read, and the answer.

A draft that cannot be used (invalid JSON, or a search text that does not match
exactly once) goes back to the worker with the error, up to twice per round,
without spending a JEV evaluation.

JEV's feedback goes back to that same worker and selected model. The controller
retains the best evaluated candidate and rejects revisions with detected
regressions or incomplete comparisons. It stops when the rubric is satisfied,
the revision budget expires, progress stalls, or a candidate repeats.

JEV returns probabilities, not explanations. When it is unsure but every check
passed, the worker lists up to 8 specific defects it suspects in its draft, and
JEV judges whether each is real. Those judged likely real (probability at least
0.5) are named in the feedback. If JEV confirms none, the loop stops rather than
revising with nothing specific to fix.

Only then does it apply the selected candidate's files. The plugin writes the
reply you see itself: the selected answer verbatim, changed files, unresolved
findings, and JEV's verdict. The visible model is only asked to acknowledge and
never sees or retells the result. Drafts and critique stay out of the main
conversation; progress appears through OpenCode notifications. Private child sessions and local audit files still contain drafts,
so “private” does not mean erased or inaccessible.

The default budget allows three revisions after the first draft, up to four
evaluations. An unresolved candidate can still be selected when the budget is
exhausted; the final result reports that status. Evaluator or generation failures
stop publication. Cancellation stops the worker and evaluator. If you edit a file
the draft changes while refinement runs, nothing is published, so your work is
never overwritten.

## Current scope

The worker can read and search the project but **cannot write files, run shell
commands or tests, install dependencies, browse the web, or delegate**. Every
other tool is denied, as are reads of common secret files (`.env`, keys,
credentials) and paths outside the project. `grep` can still match text inside
files that are not gitignored. The worker must return a JSON draft, which the
controller validates. Tool calls count toward `maxWorkerSteps`; on its last step
OpenCode asks the worker to answer without tools.

Editable files are defined in `opencode-jev/workspace.ts`. Hidden paths, symlinks,
common secret filenames, lockfiles, OpenCode configuration, and common
dependency/build directories cannot be changed or sent to JEV. Binary changes are
unsupported. This filter does not implement `.gitignore` or scan file contents for
secrets.
Conversation context includes the last 12 nonempty user/assistant text messages,
up to 100,000 characters; image inputs and tool output are not supplied.

The task and the files the worker reads are sent to your generation provider; the
task, changed files, and files read are sent to the Typesafe evaluation API.
Additional drafting and evaluation calls add latency and cost; the visible
acknowledgement is one short call. JEV judges source; it does not execute it or prove it correct.
Run your project's normal checks after changes.

## Configuration and records

Optionally create `opencode-jev.json` in the project you open in OpenCode. Restart
OpenCode after changing it. Defaults:

```json
{
  "enabled": true,
  "python": "python3",
  "maxRevisions": 3,
  "maxStalls": 2,
  "timeout": 60,
  "generationTimeout": 300,
  "maxWorkerSteps": 30,
  "codeThreshold": 0.5,
  "maxSourceBytes": 200000
}
```

`timeout` limits each evaluator process in seconds, including API retries.
`generationTimeout` limits each private worker request, including its tool calls.
`maxWorkerSteps` caps model calls per worker request (1–200). `codeThreshold`
is how sure JEV must be that a message needs code before the loop runs (0–1);
lower it if code requests get answered directly, and set it to `0` to always run
the loop. `maxSourceBytes`
caps each draft and the bundle sent to JEV (maximum 2 MB); changed files must fit,
and files the worker read are included until the cap is reached. Project size is
not limited. `maxRevisions: 0` evaluates only the initial draft.

The bridge supplies a general rubric for requirements, behavior, interfaces,
unnecessary computation, and maintainability. Optionally set `rubricFile` to an
evaluator-compatible JSON rubric; it is held fixed throughout the run. The
standalone evaluator's detailed regex-engine example can be exported with:

```sh
python3 jev_evaluate.py --export-rubric --output regex-rubric.json
```

Use `"rubricFile": "regex-rubric.json"` only for a matching regex-engine task.

Each evaluated draft, full report, promotion decision, worker session ID, and
selected model is saved under `.opencode/jev/runs/<run-id>/`. These records
contain submitted source and task text. Keep `.env` and `.opencode/jev/` out of
version control in projects where you install the plugin.

## Verification

Offline unit tests require no credentials or dependency installation:

```sh
npm test
```

The optional integration test runs an installed OpenCode server with local mock
generation and JEV responses:

```sh
npm run test:smoke
```

It needs localhost listening permissions. OpenCode may install its own plugin
support package on first startup. No paid inference endpoints are used. The test
checks private draft/revision routing, read-only worker tools and a real `read`
call, search/replace edits, unchanged files during evaluation, the selected model,
chat-only code, the verbatim final reply, parent cancellation, and publication
without feedback turns in the main chat.
These tests verify control flow, not real-model quality gains or rubric calibration.

## Implementation

- `index.ts`: public OpenCode plugin entry point.
- `opencode-jev/plugin.ts`: agent configuration and pre-generation interception.
- `opencode-jev/harness.ts`: private generation, evaluation, and selection loop.
- `opencode-jev/workspace.ts`: draft validation, search/replace edits, evaluator context, and file publication.
- `opencode-jev/io.ts`: configuration and cancellable evaluator subprocess.
- `opencode_jev_bridge.py`: JSON adapter to the existing evaluator.
- `jev_evaluate.py`: judge request, validation, rubrics, and comparison logic.

References: [OpenCode plugins](https://opencode.ai/docs/plugins/),
[agents](https://opencode.ai/docs/agents/), and the
[1.18.32 generation loop](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/session/prompt.ts).

## Contributing

Run `npm install`, `npm run typecheck`, and `npm test` before submitting changes. Keep ordinary tests independent of
credentials and paid services. Include regression coverage for changes to
cancellation, publication, stopping rules, or evaluation comparisons.

## License

[MIT](LICENSE).

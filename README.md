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
Node.js 20.3+. There are no extra runtime dependencies. Tested with OpenCode
1.18.32; experimental hooks may change in later versions.

Clone this repository, then add its absolute entry-point path to your coding
project's `opencode.json`. Merge with any existing plugin list:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-jev/index.mjs"]
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

Keep the clone in place: JavaScript modules and the Python bridge load relative
to its entry point. Inside this repository, `.opencode/plugins/jev.js` loads the
plugin automatically; do not also add it to a plugin list.

## How it works

Before the visible agent starts generating its response, the harness takes a
snapshot of eligible project files, including uncommitted edits. A private child
session generates an answer and proposed complete file contents. Those edits
stay in memory while JEV reviews the candidate against the task and rubric.

JEV's feedback goes back to that same worker and selected model. The controller
retains the best evaluated candidate and rejects revisions with detected
regressions or incomplete comparisons. It stops when the rubric is satisfied,
the revision budget expires, progress stalls, or a candidate repeats.

Only then does it apply the selected candidate's files. The main agent receives
the selected answer and review status and presents them to you. Drafts and
critique stay out of the main conversation; progress appears through OpenCode
notifications. Private child sessions and local audit files still contain drafts,
so “private” does not mean erased or inaccessible.

The default budget allows three revisions after the first draft, up to four
evaluations. An unresolved candidate can still be selected when the budget is
exhausted; the final result reports that status. Evaluator or generation failures
stop publication. Cancellation stops the worker and evaluator. Changes to source
files during refinement block publication to avoid overwriting your work.

## Current scope

The worker receives a bounded text snapshot and returns structured proposals.
It **does not run shell commands, tests, install dependencies, or browse the
repository with tools**. This version suits contained coding tasks and snippets;
it is not a replacement for every capability of OpenCode's Build agent.

The worker must return a JSON draft, which the controller validates. The final
presentation is another call to the selected model, instructed to reproduce
selected code unchanged. The controller applies evaluated file contents
directly; chat presentation is still model-generated.

Eligible text files are defined in `opencode-jev/workspace.mjs`. Hidden paths,
symlinks, common secret filenames, lockfiles, OpenCode configuration, and common
dependency/build directories are excluded. Binary changes are unsupported. This
filter does not implement `.gitignore` or scan file contents for secrets.
Conversation context includes the last 12 nonempty user/assistant text messages,
up to 100,000 characters; image inputs and tool output are not supplied.

The task and eligible project text are sent to your generation provider and the
Typesafe evaluation API. Additional drafting, evaluation, and presentation calls
add latency and cost. JEV judges source; it does not execute it or prove it correct.
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
  "maxSourceBytes": 200000
}
```

`timeout` limits each evaluator process in seconds, including API retries.
`generationTimeout` limits each private worker request. `maxSourceBytes` caps
the UTF-8 project snapshot and the candidate-plus-context bundle. Oversized
projects fail explicitly; open a smaller project directory or increase the cap
(maximum 2 MB). `maxRevisions: 0` evaluates only the initial draft.

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
checks private draft/revision routing, unchanged files during evaluation, the
selected model, chat-only code, parent cancellation, and final publication without
feedback turns in the main chat.
These tests verify control flow, not real-model quality gains or rubric calibration.

## Implementation

- `index.mjs`: public OpenCode plugin entry point.
- `opencode-jev/plugin.mjs`: agent configuration and pre-generation interception.
- `opencode-jev/harness.mjs`: private generation, evaluation, and selection loop.
- `opencode-jev/workspace.mjs`: context snapshots and selected file publication.
- `opencode-jev/io.mjs`: configuration and cancellable evaluator subprocess.
- `opencode_jev_bridge.py`: JSON adapter to the existing evaluator.
- `jev_evaluate.py`: judge request, validation, rubrics, and comparison logic.

References: [OpenCode plugins](https://opencode.ai/docs/plugins/),
[agents](https://opencode.ai/docs/agents/), and the
[1.18.32 generation loop](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/session/prompt.ts).

## Contributing

Run `npm test` before submitting changes. Keep ordinary tests independent of
credentials and paid services. Include regression coverage for changes to
cancellation, publication, stopping rules, or evaluation comparisons.

## License

[MIT](LICENSE).

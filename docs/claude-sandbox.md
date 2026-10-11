# Claude Code traffic sandbox

Run the repository's actual Claude Code CLI against a fake Anthropic API to
inspect requests and test how scripted responses change its output, tool use,
retries, and OAuth refresh behavior. The default suite needs no real account
or model API. Optional live runs capture real replies for offline comparison.

## Download and replay a dashboard session

Open an account's Claude terminal in the dashboard and use it normally.
**Show traffic** displays API request and response headers and bodies as they
arrive. Wait for the current answer to finish, then choose **Download session**
to save `claude-session-<id>.jsonl`.

Run the downloaded responses through the isolated real CLI and generate a
comparison automatically:

```sh
bun run test:claude --replay ~/Downloads/claude-session-SESSION_ID.jsonl
```

The artifact directory includes `comparison.md` and `comparison.json`, comparing
the recorded requests with the fresh CLI's requests, tool results, authentication,
session stability, and output. Original terminal output is unavailable in a
traffic download; the report labels text extracted from the last API response.

This replays API responses in order into a fresh scratch workspace. It does not
restore the original conversation, files, settings, or tools. The test CLI only
has `Read`; calls for other tools or unavailable files can produce different
results. Use `--prompt "..."` to choose the scratch session's initial prompt.
Multi-prompt recordings may contain responses that a single scratch turn never
consumes. Request differences remain visible in the report.

Dashboard recording captures traffic sent to the API base URL; OAuth endpoints
on separate hosts are outside that capture. Credentials are redacted, while
prompts, replies, and file contents remain in the download. Capture limits are
2 MiB per body, 20 MiB per session, and 200 exchanges. The replay loader rejects
entries marked incomplete or truncated. Dashboard capture uses the normal
account terminal; Docker isolation applies to the test runs described below.

Dashboard capture is off by default. Turn on **Record API traffic** in the
account terminal to enable it; switching it restarts Claude, and the choice is
not remembered. While on, the terminal's `ANTHROPIC_BASE_URL` points at a local
recorder, so Claude Code treats the session as using a custom API URL: optional
features selected by first-party hostname checks can differ, and its telemetry
reports the custom base URL. The recorder opens a fresh upstream connection per
request so recorded accounts never share one. The Docker sandbox preserves the
standard hostnames instead.

Captures persist under `data/terminal-traffic/` by default, next to the configured
database when `DB_PATH` changes its directory. Set `TERMINAL_TRAFFIC_DIR` to
choose another location. Snapshots and downloads require dashboard authentication
and remain available after the terminal exits.

## Run the tests

The host needs Bun, Docker with a running Linux-container daemon, and `tar`.
Run from the repository root:

```sh
bun run test:claude
```

The command builds an image with the locked dependencies, runs the tests, and
prints an artifact directory under `data/claude-sandbox/`. Image and dependency
downloads can access the network during the build. The test container runs
with external networking disabled.

Select a scenario and route, or change the fake assistant's final answer:

```sh
bun run test:claude --scenario text --route direct --text "Hello from the fake API"
bun run test:claude --scenario tool --route both
bun run test:claude --scenario refresh --route direct
bun run test:claude --scenario overload --route cc-lb
bun run test:claude --help
```

`--route direct` connects the CLI to the fake API. `--route cc-lb` puts the real
cc-lb proxy handler between message requests and the fake API. Profile and
refresh requests still reach the fake service directly. `--route both` runs
separate fresh sessions through both paths.

The default suite has ten cases: all seven scenarios directly, plus `text`,
`tool`, and `overload` through cc-lb. `--scenario all --route cc-lb` runs those
three cc-lb cases. A named scenario can also be selected explicitly for either
route.

- `text`: return a scripted assistant message.
- `tool`: return a `Read` tool call and inspect the next request for the real
  contents of a disposable fixture file.
- `refresh`: start with expired synthetic credentials, issue a replacement
  token, and check that the CLI saves and uses it.
- `unauthorized`: reject the first message with HTTP 401.
- `rate-limit`: reject the first message with HTTP 429.
- `overload`: reject the first message with HTTP 529.
- `truncated-stream`: end the first SSE response before its completion events.

The direct error scenarios exercise CLI recovery. cc-lb can consume or
transform upstream errors: for example, its own overload retry can turn two
upstream requests into one successful client exchange. Inspect both traffic
files when comparing the paths.

## Edit and replay responses

For an automated comparison of real replies and modified replies:

```sh
bun run test:claude --compare
```

This runs a live baseline asking Claude to read `fixture.txt`, replays the
recorded responses offline, then changes the first recorded `Read` call to
read `alternate.txt` and runs another replay. The files contain different
markers. The resulting `comparison.md` and `comparison.json` show the changed
tool history and follow-up request contents, together with any other request
differences. The command fails clearly if the live model never emits a complete
streamed `Read` call.

Live mode uses the host's `ANTHROPIC_BASE_URL` (default
`https://api.anthropic.com`) and either `ANTHROPIC_AUTH_TOKEN` or
`ANTHROPIC_API_KEY`. The host forwards only messages requests, so the baseline
makes real model calls. Credentials stay on the host; the CLI container still
has external networking disabled. All three CLI runs keep synthetic seeded
OAuth credentials and a fake profile; the live baseline does not test real
OAuth login or token validation. To record a live run without the automated
mutation, use:

```sh
bun run test:claude --live --prompt "Read fixture.txt and reply briefly."
```

To change other response details, edit a captured JSONL file and pass it with
`--replay`. The loader also accepts a JSON array of exchanges or response-only
fixtures with `responseStatus`, `responseHeaders`, and `responseBody`. Only
`POST /v1/messages` responses are replayed. SSE bodies remain strings containing
the full event sequence. After the last supplied response, another request
fails with an explicit replay-exhausted error. Response-only fixture files
produce a report of replay behavior with original-request comparison marked
unavailable.

Interactive interception is also available:

```sh
bun run test:claude --interactive
```

The command prints the exact container name and inspection/reply commands.
Once the CLI is waiting for a response, use another terminal:

```sh
docker exec CONTAINER bun tests/claude-sandbox/control.ts pending > reply.json
# Edit responseStatus, responseHeaders, or responseBody in reply.json; keep id.
docker exec -i CONTAINER bun tests/claude-sandbox/control.ts reply < reply.json
```

`pending` returns the oldest waiting exchange, or `null`. `reply` accepts that
full JSON object and applies only its response fields. Invalid replies leave
the request pending so it can be corrected. Each pending reply has a ten-minute
deadline. Combine `--replay FILE --interactive` to edit recorded responses as
they are delivered. OAuth/profile responses remain synthetic.

Use `--no-build` to reuse an already-built image and `--output DIRECTORY` to
choose the artifact location. The comparison lists exactly which dynamic IDs
and credential values were normalized; system prompts and environment text
are compared verbatim. Later assistant replies in a mutated replay still come
from the recording, so changed tool results demonstrate changed CLI requests,
not how a live model would reason about the altered input.

## Inspect artifacts

Each run contains `summary.json`, `artifacts.tar.gz`, and a directory for each
case, such as `direct-tool/` or `cc-lb-overload/`. The command exits nonzero if
a selected test fails. A setup failure can produce `error.json` instead of a
complete summary.

Each case records:

- `client.jsonl`: HTTP exchanges at the CLI-facing endpoint, with request and
  response headers, bodies, status, URL, and timestamp.
- `upstream.jsonl`: exchanges handled by the fake service. On the cc-lb path,
  message requests contain the proxy's rewritten identity and bearer token.
- `cli.stdout.jsonl`, `cli.stderr.txt`, and `cli-debug.txt`: real CLI output
  and debug diagnostics.
- `auth-status.json` and `auth-stderr.txt`: the CLI's own assessment of its
  seeded login state.
- `result.json`: the checks that passed and any failure.
- `cc-lb-requests.json`: cc-lb request logs, when that route is used.

Replay runs add `comparison.md` and `comparison.json`. `--compare` produces
`live/`, `replay/`, and `mutated/` run directories plus a combined comparison and
`mutated-responses.json`. Live runs also save `live-upstream.jsonl`, recording
the real API exchange with host authentication headers redacted.

Bodies include the full assembled SSE event text. These are application-level
HTTP captures, not packet traces: TLS records, HTTP/2 framing, exact TCP chunk
boundaries, and per-token timing are not reproduced. Exchange records are
written when their response finishes, so file order can differ from request
start order when requests overlap. Unhandled routes remain visible as errors.

## Isolation and OAuth scope

The container runs as an unprivileged user with a read-only root filesystem,
dropped capabilities, no published ports, no host directory mounts, and limits
on memory, CPU, process count, and temporary storage. The CLI receives an
explicit environment and fresh configuration/workspace directories. Its only
enabled test tool is `Read`. Host Claude credentials and API keys are not
passed into the container.

Known API hosts resolve to loopback inside the container. A temporary test
certificate is trusted only by the processes in that container; the host's
trust store is unchanged. The CLI keeps its normal API and OAuth hostnames so
tests can exercise the first-party authentication path without a custom
`ANTHROPIC_BASE_URL` changing feature selection.

The session fixture supplies a synthetic saved OAuth login and profile, with
the onboarding version taken from the installed Claude Code package. The CLI
can fetch the fake profile and refresh the fake token. The suite does not run
browser authorization, obtain real tokens, or test the full login flow.

The offline server returns scripted or recorded responses. These experiments
test the CLI and proxy's response to API messages; they do not measure a live
model's reasoning or prove compatibility with every Anthropic endpoint. Nonessential
traffic is disabled, external connections cannot leave the container, and
unsupported optional endpoints may still appear as errors in the captures.

## Files to change

`tests/claude-sandbox/server.ts` implements the fake API and response scenarios.
`fixtures.ts` defines synthetic session/profile data. `run.ts` starts the CLI,
captures traffic, and checks the scenarios. `experiments.ts` implements replay
and interception; `control.ts` supplies the terminal commands; `compare.ts`
mutates captures and writes reports. `scripts/claude-sandbox.ts` builds and runs
the container, forwards optional live calls, and extracts the artifacts.

# AgentPerch: v1 specification

## Goal

See at a glance, from the GNOME top bar, which agent session is working, has
finished, or is waiting for an answer, without going back to the terminal.

## Out of scope for v1

- Subscription quotas and monetary cost
- Resuming a closed session, selecting a terminal tab
- Answering permission prompts from the panel
- Tools other than Claude Code
- Publishing on extensions.gnome.org
- Logo

## Data model

Each adapter produces sessions in a common format:

```text
session
├── source        "claude-code"
├── key           stable identifier of a process (pid + starttime)
├── sessionId, pid, procStart, kind, cwd, name
├── state         working | waiting | background | done | idle | unknown
├── rawStatus     source value, kept for diagnostics
├── waitingFor    reason for waiting, when known
└── startedAt, statusSince
```

## State sources

`~/.claude/sessions/<pid>.json`: undocumented format, observed on Claude Code
2.1.317 by driving a real session.

| `status` | `waitingFor` | Observed situation | State |
|---|---|---|---|
| `busy` | | The model is working, including a foreground command | `working` |
| `waiting` | `permission prompt` | Permission prompt (Bash, Write) | `waiting` |
| `waiting` | `input needed` | Question (`AskUserQuestion`) | `waiting` |
| `shell` | | Turn finished, a command is still running in the background | `background` |
| `idle` | | Nothing in progress | `idle` |
| other | | Not observed | `unknown`, raw value shown |

`done` is not a source value: AgentPerch derives it when an active session becomes
`idle`, until the user closes its menu, goes to its terminal or starts a new prompt.

`claude agents --json` is the documented way to list sessions, and `scripts/doctor.sh`
uses it to detect drift. AgentPerch does not poll it: starting a process every few
seconds costs more than reading files, and its output has no `procStart`, and no
`shell` value according to its documentation.

Claude Code hooks remain an option if the format changes, or to tell "has
finished" from "has not done anything yet". They are no longer needed to detect a
permission prompt.

## Subagents and tokens

`~/.claude/projects/<transformed cwd>/`:

- `<sessionId>.jsonl`: `message.usage` and `message.model` on `assistant` lines. The
  same `message.id` repeats on several lines and counts once.
- `<sessionId>/subagents/agent-*.meta.json`: `agentType`, `description`, `finished`,
  `stoppedByUser`. `finished` is absent while running, then `true`.
- `<sessionId>/subagents/agent-*.jsonl`: same usage format.

A subagent is running if it is neither finished nor stopped by the user, and its
transcript was modified since the process started: old files never have `finished`.

"Current context" adds up the input tokens of the last message. There is no
percentage, because the context window size does not appear in these files.

## Design rules

- No blocking I/O: the code runs in the GNOME Shell process.
- A dead session is detected by its PID and `starttime`, never by the mere presence
  of a file.
- `disable()` removes all icons, GLib sources and monitors.
- The extension never opens the `.key` files in `~/.claude/sessions/`, or Claude
  Code's credentials.
- Transcripts hold the conversations: they are read only with a menu open and the
  token option on, incrementally, and only the numbers and the model are kept.
- Subagent `.meta.json` files are read continuously when the subagent option is on.
  Their `description` is task text, kept in memory and displayed.
- Notifications are opt-in, and wait 3 s so auto-approved prompts stay silent.
- The terminal window is found through the process tree. With a single-process
  terminal server the window is a best guess, and the tab stays unknown.
- One icon per session or a single icon, as chosen. Subagents are a badge, not icons.

## Open questions

1. Should sessions of other agents use a hook bridge? Their state is only documented
   through hooks, which means changing each tool's configuration.
2. Should sessions of a `kind` other than `interactive` appear?
3. Does `pidDomain` have a role for sessions started in a container?
4. Do the display delay and the space taken in the bar suit daily use?

# AgentPerch: v1 specification

## Goal

See at a glance, from the GNOME top bar, which agent session is working, has
finished, or is waiting for an answer, without going back to the terminal.

## Out of scope for v1

- Subscription quotas and monetary cost
- Going back to the terminal, resuming a session
- Answering permission prompts from the panel
- Tools other than Claude Code
- Publishing on extensions.gnome.org
- Logo, notifications

## Data model

Each adapter produces sessions in a common format:

```text
session
├── source        "claude-code"
├── key           stable identifier of a process (pid + starttime)
├── sessionId, pid, procStart, kind, cwd, name
├── state         working | waiting | background | idle | unknown
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
- One icon per session or a single icon, as chosen. Subagents are a badge, not icons.

## Open questions

1. How to tell "has finished" from "has not done anything yet"? `idle` covers both.
2. Should sessions of a `kind` other than `interactive` appear?
3. Does `pidDomain` have a role for sessions started in a container?
4. Do the display delay and the space taken in the bar suit daily use?

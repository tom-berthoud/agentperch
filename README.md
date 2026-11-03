# AgentPerch

A GNOME Shell extension that shows your Claude Code sessions in the top bar: which
one is working, which one is done, and which one is waiting for you.

![AgentPerch in the top bar: a session works, waits for permission, runs a background task, then finishes](docs/demo.gif)

**Status: early.** Claude Code only, GNOME Shell 50 and 51.

> AgentPerch is an independent project, not affiliated with or endorsed by
> Anthropic. It reads Claude Code's internal files (`~/.claude/sessions/` and
> `~/.claude/projects/`). Their format is undocumented and can change with any
> Claude Code release. Values were observed on Claude Code 2.1.317. An unrecognized
> status shows as a yellow question mark instead of breaking. Claude and Claude Code
> are trademarks of Anthropic.

| Icon | Meaning | Source `status` |
|---|---|---|
| Orange warning sign | Waiting for you: a permission prompt or a question | `waiting` |
| Blue dots | Working | `busy` |
| Light blue gear | Turn finished, a background command is still running | `shell` |
| Green envelope | Finished since you last closed its menu | `idle` after activity |
| Gray check | Idle | `idle` |
| Yellow question mark | Unrecognized status, raw value shown in the menu | anything else |

## Features

- One icon per session, or a single icon showing the most urgent state, with a count
  when there are several sessions.
- **Go to terminal** in the menu brings the session's window to the front. It cannot
  select the tab, and it finds no window for a session inside `tmux` or across a
  sandbox such as a Flatpak terminal, because the window is found through the process
  tree.
- Optional notification when a session keeps waiting for you (off by default).
- A `+n` badge for running subagents.
- In the menu: state and duration, folder, model, current context size, cumulative
  tokens, and the list of subagents.
- Session names always, only when a session needs you, or never.

The envelope clears when you close its menu, go to its terminal or start a new prompt.
AgentPerch cannot know whether you saw the terminal itself, and forgets the envelope
when GNOME Shell restarts.

Options are in the extension preferences:

```bash
gnome-extensions prefs agentperch@tom-berthoud.github.io
```

## Privacy

Everything stays on your machine: the extension makes no network requests.

Session transcripts contain your conversations. AgentPerch reads them only while a
menu is open, and only if token usage is enabled. It keeps token counts and the
model name, never message content.

With subagents enabled, it also reads their metadata files every few seconds, even
with menus closed, and checks the modification time of their transcripts without
opening them. Subagent descriptions are task text written by the model: they stay
in memory and appear in the menu.

The `.key` files in `~/.claude/sessions/` and Claude Code's credentials are never
opened.

## Install

Download the zip from the [latest release](https://github.com/tom-berthoud/agentperch/releases/latest), then:

```bash
gnome-extensions install --force agentperch@tom-berthoud.github.io.shell-extension.zip
```

On Wayland, log out and back in, then:

```bash
gnome-extensions enable agentperch@tom-berthoud.github.io
```

## Install from source

```bash
git clone https://github.com/tom-berthoud/agentperch.git
cd agentperch
./scripts/dev.sh link
```

Run `link` again after pulling, as it compiles the settings schema.

On Wayland, GNOME Shell only detects a new extension or new code after you log out
and back in. Then:

```bash
gnome-extensions enable agentperch@tom-berthoud.github.io
```

The code runs inside the GNOME Shell process, so a serious bug can affect your
session. To follow the logs:

```bash
journalctl --user -f -o cat /usr/bin/gnome-shell
```

## Reporting a problem

```bash
./scripts/doctor.sh
```

It compares Claude Code's real files with what AgentPerch expects, and prints only
versions, field names and status values, so its output can go in an issue.

## Tests

Unit tests:

```bash
./scripts/dev.sh test
```

Integration test, in an isolated headless GNOME Shell with its own `HOME`, D-Bus
bus and fake sessions (needs `jq`):

```bash
./scripts/dev.sh check
```

The same test in a Fedora container, to try another GNOME version (needs `podman`):

```bash
./scripts/container-check.sh 45
```

## License

[MIT](LICENSE)

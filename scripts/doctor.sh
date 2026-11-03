#!/usr/bin/env bash
# Prints what a bug report needs, and compares Claude Code's real files with what
# AgentPerch expects. Shows versions, field names and status values only: never paths,
# session names or conversation content, so the output is safe to paste in an issue.
set -uo pipefail

UUID="agentperch@tom-berthoud.github.io"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SESSIONS="$CLAUDE_DIR/sessions"
EXPECTED_FIELDS=(pid sessionId procStart status cwd startedAt statusUpdatedAt)
KNOWN_STATUSES=(busy waiting shell idle)
problems=0

problem() { echo "PROBLEM: $1"; problems=$((problems + 1)); }

command -v jq > /dev/null || { echo "This script needs jq."; exit 1; }

echo "== Versions"
gnome-shell --version 2>/dev/null || echo "GNOME Shell not found"
claude --version 2>/dev/null || echo "Claude Code not found on PATH"
echo "Session type: ${XDG_SESSION_TYPE:-unknown}"

echo; echo "== Extension"
if info="$(gnome-extensions info "$UUID" 2>/dev/null)"; then
    grep -E 'Version|Enabled|State' <<< "$info"
else
    problem "extension not installed"
fi

echo; echo "== Configuration directory"
# The extension sees the environment of GNOME Shell, not the one of a shell startup file.
shell_pid="$(pgrep -xo gnome-shell || true)"
shell_config=""
if [[ -n "$shell_pid" ]]; then
    shell_config="$(tr '\0' '\n' < "/proc/$shell_pid/environ" 2>/dev/null | sed -n 's/^CLAUDE_CONFIG_DIR=//p')"
fi
if [[ "${CLAUDE_CONFIG_DIR:-}" != "$shell_config" ]]; then
    problem "CLAUDE_CONFIG_DIR differs between this terminal and GNOME Shell, so the extension looks elsewhere"
else
    echo "Same in this terminal and in GNOME Shell"
fi

echo; echo "== Session files"
shopt -s nullglob
files=("$SESSIONS"/*.json)
echo "Session files: ${#files[@]}"
if [[ ! -d "$SESSIONS" ]]; then
    problem "no sessions directory: Claude Code may have moved it, or never ran"
fi

for file in "${files[@]}"; do
    for field in "${EXPECTED_FIELDS[@]}"; do
        if ! jq -e --arg f "$field" 'has($f)' "$file" > /dev/null 2>&1; then
            problem "a session file has no \"$field\" field"
        fi
    done
    status="$(jq -r '.status // "missing"' "$file" 2>/dev/null)"
    case " ${KNOWN_STATUSES[*]} " in
        *" $status "*) echo "status: $status" ;;
        *) problem "unrecognized status: $status" ;;
    esac
done

echo; echo "== Field names found in session files"
if ((${#files[@]} > 0)); then
    jq -r 'keys[]' "${files[@]}" 2>/dev/null | sort -u | paste -sd ' ' -
fi

echo; echo "== Official session list"
# `claude agents --json` is the documented way to read session state. A difference
# with the files means AgentPerch's source may be drifting.
if official="$(timeout 20 claude agents --json 2>/dev/null)"; then
    official_count="$(jq 'length' <<< "$official" 2>/dev/null || echo unknown)"
    echo "Sessions listed: $official_count"
    echo "Fields: $(jq -r '.[0] // {} | keys | join(" ")' <<< "$official" 2>/dev/null)"
    if [[ "$official_count" != "${#files[@]}" ]]; then
        echo "Note: the count differs from the session files (dead or background sessions can explain it)."
    fi
else
    echo "Not available"
fi

echo; echo "== Errors in the GNOME Shell log (this boot)"
journalctl --user -b -o cat /usr/bin/gnome-shell 2>/dev/null \
    | grep -E 'AgentPerch:|agentperch@' \
    | sed -E 's#/[^ ]+#<path>#g' \
    | tail -n 10 \
    || true

echo
if ((problems)); then
    echo "$problems problem(s) found."
    exit 1
fi
echo "No problem found."

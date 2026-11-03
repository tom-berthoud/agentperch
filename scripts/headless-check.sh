#!/usr/bin/env bash
# Integration test: runs a headless GNOME Shell with its own HOME, its own D-Bus bus
# and fake sessions. The desktop session is not touched.
# Internal use: the script restarts itself inside dbus-run-session.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="agentperch@tom-berthoud.github.io"
PROBE_UUID="agentperch-probe@tests.invalid"

if [[ "${1:-}" != "--inner" ]]; then
    WORK="$(mktemp -d "${TMPDIR:-/tmp}/agentperch-headless.XXXXXX")"
    # Short path required: a Unix socket is limited to 108 bytes, which TMPDIR can
    # exceed. mktemp -d creates this directory with mode 700.
    RUNTIME="$(mktemp -d /tmp/apk.XXXXXX)"
    mkdir -p "$WORK/home" "$WORK/probe"
    status=0
    env -u DISPLAY -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS \
        -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u XDG_STATE_HOME \
        HOME="$WORK/home" XDG_RUNTIME_DIR="$RUNTIME" \
        AGENTPERCH_PROBE_DIR="$WORK/probe" WORK="$WORK" \
        dbus-run-session -- "$0" --inner || status=$?
    # Services started by the Shell (portal, gvfs) leave FUSE mounts there.
    fusermount3 -uz "$RUNTIME/doc" 2>/dev/null || true
    fusermount3 -uz "$RUNTIME/gvfs" 2>/dev/null || true
    rm -rf "$RUNTIME" 2>/dev/null || echo "Incomplete cleanup: $RUNTIME"
    echo "Artifacts: $WORK"
    exit "$status"
fi

PROBE="$AGENTPERCH_PROBE_DIR"
SESSIONS="$HOME/.claude/sessions"
EXT_ROOT="$HOME/.local/share/gnome-shell/extensions"
mkdir -p "$SESSIONS" "$EXT_ROOT"
cp -r "$ROOT/extension" "$EXT_ROOT/$UUID"
cp -r "$ROOT/tests/probe" "$EXT_ROOT/$PROBE_UUID"
SCHEMAS="$EXT_ROOT/$UUID/schemas"
glib-compile-schemas "$SCHEMAS"
perch_set() { gsettings --schemadir "$SCHEMAS" set org.gnome.shell.extensions.agentperch "$1" "$2"; }

failures=0
ok()   { echo "ok    $1"; }
fail() { echo "FAIL  $1"; failures=$((failures + 1)); }

SLEEPERS=()
start_sleeper() { sleep 300 & SLEEPERS+=("$!"); LAST_PID=$!; }
proc_start()    { sed 's/.*) //' "/proc/$1/stat" | cut -d' ' -f20; }
write_session() { # pid status name startedAt [waitingFor]
    local tmp="$SESSIONS/.$1.tmp"
    jq -n --argjson pid "$1" --arg status "$2" --arg name "$3" --argjson started "$4" \
        --arg proc "$(proc_start "$1")" --arg cwd "$HOME/projects/$3" --arg waiting "${5:-}" \
        '{pid:$pid,sessionId:("s-"+$name),procStart:$proc,cwd:$cwd,name:$name,kind:"interactive",
          status:$status,startedAt:$started,statusUpdatedAt:(now*1000|floor),messagingSocketPath:"/secret"}
          + (if $waiting == "" then {} else {waitingFor:$waiting} end)' > "$tmp"
    mv "$tmp" "$SESSIONS/$1.json"
}

now_ms=$(($(date +%s) * 1000))
start_sleeper; PID_A=$LAST_PID; write_session "$PID_A" busy planning-backend $((now_ms - 1500000))
start_sleeper; PID_B=$LAST_PID; write_session "$PID_B" idle scanner-3d $((now_ms - 600000))
start_sleeper; PID_C=$LAST_PID; write_session "$PID_C" waiting a-really-long-session-name $((now_ms - 60000)) "permission prompt"
# Transcript and subagent of the first session, in the observed format.
PROJECT="$HOME/.claude/projects/$(sed 's/[^a-zA-Z0-9]/-/g' <<< "$HOME/projects/planning-backend")"
mkdir -p "$PROJECT/s-planning-backend/subagents"
USAGE='{"input_tokens":1000,"cache_creation_input_tokens":500,"cache_read_input_tokens":70000,"output_tokens":2000}'
echo "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"model\":\"claude-test\",\"usage\":$USAGE}}" > "$PROJECT/s-planning-backend.jsonl"
echo "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"id\":\"m2\",\"model\":\"claude-test\",\"usage\":$USAGE}}" > "$PROJECT/s-planning-backend/subagents/agent-a1.jsonl"
echo '{"agentType":"general-purpose","description":"Code review"}' > "$PROJECT/s-planning-backend/subagents/agent-a1.meta.json"
# File of a dead process, as after a crash: must never be shown.
echo '{"pid":2147483646,"sessionId":"ghost","procStart":"1","status":"busy","name":"ghost"}' > "$SESSIONS/2147483646.json"

gsettings set org.gnome.shell enabled-extensions "['$UUID', '$PROBE_UUID']"
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell welcome-dialog-last-shown-version "'999'"

gnome-shell --headless --no-x11 --wayland-display agentperch-test \
    --virtual-monitor 1600x900 > "$WORK/shell.log" 2>&1 &
SHELL_PID=$!

cleanup() {
    kill "$SHELL_PID" 2>/dev/null || true
    wait "$SHELL_PID" 2>/dev/null || true
    kill "${SLEEPERS[@]}" 2>/dev/null || true
}
trap cleanup EXIT

# wait_for <description> <timeout s> <jq expression on state.json>
wait_for() {
    local deadline=$((SECONDS + $2))
    while ((SECONDS < deadline)); do
        if ! kill -0 "$SHELL_PID" 2>/dev/null; then
            fail "$1 (gnome-shell stopped)"
            return 1
        fi
        if [[ -f "$PROBE/state.json" ]] && jq -e "$3" "$PROBE/state.json" > /dev/null 2>&1; then
            ok "$1"
            return 0
        fi
        sleep 0.2
    done
    fail "$1"
    [[ -f "$PROBE/state.json" ]] && jq -c '.' "$PROBE/state.json"
    return 1
}

labels='[.indicators[].label]'

wait_for "three icons, oldest first, without the ghost" 60 \
    "$labels == [\"planning-back… +1\",\"scanner-3d\",\"a-really-long…\"]" || true
wait_for "one icon and one color per state" 5 \
    '[.indicators[].icon] == ["content-loading-symbolic","object-select-symbolic","dialog-warning-symbolic"]
     and (.indicators[0].styleClass | contains("agentperch-working"))
     and (.indicators[1].styleClass | contains("agentperch-idle"))
     and (.indicators[2].styleClass | contains("agentperch-waiting"))' || true
wait_for "the menu shows the waiting reason and the path" 5 \
    '(.indicators[2].menu[1] | contains("Asking for permission"))
     and (.indicators[0].menu[2] == "~/projects/planning-backend")
     and (.indicators[0].menu[4] | contains("claude-code"))' || true
wait_for "a closed menu does not read transcripts" 2 \
    '(.indicators[0].menu | length) == 5' || true

touch "$PROBE/cmd-open-menu"
wait_for "an open menu shows tokens and subagents" 5 \
    '(.indicators[0].menu | index("Current context: 72k tokens")) != null
     and (.indicators[0].menu | index("Total: 2k in · 2k out · 70k cache read")) != null
     and (.indicators[0].menu | index("Subagents: 1 running of 1")) != null
     and (.indicators[0].menu | index("▶ general-purpose — Code review · 4k")) != null' || true
touch "$PROBE/cmd-screenshot"
for _ in $(seq 1 50); do [[ -f "$PROBE/screenshot-done" ]] && break; sleep 0.2; done
if [[ -s "$PROBE/screenshot.png" ]]; then ok "screenshot"; else fail "screenshot"; fi
touch "$PROBE/cmd-close-menu"

write_session "$PID_B" busy scanner-3d $((now_ms - 600000))
wait_for "a status change updates the icon" 3 \
    '.indicators[1].icon == "content-loading-symbolic"' || true
write_session "$PID_B" shell scanner-3d $((now_ms - 600000))
wait_for "shell shows as a background task" 3 \
    '.indicators[1].icon == "system-run-symbolic" and (.indicators[1].menu[1] | contains("Background task"))' || true
write_session "$PID_B" brand-new scanner-3d $((now_ms - 600000))
wait_for "an unknown status stays visible" 3 \
    '.indicators[1].icon == "dialog-question-symbolic" and (.indicators[1].menu[1] | contains("Unknown state (brand-new)"))' || true
write_session "$PID_B" idle scanner-3d $((now_ms - 600000))

perch_set show-session-names false
wait_for "names can be hidden" 5 "$labels == [\"+1\",\"\",\"\"]" || true
perch_set show-subagents false
wait_for "the badge can be hidden" 5 "$labels == [\"\",\"\",\"\"]" || true
perch_set show-session-names true
perch_set show-subagents true

perch_set show-usage false
touch "$PROBE/cmd-open-menu"
wait_for "token option off: subagents listed, no tokens" 5 \
    '(.indicators[0].menu | index("▶ general-purpose — Code review")) != null
     and ([.indicators[0].menu[] | select(contains("context") or contains("Total"))] | length) == 0' || true
touch "$PROBE/cmd-close-menu"
perch_set show-usage true

perch_set display-mode "'single'"
wait_for "a single icon, on the most urgent state" 5 \
    '(.indicators | length) == 1 and .indicators[0].label == "3 +1"
     and .indicators[0].icon == "dialog-warning-symbolic"
     and (.indicators[0].menu | index("a-really-long-session-name — Asking for permission")) != null' || true
touch "$PROBE/cmd-open-menu"
wait_for "the single icon details each session" 5 \
    '(.indicators[0].menu | index("Current context: 72k tokens")) != null' || true
touch "$PROBE/cmd-close-menu"
perch_set display-mode "'per-session'"
wait_for "back to one icon per session" 5 '(.indicators | length) == 3' || true

WAYLAND_DISPLAY=agentperch-test gnome-extensions prefs "$UUID" > "$WORK/prefs.log" 2>&1 || true
wait_for "the preferences window opens" 15 '.windows | any(. == "AgentPerch")' || true

kill -9 "$PID_A"; wait "$PID_A" 2>/dev/null || true
wait_for "a crashed session (file left behind) disappears" 8 \
    "$labels == [\"scanner-3d\",\"a-really-long…\"]" || true

rm "$SESSIONS/$PID_C.json"
wait_for "a deleted session disappears" 3 "$labels == [\"scanner-3d\"]" || true

start_sleeper; PID_D=$LAST_PID; write_session "$PID_D" idle fresh $((now_ms))
wait_for "a new session appears right of older ones" 3 \
    "$labels == [\"scanner-3d\",\"fresh\"]" || true

touch "$PROBE/cmd-disable"
wait_for "disable() removes all icons" 5 '.indicators == [] and (.extensionError // "") == ""' || true
touch "$PROBE/cmd-enable"
wait_for "enable() recreates them" 5 "$labels == [\"scanner-3d\",\"fresh\"]" || true

if grep -E "JS ERROR|AgentPerch:|agentperch@|probe:|already disposed" "$WORK/shell.log" "$WORK/prefs.log"; then
    fail "errors in the Shell log (above)"
else
    ok "no JS errors in the Shell log"
fi

if ((failures)); then
    echo; echo "$failures failure(s)"; exit 1
fi
echo; echo "All integration tests pass"

#!/usr/bin/env bash
# Test d'intégration : lance un GNOME Shell headless avec son propre HOME, son
# propre bus D-Bus et de fausses sessions. La session de bureau n'est pas touchée.
# Usage interne : le script se relance lui-même dans dbus-run-session.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="agentperch@tom-berthoud.github.io"
PROBE_UUID="agentperch-probe@tests.invalid"

if [[ "${1:-}" != "--inner" ]]; then
    WORK="$(mktemp -d "${TMPDIR:-/tmp}/agentperch-headless.XXXXXX")"
    # Chemin court imposé : un socket Unix est limité à 108 octets, ce que TMPDIR
    # peut dépasser. mktemp -d crée ce dossier en mode 700.
    RUNTIME="$(mktemp -d /tmp/apk.XXXXXX)"
    mkdir -p "$WORK/home" "$WORK/probe"
    status=0
    env -u DISPLAY -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS \
        -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u XDG_STATE_HOME \
        HOME="$WORK/home" XDG_RUNTIME_DIR="$RUNTIME" \
        AGENTPERCH_PROBE_DIR="$WORK/probe" WORK="$WORK" \
        dbus-run-session -- "$0" --inner || status=$?
    # Les services lancés par le Shell (portail, gvfs) y laissent des montages FUSE.
    fusermount3 -uz "$RUNTIME/doc" 2>/dev/null || true
    fusermount3 -uz "$RUNTIME/gvfs" 2>/dev/null || true
    rm -rf "$RUNTIME" 2>/dev/null || echo "Nettoyage incomplet : $RUNTIME"
    echo "Artefacts : $WORK"
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
        --arg proc "$(proc_start "$1")" --arg cwd "$HOME/projets/$3" --arg waiting "${5:-}" \
        '{pid:$pid,sessionId:("s-"+$name),procStart:$proc,cwd:$cwd,name:$name,kind:"interactive",
          status:$status,startedAt:$started,statusUpdatedAt:(now*1000|floor),messagingSocketPath:"/secret"}
          + (if $waiting == "" then {} else {waitingFor:$waiting} end)' > "$tmp"
    mv "$tmp" "$SESSIONS/$1.json"
}

now_ms=$(($(date +%s) * 1000))
start_sleeper; PID_A=$LAST_PID; write_session "$PID_A" busy planning-backend $((now_ms - 1500000))
start_sleeper; PID_B=$LAST_PID; write_session "$PID_B" idle scanner-3d $((now_ms - 600000))
start_sleeper; PID_C=$LAST_PID; write_session "$PID_C" waiting un-nom-vraiment-tres-long $((now_ms - 60000)) "permission prompt"
# Transcript et sous-agent de la première session, avec le format observé.
PROJECT="$HOME/.claude/projects/$(sed 's/[^a-zA-Z0-9]/-/g' <<< "$HOME/projets/planning-backend")"
mkdir -p "$PROJECT/s-planning-backend/subagents"
USAGE='{"input_tokens":1000,"cache_creation_input_tokens":500,"cache_read_input_tokens":70000,"output_tokens":2000}'
echo "{\"type\":\"assistant\",\"message\":{\"id\":\"m1\",\"model\":\"claude-test\",\"usage\":$USAGE}}" > "$PROJECT/s-planning-backend.jsonl"
echo "{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"id\":\"m2\",\"model\":\"claude-test\",\"usage\":$USAGE}}" > "$PROJECT/s-planning-backend/subagents/agent-a1.jsonl"
echo '{"agentType":"general-purpose","description":"Relecture du code"}' > "$PROJECT/s-planning-backend/subagents/agent-a1.meta.json"
# Fichier d'un processus mort, comme après un crash : ne doit jamais s'afficher.
echo '{"pid":2147483646,"sessionId":"ghost","procStart":"1","status":"busy","name":"fantome"}' > "$SESSIONS/2147483646.json"

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

# wait_for <description> <délai s> <expression jq sur state.json>
wait_for() {
    local deadline=$((SECONDS + $2))
    while ((SECONDS < deadline)); do
        if ! kill -0 "$SHELL_PID" 2>/dev/null; then
            fail "$1 (gnome-shell s'est arrêté)"
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

wait_for "trois icônes, triées par ancienneté, sans le fantôme" 60 \
    "$labels == [\"planning-back… +1\",\"scanner-3d\",\"un-nom-vraime…\"]" || true
wait_for "une icône et une couleur par état" 5 \
    '[.indicators[].icon] == ["content-loading-symbolic","object-select-symbolic","dialog-warning-symbolic"]
     and (.indicators[0].styleClass | contains("agentperch-working"))
     and (.indicators[1].styleClass | contains("agentperch-idle"))
     and (.indicators[2].styleClass | contains("agentperch-waiting"))' || true
wait_for "le menu affiche la raison de l'attente et le chemin" 5 \
    '(.indicators[2].menu[1] | contains("Demande une permission"))
     and (.indicators[0].menu[2] == "~/projets/planning-backend")
     and (.indicators[0].menu[4] | contains("claude-code"))' || true
wait_for "le menu fermé ne lit pas les transcripts" 2 \
    '(.indicators[0].menu | length) == 5' || true

touch "$PROBE/cmd-open-menu"
wait_for "le menu ouvert montre tokens et sous-agents" 5 \
    '(.indicators[0].menu | index("Contexte actuel : 72 k tokens")) != null
     and (.indicators[0].menu | index("Cumul : 2 k en entrée · 2 k en sortie · 70 k lus en cache")) != null
     and (.indicators[0].menu | index("Sous-agents : 1 actif(s) sur 1")) != null
     and (.indicators[0].menu | index("▶ general-purpose — Relecture du code · 4 k")) != null' || true
touch "$PROBE/cmd-screenshot"
for _ in $(seq 1 50); do [[ -f "$PROBE/screenshot-done" ]] && break; sleep 0.2; done
if [[ -s "$PROBE/screenshot.png" ]]; then ok "capture d'écran"; else fail "capture d'écran"; fi
touch "$PROBE/cmd-close-menu"

write_session "$PID_B" busy scanner-3d $((now_ms - 600000))
wait_for "un changement de statut met l'icône à jour" 3 \
    '.indicators[1].icon == "content-loading-symbolic"' || true
write_session "$PID_B" shell scanner-3d $((now_ms - 600000))
wait_for "shell s'affiche comme tâche de fond" 3 \
    '.indicators[1].icon == "system-run-symbolic" and (.indicators[1].menu[1] | contains("Tâche de fond"))' || true
write_session "$PID_B" nouveau scanner-3d $((now_ms - 600000))
wait_for "un statut inconnu reste visible" 3 \
    '.indicators[1].icon == "dialog-question-symbolic" and (.indicators[1].menu[1] | contains("État inconnu (nouveau)"))' || true
write_session "$PID_B" idle scanner-3d $((now_ms - 600000))

perch_set show-session-names false
wait_for "les noms peuvent être masqués" 5 "$labels == [\"+1\",\"\",\"\"]" || true
perch_set show-subagents false
wait_for "le badge peut être masqué" 5 "$labels == [\"\",\"\",\"\"]" || true
perch_set show-session-names true
perch_set show-subagents true

perch_set show-usage false
touch "$PROBE/cmd-open-menu"
wait_for "option tokens coupée : sous-agents listés, sans aucun token" 5 \
    '(.indicators[0].menu | index("▶ general-purpose — Relecture du code")) != null
     and ([.indicators[0].menu[] | select(contains("Contexte") or contains("Cumul"))] | length) == 0' || true
touch "$PROBE/cmd-close-menu"
perch_set show-usage true

perch_set display-mode "'single'"
wait_for "une seule icône, sur l'état le plus urgent" 5 \
    '(.indicators | length) == 1 and .indicators[0].label == "3 +1"
     and .indicators[0].icon == "dialog-warning-symbolic"
     and (.indicators[0].menu | index("un-nom-vraiment-tres-long — Demande une permission")) != null' || true
touch "$PROBE/cmd-open-menu"
wait_for "l'icône unique détaille chaque session" 5 \
    '(.indicators[0].menu | index("Contexte actuel : 72 k tokens")) != null' || true
touch "$PROBE/cmd-close-menu"
perch_set display-mode "'per-session'"
wait_for "retour à une icône par session" 5 '(.indicators | length) == 3' || true

WAYLAND_DISPLAY=agentperch-test gnome-extensions prefs "$UUID" > "$WORK/prefs.log" 2>&1 || true
wait_for "la fenêtre de préférences s'ouvre" 15 '.windows | any(. == "AgentPerch")' || true

kill -9 "$PID_A"; wait "$PID_A" 2>/dev/null || true
wait_for "une session crashée (fichier restant) disparaît" 8 \
    "$labels == [\"scanner-3d\",\"un-nom-vraime…\"]" || true

rm "$SESSIONS/$PID_C.json"
wait_for "une session supprimée disparaît" 3 "$labels == [\"scanner-3d\"]" || true

start_sleeper; PID_D=$LAST_PID; write_session "$PID_D" idle nouvelle $((now_ms))
wait_for "une nouvelle session apparaît à droite des anciennes" 3 \
    "$labels == [\"scanner-3d\",\"nouvelle\"]" || true

touch "$PROBE/cmd-disable"
wait_for "disable() retire toutes les icônes" 5 '.indicators == [] and (.extensionError // "") == ""' || true
touch "$PROBE/cmd-enable"
wait_for "enable() les recrée" 5 "$labels == [\"scanner-3d\",\"nouvelle\"]" || true

if grep -E "JS ERROR|AgentPerch:|agentperch@|probe:|already disposed" "$WORK/shell.log" "$WORK/prefs.log"; then
    fail "erreurs dans le journal du Shell (ci-dessus)"
else
    ok "aucune erreur JS dans le journal du Shell"
fi

if ((failures)); then
    echo; echo "$failures échec(s)"; exit 1
fi
echo; echo "Tous les tests d'intégration passent"

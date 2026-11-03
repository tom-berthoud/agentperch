#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="agentperch@tom-berthoud.github.io"
TARGET="$HOME/.local/share/gnome-shell/extensions/$UUID"

case "${1:-}" in
    test)
        gjs -m "$ROOT/tests/model.test.js"
        ;;
    check)
        "$ROOT/scripts/headless-check.sh"
        ;;
    link)
        if [[ -e "$TARGET" && ! -L "$TARGET" ]]; then
            echo "$TARGET exists and is not a link: nothing was changed." >&2
            exit 1
        fi
        glib-compile-schemas "$ROOT/extension/schemas"
        mkdir -p "$(dirname "$TARGET")"
        ln -sfn "$ROOT/extension" "$TARGET"
        echo "Link created. On Wayland, log out and back in, then:"
        echo "  gnome-extensions enable $UUID"
        ;;
    unlink)
        gnome-extensions disable "$UUID" 2>/dev/null || true
        if [[ -L "$TARGET" ]]; then
            rm "$TARGET"
        elif [[ -e "$TARGET" ]]; then
            echo "$TARGET is not a link: nothing was removed." >&2
            exit 1
        fi
        ;;
    pack)
        mkdir -p "$ROOT/dist"
        gnome-extensions pack "$ROOT/extension" --extra-source=lib --extra-source=../LICENSE --force --out-dir="$ROOT/dist"
        ;;
    *)
        echo "Usage: $0 {test|check|link|unlink|pack}" >&2
        exit 2
        ;;
esac

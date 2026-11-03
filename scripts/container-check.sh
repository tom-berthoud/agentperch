#!/usr/bin/env bash
# Runs the integration test in a Fedora container, to try GNOME versions this machine
# does not have. Usage: scripts/container-check.sh <fedora release>
#
# The copy under test declares the container's GNOME version, so this answers "does
# it work there?". Only then should that version go into metadata.json.
#
# The container runs systemd because GNOME Shell needs a system bus and logind.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE="${1:?Usage: $0 <fedora release>}"
NAME="agentperch-check-$RELEASE"

podman run -d --rm --replace --name "$NAME" --systemd=always \
    --security-opt label=disable -v "$ROOT:/src:ro" \
    "registry.fedoraproject.org/fedora:$RELEASE" bash -euc '
dnf -y -q install --setopt=install_weak_deps=False \
    systemd gnome-shell jq dbus-daemon glib2 mesa-dri-drivers procps-ng >/dev/null
exec /sbin/init
' > /dev/null
trap 'podman stop -t 2 "$NAME" > /dev/null 2>&1 || true' EXIT

for _ in $(seq 1 240); do
    if podman exec "$NAME" systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded'; then
        break
    fi
    sleep 1
done

podman exec "$NAME" bash -euc '
systemctl start systemd-logind
useradd tester
cp -r /src /home/tester/agentperch
cd /home/tester/agentperch
major="$(gnome-shell --version | sed -E "s/[^0-9]*([0-9]+).*/\1/")"
echo "GNOME Shell: $(gnome-shell --version)"
for metadata in extension/metadata.json tests/probe/metadata.json; do
    jq --arg v "$major" ".\"shell-version\" = [\$v]" "$metadata" > metadata.tmp
    mv metadata.tmp "$metadata"
done
chown -R tester: /home/tester
status=0
runuser -u tester -- env TMPDIR=/tmp ./scripts/headless-check.sh || status=$?
if ((status)); then
    echo "--- end of the Shell log"
    tail -n 40 /tmp/agentperch-headless.*/shell.log
fi
exit "$status"
'

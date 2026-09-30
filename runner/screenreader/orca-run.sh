#!/bin/bash
# Container entrypoint: start a virtual display, window manager, accessibility bus, speech server
# and Orca, then run the Orca probe with the given arguments.
set -u
export DISPLAY=:99 NO_AT_BRIDGE=0 ACCESSIBILITY_ENABLED=1 GNOME_ACCESSIBILITY=1 GTK_MODULES=gail:atk-bridge
LOGS=$(mktemp -d)

Xvfb :99 -screen 0 1280x900x24 >"$LOGS/xvfb.log" 2>&1 &
sleep 1
# Without a window manager no window becomes active, and Orca ignores inactive windows
openbox >"$LOGS/openbox.log" 2>&1 &
eval "$(dbus-launch --sh-syntax)"
/usr/libexec/at-spi-bus-launcher --launch-immediately >"$LOGS/atspi.log" 2>&1 &
sleep 1
for prop in IsEnabled ScreenReaderEnabled; do
  dbus-send --session --print-reply --dest=org.a11y.Bus /org/a11y/bus \
    org.freedesktop.DBus.Properties.Set string:org.a11y.Status string:$prop variant:boolean:true >/dev/null
done
speech-dispatcher -d >"$LOGS/spd.log" 2>&1
orca --replace --debug --debug-file="$LOGS/orca-debug.log" >"$LOGS/orca.out" 2>&1 &
sleep 4

node /regressions/runner/screenreader/orca_probe.cjs --orca-log "$LOGS/orca-debug.log" "$@"

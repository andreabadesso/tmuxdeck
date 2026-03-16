#!/bin/sh
# Fix ownership of host tmux socket directory.
# Docker bind-mounts create missing host dirs as root, but tmux
# requires the socket dir to be owned by the host user (mode 700).
if [ -n "$HOST_TMUX_SOCKET" ]; then
    tmux_dir=$(dirname "$HOST_TMUX_SOCKET")
    if [ -d "$tmux_dir" ]; then
        chown "${HOST_UID:-1000}:${HOST_UID:-1000}" "$tmux_dir" 2>/dev/null || true
        chmod 700 "$tmux_dir" 2>/dev/null || true
    fi
fi
exec uv run tmuxdeck-bridge "$@"

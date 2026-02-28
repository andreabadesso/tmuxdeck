"""Bridge configuration from CLI args and environment variables."""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass


@dataclass
class BridgeConfig:
    url: str = ""
    token: str = ""
    name: str = "bridge"
    # Tmux discovery modes (same as backend: local, host socket, docker)
    local: bool = True  # discover local tmux sessions
    host_tmux_socket: str = ""  # path to host tmux socket (like backend host mode)
    docker_socket: str = ""  # path to docker socket for container tmux
    docker_label: str = ""  # docker label filter for containers
    ipv6: bool = False  # use IPv6 instead of IPv4
    session_report_interval: float = 5.0
    reconnect_min: float = 5.0
    reconnect_max: float = 60.0


def parse_config() -> BridgeConfig:
    parser = argparse.ArgumentParser(
        description="TmuxDeck bridge agent — connects remote tmux to TmuxDeck backend",
    )
    parser.add_argument(
        "--url", default=os.environ.get("BRIDGE_URL", ""),
        help="WebSocket URL of TmuxDeck backend (e.g. ws://host:8000/ws/bridge)",
    )
    parser.add_argument(
        "--token", default=os.environ.get("BRIDGE_TOKEN", ""),
        help="Bridge authentication token",
    )
    parser.add_argument(
        "--name", default=None,
        help="Display name for this bridge (default: hostname)",
    )
    parser.add_argument(
        "--no-local", action="store_true",
        help="Disable local tmux session discovery",
    )
    parser.add_argument(
        "--host-tmux-socket", default="",
        help="Path to host tmux socket (like backend host mode)",
    )
    parser.add_argument(
        "--docker-socket", default="",
        help="Path to Docker socket for container tmux discovery",
    )
    parser.add_argument(
        "--docker-label", default="",
        help="Docker label filter for containers",
    )
    parser.add_argument(
        "-6", "--ipv6", action="store_true",
        help="Use IPv6 instead of IPv4",
    )
    parser.add_argument(
        "--report-interval", type=float, default=5.0,
        help="Session report interval in seconds (default: 5)",
    )

    args = parser.parse_args()

    if not args.url:
        parser.error("--url is required (or set BRIDGE_URL env var)")
    if not args.token:
        parser.error("--token is required (or set BRIDGE_TOKEN env var)")

    import socket as _socket

    return BridgeConfig(
        url=args.url,
        token=args.token,
        name=args.name or os.environ.get("BRIDGE_NAME", _socket.gethostname()),
        local=not args.no_local,
        host_tmux_socket=args.host_tmux_socket or os.environ.get("HOST_TMUX_SOCKET", ""),
        docker_socket=args.docker_socket or os.environ.get("DOCKER_SOCKET", ""),
        docker_label=args.docker_label or os.environ.get("DOCKER_LABEL", ""),
        ipv6=args.ipv6,
        session_report_interval=args.report_interval,
    )

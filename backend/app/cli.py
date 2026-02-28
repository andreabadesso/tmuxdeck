"""CLI entry point for tmuxdeck: list sessions, capture pane text, and take screenshots."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys


def _aggregate_status(windows: list) -> str:
    """Return worst status among windows: attention > running > idle."""
    statuses = set()
    for w in windows:
        ps = w.pane_status if hasattr(w, "pane_status") else (w.get("pane_status") or "")
        if ps:
            statuses.add(ps)
    if "attention" in statuses:
        return "attention"
    if "running" in statuses:
        return "running"
    return "idle"


async def _cmd_list(args: argparse.Namespace) -> None:
    from .api.containers import list_containers

    resp = await list_containers()

    rows: list[tuple[str, str, str, int, str]] = []
    for container in resp.containers:
        for session in container.sessions:
            status = _aggregate_status(session.windows)
            if args.filter and status != args.filter:
                continue
            win_count = len(session.windows)
            rows.append((
                container.display_name,
                session.name,
                session.id,
                win_count,
                status,
            ))

    if not rows:
        print("No sessions found.")
        return

    # Column widths
    h_container = "Container"
    h_session = "Session (ID)"
    h_windows = "Win"
    h_status = "Status"

    col_container = max(len(h_container), *(len(r[0]) for r in rows))
    col_session = max(len(h_session), *(len(f"{r[1]} ({r[2]})") for r in rows))
    col_windows = max(len(h_windows), 3)
    col_status = max(len(h_status), *(len(r[4]) for r in rows))

    header = (
        f"{h_container:<{col_container}}  "
        f"{h_session:<{col_session}}  "
        f"{h_windows:>{col_windows}}  "
        f"{h_status:<{col_status}}"
    )
    sep = "-" * len(header)
    print(header)
    print(sep)

    for container_name, session_name, session_id, win_count, status in rows:
        session_col = f"{session_name} ({session_id})"
        print(
            f"{container_name:<{col_container}}  "
            f"{session_col:<{col_session}}  "
            f"{win_count:>{col_windows}}  "
            f"{status:<{col_status}}"
        )


async def _cmd_capture(args: argparse.Namespace) -> None:
    from .services.tmux_manager import TmuxManager

    tm = TmuxManager.get()
    resolved = await tm.resolve_session_id_global(args.session_id)
    if not resolved:
        print(f"Error: session '{args.session_id}' not found.", file=sys.stderr)
        sys.exit(1)

    container_id, session_name = resolved
    try:
        text = await tm.capture_pane(
            container_id, session_name, window_index=args.window, ansi=args.ansi
        )
    except Exception as exc:
        print(f"Error capturing pane: {exc}", file=sys.stderr)
        sys.exit(1)

    if args.output:
        with open(args.output, "w") as f:
            f.write(text)
        print(f"Captured to {args.output}", file=sys.stderr)
    else:
        sys.stdout.write(text)


async def _cmd_screenshot(args: argparse.Namespace) -> None:
    from .services.render import render_ansi_to_png
    from .services.tmux_manager import TmuxManager

    tm = TmuxManager.get()
    resolved = await tm.resolve_session_id_global(args.session_id)
    if not resolved:
        print(f"Error: session '{args.session_id}' not found.", file=sys.stderr)
        sys.exit(1)

    container_id, session_name = resolved
    try:
        ansi_text = await tm.capture_pane(
            container_id, session_name, window_index=args.window, ansi=True
        )
    except Exception as exc:
        print(f"Error capturing pane: {exc}", file=sys.stderr)
        sys.exit(1)

    if not ansi_text.strip():
        print("Pane is empty, nothing to screenshot.", file=sys.stderr)
        sys.exit(1)

    png_buf = render_ansi_to_png(ansi_text)
    output_path = args.output
    with open(output_path, "wb") as f:
        f.write(png_buf.read())

    print(f"Screenshot saved to {output_path}")


def main() -> None:
    # Suppress noisy library logs (Docker connection errors, etc.)
    logging.basicConfig(level=logging.ERROR)

    parser = argparse.ArgumentParser(
        prog="tmuxdeck",
        description="TmuxDeck CLI — list sessions, capture pane text, and take screenshots",
    )
    sub = parser.add_subparsers(dest="command")

    # list
    list_parser = sub.add_parser("list", help="List all tmux sessions across containers")
    list_parser.add_argument(
        "--filter",
        choices=["attention", "running", "idle"],
        default=None,
        help="Show only sessions matching this status",
    )

    # capture
    cap_parser = sub.add_parser("capture", help="Capture pane text content")
    cap_parser.add_argument("session_id", help="Session ID (from 'tmuxdeck list')")
    cap_parser.add_argument(
        "-o", "--output",
        default=None,
        help="Output file path (default: stdout)",
    )
    cap_parser.add_argument(
        "-w", "--window",
        type=int,
        default=0,
        help="Window index to capture (default: 0)",
    )
    cap_parser.add_argument(
        "--ansi",
        action="store_true",
        default=False,
        help="Include ANSI escape sequences in output",
    )

    # screenshot
    ss_parser = sub.add_parser("screenshot", help="Take a PNG screenshot of a session pane")
    ss_parser.add_argument("session_id", help="Session ID (from 'tmuxdeck list')")
    ss_parser.add_argument(
        "-o", "--output",
        default="screenshot.png",
        help="Output file path (default: screenshot.png)",
    )
    ss_parser.add_argument(
        "-w", "--window",
        type=int,
        default=0,
        help="Window index to capture (default: 0)",
    )

    args = parser.parse_args()

    if args.command == "list":
        asyncio.run(_cmd_list(args))
    elif args.command == "capture":
        asyncio.run(_cmd_capture(args))
    elif args.command == "screenshot":
        asyncio.run(_cmd_screenshot(args))
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()

"""CLI entry point for tmuxdeck: manage tmux sessions, windows, and panes across containers."""

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


async def _resolve_session(session_id: str) -> tuple[str, str]:
    """Resolve a session_id to (container_id, session_name) or exit with error."""
    from .services.tmux_manager import TmuxManager

    tm = TmuxManager.get()
    resolved = await tm.resolve_session_id_global(session_id)
    if not resolved:
        print(f"Error: session '{session_id}' not found.", file=sys.stderr)
        sys.exit(1)
    return resolved


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


async def _cmd_windows(args: argparse.Namespace) -> None:
    from .services.tmux_manager import TmuxManager

    container_id, session_name = await _resolve_session(args.session_id)
    tm = TmuxManager.get()
    windows = await tm.list_windows(container_id, session_name)

    if not windows:
        print("No windows found.")
        return

    h_idx = "Index"
    h_name = "Name"
    h_cmd = "Command"
    h_panes = "Panes"
    h_status = "Status"

    col_idx = max(len(h_idx), *(len(str(w["index"])) for w in windows))
    col_name = max(len(h_name), *(len(w["name"]) for w in windows))
    col_cmd = max(len(h_cmd), *(len(w.get("command", "")) for w in windows))
    col_panes = max(len(h_panes), *(len(str(w["panes"])) for w in windows))
    col_status = max(len(h_status), *(len(w.get("pane_status", "")) for w in windows))

    header = (
        f"{h_idx:<{col_idx}}  "
        f"{h_name:<{col_name}}  "
        f"{h_cmd:<{col_cmd}}  "
        f"{h_panes:>{col_panes}}  "
        f"{h_status:<{col_status}}"
    )
    print(header)
    print("-" * len(header))

    for w in windows:
        print(
            f"{w['index']:<{col_idx}}  "
            f"{w['name']:<{col_name}}  "
            f"{w.get('command', ''):<{col_cmd}}  "
            f"{w['panes']:>{col_panes}}  "
            f"{w.get('pane_status', ''):<{col_status}}"
        )


async def _cmd_search(args: argparse.Namespace) -> None:
    from .api.containers import list_containers

    query = args.query.lower()
    resp = await list_containers()

    rows: list[tuple[str, int, str, str]] = []
    for container in resp.containers:
        for session in container.sessions:
            for w in session.windows:
                w_name = w.name if hasattr(w, "name") else w.get("name", "")
                w_cmd = w.command if hasattr(w, "command") else w.get("command", "")
                w_idx = w.index if hasattr(w, "index") else w.get("index", 0)
                s_name = session.name
                if query in w_name.lower() or query in w_cmd.lower() or query in s_name.lower():
                    rows.append((session.id, w_idx, w_name, w_cmd))

    if not rows:
        print(f"No windows matching '{args.query}'.")
        return

    h_session = "Session"
    h_idx = "Win"
    h_name = "Name"
    h_cmd = "Command"

    col_session = max(len(h_session), *(len(r[0]) for r in rows))
    col_idx = max(len(h_idx), *(len(str(r[1])) for r in rows))
    col_name = max(len(h_name), *(len(r[2]) for r in rows))
    col_cmd = max(len(h_cmd), *(len(r[3]) for r in rows))

    header = (
        f"{h_session:<{col_session}}  "
        f"{h_idx:>{col_idx}}  "
        f"{h_name:<{col_name}}  "
        f"{h_cmd:<{col_cmd}}"
    )
    print(header)
    print("-" * len(header))

    for sid, idx, name, cmd in rows:
        print(
            f"{sid:<{col_session}}  "
            f"{idx:>{col_idx}}  "
            f"{name:<{col_name}}  "
            f"{cmd:<{col_cmd}}"
        )


async def _cmd_pane_status(args: argparse.Namespace) -> None:
    from .services.tmux_manager import TmuxManager

    container_id, session_name = await _resolve_session(args.session_id)
    tm = TmuxManager.get()
    windows = await tm.list_windows(container_id, session_name)

    for w in windows:
        if args.window is not None and w["index"] != args.window:
            continue
        status = w.get("pane_status", "") or "none"
        print(f"Window {w['index']} ({w['name']}): {status}")


async def _cmd_capture(args: argparse.Namespace) -> None:
    from .services.tmux_manager import TmuxManager

    container_id, session_name = await _resolve_session(args.session_id)
    tm = TmuxManager.get()
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

    container_id, session_name = await _resolve_session(args.session_id)
    tm = TmuxManager.get()
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


async def _cmd_create_session(args: argparse.Namespace) -> None:
    from .services.tmux_manager import TmuxManager, make_session_id

    tm = TmuxManager.get()
    try:
        await tm.create_session(args.container_id, args.name)
    except Exception as exc:
        print(f"Error creating session: {exc}", file=sys.stderr)
        sys.exit(1)
    sid = make_session_id(args.container_id, args.name)
    print(f"Created session: {sid}")


async def _cmd_create_window(args: argparse.Namespace) -> None:
    from .services.tmux_manager import TmuxManager

    container_id, session_name = await _resolve_session(args.session_id)
    tm = TmuxManager.get()
    try:
        windows = await tm.create_window(container_id, session_name, args.name)
    except Exception as exc:
        print(f"Error creating window: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"Created window in {args.session_id} (total: {len(windows)})")


async def _cmd_rename_session(args: argparse.Namespace) -> None:
    from .services.tmux_manager import TmuxManager

    container_id, session_name = await _resolve_session(args.session_id)
    tm = TmuxManager.get()
    try:
        await tm.rename_session(container_id, session_name, args.new_name)
    except Exception as exc:
        print(f"Error renaming session: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"Renamed session '{session_name}' -> '{args.new_name}'")


async def _cmd_rename_window(args: argparse.Namespace) -> None:
    from .services.tmux_manager import TmuxManager

    container_id, session_name = await _resolve_session(args.session_id)
    tm = TmuxManager.get()
    try:
        await tm.rename_window(container_id, session_name, args.window_index, args.new_name)
    except Exception as exc:
        print(f"Error renaming window: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"Renamed window {args.window_index} -> '{args.new_name}'")


async def _cmd_kill_session(args: argparse.Namespace) -> None:
    from .services.tmux_manager import TmuxManager

    container_id, session_name = await _resolve_session(args.session_id)
    tm = TmuxManager.get()
    try:
        await tm.kill_session(container_id, session_name)
    except Exception as exc:
        print(f"Error killing session: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"Killed session: {args.session_id}")


async def _cmd_send_keys(args: argparse.Namespace) -> None:
    from .services.tmux_manager import TmuxManager

    container_id, session_name = await _resolve_session(args.session_id)
    tm = TmuxManager.get()
    try:
        await tm.send_keys(
            container_id, session_name, args.window_index, args.text,
            enter=not args.no_enter,
        )
    except Exception as exc:
        print(f"Error sending keys: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"Sent keys to {args.session_id}:{args.window_index}")


async def _cmd_swap_windows(args: argparse.Namespace) -> None:
    from .services.tmux_manager import TmuxManager

    container_id, session_name = await _resolve_session(args.session_id)
    tm = TmuxManager.get()
    try:
        await tm.swap_windows(container_id, session_name, args.index1, args.index2)
    except Exception as exc:
        print(f"Error swapping windows: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"Swapped windows {args.index1} <-> {args.index2} in {args.session_id}")


async def _cmd_move_window(args: argparse.Namespace) -> None:
    from .services.tmux_manager import TmuxManager

    container_id, session_name = await _resolve_session(args.session_id)
    tm = TmuxManager.get()

    # Resolve target session
    target_resolved = await tm.resolve_session_id_global(args.target_session_id)
    if not target_resolved:
        print(f"Error: target session '{args.target_session_id}' not found.", file=sys.stderr)
        sys.exit(1)
    _, dst_session = target_resolved

    try:
        await tm.move_window(container_id, session_name, args.window_index, dst_session)
    except Exception as exc:
        print(f"Error moving window: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"Moved window {args.window_index} from {args.session_id} to {args.target_session_id}")


# ── Command dispatch table ──────────────────────────────────────────
_COMMANDS = {
    "list": _cmd_list,
    "windows": _cmd_windows,
    "search": _cmd_search,
    "pane-status": _cmd_pane_status,
    "capture": _cmd_capture,
    "screenshot": _cmd_screenshot,
    "create-session": _cmd_create_session,
    "create-window": _cmd_create_window,
    "rename-session": _cmd_rename_session,
    "rename-window": _cmd_rename_window,
    "kill-session": _cmd_kill_session,
    "send-keys": _cmd_send_keys,
    "swap-windows": _cmd_swap_windows,
    "move-window": _cmd_move_window,
}


def main() -> None:
    # Suppress noisy library logs (Docker connection errors, etc.)
    logging.basicConfig(level=logging.ERROR)

    parser = argparse.ArgumentParser(
        prog="tmuxdeck",
        description="TmuxDeck CLI — manage tmux sessions, windows, and panes across containers",
    )
    sub = parser.add_subparsers(dest="command")

    # ── Read-only commands ───────────────────────────────────────────

    # list
    list_parser = sub.add_parser("list", help="List all tmux sessions across containers")
    list_parser.add_argument(
        "--filter",
        choices=["attention", "running", "idle"],
        default=None,
        help="Show only sessions matching this status",
    )

    # windows
    win_parser = sub.add_parser("windows", help="List windows in a session")
    win_parser.add_argument("session_id", help="Session ID (e.g. local:dev)")

    # search
    search_parser = sub.add_parser("search", help="Search windows by name/command across all containers")
    search_parser.add_argument("query", help="Search query (case-insensitive substring)")

    # pane-status
    ps_parser = sub.add_parser("pane-status", help="Get pane status for windows in a session")
    ps_parser.add_argument("session_id", help="Session ID")
    ps_parser.add_argument("-w", "--window", type=int, default=None, help="Window index (default: all)")

    # capture
    cap_parser = sub.add_parser("capture", help="Capture pane text content")
    cap_parser.add_argument("session_id", help="Session ID (from 'tmuxdeck list')")
    cap_parser.add_argument("-o", "--output", default=None, help="Output file path (default: stdout)")
    cap_parser.add_argument("-w", "--window", type=int, default=0, help="Window index (default: 0)")
    cap_parser.add_argument("--ansi", action="store_true", default=False, help="Include ANSI escape sequences")

    # screenshot
    ss_parser = sub.add_parser("screenshot", help="Take a PNG screenshot of a session pane")
    ss_parser.add_argument("session_id", help="Session ID (from 'tmuxdeck list')")
    ss_parser.add_argument("-o", "--output", default="screenshot.png", help="Output file path (default: screenshot.png)")
    ss_parser.add_argument("-w", "--window", type=int, default=0, help="Window index (default: 0)")

    # ── Modify commands ──────────────────────────────────────────────

    # create-session
    cs_parser = sub.add_parser("create-session", help="Create a new tmux session")
    cs_parser.add_argument("container_id", help="Container ID (e.g. local)")
    cs_parser.add_argument("name", help="Session name")

    # create-window
    cw_parser = sub.add_parser("create-window", help="Create a new window in a session")
    cw_parser.add_argument("session_id", help="Session ID")
    cw_parser.add_argument("--name", default=None, help="Window name")

    # rename-session
    rs_parser = sub.add_parser("rename-session", help="Rename a tmux session")
    rs_parser.add_argument("session_id", help="Session ID")
    rs_parser.add_argument("new_name", help="New session name")

    # rename-window
    rw_parser = sub.add_parser("rename-window", help="Rename a window")
    rw_parser.add_argument("session_id", help="Session ID")
    rw_parser.add_argument("window_index", type=int, help="Window index")
    rw_parser.add_argument("new_name", help="New window name")

    # kill-session
    ks_parser = sub.add_parser("kill-session", help="Kill a tmux session")
    ks_parser.add_argument("session_id", help="Session ID")

    # send-keys
    sk_parser = sub.add_parser("send-keys", help="Send keystrokes to a pane")
    sk_parser.add_argument("session_id", help="Session ID")
    sk_parser.add_argument("window_index", type=int, help="Window index")
    sk_parser.add_argument("text", help="Text to send")
    sk_parser.add_argument("--no-enter", action="store_true", default=False, help="Don't press Enter after text")

    # swap-windows
    sw_parser = sub.add_parser("swap-windows", help="Swap two window positions")
    sw_parser.add_argument("session_id", help="Session ID")
    sw_parser.add_argument("index1", type=int, help="First window index")
    sw_parser.add_argument("index2", type=int, help="Second window index")

    # move-window
    mw_parser = sub.add_parser("move-window", help="Move a window to another session")
    mw_parser.add_argument("session_id", help="Source session ID")
    mw_parser.add_argument("window_index", type=int, help="Window index to move")
    mw_parser.add_argument("target_session_id", help="Target session ID")

    args = parser.parse_args()

    handler = _COMMANDS.get(args.command) if args.command else None
    if handler:
        asyncio.run(handler(args))
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()

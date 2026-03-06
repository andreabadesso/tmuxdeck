"""Non-blocking logging configuration.

Python's default StreamHandler writes to stdout/stderr synchronously.
When the server runs inside a tmux pane that goes to background, tmux
flow-control can cause the PTY buffer to fill, blocking the write and
freezing the entire asyncio event loop.

This module sets up a QueueHandler/QueueListener pair so that all log
records are enqueued (non-blocking) on the calling thread, and a
dedicated listener thread drains the queue to the actual stream handler.
"""

from __future__ import annotations

import atexit
import logging
import logging.handlers
import queue
import sys


_listener: logging.handlers.QueueListener | None = None


def setup() -> None:
    """Install non-blocking queue-based logging for all loggers.

    Safe to call multiple times; only the first call has effect.
    """
    global _listener
    if _listener is not None:
        return

    log_queue: queue.Queue[logging.LogRecord] = queue.Queue(-1)

    # The actual handler that writes to stderr (same as default).
    stream_handler = logging.StreamHandler(sys.stderr)
    stream_handler.setFormatter(
        logging.Formatter("%(levelname)s:     %(name)s - %(message)s")
    )

    # Listener drains the queue on a background thread.
    _listener = logging.handlers.QueueListener(
        log_queue, stream_handler, respect_handler_level=True,
    )
    _listener.start()
    atexit.register(_listener.stop)

    # Replace handlers on the root logger so every logger in the
    # application (including uvicorn's) goes through the queue.
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(logging.handlers.QueueHandler(log_queue))
    root.setLevel(logging.INFO)

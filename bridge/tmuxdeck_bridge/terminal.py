"""Terminal session management — PTY + tmux attach for bridge channels."""

from __future__ import annotations

import asyncio
import fcntl
import logging
import os
import pty
import signal
import struct
import termios
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import websockets

logger = logging.getLogger(__name__)

_READ_BUF = 65536  # Large buffer to reduce frame count over double-hop WS relay
_COALESCE_MS = 0.0  # Start with zero coalescing; auto-tune raises for high-latency links
_BACKPRESSURE_CAP = 262144  # 256KB max per coalesced batch


class TerminalSession:
    """Manages a single PTY running tmux attach, connected to a bridge channel."""

    def __init__(
        self,
        channel_id: int,
        ws: websockets.ClientConnection,
        cmd: list[str],
        ws_stats: dict[str, int | float] | None = None,
    ) -> None:
        self.channel_id = channel_id
        self._ws = ws
        self._cmd = cmd
        self._ws_stats = ws_stats
        self._master_fd: int | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        """Spawn the PTY process and start the read loop."""
        env = os.environ.copy()
        env.pop("TMUX", None)
        env["TERM"] = "xterm-256color"

        master_fd, slave_fd = pty.openpty()
        self._master_fd = master_fd

        self._proc = await asyncio.create_subprocess_exec(
            *self._cmd,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=env,
        )
        os.close(slave_fd)

        self._task = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        """Read from PTY and send binary frames with channel header to backend.

        Uses non-blocking I/O with a 2ms coalescing window to batch
        small writes into fewer WebSocket frames, reducing overhead
        on the double-hop relay path.
        """
        loop = asyncio.get_event_loop()
        header = struct.pack(">H", self.channel_id)
        fd = self._master_fd

        # Set fd to non-blocking
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

        ready = asyncio.Event()

        def _on_readable():
            ready.set()

        loop.add_reader(fd, _on_readable)
        try:
            while True:
                ready.clear()
                await ready.wait()

                # Drain all immediately available data
                chunks = []
                total = 0
                while total < _BACKPRESSURE_CAP:
                    try:
                        chunk = os.read(fd, _READ_BUF)
                        if not chunk:
                            if chunks:
                                frame = header + b"".join(chunks)
                                if self._ws_stats is not None:
                                    self._ws_stats["tx_binary_frames"] += 1
                                    self._ws_stats["tx_binary_bytes"] += len(frame) - 2
                                await self._ws.send(frame)
                            return
                        chunks.append(chunk)
                        total += len(chunk)
                    except BlockingIOError:
                        break

                if not chunks:
                    continue

                # Coalescing window: wait for more data (skipped when zero)
                if total < _BACKPRESSURE_CAP and _COALESCE_MS > 0:
                    try:
                        ready.clear()
                        await asyncio.wait_for(ready.wait(), timeout=_COALESCE_MS)
                        # More data arrived — drain again
                        while total < _BACKPRESSURE_CAP:
                            try:
                                chunk = os.read(fd, _READ_BUF)
                                if not chunk:
                                    frame = header + b"".join(chunks)
                                    if self._ws_stats is not None:
                                        self._ws_stats["tx_binary_frames"] += 1
                                        self._ws_stats["tx_binary_bytes"] += len(frame) - 2
                                    await self._ws.send(frame)
                                    return
                                chunks.append(chunk)
                                total += len(chunk)
                            except BlockingIOError:
                                break
                    except asyncio.TimeoutError:
                        pass

                frame = header + b"".join(chunks)
                if self._ws_stats is not None:
                    self._ws_stats["tx_binary_frames"] += 1
                    self._ws_stats["tx_binary_bytes"] += len(frame) - 2
                await self._ws.send(frame)
        except OSError:
            pass
        except Exception as e:
            logger.debug("Terminal read loop error (ch %d): %s", self.channel_id, e)
        finally:
            try:
                loop.remove_reader(fd)
            except Exception:
                pass

    def write(self, data: bytes) -> None:
        """Write data to the PTY (terminal input from user)."""
        if self._master_fd is not None:
            try:
                os.write(self._master_fd, data)
            except OSError:
                pass

    def resize(self, cols: int, rows: int) -> None:
        """Resize the PTY."""
        if self._master_fd is not None:
            try:
                winsize = struct.pack("HHHH", rows, cols, 0, 0)
                fcntl.ioctl(self._master_fd, termios.TIOCSWINSZ, winsize)
                if self._proc and self._proc.returncode is None:
                    self._proc.send_signal(signal.SIGWINCH)
            except OSError as e:
                logger.debug("Resize failed (ch %d): %s", self.channel_id, e)

    async def stop(self) -> None:
        """Terminate the PTY process and clean up."""
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        if self._master_fd is not None:
            try:
                os.close(self._master_fd)
            except OSError:
                pass
            self._master_fd = None
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=3)
            except asyncio.TimeoutError:
                try:
                    self._proc.kill()
                except ProcessLookupError:
                    pass

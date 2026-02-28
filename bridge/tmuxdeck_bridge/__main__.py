"""CLI entry point: python -m tmuxdeck_bridge"""

from __future__ import annotations

import asyncio
import logging
import signal


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    from .bridge import Bridge
    from .config import parse_config

    config = parse_config()
    bridge = Bridge(config)

    async def _run():
        loop = asyncio.get_running_loop()
        main_task = asyncio.current_task()
        shutdown_requested = False

        def _on_signal():
            nonlocal shutdown_requested
            if shutdown_requested:
                logging.warning("Forced shutdown")
                import os
                os._exit(1)
            shutdown_requested = True
            logging.info("Shutting down...")
            bridge.stop()
            main_task.cancel()

        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, _on_signal)

        try:
            await bridge.run()
        except asyncio.CancelledError:
            pass

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

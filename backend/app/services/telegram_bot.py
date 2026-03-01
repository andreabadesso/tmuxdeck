"""Telegram bot: notification forwarding, session browsing, talk mode, and AI chat mode."""

from __future__ import annotations

import asyncio
import logging
from io import BytesIO
from typing import TYPE_CHECKING

from telegram import InlineKeyboardButton, InlineKeyboardMarkup
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from .. import store
from .render import render_ansi_to_png

if TYPE_CHECKING:
    from telegram import Update

    from .notification_manager import NotificationRecord

logger = logging.getLogger(__name__)

TALK_IDLE_TIMEOUT = 300  # 5 minutes

# Module-level reference to the active bot instance (set by TelegramBot.start)
_active_bot: TelegramBot | None = None


async def send_security_alert(title: str, message: str) -> None:
    """Send a security alert to all registered Telegram chats.

    This is a simple fire-and-forget function — no dedup, no session context.
    Called from auth endpoints via asyncio.create_task.
    """
    bot = _active_bot
    if bot is None or bot._app is None:
        return

    chat_ids = store.get_telegram_chats()
    if not chat_ids:
        return

    escaped_title = _escape_md2(title)
    escaped_msg = _escape_md2(message)
    text = f"\U0001f6a8 *{escaped_title}*\n\n{escaped_msg}"

    for chat_id in chat_ids:
        try:
            await bot._app.bot.send_message(
                chat_id=chat_id,
                text=text,
                parse_mode=ParseMode.MARKDOWN_V2,
            )
        except Exception:
            logger.exception("Failed to send security alert to chat %d", chat_id)

# Status emoji mapping
_STATUS_EMOJI = {
    "attention": "\U0001f534",  # 🔴
    "running": "\U0001f7e2",    # 🟢
    "idle": "\u26aa",           # ⚪
}


def _escape_md2(text: str) -> str:
    """Escape special characters for MarkdownV2."""
    special = r"_*[]()~`>#+-=|{}.!"
    return "".join(f"\\{c}" if c in special else c for c in text)


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


def _parse_session_arg(arg: str) -> tuple[str, int]:
    """Parse a session argument like 'abc123' or 'abc123:2' into (session_id, window_index)."""
    if ":" in arg:
        parts = arg.rsplit(":", 1)
        if parts[1].isdigit():
            return parts[0], int(parts[1])
    return arg, 0


class TelegramBot:
    def __init__(self, token: str) -> None:
        self._token = token
        self._app: Application | None = None
        self._notification_manager: object | None = None
        self._talk_mode: dict[int, dict] = {}  # chat_id → talk state
        self._chat_mode: dict[int, dict] = {}  # chat_id → chat mode state (AI agent)
        # Map (chat_id, message_id) → session context for reply-to-screenshot/capture
        self._message_sessions: dict[tuple[int, int], dict] = {}

    def set_notification_manager(self, manager: object) -> None:
        self._notification_manager = manager

    def _is_registered(self, chat_id: int) -> bool:
        return chat_id in store.get_telegram_chats()

    async def start(self) -> None:
        global _active_bot
        self._app = Application.builder().token(self._token).build()

        self._app.add_handler(CommandHandler("start", self._handle_start))
        self._app.add_handler(CommandHandler("list", self._handle_list))
        self._app.add_handler(CommandHandler("screenshot", self._handle_screenshot))
        self._app.add_handler(CommandHandler("capture", self._handle_capture))
        self._app.add_handler(CommandHandler("talk", self._handle_talk))
        self._app.add_handler(CommandHandler("send", self._handle_talk))
        self._app.add_handler(CommandHandler("chat", self._handle_chat))
        self._app.add_handler(CommandHandler("cancel", self._handle_cancel))
        self._app.add_handler(CommandHandler("unlock", self._handle_unlock))
        self._app.add_handler(CallbackQueryHandler(self._handle_callback))
        self._app.add_handler(
            MessageHandler(filters.VOICE | filters.AUDIO, self._handle_voice)
        )
        self._app.add_handler(
            MessageHandler(filters.TEXT & ~filters.COMMAND, self._handle_message)
        )

        await self._app.initialize()
        await self._app.start()
        await self._app.updater.start_polling(drop_pending_updates=True)

        # Register bot commands so they appear in Telegram's "/" menu
        from telegram import BotCommand

        try:
            await self._app.bot.set_my_commands([
                BotCommand("list", "Browse tmux sessions"),
                BotCommand("screenshot", "Screenshot a session pane"),
                BotCommand("capture", "Capture pane as text"),
                BotCommand("send", "Send keys to a session window"),
                BotCommand("chat", "AI chat mode for a session"),
                BotCommand("cancel", "Exit send/chat mode"),
                BotCommand("unlock", "Unlock login after lockout"),
            ])
            logger.info("Registered bot commands menu")
        except Exception:
            logger.exception("Failed to register bot commands menu")

        _active_bot = self
        logger.info("Telegram bot started")

    async def stop(self) -> None:
        global _active_bot
        if self._app:
            # Cancel all talk mode timers
            for state in self._talk_mode.values():
                timer = state.get("timer_task")
                if timer and not timer.done():
                    timer.cancel()
            self._talk_mode.clear()

            # Cancel all chat mode timers
            for state in self._chat_mode.values():
                timer = state.get("timer_task")
                if timer and not timer.done():
                    timer.cancel()
            self._chat_mode.clear()

            await self._app.updater.stop()
            await self._app.stop()
            await self._app.shutdown()
            _active_bot = None
            logger.info("Telegram bot stopped")

    async def send_notification(self, record: NotificationRecord) -> None:
        """Send a notification to all registered chat IDs."""
        if not self._app:
            return

        chat_ids = store.get_telegram_chats()
        if not chat_ids:
            logger.warning("No registered Telegram chats, skipping notification")
            return

        container_display = _escape_md2(record.container_id or "unknown")
        session_display = _escape_md2(f"{record.tmux_session}:{record.tmux_window}")
        message_text = _escape_md2(record.message or "No message")
        title_text = _escape_md2(record.title or "Claude Code needs attention")

        text = (
            f"\U0001f514 *{title_text}*\n\n"
            f"\U0001f4e6 `{container_display}`  \u00b7  \U0001f4bb `{session_display}`\n\n"
            f"{message_text}\n\n"
            f"\u21a9\ufe0f _Reply to this message to respond_"
        )

        for chat_id in chat_ids:
            try:
                msg = await self._app.bot.send_message(
                    chat_id=chat_id,
                    text=text,
                    parse_mode=ParseMode.MARKDOWN_V2,
                )
                record.telegram_message_id = msg.message_id
                record.telegram_chat_id = chat_id
                logger.info("Sent Telegram notification to chat %d", chat_id)
            except Exception:
                logger.exception("Failed to send Telegram message to chat %d", chat_id)

    # ── /start ────────────────────────────────────────────────

    async def _handle_start(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle /start <secret> command for registration."""
        if not update.message or not update.effective_chat:
            return

        chat_id = update.effective_chat.id
        args = context.args or []

        if not args:
            await update.message.reply_text(
                "\u26a0\ufe0f Please provide the registration secret:\n"
                "/start <secret>\n\n"
                "You can find the secret in TmuxDeck Settings \u2192 Telegram Bot section."
            )
            return

        secret = args[0]
        settings = store.get_settings()
        expected_secret = settings.get("telegramRegistrationSecret", "")

        if not expected_secret:
            await update.message.reply_text(
                "\u26a0\ufe0f No registration secret configured in TmuxDeck.\n"
                "Please generate one in Settings \u2192 Telegram Bot first."
            )
            return

        if secret != expected_secret:
            await update.message.reply_text("\u274c Invalid registration secret.")
            return

        existing = store.get_telegram_chats()
        if chat_id in existing:
            await update.message.reply_text(
                "\u2705 This chat is already registered for notifications."
            )
            return

        user = update.effective_chat
        store.add_telegram_chat(chat_id, username=user.username, first_name=user.first_name)
        await update.message.reply_text(
            "\u2705 Registration successful!\n"
            "You will get tmux notifications here when no browser is active."
        )
        logger.info("Registered Telegram chat: %d", chat_id)

    # ── /list [state] ─────────────────────────────────────────

    async def _handle_list(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.message or not update.effective_chat:
            return
        chat_id = update.effective_chat.id
        if not self._is_registered(chat_id):
            await update.message.reply_text(
                "\u26a0\ufe0f This chat is not registered. Use /start <secret> first."
            )
            return

        state_filter = (context.args[0].lower() if context.args else None)
        await self._send_session_list(update.message.chat_id, state_filter=state_filter)

    async def _send_session_list(
        self, chat_id: int, state_filter: str | None = None, message_id: int | None = None
    ) -> None:
        """Build and send/edit the session list with inline keyboard."""
        from ..api.containers import list_containers

        resp = await list_containers()

        buttons: list[list[InlineKeyboardButton]] = []
        for container in resp.containers:
            for session in container.sessions:
                status = _aggregate_status(session.windows)
                if state_filter and status != state_filter:
                    continue
                emoji = _STATUS_EMOJI.get(status, "\u26aa")
                label = f"{emoji} {container.display_name}/{session.name}"
                buttons.append([
                    InlineKeyboardButton(label, callback_data=f"d:{session.id}")
                ])

        # Filter buttons at bottom
        filter_row = [
            InlineKeyboardButton(
                f"{'[\U0001f534]' if state_filter == 'attention' else '\U0001f534'} Attn",
                callback_data="f:attention",
            ),
            InlineKeyboardButton(
                f"{'[\U0001f7e2]' if state_filter == 'running' else '\U0001f7e2'} Run",
                callback_data="f:running",
            ),
            InlineKeyboardButton(
                f"{'[\u26aa]' if state_filter == 'idle' else '\u26aa'} Idle",
                callback_data="f:idle",
            ),
        ]
        if state_filter:
            filter_row.append(
                InlineKeyboardButton("\u274c Clear", callback_data="f:all")
            )
        buttons.append(filter_row)

        if state_filter:
            escaped = _escape_md2(state_filter)
            text = f"\U0001f4cb *Sessions* \\({escaped}\\)"
        else:
            text = "\U0001f4cb *Sessions*"
        if len(buttons) == 1:
            # Only filter row, no sessions
            text += "\n\n_No sessions found\\._"

        markup = InlineKeyboardMarkup(buttons)

        if message_id and self._app:
            try:
                await self._app.bot.edit_message_text(
                    chat_id=chat_id,
                    message_id=message_id,
                    text=text,
                    parse_mode=ParseMode.MARKDOWN_V2,
                    reply_markup=markup,
                )
                return
            except Exception:
                pass  # Fall through to send new message

        if self._app:
            await self._app.bot.send_message(
                chat_id=chat_id,
                text=text,
                parse_mode=ParseMode.MARKDOWN_V2,
                reply_markup=markup,
            )

    # ── Session detail (callback) ─────────────────────────────

    async def _send_session_detail(
        self, chat_id: int, session_id: str, message_id: int | None = None
    ) -> None:
        """Show session detail view with action buttons."""
        from ..api.containers import list_containers

        resp = await list_containers()
        target_container = None
        target_session = None
        for container in resp.containers:
            for session in container.sessions:
                if session.id == session_id:
                    target_container = container
                    target_session = session
                    break
            if target_session:
                break

        if not target_session or not target_container:
            text = "\u26a0\ufe0f Session not found\\. It may have been closed\\."
            if message_id and self._app:
                try:
                    await self._app.bot.edit_message_text(
                        chat_id=chat_id,
                        message_id=message_id,
                        text=text,
                        parse_mode=ParseMode.MARKDOWN_V2,
                        reply_markup=InlineKeyboardMarkup([
                            [InlineKeyboardButton("\u2b05 Back", callback_data="back")]
                        ]),
                    )
                    return
                except Exception:
                    pass
            if self._app:
                await self._app.bot.send_message(
                    chat_id=chat_id,
                    text=text,
                    parse_mode=ParseMode.MARKDOWN_V2,
                )
            return

        # Build detail text
        cname = _escape_md2(target_container.display_name)
        sname = _escape_md2(target_session.name)
        lines = [f"\U0001f4bb *{cname}/{sname}*\n"]
        for w in target_session.windows:
            ps = w.pane_status or "idle"
            emoji = _STATUS_EMOJI.get(ps, "\u26aa")
            wname = _escape_md2(w.name)
            wcmd = _escape_md2(w.command)
            lines.append(
                f"  {emoji} W{w.index}: `{wname}` \\({wcmd}\\)"
            )

        lines.append("")
        lines.append("_Tap a window for actions_")

        text = "\n".join(lines)

        # Window buttons — each navigates to window detail
        buttons: list[list[InlineKeyboardButton]] = []
        for w in target_session.windows:
            ps = w.pane_status or "idle"
            emoji = _STATUS_EMOJI.get(ps, "\u26aa")
            label = f"{emoji} W{w.index}: {w.name}"
            buttons.append([
                InlineKeyboardButton(
                    label, callback_data=f"w:{session_id}:{w.index}"
                ),
            ])

        buttons.append([
            InlineKeyboardButton("\u2b05 Back", callback_data="back"),
        ])

        markup = InlineKeyboardMarkup(buttons)

        if message_id and self._app:
            try:
                await self._app.bot.edit_message_text(
                    chat_id=chat_id,
                    message_id=message_id,
                    text=text,
                    parse_mode=ParseMode.MARKDOWN_V2,
                    reply_markup=markup,
                )
                return
            except Exception:
                pass

        if self._app:
            await self._app.bot.send_message(
                chat_id=chat_id,
                text=text,
                parse_mode=ParseMode.MARKDOWN_V2,
                reply_markup=markup,
            )

    # ── Window detail (callback) ────────────────────────────

    async def _send_window_detail(
        self,
        chat_id: int,
        session_id: str,
        window_index: int,
        message_id: int | None = None,
    ) -> None:
        """Show window action menu with screenshot, capture, chat, send, copy ID."""
        from ..api.containers import list_containers

        resp = await list_containers()
        target_container = None
        target_session = None
        target_window = None
        for container in resp.containers:
            for session in container.sessions:
                if session.id == session_id:
                    target_container = container
                    target_session = session
                    for w in session.windows:
                        if w.index == window_index:
                            target_window = w
                            break
                    break
            if target_session:
                break

        if not target_session or not target_container or not target_window:
            text = "\u26a0\ufe0f Window not found\\."
            if message_id and self._app:
                try:
                    await self._app.bot.edit_message_text(
                        chat_id=chat_id,
                        message_id=message_id,
                        text=text,
                        parse_mode=ParseMode.MARKDOWN_V2,
                        reply_markup=InlineKeyboardMarkup([
                            [InlineKeyboardButton(
                                "\u2b05 Back", callback_data=f"d:{session_id}"
                            )]
                        ]),
                    )
                    return
                except Exception:
                    pass
            if self._app:
                await self._app.bot.send_message(
                    chat_id=chat_id,
                    text=text,
                    parse_mode=ParseMode.MARKDOWN_V2,
                )
            return

        cname = _escape_md2(target_container.display_name)
        sname = _escape_md2(target_session.name)
        wname = _escape_md2(target_window.name)
        wcmd = _escape_md2(target_window.command)
        ps = target_window.pane_status or "idle"
        emoji = _STATUS_EMOJI.get(ps, "\u26aa")
        wid = f"{session_id}:{window_index}"
        wid_escaped = _escape_md2(wid)

        text = (
            f"{emoji} *{cname}/{sname}* — W{window_index}: `{wname}`\n"
            f"Command: {wcmd}\n"
            f"ID: `{wid_escaped}`"
        )

        buttons = [
            [
                InlineKeyboardButton(
                    "\U0001f4f7 Screenshot",
                    callback_data=f"sw:{session_id}:{window_index}",
                ),
                InlineKeyboardButton(
                    "\U0001f4cb Capture",
                    callback_data=f"cw:{session_id}:{window_index}",
                ),
            ],
            [
                InlineKeyboardButton(
                    "\U0001f916 Chat",
                    callback_data=f"aw:{session_id}:{window_index}",
                ),
                InlineKeyboardButton(
                    "\U0001f4ac Send",
                    callback_data=f"tw:{session_id}:{window_index}",
                ),
            ],
            [
                InlineKeyboardButton(
                    "\U0001f4cb Copy ID",
                    callback_data=f"copyid:{wid}",
                ),
            ],
            [
                InlineKeyboardButton(
                    "\u2b05 Back", callback_data=f"d:{session_id}"
                ),
            ],
        ]

        markup = InlineKeyboardMarkup(buttons)

        if message_id and self._app:
            try:
                await self._app.bot.edit_message_text(
                    chat_id=chat_id,
                    message_id=message_id,
                    text=text,
                    parse_mode=ParseMode.MARKDOWN_V2,
                    reply_markup=markup,
                )
                return
            except Exception:
                pass

        if self._app:
            await self._app.bot.send_message(
                chat_id=chat_id,
                text=text,
                parse_mode=ParseMode.MARKDOWN_V2,
                reply_markup=markup,
            )

    # ── /screenshot [session-uid] ─────────────────────────────

    async def _handle_screenshot(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        if not update.message or not update.effective_chat:
            return
        chat_id = update.effective_chat.id
        if not self._is_registered(chat_id):
            await update.message.reply_text(
                "\u26a0\ufe0f This chat is not registered. Use /start <secret> first."
            )
            return

        args = context.args or []
        if not args:
            await update.message.reply_text(
                "Usage: /screenshot <session\\-id\\[:window\\]>\n"
                "Use /list to find session IDs\\.",
                parse_mode=ParseMode.MARKDOWN_V2,
            )
            return

        session_id, window_index = _parse_session_arg(args[0])
        await self._do_screenshot(chat_id, session_id, window_index=window_index)

    async def _do_screenshot(
        self, chat_id: int, session_id: str, window_index: int = 0
    ) -> None:
        """Capture pane with ANSI and send as PNG photo."""
        from ..services.tmux_manager import TmuxManager

        tm = TmuxManager.get()
        resolved = await tm.resolve_session_id_global(session_id)
        if not resolved:
            if self._app:
                await self._app.bot.send_message(
                    chat_id=chat_id,
                    text="\u26a0\ufe0f Session not found.",
                )
            return

        container_id, session_name = resolved
        try:
            ansi_text = await tm.capture_pane(
                container_id, session_name, window_index=window_index, ansi=True
            )
            pane_width = await tm.get_pane_width(
                container_id, session_name, window_index=window_index
            )
        except Exception:
            logger.exception("Failed to capture pane for screenshot")
            if self._app:
                await self._app.bot.send_message(
                    chat_id=chat_id, text="\u26a0\ufe0f Failed to capture pane."
                )
            return

        if not ansi_text.strip():
            if self._app:
                await self._app.bot.send_message(chat_id=chat_id, text="(empty pane)")
            return

        try:
            png_buf = render_ansi_to_png(ansi_text, cols=pane_width)
        except Exception:
            logger.exception("Failed to render PNG")
            if self._app:
                await self._app.bot.send_message(
                    chat_id=chat_id, text="\u26a0\ufe0f Failed to render screenshot."
                )
            return

        # Build caption with window name
        caption = f"{container_id}:{session_name}:{window_index}"
        try:
            windows = await tm.list_windows(container_id, session_name)
            for w in windows:
                if w["index"] == window_index:
                    caption = f"{container_id}:{session_name}:{window_index}:{w['name']}"
                    break
        except Exception:
            pass  # Use caption without window name

        if self._app:
            msg = await self._app.bot.send_photo(
                chat_id=chat_id, photo=png_buf, caption=caption
            )
            self._message_sessions[(chat_id, msg.message_id)] = {
                "container_id": container_id,
                "session_name": session_name,
                "window_index": window_index,
            }

    # ── /capture [session-uid] ────────────────────────────────

    async def _handle_capture(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        if not update.message or not update.effective_chat:
            return
        chat_id = update.effective_chat.id
        if not self._is_registered(chat_id):
            await update.message.reply_text(
                "\u26a0\ufe0f This chat is not registered. Use /start <secret> first."
            )
            return

        args = context.args or []
        if not args:
            await update.message.reply_text(
                "Usage: /capture <session\\-id\\[:window\\]>\n"
                "Use /list to find session IDs\\.",
                parse_mode=ParseMode.MARKDOWN_V2,
            )
            return

        session_id, window_index = _parse_session_arg(args[0])
        await self._do_capture(chat_id, session_id, window_index=window_index)

    async def _do_capture(
        self, chat_id: int, session_id: str, window_index: int = 0
    ) -> None:
        """Capture pane as plain text and send as code block or file."""
        from ..services.tmux_manager import TmuxManager

        tm = TmuxManager.get()
        resolved = await tm.resolve_session_id_global(session_id)
        if not resolved:
            if self._app:
                await self._app.bot.send_message(
                    chat_id=chat_id,
                    text="\u26a0\ufe0f Session not found.",
                )
            return

        container_id, session_name = resolved
        try:
            text = await tm.capture_pane(
                container_id, session_name, window_index=window_index, ansi=False
            )
        except Exception:
            logger.exception("Failed to capture pane")
            if self._app:
                await self._app.bot.send_message(
                    chat_id=chat_id, text="\u26a0\ufe0f Failed to capture pane."
                )
            return

        if not text.strip():
            if self._app:
                await self._app.bot.send_message(chat_id=chat_id, text="(empty pane)")
            return

        # Build caption with window name
        caption = f"{container_id}:{session_name}:{window_index}"
        try:
            windows = await tm.list_windows(container_id, session_name)
            for w in windows:
                if w["index"] == window_index:
                    caption = f"{container_id}:{session_name}:{window_index}:{w['name']}"
                    break
        except Exception:
            pass  # Use caption without window name

        if self._app:
            session_ctx = {
                "container_id": container_id,
                "session_name": session_name,
                "window_index": window_index,
            }
            try:
                if len(text) > 3900:
                    # Send as file
                    buf = BytesIO(text.encode("utf-8"))
                    buf.name = "capture.txt"
                    msg = await self._app.bot.send_document(
                        chat_id=chat_id, document=buf, caption=caption
                    )
                else:
                    # Use HTML to avoid MarkdownV2 escaping issues
                    from html import escape as html_escape
                    html_text = (
                        f"<code>{html_escape(caption)}</code>\n"
                        f"<pre>{html_escape(text)}</pre>"
                    )
                    msg = await self._app.bot.send_message(
                        chat_id=chat_id,
                        text=html_text,
                        parse_mode=ParseMode.HTML,
                    )
                self._message_sessions[(chat_id, msg.message_id)] = session_ctx
            except Exception:
                logger.exception("Failed to send capture message")
                await self._app.bot.send_message(
                    chat_id=chat_id, text="\u26a0\ufe0f Internal error."
                )

    # ── /talk [session-uid] [message] ─────────────────────────

    async def _handle_talk(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        if not update.message or not update.effective_chat:
            return
        chat_id = update.effective_chat.id
        if not self._is_registered(chat_id):
            await update.message.reply_text(
                "\u26a0\ufe0f This chat is not registered. Use /start <secret> first."
            )
            return

        args = context.args or []
        if not args:
            await update.message.reply_text(
                "Usage: /send <session\\-id\\[:window\\]> \\[message\\]\n"
                "Use /list to find session IDs\\.",
                parse_mode=ParseMode.MARKDOWN_V2,
            )
            return

        session_id, window_index = _parse_session_arg(args[0])
        message = " ".join(args[1:]) if len(args) > 1 else None
        await self._do_talk(chat_id, session_id, window_index=window_index, message=message)

    async def _do_talk(
        self,
        chat_id: int,
        session_id: str,
        window_index: int = 0,
        message: str | None = None,
    ) -> None:
        """Enter talk mode or send one-shot message."""
        from ..services.tmux_manager import TmuxManager

        tm = TmuxManager.get()
        resolved = await tm.resolve_session_id_global(session_id)
        if not resolved:
            if self._app:
                await self._app.bot.send_message(
                    chat_id=chat_id,
                    text="\u26a0\ufe0f Session not found.",
                )
            return

        container_id, session_name = resolved

        if message:
            # One-shot mode
            try:
                await tm.send_keys(container_id, session_name, window_index, message)
                if self._app:
                    await self._app.bot.send_message(
                        chat_id=chat_id, text="\u2705 Sent."
                    )
            except Exception:
                logger.exception("Failed to send keys")
                if self._app:
                    await self._app.bot.send_message(
                        chat_id=chat_id,
                        text="\u26a0\ufe0f Failed to send message to session.",
                    )
        else:
            # Enter persistent talk mode
            self._enter_talk_mode(
                chat_id, session_id, container_id, session_name, window_index
            )
            if self._app:
                sn = _escape_md2(session_name)
                await self._app.bot.send_message(
                    chat_id=chat_id,
                    text=(
                        f"\U0001f4ac Send mode: *{sn}*"
                        f" window {window_index}\n\n"
                        f"Messages you send will go to"
                        f" this session\\.\n"
                        f"Use /cancel to exit\\.\n"
                        f"Auto\\-exits after 5 min idle\\."
                    ),
                    parse_mode=ParseMode.MARKDOWN_V2,
                )

    def _enter_talk_mode(
        self,
        chat_id: int,
        session_id: str,
        container_id: str,
        session_name: str,
        window_index: int,
    ) -> None:
        """Set up talk mode state with idle timer."""
        # Cancel existing talk mode if any
        self._exit_talk_mode(chat_id)

        timer = asyncio.create_task(self._talk_idle_timer(chat_id))
        self._talk_mode[chat_id] = {
            "session_id": session_id,
            "container_id": container_id,
            "session_name": session_name,
            "window_index": window_index,
            "timer_task": timer,
        }

    def _exit_talk_mode(self, chat_id: int) -> None:
        """Clear talk mode for a chat."""
        state = self._talk_mode.pop(chat_id, None)
        if state:
            timer = state.get("timer_task")
            if timer and not timer.done():
                timer.cancel()

    def _reset_talk_timer(self, chat_id: int) -> None:
        """Reset the idle timer for talk mode."""
        state = self._talk_mode.get(chat_id)
        if not state:
            return
        timer = state.get("timer_task")
        if timer and not timer.done():
            timer.cancel()
        state["timer_task"] = asyncio.create_task(self._talk_idle_timer(chat_id))

    async def _talk_idle_timer(self, chat_id: int) -> None:
        """Auto-exit talk mode after idle timeout."""
        try:
            await asyncio.sleep(TALK_IDLE_TIMEOUT)
        except asyncio.CancelledError:
            return
        # Timer fired — exit talk mode
        self._talk_mode.pop(chat_id, None)
        if self._app:
            try:
                await self._app.bot.send_message(
                    chat_id=chat_id,
                    text="\U0001f4ac Send mode exited (idle timeout).",
                )
            except Exception:
                logger.exception("Failed to send idle timeout message")

    # ── /chat [session-uid] ─────────────────────────────────

    async def _handle_chat(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        if not update.message or not update.effective_chat:
            return
        chat_id = update.effective_chat.id
        if not self._is_registered(chat_id):
            await update.message.reply_text(
                "\u26a0\ufe0f This chat is not registered. Use /start <secret> first."
            )
            return

        from ..config import config as app_config

        settings = store.get_settings()
        if not (settings.get("openaiApiKey") or app_config.openai_api_key):
            await update.message.reply_text(
                "\u26a0\ufe0f OpenAI API key is not configured. "
                "Set it in Settings \u2192 Telegram."
            )
            return

        args = context.args or []
        if not args:
            await update.message.reply_text(
                "Usage: /chat <session\\-id\\[:window\\]>\n"
                "Use /list to find session IDs\\.",
                parse_mode=ParseMode.MARKDOWN_V2,
            )
            return

        session_id, window_index = _parse_session_arg(args[0])
        await self._do_chat(chat_id, session_id, window_index=window_index)

    async def _do_chat(
        self,
        chat_id: int,
        session_id: str,
        window_index: int = 0,
    ) -> None:
        """Enter AI chat mode for a session."""
        from ..services.tmux_manager import TmuxManager

        tm = TmuxManager.get()
        resolved = await tm.resolve_session_id_global(session_id)
        if not resolved:
            if self._app:
                await self._app.bot.send_message(
                    chat_id=chat_id,
                    text="\u26a0\ufe0f Session not found.",
                )
            return

        container_id, session_name = resolved

        # Exit talk mode if active
        self._exit_talk_mode(chat_id)

        # Enter chat mode
        self._enter_chat_mode(
            chat_id, session_id, container_id, session_name, window_index
        )
        if self._app:
            sn = _escape_md2(session_name)
            await self._app.bot.send_message(
                chat_id=chat_id,
                text=(
                    f"\U0001f916 Chat mode: *{sn}*"
                    f" window {window_index}\n\n"
                    f"Send text or voice messages\\.\n"
                    f"The AI agent will read the terminal and respond\\.\n"
                    f"Use /cancel to exit\\.\n"
                    f"Auto\\-exits after 5 min idle\\."
                ),
                parse_mode=ParseMode.MARKDOWN_V2,
            )

    def _enter_chat_mode(
        self,
        chat_id: int,
        session_id: str,
        container_id: str,
        session_name: str,
        window_index: int,
    ) -> None:
        """Set up chat mode state with idle timer."""
        self._exit_chat_mode(chat_id)

        timer = asyncio.create_task(self._chat_idle_timer(chat_id))
        self._chat_mode[chat_id] = {
            "session_id": session_id,
            "container_id": container_id,
            "session_name": session_name,
            "window_index": window_index,
            "timer_task": timer,
        }

    def _exit_chat_mode(self, chat_id: int) -> None:
        """Clear chat mode for a chat."""
        state = self._chat_mode.pop(chat_id, None)
        if state:
            timer = state.get("timer_task")
            if timer and not timer.done():
                timer.cancel()
        # Also clear any pending proposal
        from .voice_agent import VoiceAgent

        try:
            agent = VoiceAgent.get()
            agent.clear_pending_proposal(chat_id)
        except Exception:
            pass

    def _reset_chat_timer(self, chat_id: int) -> None:
        """Reset the idle timer for chat mode."""
        state = self._chat_mode.get(chat_id)
        if not state:
            return
        timer = state.get("timer_task")
        if timer and not timer.done():
            timer.cancel()
        state["timer_task"] = asyncio.create_task(self._chat_idle_timer(chat_id))

    async def _chat_idle_timer(self, chat_id: int) -> None:
        """Auto-exit chat mode after idle timeout."""
        try:
            await asyncio.sleep(TALK_IDLE_TIMEOUT)
        except asyncio.CancelledError:
            return
        self._chat_mode.pop(chat_id, None)
        if self._app:
            try:
                await self._app.bot.send_message(
                    chat_id=chat_id,
                    text="\U0001f916 Chat mode exited (idle timeout).",
                )
            except Exception:
                logger.exception("Failed to send chat idle timeout message")

    # ── Voice message handler ─────────────────────────────────

    async def _handle_voice(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        """Handle voice/audio messages — route through AI agent."""
        if not update.message or not update.effective_chat:
            return

        chat_id = update.effective_chat.id
        if not self._is_registered(chat_id):
            await update.message.reply_text(
                "\u26a0\ufe0f This chat is not registered. Use /start <secret> first."
            )
            return

        from ..config import config as app_config

        settings = store.get_settings()
        if not (settings.get("openaiApiKey") or app_config.openai_api_key):
            await update.message.reply_text(
                "\u26a0\ufe0f OpenAI API key is not configured. "
                "Set it in Settings \u2192 Telegram."
            )
            return

        # Determine session context
        session_ctx = None

        # 1. Chat mode
        if chat_id in self._chat_mode:
            state = self._chat_mode[chat_id]
            session_ctx = {
                "container_id": state["container_id"],
                "session_name": state["session_name"],
                "window_index": state["window_index"],
                "session_id": state["session_id"],
            }
            self._reset_chat_timer(chat_id)

        # 2. Reply to a bot message with session context
        elif update.message.reply_to_message:
            reply_to_id = update.message.reply_to_message.message_id
            ctx = self._message_sessions.get((chat_id, reply_to_id))
            if ctx:
                from .tmux_manager import make_session_id

                session_ctx = {
                    **ctx,
                    "session_id": make_session_id(ctx["container_id"], ctx["session_name"]),
                }
            else:
                # 3. Reply to a notification message
                from .notification_manager import NotificationManager
                from .tmux_manager import make_session_id

                record = NotificationManager.get().get_by_telegram_message_id(reply_to_id)
                if record:
                    session_ctx = {
                        "container_id": record.container_id,
                        "session_name": record.tmux_session,
                        "window_index": record.tmux_window,
                        "session_id": make_session_id(record.container_id, record.tmux_session),
                    }

        if not session_ctx:
            await update.message.reply_text(
                "Enter /chat <session-id> first, or reply to a session message."
            )
            return

        # Download voice file
        voice = update.message.voice or update.message.audio
        if not voice:
            return

        try:
            file = await context.bot.get_file(voice.file_id)
            voice_bytes = await file.download_as_bytearray()
        except Exception:
            logger.exception("Failed to download voice file")
            await update.message.reply_text("\u26a0\ufe0f Failed to download voice message.")
            return

        # Transcribe
        from .audio import transcribe

        try:
            transcript = await transcribe(bytes(voice_bytes))
        except Exception:
            logger.exception("Failed to transcribe voice")
            await update.message.reply_text("\u26a0\ufe0f Failed to transcribe voice message.")
            return

        if not transcript.strip():
            await update.message.reply_text("(could not understand audio)")
            return

        # Debug log transcription if enabled
        settings = store.get_settings()
        if settings.get("audioDebugLog"):
            from .debug_log import DebugLog

            user = update.effective_chat
            user_label = user.username or user.first_name or str(chat_id)
            DebugLog.get().info(
                "audio",
                f"Voice transcription from {user_label}",
                transcript,
            )

        # Show transcription
        escaped = _escape_md2(transcript)
        await update.message.reply_text(
            f"\U0001f399 _{escaped}_", parse_mode=ParseMode.MARKDOWN_V2
        )

        # Process through agent
        await self._process_agent_message(chat_id, session_ctx, transcript, voice_reply=True)

    async def _process_agent_message(
        self,
        chat_id: int,
        session_ctx: dict,
        user_message: str,
        voice_reply: bool = False,
    ) -> None:
        """Process a message through the voice agent and send results."""
        from .voice_agent import VoiceAgent

        agent = VoiceAgent.get()

        try:
            result = await agent.process_message(chat_id, session_ctx, user_message)
        except Exception:
            logger.exception("Agent processing failed")
            if self._app:
                await self._app.bot.send_message(
                    chat_id=chat_id,
                    text="\u26a0\ufe0f Agent error. Please try again.",
                )
            return

        if not self._app:
            return

        # Send screenshots
        for screenshot in result.screenshots:
            try:
                await self._app.bot.send_photo(chat_id=chat_id, photo=screenshot)
            except Exception:
                logger.exception("Failed to send screenshot from agent")

        # Send proposal if any
        if result.proposal:
            proposed = result.proposal.text
            submit_label = " + Enter" if result.proposal.submit else ""
            from html import escape as html_escape

            proposal_text = (
                f"\U0001f4dd <b>Proposed input{html_escape(submit_label)}:</b>\n"
                f"<pre>{html_escape(proposed)}</pre>"
            )
            buttons = InlineKeyboardMarkup([
                [
                    InlineKeyboardButton("\u2705 Send", callback_data="proposal:approve"),
                    InlineKeyboardButton("\u274c Cancel", callback_data="proposal:cancel"),
                ],
            ])
            try:
                await self._app.bot.send_message(
                    chat_id=chat_id,
                    text=proposal_text,
                    parse_mode=ParseMode.HTML,
                    reply_markup=buttons,
                )
            except Exception:
                logger.exception("Failed to send proposal message")

            # Also send proposal as voice
            if voice_reply and proposed:
                try:
                    from .audio import text_to_speech

                    proposal_audio = await text_to_speech(
                        f"I'd like to send: {proposed}"
                    )
                    await self._app.bot.send_voice(
                        chat_id=chat_id, voice=BytesIO(proposal_audio)
                    )
                except Exception:
                    logger.exception("Failed to send proposal voice")

        # Send response text
        if result.response_text:
            # Send as text message
            try:
                msg = await self._app.bot.send_message(
                    chat_id=chat_id, text=result.response_text
                )
                self._message_sessions[(chat_id, msg.message_id)] = {
                    "container_id": session_ctx["container_id"],
                    "session_name": session_ctx["session_name"],
                    "window_index": session_ctx["window_index"],
                }
            except Exception:
                logger.exception("Failed to send agent text response")

            # Also send as voice if this was a voice interaction
            if voice_reply:
                try:
                    from .audio import text_to_speech

                    audio_bytes = await text_to_speech(result.response_text)
                    await self._app.bot.send_voice(
                        chat_id=chat_id, voice=BytesIO(audio_bytes)
                    )
                except Exception:
                    logger.exception("Failed to send TTS voice response")

    async def _handle_proposal_callback(
        self, chat_id: int, action: str, query
    ) -> None:
        """Handle proposal approve/cancel callback."""
        from .voice_agent import VoiceAgent

        agent = VoiceAgent.get()
        proposal = agent.clear_pending_proposal(chat_id)

        if not proposal:
            if self._app:
                await self._app.bot.send_message(
                    chat_id=chat_id,
                    text="\u26a0\ufe0f No pending proposal.",
                )
            return

        if action == "approve":
            from .tmux_manager import TmuxManager

            tm = TmuxManager.get()
            try:
                await tm.send_keys(
                    proposal.session_ctx["container_id"],
                    proposal.session_ctx["session_name"],
                    proposal.session_ctx["window_index"],
                    proposal.text,
                    enter=proposal.submit,
                )
                if self._app:
                    await self._app.bot.send_message(
                        chat_id=chat_id, text="\u2705 Sent to terminal."
                    )
            except Exception:
                logger.exception("Failed to send proposed input")
                if self._app:
                    await self._app.bot.send_message(
                        chat_id=chat_id,
                        text="\u26a0\ufe0f Failed to send input to terminal.",
                    )

            # Notify agent
            session_id = proposal.session_ctx.get("session_id", "")
            await agent.notify_proposal_result(chat_id, session_id, approved=True)

        else:
            if self._app:
                await self._app.bot.send_message(
                    chat_id=chat_id, text="\u274c Proposal cancelled."
                )
            session_id = proposal.session_ctx.get("session_id", "")
            await agent.notify_proposal_result(chat_id, session_id, approved=False)

        # Remove inline keyboard from proposal message
        if query.message:
            import contextlib

            with contextlib.suppress(Exception):
                await query.message.edit_reply_markup(reply_markup=None)

    # ── /unlock ───────────────────────────────────────────────

    async def _handle_unlock(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        if not update.message or not update.effective_chat:
            return
        chat_id = update.effective_chat.id
        if not self._is_registered(chat_id):
            await update.message.reply_text(
                "\u26a0\ufe0f This chat is not registered. Use /start <secret> first."
            )
            return

        from ..rate_limit import get_limiter

        limiter = get_limiter()
        limiter.unlock_all()
        await update.message.reply_text("\u2705 Login unlocked. All rate limits cleared.")
        logger.info("Login unlocked via Telegram by chat %d", chat_id)

        await send_security_alert("Login unlocked", "Login unlocked via Telegram /unlock command")

    # ── /cancel ───────────────────────────────────────────────

    async def _handle_cancel(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        if not update.message or not update.effective_chat:
            return
        chat_id = update.effective_chat.id
        if chat_id in self._chat_mode:
            self._exit_chat_mode(chat_id)
            await update.message.reply_text("\U0001f916 Chat mode exited.")
        elif chat_id in self._talk_mode:
            self._exit_talk_mode(chat_id)
            await update.message.reply_text("\U0001f4ac Send mode exited.")
        else:
            await update.message.reply_text("No active send or chat mode.")

    # ── Callback query handler ────────────────────────────────

    async def _handle_callback(
        self, update: Update, context: ContextTypes.DEFAULT_TYPE
    ) -> None:
        query = update.callback_query
        if not query or not query.data:
            return
        await query.answer()

        chat_id = query.message.chat_id if query.message else None
        if not chat_id:
            return
        if not self._is_registered(chat_id):
            return

        message_id = query.message.message_id if query.message else None
        data = query.data

        if data == "back":
            await self._send_session_list(chat_id, message_id=message_id)

        elif data.startswith("f:"):
            state_filter = data[2:]
            if state_filter == "all":
                state_filter = None
            await self._send_session_list(
                chat_id, state_filter=state_filter, message_id=message_id
            )

        elif data.startswith("d:"):
            session_id = data[2:]
            await self._send_session_detail(chat_id, session_id, message_id=message_id)

        elif data.startswith("w:"):
            parts = data[2:].rsplit(":", 1)
            if len(parts) == 2 and parts[1].isdigit():
                session_id, win = parts[0], int(parts[1])
                await self._send_window_detail(
                    chat_id, session_id, win, message_id=message_id
                )

        elif data.startswith("sw:"):
            parts = data[3:].rsplit(":", 1)
            if len(parts) == 2 and parts[1].isdigit():
                session_id, win = parts[0], int(parts[1])
                await self._do_screenshot(chat_id, session_id, window_index=win)

        elif data.startswith("cw:"):
            parts = data[3:].rsplit(":", 1)
            if len(parts) == 2 and parts[1].isdigit():
                session_id, win = parts[0], int(parts[1])
                await self._do_capture(chat_id, session_id, window_index=win)

        elif data.startswith("tw:"):
            parts = data[3:].rsplit(":", 1)
            if len(parts) == 2 and parts[1].isdigit():
                session_id, win = parts[0], int(parts[1])
                await self._do_talk(chat_id, session_id, window_index=win)

        elif data.startswith("aw:"):
            parts = data[3:].rsplit(":", 1)
            if len(parts) == 2 and parts[1].isdigit():
                session_id, win = parts[0], int(parts[1])
                await self._do_chat(chat_id, session_id, window_index=win)

        elif data.startswith("copyid:"):
            window_id = data[7:]  # e.g. "abc123:0"
            if self._app:
                await self._app.bot.send_message(
                    chat_id=chat_id,
                    text=f"`{_escape_md2(window_id)}`",
                    parse_mode=ParseMode.MARKDOWN_V2,
                )

        elif data.startswith("proposal:"):
            action = data[9:]  # "approve" or "cancel"
            await self._handle_proposal_callback(chat_id, action, query)

    # ── Message handler (notification replies + talk mode) ────

    async def _handle_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not update.message or not update.effective_chat:
            return

        chat_id = update.effective_chat.id
        if not self._is_registered(chat_id):
            await update.message.reply_text(
                "\u26a0\ufe0f This chat is not registered. Use /start <secret> first."
            )
            return

        # 1. If it's a reply to a bot message, try screenshot/capture session first,
        #    then fall back to notification reply.
        if update.message.reply_to_message:
            reply_to_id = update.message.reply_to_message.message_id
            text = update.message.text or ""
            if not text.strip():
                return

            # Check if the replied-to message is a screenshot or capture
            session_ctx = self._message_sessions.get((chat_id, reply_to_id))
            if session_ctx:
                from ..services.tmux_manager import TmuxManager

                tm = TmuxManager.get()
                try:
                    await tm.send_keys(
                        session_ctx["container_id"],
                        session_ctx["session_name"],
                        session_ctx["window_index"],
                        text,
                        enter=False,
                        submit=True,
                    )
                    await update.message.reply_text("\u2705 Sent.")
                except Exception:
                    logger.exception("Failed to send keys via screenshot reply")
                    await update.message.reply_text(
                        "\u26a0\ufe0f Failed to send message to session."
                    )
                return

            from .notification_manager import NotificationManager

            nm = NotificationManager.get()
            record = nm.handle_telegram_reply(reply_to_id, text)

            if record:
                await update.message.reply_text("\u2705")
            else:
                await update.message.reply_text(
                    "\u26a0\ufe0f Could not find the notification for this message. "
                    "It may have expired."
                )
            return

        # 2. If in chat mode, route through AI agent
        if chat_id in self._chat_mode:
            text = update.message.text or ""
            if not text.strip():
                return

            state = self._chat_mode[chat_id]
            session_ctx = {
                "container_id": state["container_id"],
                "session_name": state["session_name"],
                "window_index": state["window_index"],
                "session_id": state["session_id"],
            }
            self._reset_chat_timer(chat_id)
            await self._process_agent_message(
                chat_id, session_ctx, text, voice_reply=False
            )
            return

        # 3. If in talk mode, forward to tmux session
        if chat_id in self._talk_mode:
            text = update.message.text or ""
            if not text.strip():
                return

            state = self._talk_mode[chat_id]
            from ..services.tmux_manager import TmuxManager

            tm = TmuxManager.get()
            try:
                await tm.send_keys(
                    state["container_id"],
                    state["session_name"],
                    state["window_index"],
                    text,
                )
                self._reset_talk_timer(chat_id)
            except Exception:
                logger.exception("Talk mode send failed")
                self._exit_talk_mode(chat_id)
                await update.message.reply_text(
                    "\u26a0\ufe0f Send failed. Send mode exited (session may be dead)."
                )
            return

        # 4. Otherwise, show help hint
        await update.message.reply_text(
            "Use /list to browse sessions, /chat to start AI chat mode, "
            "or reply to a notification message."
        )

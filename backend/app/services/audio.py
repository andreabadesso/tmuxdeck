"""Audio services: Speech-to-Text (Whisper) and Text-to-Speech (OpenAI TTS)."""

from __future__ import annotations

import logging

from openai import AsyncOpenAI

from .. import store
from ..config import config

logger = logging.getLogger(__name__)

_client: AsyncOpenAI | None = None
_client_key: str = ""


def _get_openai_api_key() -> str:
    """Return the OpenAI API key from settings (preferred) or env var fallback."""
    settings = store.get_settings()
    return settings.get("openaiApiKey", "") or config.openai_api_key


def _get_client() -> AsyncOpenAI:
    global _client, _client_key
    key = _get_openai_api_key()
    if _client is None or key != _client_key:
        _client = AsyncOpenAI(api_key=key)
        _client_key = key
    return _client


async def transcribe(ogg_bytes: bytes) -> str:
    """Transcribe audio bytes (OGG/opus) to text using Whisper."""
    client = _get_client()
    # OpenAI expects a file-like object with a name attribute
    import io

    buf = io.BytesIO(ogg_bytes)
    buf.name = "voice.ogg"

    response = await client.audio.transcriptions.create(
        model="whisper-1",
        file=buf,
    )
    return response.text


async def text_to_speech(text: str) -> bytes:
    """Convert text to speech using OpenAI TTS. Returns OGG/opus bytes."""
    client = _get_client()
    response = await client.audio.speech.create(
        model=config.tts_model,
        voice=config.tts_voice,
        input=text,
        response_format="opus",
    )
    return response.content

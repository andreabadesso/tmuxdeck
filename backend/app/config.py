from pathlib import Path

from pydantic_settings import BaseSettings


class AppConfig(BaseSettings):
    data_dir: str = "/data"
    docker_socket: str = "/var/run/docker.sock"
    container_name_prefix: str = "tmuxdeck"
    templates_dir: str = "/app/docker/templates"
    host_tmux_socket: str = ""  # e.g. "/tmp/tmux-host/default"
    static_dir: str = ""  # Path to frontend static files (set by Nix package)

    # IP allowlist (Tailscale + localhost) — disabled by default, enable when ready
    ip_allowlist_enabled: bool = False
    ip_allowlist: str = "127.0.0.0/8,::1,100.64.0.0/10"

    # Login rate limiting
    login_max_attempts: int = 5
    login_backoff_base_seconds: int = 2
    login_lockout_threshold_seconds: int = 60

    # OpenAI (voice agent)
    openai_api_key: str = ""
    chat_agent_model: str = "gpt-4o"
    tts_model: str = "tts-1"
    tts_voice: str = "alloy"

    model_config = {"env_file": ".env", "extra": "ignore"}

    @property
    def data_path(self) -> Path:
        return Path(self.data_dir)


config = AppConfig()

"""Login rate limiter with exponential backoff and hard lockout."""

from __future__ import annotations

import time

from .config import config


class IPState:
    """Per-IP failure tracking."""

    __slots__ = ("failures", "last_failure_at", "locked")

    def __init__(self) -> None:
        self.failures: int = 0
        self.last_failure_at: float = 0.0
        self.locked: bool = False


class CheckResult:
    """Result of a rate-limit check."""

    __slots__ = ("allowed", "retry_after", "locked")

    def __init__(self, *, allowed: bool, retry_after: float = 0.0, locked: bool = False) -> None:
        self.allowed = allowed
        self.retry_after = retry_after
        self.locked = locked


class LoginRateLimiter:
    def __init__(
        self,
        max_attempts: int | None = None,
        backoff_base: int | None = None,
        lockout_threshold: int | None = None,
    ) -> None:
        self._max_attempts = max_attempts if max_attempts is not None else config.login_max_attempts
        self._backoff_base = backoff_base if backoff_base is not None else config.login_backoff_base_seconds
        self._lockout_threshold = lockout_threshold if lockout_threshold is not None else config.login_lockout_threshold_seconds
        self._state: dict[str, IPState] = {}

    def _get(self, ip: str) -> IPState:
        state = self._state.get(ip)
        if state is None:
            state = IPState()
            self._state[ip] = state
        return state

    def check(self, ip: str) -> CheckResult:
        """Check if *ip* is allowed to attempt login.

        Returns a ``CheckResult`` with ``allowed=False`` if throttled or locked.
        """
        state = self._get(ip)

        if state.locked:
            return CheckResult(allowed=False, locked=True)

        if state.failures < self._max_attempts:
            return CheckResult(allowed=True)

        # Exponential backoff: base * 2^(excess_failures)
        excess = state.failures - self._max_attempts
        delay = self._backoff_base * (2 ** excess)

        elapsed = time.time() - state.last_failure_at
        remaining = delay - elapsed

        if remaining > 0:
            return CheckResult(allowed=False, retry_after=remaining, locked=False)

        return CheckResult(allowed=True)

    def record_failure(self, ip: str) -> dict:
        """Record a failed login attempt.

        Returns a dict with ``remaining_attempts``, ``retry_after``, and ``locked``.
        """
        state = self._get(ip)
        state.failures += 1
        state.last_failure_at = time.time()

        remaining_attempts = max(0, self._max_attempts - state.failures)

        # Check if we should trigger hard lockout
        if state.failures > self._max_attempts:
            excess = state.failures - self._max_attempts
            delay = self._backoff_base * (2 ** excess)
            if delay > self._lockout_threshold:
                state.locked = True
                return {
                    "remaining_attempts": 0,
                    "retry_after": 0,
                    "locked": True,
                }
            return {
                "remaining_attempts": 0,
                "retry_after": delay,
                "locked": False,
            }

        return {
            "remaining_attempts": remaining_attempts,
            "retry_after": 0,
            "locked": False,
        }

    def record_success(self, ip: str) -> None:
        """Reset failure counter on successful login."""
        self._state.pop(ip, None)

    def is_locked(self, ip: str) -> bool:
        """Check if *ip* is hard-locked."""
        state = self._state.get(ip)
        return state is not None and state.locked

    def is_any_locked(self) -> bool:
        """Check if any IP is hard-locked."""
        return any(s.locked for s in self._state.values())

    def unlock(self, ip: str) -> None:
        """Unlock a specific IP."""
        self._state.pop(ip, None)

    def unlock_all(self) -> None:
        """Unlock all IPs."""
        self._state.clear()


# Module-level singleton (same pattern as auth._sessions)
_limiter: LoginRateLimiter | None = None


def get_limiter() -> LoginRateLimiter:
    global _limiter
    if _limiter is None:
        _limiter = LoginRateLimiter()
    return _limiter

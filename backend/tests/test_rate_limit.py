"""Tests for LoginRateLimiter."""

from __future__ import annotations

import time
from unittest.mock import patch

from app.rate_limit import LoginRateLimiter


class TestRateLimiter:
    def _make(self, **kwargs) -> LoginRateLimiter:
        return LoginRateLimiter(
            max_attempts=kwargs.get("max_attempts", 5),
            backoff_base=kwargs.get("backoff_base", 2),
            lockout_threshold=kwargs.get("lockout_threshold", 60),
        )

    def test_allows_initial_attempts(self):
        limiter = self._make()
        for _ in range(5):
            assert limiter.check("1.2.3.4").allowed is True
            limiter.record_failure("1.2.3.4")

    def test_throttles_after_max_attempts(self):
        limiter = self._make(max_attempts=3)
        for _ in range(3):
            limiter.record_failure("1.2.3.4")
        # 4th attempt should still be checked but after max it throttles
        limiter.record_failure("1.2.3.4")
        check = limiter.check("1.2.3.4")
        assert check.allowed is False
        assert check.retry_after > 0

    def test_exponential_backoff_values(self):
        limiter = self._make(max_attempts=2, backoff_base=2)
        ip = "10.0.0.1"
        # Fill up max_attempts
        for _ in range(2):
            limiter.record_failure(ip)
        # failures=3, excess=1 → delay = 2 * 2^1 = 4
        result = limiter.record_failure(ip)
        assert result["retry_after"] == 4
        # failures=4, excess=2 → delay = 2 * 2^2 = 8
        result = limiter.record_failure(ip)
        assert result["retry_after"] == 8
        # failures=5, excess=3 → delay = 2 * 2^3 = 16
        result = limiter.record_failure(ip)
        assert result["retry_after"] == 16

    def test_success_resets_counter(self):
        limiter = self._make(max_attempts=3)
        for _ in range(3):
            limiter.record_failure("1.2.3.4")
        limiter.record_success("1.2.3.4")
        # After success, should be back to clean state
        check = limiter.check("1.2.3.4")
        assert check.allowed is True

    def test_per_ip_isolation(self):
        limiter = self._make(max_attempts=2)
        for _ in range(5):
            limiter.record_failure("1.1.1.1")
        # Different IP should be unaffected
        assert limiter.check("2.2.2.2").allowed is True

    def test_hard_lockout_trigger(self):
        limiter = self._make(max_attempts=2, backoff_base=2, lockout_threshold=10)
        ip = "5.5.5.5"
        # Fill max_attempts
        for _ in range(2):
            limiter.record_failure(ip)
        # excess 0: delay=2, excess 1: delay=4, excess 2: delay=8, excess 3: delay=16 > 10
        limiter.record_failure(ip)  # delay=2
        limiter.record_failure(ip)  # delay=4
        limiter.record_failure(ip)  # delay=8
        result = limiter.record_failure(ip)  # delay=16 > 10 → locked
        assert result["locked"] is True

        check = limiter.check(ip)
        assert check.allowed is False
        assert check.locked is True

    def test_unlock(self):
        limiter = self._make(max_attempts=2, backoff_base=2, lockout_threshold=4)
        ip = "5.5.5.5"
        for _ in range(2):
            limiter.record_failure(ip)
        limiter.record_failure(ip)  # delay=2
        limiter.record_failure(ip)  # delay=4
        limiter.record_failure(ip)  # delay=8 > 4 → locked
        assert limiter.is_locked(ip) is True

        limiter.unlock(ip)
        assert limiter.is_locked(ip) is False
        assert limiter.check(ip).allowed is True

    def test_unlock_all(self):
        limiter = self._make(max_attempts=1, backoff_base=2, lockout_threshold=1)
        for ip in ["1.1.1.1", "2.2.2.2"]:
            limiter.record_failure(ip)
            limiter.record_failure(ip)  # delay=2 > 1 → locked
        assert limiter.is_any_locked() is True

        limiter.unlock_all()
        assert limiter.is_any_locked() is False

    def test_allows_after_backoff_elapses(self):
        limiter = self._make(max_attempts=2, backoff_base=1)
        ip = "9.9.9.9"
        for _ in range(2):
            limiter.record_failure(ip)
        limiter.record_failure(ip)  # excess=0, delay=1

        # Right after failure, should be throttled
        check = limiter.check(ip)
        assert check.allowed is False

        # Simulate time passing beyond the delay
        state = limiter._get(ip)
        state.last_failure_at = time.time() - 2.0

        check = limiter.check(ip)
        assert check.allowed is True

    def test_remaining_attempts_counts_down(self):
        limiter = self._make(max_attempts=5)
        ip = "3.3.3.3"
        for i in range(5):
            result = limiter.record_failure(ip)
            assert result["remaining_attempts"] == 5 - (i + 1)

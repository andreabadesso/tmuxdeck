"""Tests for IP allowlist parsing and matching."""

from __future__ import annotations

from app.ip_allowlist import is_ip_allowed, parse_allowlist


class TestParseAllowlist:
    def test_parses_valid_cidrs(self):
        networks = parse_allowlist("127.0.0.0/8,::1,100.64.0.0/10")
        assert len(networks) == 3

    def test_skips_empty_entries(self):
        networks = parse_allowlist("127.0.0.0/8,,  ,::1")
        assert len(networks) == 2

    def test_skips_invalid_entries(self):
        networks = parse_allowlist("127.0.0.0/8,not-a-cidr,::1")
        assert len(networks) == 2

    def test_empty_string(self):
        assert parse_allowlist("") == []

    def test_strips_whitespace(self):
        networks = parse_allowlist("  127.0.0.0/8 , ::1 ")
        assert len(networks) == 2


class TestIsIpAllowed:
    def _default_networks(self):
        return parse_allowlist("127.0.0.0/8,::1,100.64.0.0/10")

    def test_localhost_ipv4(self):
        nets = self._default_networks()
        assert is_ip_allowed("127.0.0.1", nets) is True
        assert is_ip_allowed("127.0.0.2", nets) is True

    def test_localhost_ipv6(self):
        nets = self._default_networks()
        assert is_ip_allowed("::1", nets) is True

    def test_tailscale_range(self):
        nets = self._default_networks()
        assert is_ip_allowed("100.64.0.1", nets) is True
        assert is_ip_allowed("100.100.100.100", nets) is True
        assert is_ip_allowed("100.127.255.255", nets) is True

    def test_public_ips_blocked(self):
        nets = self._default_networks()
        assert is_ip_allowed("8.8.8.8", nets) is False
        assert is_ip_allowed("1.1.1.1", nets) is False
        assert is_ip_allowed("203.0.113.1", nets) is False

    def test_docker_bridge_blocked(self):
        nets = self._default_networks()
        assert is_ip_allowed("172.17.0.1", nets) is False
        assert is_ip_allowed("172.18.0.2", nets) is False

    def test_private_lan_blocked(self):
        nets = self._default_networks()
        assert is_ip_allowed("192.168.1.1", nets) is False
        assert is_ip_allowed("10.0.0.1", nets) is False

    def test_ipv4_mapped_ipv6(self):
        nets = self._default_networks()
        # ::ffff:127.0.0.1 should be treated as 127.0.0.1
        assert is_ip_allowed("::ffff:127.0.0.1", nets) is True
        assert is_ip_allowed("::ffff:8.8.8.8", nets) is False

    def test_invalid_ip(self):
        nets = self._default_networks()
        assert is_ip_allowed("not-an-ip", nets) is False
        assert is_ip_allowed("", nets) is False

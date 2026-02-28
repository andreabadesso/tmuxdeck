"""IP allowlist middleware — restrict access to localhost + Tailscale CGNAT."""

from __future__ import annotations

import logging
from ipaddress import IPv4Address, IPv6Address, ip_address, ip_network

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from .config import config

logger = logging.getLogger(__name__)


def parse_allowlist(raw: str) -> list:
    """Parse a comma-separated string of CIDRs into a list of network objects."""
    networks = []
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        try:
            networks.append(ip_network(entry, strict=False))
        except ValueError:
            logger.warning("Ignoring invalid CIDR in allowlist: %s", entry)
    return networks


def is_ip_allowed(client_ip: str, networks: list) -> bool:
    """Check if *client_ip* falls within any of the allowed *networks*.

    Handles IPv4-mapped IPv6 addresses (e.g. ``::ffff:127.0.0.1``).
    """
    try:
        addr = ip_address(client_ip)
    except ValueError:
        return False

    # Convert IPv4-mapped IPv6 to plain IPv4 for matching
    if isinstance(addr, IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped

    for net in networks:
        try:
            if addr in net:
                return True
        except TypeError:
            # Mismatched address families (e.g. IPv6 addr vs IPv4 network) — skip
            continue
    return False


class IPAllowlistMiddleware(BaseHTTPMiddleware):
    """Reject requests from IPs not in the configured allowlist."""

    def __init__(self, app, **kwargs):
        super().__init__(app, **kwargs)
        self._networks = parse_allowlist(config.ip_allowlist)
        logger.info(
            "IP allowlist enabled with %d network(s): %s",
            len(self._networks),
            config.ip_allowlist,
        )

    async def dispatch(self, request: Request, call_next):
        if not config.ip_allowlist_enabled:
            return await call_next(request)

        client_ip = request.client.host if request.client else None
        if client_ip is None or not is_ip_allowed(client_ip, self._networks):
            logger.warning("Blocked request from %s", client_ip)
            return JSONResponse(
                {"detail": "Forbidden"},
                status_code=403,
            )

        return await call_next(request)

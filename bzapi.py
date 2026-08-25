"""
Thin, polite clients for the two APIs this tool uses.

  SkyCofl (sky.coflnet.com)  -> historical bazaar series (the thing you actually want)
  Hypixel  (api.hypixel.net) -> authoritative list of bazaar product IDs + live order book

Why both: Coflnet has the history, but its item tags have to match Hypixel's product IDs
exactly. Rather than guess tags, we pull the real list from Hypixel once and validate.

Rate limits (from Coflnet's wiki): 30 req / 10s AND 100 req / 60s, per IP, enforced in
parallel. They explicitly recommend ~1 request per second for direct API use. We enforce
that with a min-interval limiter plus a disk cache, because a scan over 25 recipes is
50+ requests and you'll get blacklisted if you fire them off in parallel.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

COFL_ROOT = "https://sky.coflnet.com/api"
HYPIXEL_BAZAAR = "https://api.hypixel.net/v2/skyblock/bazaar"

# Identify yourself. Coflnet asks for attribution if you build on their data.
USER_AGENT = "bzcraft/1.0 (personal bazaar craft scanner; data via SkyCofl)"


class RateLimiter:
    """Single-threaded min-interval limiter. Deliberately not a token bucket:
    Coflnet's short 10s window means bursting is what gets you blocked."""

    def __init__(self, min_interval: float = 1.05):
        self.min_interval = min_interval
        self._last = 0.0

    def wait(self) -> None:
        elapsed = time.monotonic() - self._last
        if elapsed < self.min_interval:
            time.sleep(self.min_interval - elapsed)
        self._last = time.monotonic()


class DiskCache:
    """Dumb JSON file cache. Keeps repeat scans off the network entirely."""

    def __init__(self, directory: str = ".bzcache"):
        self.dir = directory
        os.makedirs(self.dir, exist_ok=True)

    def _path(self, key: str) -> str:
        digest = hashlib.sha1(key.encode()).hexdigest()[:20]
        return os.path.join(self.dir, f"{digest}.json")

    def get(self, key: str, ttl_seconds: float) -> Any | None:
        if ttl_seconds <= 0:
            return None
        path = self._path(key)
        if not os.path.exists(path):
            return None
        if time.time() - os.path.getmtime(path) > ttl_seconds:
            return None
        try:
            with open(path) as handle:
                return json.load(handle)
        except (json.JSONDecodeError, OSError):
            return None

    def set(self, key: str, value: Any) -> None:
        try:
            with open(self._path(key), "w") as handle:
                json.dump(value, handle)
        except OSError:
            pass  # cache failures should never break a scan


class ApiError(RuntimeError):
    pass


class BazaarClient:
    def __init__(
        self,
        cache_dir: str = ".bzcache",
        min_interval: float = 1.05,
        token: str | None = None,
        verbose: bool = False,
    ):
        self.limiter = RateLimiter(min_interval)
        self.cache = DiskCache(cache_dir)
        self.verbose = verbose
        self.session = requests.Session()
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        if token:
            # Only needed for Premium endpoints (exports). History is free.
            headers["Authorization"] = f"Bearer {token}"
        self.session.headers.update(headers)

    # ------------------------------------------------------------------ core

    def _get(
        self,
        url: str,
        params: dict | None = None,
        ttl: float = 0,
        max_retries: int = 4,
    ) -> Any:
        cache_key = url + "?" + json.dumps(params or {}, sort_keys=True)
        cached = self.cache.get(cache_key, ttl)
        if cached is not None:
            if self.verbose:
                print(f"  cache hit: {url}")
            return cached

        for attempt in range(max_retries):
            self.limiter.wait()
            if self.verbose:
                print(f"  GET {url} {params or ''}")
            try:
                response = self.session.get(url, params=params, timeout=30)
            except requests.RequestException as exc:
                if attempt == max_retries - 1:
                    raise ApiError(f"network error for {url}: {exc}") from exc
                time.sleep(2 ** attempt)
                continue

            if response.status_code == 429:
                # Respect Retry-After. Their headers only report the longest active
                # window, so you can get 429s that look impossible from the headers.
                delay = float(response.headers.get("Retry-After", 5))
                if self.verbose:
                    print(f"  429 rate limited, sleeping {delay}s")
                time.sleep(min(delay, 60))
                continue

            if response.status_code == 404:
                return None  # unknown tag -> caller decides what that means

            if not response.ok:
                if attempt == max_retries - 1:
                    raise ApiError(f"{response.status_code} from {url}: {response.text[:200]}")
                time.sleep(2 ** attempt)
                continue

            try:
                payload = response.json()
            except json.JSONDecodeError as exc:
                raise ApiError(f"non-JSON response from {url}") from exc

            self.cache.set(cache_key, payload)
            return payload

        raise ApiError(f"gave up on {url} after {max_retries} attempts")

    # ------------------------------------------------------------- endpoints

    def snapshot(self, tag: str, ttl: float = 60) -> dict | None:
        """Current bazaar state for one item, including partial order book."""
        return self._get(f"{COFL_ROOT}/bazaar/{tag}/snapshot", ttl=ttl)

    def history_span(self, tag: str, span: str = "day", ttl: float = 1800) -> list[dict]:
        """span: 'hour' (1m buckets), 'day' (5m buckets), 'week' (2h buckets)."""
        if span not in {"hour", "day", "week"}:
            raise ValueError("span must be hour, day or week")
        data = self._get(f"{COFL_ROOT}/bazaar/{tag}/history/{span}", ttl=ttl)
        return data or []

    def history_range(
        self, tag: str, start: datetime, end: datetime, ttl: float = 3600
    ) -> list[dict]:
        """Custom window. Resolution is chosen server-side and gets coarser as you
        go further back, so don't assume evenly spaced buckets."""
        params = {
            "start": _iso(start),
            "end": _iso(end),
        }
        data = self._get(f"{COFL_ROOT}/bazaar/{tag}/history", params=params, ttl=ttl)
        return data or []

    def history_days(self, tag: str, days: int = 14, ttl: float = 3600) -> list[dict]:
        end = datetime.now(timezone.utc)
        return self.history_range(tag, end - timedelta(days=days), end, ttl=ttl)

    # -------------------------------------------------------------- hypixel

    def hypixel_products(self, ttl: float = 86400) -> dict[str, dict]:
        """Every live bazaar product keyed by productId. No API key needed.
        This is the source of truth for valid tags."""
        payload = self._get(HYPIXEL_BAZAAR, ttl=ttl)
        if not payload or not payload.get("success"):
            raise ApiError("Hypixel bazaar endpoint returned failure")
        return payload.get("products", {})


def _iso(moment: datetime) -> str:
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

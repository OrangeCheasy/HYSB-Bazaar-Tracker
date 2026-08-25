"""
Turning raw bazaar history into decisions.

THE ONE THING THAT MATTERS MOST HERE
------------------------------------
Hypixel's field names are famously ambiguous ("buyPrice" is what *you* pay to instant
buy, i.e. the lowest sell offer). People invert this constantly and end up with profit
numbers that are backwards. So this module refuses to trust the names and instead uses
market structure, which cannot be wrong:

    ask = the higher of the two prices = lowest SELL OFFER
          -> what you pay to instant-buy
          -> what your own sell offer competes against
    bid = the lower of the two prices = highest BUY ORDER
          -> what you receive when you instant-sell
          -> what your own buy order competes against

ask > bid always, because if they crossed the book would match. We pick the side by
comparing medians across the whole series, then keep that mapping consistent.

WHAT THIS MEANS FOR YOUR STRATEGY
Placing a buy order overnight means you fill near `bid`, not `ask`. Selling the crafted
enchanted item via a sell offer means you fill near `ask`, not `bid`. Using ask-to-bid
(the "instant both ways" numbers) will make every craft look unprofitable; using
bid-to-ask is your realistic case, with the caveat that both orders have to actually fill.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from datetime import datetime, timezone, tzinfo
from typing import Iterable, Sequence

HOURS_PER_WEEK = 168.0


@dataclass
class Point:
    ts: datetime
    ask: float           # lowest sell offer
    ask_min: float
    ask_max: float
    bid: float           # highest buy order
    bid_min: float
    bid_max: float
    ask_depth: float     # units resting in sell offers
    bid_depth: float     # units resting in buy orders (the queue ahead of your order)
    instant_buy_week: float   # units instant-bought over trailing week
    instant_sell_week: float  # units instant-sold over trailing week (fills YOUR buy orders)


def _num(raw: dict, *names: str, default: float = 0.0) -> float:
    for name in names:
        if name in raw and raw[name] is not None:
            try:
                return float(raw[name])
            except (TypeError, ValueError):
                continue
    return default


def _parse_ts(raw: dict) -> datetime:
    value = raw.get("timestamp") or raw.get("timeStamp") or raw.get("time")
    if not value:
        return datetime.now(timezone.utc)
    text = str(value).replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return datetime.now(timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


@dataclass
class Series:
    tag: str
    points: list[Point] = field(default_factory=list)
    ask_prefix: str = "buy"   # which raw field name turned out to be the ask side

    def __bool__(self) -> bool:
        return bool(self.points)

    @property
    def latest(self) -> Point:
        return self.points[-1]


def build_series(tag: str, raw_points: Sequence[dict]) -> Series:
    """Normalize a Coflnet history response into an ask/bid series."""
    usable = [p for p in raw_points if isinstance(p, dict)]
    if not usable:
        return Series(tag=tag)

    buys = [_num(p, "buy", "buyPrice") for p in usable]
    sells = [_num(p, "sell", "sellPrice") for p in usable]
    buys = [v for v in buys if v > 0]
    sells = [v for v in sells if v > 0]
    if not buys or not sells:
        return Series(tag=tag)

    # Structural detection: whichever side is consistently higher is the ask.
    ask_prefix = "buy" if statistics.median(buys) >= statistics.median(sells) else "sell"
    bid_prefix = "sell" if ask_prefix == "buy" else "buy"
    ask_title, bid_title = ask_prefix.capitalize(), bid_prefix.capitalize()

    points: list[Point] = []
    for raw in usable:
        ask = _num(raw, ask_prefix, f"{ask_prefix}Price")
        bid = _num(raw, bid_prefix, f"{bid_prefix}Price")
        if ask <= 0 or bid <= 0:
            continue
        points.append(
            Point(
                ts=_parse_ts(raw),
                ask=ask,
                ask_min=_num(raw, f"min{ask_title}", default=ask),
                ask_max=_num(raw, f"max{ask_title}", default=ask),
                bid=bid,
                bid_min=_num(raw, f"min{bid_title}", default=bid),
                bid_max=_num(raw, f"max{bid_title}", default=bid),
                ask_depth=_num(raw, f"{ask_prefix}Volume"),
                bid_depth=_num(raw, f"{bid_prefix}Volume"),
                instant_buy_week=_num(raw, f"{ask_prefix}MovingWeek"),
                instant_sell_week=_num(raw, f"{bid_prefix}MovingWeek"),
            )
        )

    points.sort(key=lambda p: p.ts)
    return Series(tag=tag, points=points, ask_prefix=ask_prefix)


def series_from_snapshot(tag: str, snapshot: dict) -> Series:
    return build_series(tag, [snapshot]) if snapshot else Series(tag=tag)


# --------------------------------------------------------------------- stats


@dataclass
class Stats:
    tag: str
    samples: int
    ask_mean: float
    ask_avg_low: float     # mean of each bucket's low  -> a realistic "good fill" price
    ask_avg_high: float
    ask_floor: float       # absolute lowest seen in window
    ask_ceiling: float
    bid_mean: float
    bid_avg_low: float
    bid_avg_high: float
    bid_floor: float
    bid_ceiling: float
    spread_pct: float
    volatility_pct: float  # stdev of ask / mean ask
    instant_buy_per_hour: float
    instant_sell_per_hour: float
    ask_depth: float
    bid_depth: float
    last_ask: float
    last_bid: float


def summarize(series: Series) -> Stats | None:
    if not series:
        return None
    pts = series.points
    asks = [p.ask for p in pts]
    bids = [p.bid for p in pts]
    ask_mean = statistics.fmean(asks)
    bid_mean = statistics.fmean(bids)
    last = pts[-1]
    return Stats(
        tag=series.tag,
        samples=len(pts),
        ask_mean=ask_mean,
        ask_avg_low=statistics.fmean([p.ask_min for p in pts]),
        ask_avg_high=statistics.fmean([p.ask_max for p in pts]),
        ask_floor=min(p.ask_min for p in pts),
        ask_ceiling=max(p.ask_max for p in pts),
        bid_mean=bid_mean,
        bid_avg_low=statistics.fmean([p.bid_min for p in pts]),
        bid_avg_high=statistics.fmean([p.bid_max for p in pts]),
        bid_floor=min(p.bid_min for p in pts),
        bid_ceiling=max(p.bid_max for p in pts),
        spread_pct=(ask_mean - bid_mean) / ask_mean * 100 if ask_mean else 0.0,
        volatility_pct=(statistics.pstdev(asks) / ask_mean * 100) if ask_mean and len(asks) > 1 else 0.0,
        instant_buy_per_hour=last.instant_buy_week / HOURS_PER_WEEK,
        instant_sell_per_hour=last.instant_sell_week / HOURS_PER_WEEK,
        ask_depth=last.ask_depth,
        bid_depth=last.bid_depth,
        last_ask=last.ask,
        last_bid=last.bid,
    )


# ------------------------------------------------------------- hour profile


@dataclass
class HourCell:
    hour: int
    samples: int
    ask_mean: float
    bid_mean: float
    ask_index: float = 0.0   # % vs the 24h mean; negative = cheaper than average
    bid_index: float = 0.0


def hour_profile(series: Series, tz: tzinfo) -> list[HourCell]:
    """Average ask/bid by local hour of day.

    Caveat worth knowing: Coflnet coarsens resolution the further back you go, so a
    14-day pull may give you 2h buckets. That is still fine for a diurnal pattern,
    it just means adjacent hours share information. Don't read a 0.3% difference
    between two hours as signal.
    """
    buckets: dict[int, list[tuple[float, float]]] = {h: [] for h in range(24)}
    for p in series.points:
        buckets[p.ts.astimezone(tz).hour].append((p.ask, p.bid))

    cells = [
        HourCell(
            hour=h,
            samples=len(v),
            ask_mean=statistics.fmean([a for a, _ in v]) if v else 0.0,
            bid_mean=statistics.fmean([b for _, b in v]) if v else 0.0,
        )
        for h, v in sorted(buckets.items())
    ]
    populated = [c for c in cells if c.samples]
    if not populated:
        return cells
    ask_base = statistics.fmean([c.ask_mean for c in populated])
    bid_base = statistics.fmean([c.bid_mean for c in populated])
    for cell in populated:
        cell.ask_index = (cell.ask_mean / ask_base - 1) * 100 if ask_base else 0.0
        cell.bid_index = (cell.bid_mean / bid_base - 1) * 100 if bid_base else 0.0
    return cells


def best_window(
    cells: Sequence[HourCell], key: str, length: int, minimize: bool
) -> tuple[list[int], float]:
    """Best contiguous run of `length` hours (wrapping past midnight)."""
    valid = [c for c in cells if c.samples]
    if not valid or length <= 0:
        return [], 0.0
    values = {c.hour: getattr(c, key) for c in valid}
    best_hours: list[int] = []
    best_score = float("inf") if minimize else float("-inf")
    for start in range(24):
        window = [(start + offset) % 24 for offset in range(length)]
        present = [values[h] for h in window if h in values]
        if len(present) < max(1, length // 2):
            continue
        score = statistics.fmean(present)
        if (minimize and score < best_score) or (not minimize and score > best_score):
            best_score, best_hours = score, window
    return best_hours, best_score


def mean_over_hours(cells: Sequence[HourCell], hours: Iterable[int], key: str) -> float:
    lookup = {c.hour: getattr(c, key) for c in cells if c.samples}
    picked = [lookup[h] for h in hours if h in lookup]
    return statistics.fmean(picked) if picked else 0.0


# --------------------------------------------------------------- craft model


@dataclass
class CraftResult:
    base_tag: str
    ench_tag: str
    ratio: int

    # Scenario A: no patience. Instant-buy the base, instant-sell the enchanted.
    floor_cost: float
    floor_revenue_net: float
    floor_profit: float
    floor_margin_pct: float

    # Scenario B: current book, using orders on both sides.
    order_cost: float
    order_revenue_net: float
    order_profit: float
    order_margin_pct: float

    # Scenario C: your overnight plan. Buy in the cheap window, sell in the peak window.
    timed_buy_price: float
    timed_sell_price: float
    timed_cost: float
    timed_revenue_net: float
    timed_profit: float
    timed_margin_pct: float

    # Reality checks
    crafts_per_day_supply: float   # limited by base flowing into your buy orders
    crafts_per_day_demand: float   # limited by people instant-buying the enchanted
    crafts_per_day: float
    profit_per_day: float
    capital_per_craft: float
    hours_to_fill_one_craft: float
    base_volatility_pct: float
    ench_volatility_pct: float
    notes: list[str] = field(default_factory=list)


def craft_economics(
    base: Stats,
    ench: Stats,
    ratio: int,
    *,
    tax: float,
    tick: float,
    capture: float,
    timed_buy_price: float | None = None,
    timed_sell_price: float | None = None,
) -> CraftResult:
    """
    tax     : bazaar sell tax as a fraction (0.0125 base, 0.01 with Bazaar Flipper II,
              ~0.0225 under Mayor Aura). Applies to your sell offer proceeds only.
    tick    : how much you outbid/undercut by, in coins per unit.
    capture : fraction of total market flow you realistically get. You are not the only
              person doing this. 0.15-0.3 is honest for a popular item.
    """
    notes: list[str] = []

    # A -- instant both ways. This is your worst case and your true floor.
    floor_cost = ratio * base.last_ask
    floor_revenue_net = ench.last_bid * (1 - tax)
    floor_profit = floor_revenue_net - floor_cost

    # B -- orders both ways on the current book.
    order_buy = base.last_bid + tick
    order_sell = max(ench.last_ask - tick, 0.0)
    order_cost = ratio * order_buy
    order_revenue_net = order_sell * (1 - tax)
    order_profit = order_revenue_net - order_cost

    # C -- time-aware. Falls back to B if we have no hourly profile.
    buy_price = timed_buy_price if timed_buy_price else order_buy
    sell_price = timed_sell_price if timed_sell_price else order_sell
    timed_cost = ratio * buy_price
    timed_revenue_net = sell_price * (1 - tax)
    timed_profit = timed_revenue_net - timed_cost

    # Throughput. A 40% margin on an item that trades 200 units a day is not a business.
    supply_per_day = base.instant_sell_per_hour * 24 * capture
    crafts_supply = supply_per_day / ratio if ratio else 0.0
    crafts_demand = ench.instant_buy_per_hour * 24 * capture
    crafts_per_day = min(crafts_supply, crafts_demand)

    hours_to_fill = (
        ratio / (base.instant_sell_per_hour * capture)
        if base.instant_sell_per_hour * capture > 0
        else float("inf")
    )

    if base.bid_depth > 0 and base.instant_sell_per_hour > 0:
        queue_hours = base.bid_depth / base.instant_sell_per_hour
        if queue_hours > 48:
            notes.append(f"deep buy-order queue (~{queue_hours:.0f}h of flow resting)")
    if ench.instant_buy_per_hour < 1:
        notes.append("enchanted barely instant-buys; sell offers may sit for days")
    if base.volatility_pct > 12:
        notes.append(f"base volatile ({base.volatility_pct:.0f}%)")
    if timed_profit > 0 and floor_profit < 0:
        notes.append("profit depends entirely on both orders filling")
    if hours_to_fill > 14:
        notes.append("one craft takes >14h of flow; overnight fill unlikely")

    return CraftResult(
        base_tag=base.tag,
        ench_tag=ench.tag,
        ratio=ratio,
        floor_cost=floor_cost,
        floor_revenue_net=floor_revenue_net,
        floor_profit=floor_profit,
        floor_margin_pct=floor_profit / floor_cost * 100 if floor_cost else 0.0,
        order_cost=order_cost,
        order_revenue_net=order_revenue_net,
        order_profit=order_profit,
        order_margin_pct=order_profit / order_cost * 100 if order_cost else 0.0,
        timed_buy_price=buy_price,
        timed_sell_price=sell_price,
        timed_cost=timed_cost,
        timed_revenue_net=timed_revenue_net,
        timed_profit=timed_profit,
        timed_margin_pct=timed_profit / timed_cost * 100 if timed_cost else 0.0,
        crafts_per_day_supply=crafts_supply,
        crafts_per_day_demand=crafts_demand,
        crafts_per_day=crafts_per_day,
        profit_per_day=crafts_per_day * timed_profit,
        capital_per_craft=timed_cost,
        hours_to_fill_one_craft=hours_to_fill,
        base_volatility_pct=base.volatility_pct,
        ench_volatility_pct=ench.volatility_pct,
        notes=notes,
    )

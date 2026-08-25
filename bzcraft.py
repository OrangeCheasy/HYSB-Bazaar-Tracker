#!/usr/bin/env python3
"""
bzcraft - decide what to buy-order overnight, craft into enchanted form, and sell.

Commands
    check            validate every configured tag against Hypixel's live product list
    discover         auto-generate recipe candidates from the live product list
    hours TAG        hour-of-day price profile for a single item
    item BASE_TAG    full breakdown of one craft (stats, hours, all three scenarios)
    scan             run every recipe, rank by profit, write a TSV for Excel

Every command writes a tab-separated .txt into output/ alongside printing to the console.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - py<3.9
    ZoneInfo = None  # type: ignore

from bzapi import ApiError, BazaarClient
from model import (
    CraftResult,
    Stats,
    best_window,
    build_series,
    craft_economics,
    hour_profile,
    mean_over_hours,
    summarize,
)

HERE = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(HERE, "output")


# ----------------------------------------------------------------- utilities


def load_config(path: str) -> dict:
    with open(path) as handle:
        return json.load(handle)


def resolve_tz(name: str | None):
    if name and ZoneInfo:
        return ZoneInfo(name)
    return datetime.now().astimezone().tzinfo


def parse_window(spec: str) -> list[int]:
    """'23-07' -> [23, 0, 1, 2, 3, 4, 5, 6]"""
    start_text, end_text = spec.split("-")
    start, end = int(start_text) % 24, int(end_text) % 24
    hours, cursor = [], start
    for _ in range(24):
        if cursor == end:
            break
        hours.append(cursor)
        cursor = (cursor + 1) % 24
    return hours or [start]


def coins(value: float) -> str:
    if abs(value) >= 1_000_000:
        return f"{value/1_000_000:,.2f}M"
    if abs(value) >= 1_000:
        return f"{value:,.0f}"
    return f"{value:,.2f}"


def hour_label(hours: list[int]) -> str:
    if not hours:
        return "-"
    return f"{hours[0]:02d}:00-{(hours[-1]+1)%24:02d}:00"


def write_tsv(filename: str, header: list[str], rows: list[list]) -> str:
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    path = os.path.join(OUTPUT_DIR, filename)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\t".join(header) + "\n")
        for row in rows:
            handle.write("\t".join("" if c is None else str(c) for c in row) + "\n")
    return path


def get_stats(client: BazaarClient, tag: str, days: int) -> tuple[Stats | None, list]:
    """Returns (stats over the long window, normalized points) for one tag."""
    raw = client.history_days(tag, days=days)
    if not raw:
        raw = client.history_span(tag, "week")
    series = build_series(tag, raw)
    if not series:
        snapshot = client.snapshot(tag)
        series = build_series(tag, [snapshot] if snapshot else [])
    return summarize(series), series


# ------------------------------------------------------------------ commands


def cmd_check(args, config: dict) -> None:
    client = BazaarClient(verbose=args.verbose)
    products = client.hypixel_products()
    print(f"Hypixel reports {len(products)} live bazaar products.\n")

    rows, bad = [], 0
    for recipe in config["recipes"]:
        base_ok = recipe["base"] in products
        ench_ok = recipe["enchanted"] in products
        status = "ok" if base_ok and ench_ok else "BAD TAG"
        if status != "ok":
            bad += 1
            print(f"  {status:8} {recipe['base']:28} -> {recipe['enchanted']:32} "
                  f"(base:{'y' if base_ok else 'n'} ench:{'y' if ench_ok else 'n'})")
        rows.append([recipe["base"], recipe["enchanted"], recipe["ratio"],
                     "yes" if base_ok else "no", "yes" if ench_ok else "no", status])

    path = write_tsv("tag_check.txt",
                     ["base", "enchanted", "ratio", "base_valid", "ench_valid", "status"], rows)
    print(f"\n{len(rows) - bad}/{len(rows)} recipes valid. Details: {path}")
    if bad:
        print("Fix or delete the bad rows in config.json before scanning. "
              "Try `discover` to find the real tag names.")


def cmd_discover(args, config: dict) -> None:
    """Find every X / ENCHANTED_X pair that actually exists on the bazaar."""
    client = BazaarClient(verbose=args.verbose)
    products = client.hypixel_products()
    known = {(r["base"], r["enchanted"]) for r in config["recipes"]}

    found = []
    for pid in sorted(products):
        if not pid.startswith("ENCHANTED_"):
            continue
        stem = pid[len("ENCHANTED_"):]
        for candidate in (stem, f"{stem}_ITEM", f"RAW_{stem}", f"{stem}_ORE"):
            if candidate in products and candidate != pid:
                found.append((candidate, pid))
                break

    fresh = [pair for pair in found if pair not in known]
    rows = [[b, e, 160, "already in config" if (b, e) in known else "new"] for b, e in found]
    path = write_tsv("discovered_recipes.txt", ["base", "enchanted", "guessed_ratio", "status"], rows)

    print(f"{len(found)} name-matched pairs on the live bazaar, {len(fresh)} not in your config.")
    for b, e in fresh[:40]:
        print(f"  new  {b:28} -> {e}")
    print(f"\nWritten to {path}")
    print("Ratios are GUESSED at 160. Confirm each recipe in game before trusting it — "
          "name matching cannot see the actual crafting grid.")


def cmd_hours(args, config: dict) -> None:
    client = BazaarClient(verbose=args.verbose)
    tz = resolve_tz(args.tz)
    days = args.days or config.get("history_days", 14)

    _, series = get_stats(client, args.tag, days)
    if not series:
        print(f"No history for {args.tag}. Run `check` — the tag is probably wrong.")
        return

    cells = hour_profile(series, tz)
    print(f"\n{args.tag} — {days}d hour-of-day profile ({tz}) — "
          f"ask field detected as '{series.ask_prefix}'\n")
    print(f"{'hour':>5} {'n':>5} {'top buy order':>15} {'vs avg':>8} "
          f"{'low sell offer':>15} {'vs avg':>8}")
    rows = []
    for cell in cells:
        if not cell.samples:
            continue
        print(f"{cell.hour:>5} {cell.samples:>5} {coins(cell.bid_mean):>15} "
              f"{cell.bid_index:>+7.2f}% {coins(cell.ask_mean):>15} {cell.ask_index:>+7.2f}%")
        rows.append([cell.hour, cell.samples, round(cell.bid_mean, 3), round(cell.bid_index, 3),
                     round(cell.ask_mean, 3), round(cell.ask_index, 3)])

    cheap, cheap_score = best_window(cells, "bid_index", args.window, minimize=True)
    rich, rich_score = best_window(cells, "ask_index", args.window, minimize=False)
    print(f"\ncheapest {args.window}h to hold a buy order : {hour_label(cheap)} ({cheap_score:+.2f}%)")
    print(f"richest  {args.window}h to hold a sell offer: {hour_label(rich)} ({rich_score:+.2f}%)")

    path = write_tsv(f"hours_{args.tag.replace(':', '_')}.txt",
                     ["hour", "samples", "top_buy_order", "bid_index_pct",
                      "low_sell_offer", "ask_index_pct"], rows)
    print(f"\nWritten to {path}")


def analyze_pair(client, recipe, config, tz, sleep_hours, days, sell_window):
    base_stats, base_series = get_stats(client, recipe["base"], days)
    ench_stats, ench_series = get_stats(client, recipe["enchanted"], days)
    if not base_stats or not ench_stats:
        return None, None, None

    base_cells = hour_profile(base_series, tz)
    ench_cells = hour_profile(ench_series, tz)

    overnight_bid = mean_over_hours(base_cells, sleep_hours, "bid_mean") or base_stats.last_bid
    peak_hours, _ = best_window(ench_cells, "ask_index", sell_window, minimize=False)
    peak_ask = mean_over_hours(ench_cells, peak_hours, "ask_mean") or ench_stats.last_ask

    result = craft_economics(
        base_stats, ench_stats, recipe["ratio"],
        tax=config["tax"], tick=config["tick"], capture=config["capture"],
        timed_buy_price=overnight_bid + config["tick"],
        timed_sell_price=max(peak_ask - config["tick"], 0.0),
    )
    return result, peak_hours, (base_cells, ench_cells)


def cmd_item(args, config: dict) -> None:
    client = BazaarClient(verbose=args.verbose)
    tz = resolve_tz(args.tz)
    days = args.days or config.get("history_days", 14)
    sleep_hours = parse_window(args.sleep or config.get("sleep_window", "23-07"))

    recipe = next((r for r in config["recipes"] if r["base"] == args.tag
                   or r["enchanted"] == args.tag), None)
    if not recipe:
        print(f"{args.tag} is not in config.json. Add it, or run `discover`.")
        return

    result, peak_hours, _ = analyze_pair(client, recipe, config, tz, sleep_hours, days, args.window)
    if not result:
        print("No usable history for that pair.")
        return

    print(f"\n{recipe['base']} x{recipe['ratio']} -> {recipe['enchanted']}   [{days}d window]")
    print(f"buy-order window {hour_label(sleep_hours)}   sell window {hour_label(peak_hours)}   ({tz})\n")

    print(f"{'scenario':<34} {'cost':>14} {'net revenue':>14} {'profit':>14} {'margin':>9}")
    for label, cost, revenue, profit, margin in [
        ("A instant buy -> instant sell", result.floor_cost, result.floor_revenue_net,
         result.floor_profit, result.floor_margin_pct),
        ("B order -> offer, current book", result.order_cost, result.order_revenue_net,
         result.order_profit, result.order_margin_pct),
        ("C overnight order -> peak offer", result.timed_cost, result.timed_revenue_net,
         result.timed_profit, result.timed_margin_pct),
    ]:
        print(f"{label:<34} {coins(cost):>14} {coins(revenue):>14} "
              f"{coins(profit):>14} {margin:>8.2f}%")

    print(f"\nbuy order at        {result.timed_buy_price:,.2f} /unit")
    print(f"sell offer at       {result.timed_sell_price:,.2f} /unit")
    print(f"capital per craft   {coins(result.capital_per_craft)}")
    print(f"hours to fill one   {result.hours_to_fill_one_craft:,.1f}h of base flow")
    print(f"crafts/day cap      {result.crafts_per_day:,.1f} "
          f"(supply {result.crafts_per_day_supply:,.1f} / demand {result.crafts_per_day_demand:,.1f})")
    print(f"est. profit/day     {coins(result.profit_per_day)}")
    if result.notes:
        print("\nflags: " + "; ".join(result.notes))


def cmd_scan(args, config: dict) -> None:
    client = BazaarClient(verbose=args.verbose)
    tz = resolve_tz(args.tz)
    days = args.days or config.get("history_days", 14)
    sleep_hours = parse_window(args.sleep or config.get("sleep_window", "23-07"))

    recipes = config["recipes"]
    results: list[tuple[dict, CraftResult, list[int]]] = []

    for index, recipe in enumerate(recipes, 1):
        print(f"[{index}/{len(recipes)}] {recipe['base']} -> {recipe['enchanted']}", flush=True)
        try:
            result, peak_hours, _ = analyze_pair(
                client, recipe, config, tz, sleep_hours, days, args.window)
        except ApiError as exc:
            print(f"    skipped: {exc}")
            continue
        if not result:
            print("    skipped: no history (bad tag?)")
            continue
        results.append((recipe, result, peak_hours))

    results.sort(key=lambda item: item[1].profit_per_day, reverse=True)

    header = [
        "base", "enchanted", "ratio",
        "buy_order_price", "sell_offer_price",
        "cost_per_craft", "net_revenue", "profit_per_craft", "margin_pct",
        "floor_profit", "floor_margin_pct",
        "crafts_per_day", "profit_per_day", "capital_per_craft",
        "hours_to_fill", "base_volatility_pct", "ench_volatility_pct",
        "base_instant_sell_per_hr", "ench_instant_buy_per_hr",
        "buy_window", "sell_window", "flags",
    ]
    rows = []
    for recipe, r, peak in results:
        rows.append([
            r.base_tag, r.ench_tag, r.ratio,
            round(r.timed_buy_price, 3), round(r.timed_sell_price, 2),
            round(r.timed_cost, 2), round(r.timed_revenue_net, 2),
            round(r.timed_profit, 2), round(r.timed_margin_pct, 2),
            round(r.floor_profit, 2), round(r.floor_margin_pct, 2),
            round(r.crafts_per_day, 2), round(r.profit_per_day, 2),
            round(r.capital_per_craft, 2),
            round(r.hours_to_fill_one_craft, 2),
            round(r.base_volatility_pct, 2), round(r.ench_volatility_pct, 2),
            round(r.crafts_per_day_supply * r.ratio / 24, 1),
            round(r.crafts_per_day_demand / 24, 3),
            hour_label(sleep_hours), hour_label(peak), "; ".join(r.notes),
        ])

    print(f"\n{'craft':<46} {'profit/craft':>13} {'margin':>8} {'crafts/day':>11} {'profit/day':>12}")
    for recipe, r, _ in results[:20]:
        name = f"{r.base_tag} -> {r.ench_tag}"
        print(f"{name:<46} {coins(r.timed_profit):>13} {r.timed_margin_pct:>7.2f}% "
              f"{r.crafts_per_day:>11,.1f} {coins(r.profit_per_day):>12}")

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M")
    path = write_tsv(f"scan_{stamp}.txt", header, rows)
    print(f"\n{len(rows)} rows written to {path}")
    print("Open it in VS Code, select all, paste straight into Excel.")


# --------------------------------------------------------------------- entry


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default=os.path.join(HERE, "config.json"))
    parser.add_argument("--tz", help="IANA timezone, e.g. America/Edmonton. Defaults to system local.")
    parser.add_argument("--days", type=int, help="History window in days.")
    parser.add_argument("--sleep", help="Buy-order window as local hours, e.g. 23-07")
    parser.add_argument("--window", type=int, default=4, help="Length of the sell window in hours.")
    parser.add_argument("-v", "--verbose", action="store_true")

    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("check")
    subparsers.add_parser("discover")
    subparsers.add_parser("scan")
    hours_parser = subparsers.add_parser("hours")
    hours_parser.add_argument("tag")
    item_parser = subparsers.add_parser("item")
    item_parser.add_argument("tag")

    args = parser.parse_args()
    config = load_config(args.config)

    handlers = {
        "check": cmd_check,
        "discover": cmd_discover,
        "hours": cmd_hours,
        "item": cmd_item,
        "scan": cmd_scan,
    }
    try:
        handlers[args.command](args, config)
    except ApiError as exc:
        print(f"API error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\ninterrupted")
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

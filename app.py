"""Stock portfolio dashboard: a small Flask server that stores your holdings
and fetches US stock prices from Yahoo Finance (via yfinance, no API key)."""

import json
import math
import os
import random
import re
import threading
import time
from datetime import date, timedelta
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory

BASE = Path(__file__).parent
HOLDINGS_FILE = Path(os.environ.get("HOLDINGS_FILE", BASE / "holdings.json"))
DEMO = os.environ.get("STOCK_DEMO") == "1"  # fake prices, for trying it offline
CACHE_SECONDS = 60
SYMBOL_RE = re.compile(r"^[A-Z0-9.\-^=]{1,15}$")
RANGES = {"1mo": "1d", "3mo": "1d", "6mo": "1d", "1y": "1d", "5y": "1wk"}

app = Flask(__name__, static_folder="static", static_url_path="")
_lock = threading.Lock()
_cache: dict = {}


# ---------- holdings storage ----------

def load_holdings() -> list:
    if not HOLDINGS_FILE.exists():
        return []
    return json.loads(HOLDINGS_FILE.read_text())


def save_holdings(items: list) -> None:
    tmp = HOLDINGS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(items, indent=2))
    tmp.replace(HOLDINGS_FILE)


# ---------- market data ----------

def cached(key, fn):
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    value = fn()
    _cache[key] = (now, value)
    return value


def _demo_series(symbol: str, days: int) -> list:
    rnd = random.Random(symbol)
    price = rnd.uniform(40, 400)
    out, d = [], date.today() - timedelta(days=days)
    while d <= date.today():
        if d.weekday() < 5:
            price *= 1 + rnd.gauss(0.0004, 0.015)
            out.append({"date": d.isoformat(), "close": round(price, 2)})
        d += timedelta(days=1)
    return out


def fetch_quote(symbol: str) -> dict:
    if DEMO:
        s = _demo_series(symbol, 10)
        return {"symbol": symbol, "name": symbol + " Inc.", "price": s[-1]["close"],
                "prevClose": s[-2]["close"], "currency": "USD"}
    import yfinance as yf
    t = yf.Ticker(symbol)
    hist = t.history(period="5d", auto_adjust=False)
    if hist.empty:
        raise ValueError(f"No price data for {symbol}")
    closes = [float(c) for c in hist["Close"] if not math.isnan(c)]
    price = closes[-1]
    prev = closes[-2] if len(closes) > 1 else price
    name = symbol
    try:
        info = t.get_info()
        name = info.get("shortName") or info.get("longName") or symbol
    except Exception:
        pass
    return {"symbol": symbol, "name": name, "price": round(price, 4),
            "prevClose": round(prev, 4), "currency": "USD"}


def fetch_history(symbol: str, period: str) -> list:
    if DEMO:
        days = {"1mo": 31, "3mo": 92, "6mo": 183, "1y": 365, "5y": 1826}[period]
        return _demo_series(symbol, days)
    import yfinance as yf
    hist = yf.Ticker(symbol).history(period=period, interval=RANGES[period])
    return [{"date": idx.date().isoformat(), "close": round(float(c), 4)}
            for idx, c in hist["Close"].items() if not math.isnan(c)]


def clean_symbol(raw) -> str:
    s = str(raw or "").strip().upper()
    if not SYMBOL_RE.match(s):
        abort(400, f"Invalid symbol: {raw!r}")
    return s


# ---------- API ----------

@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/holdings")
def get_holdings():
    return jsonify(load_holdings())


@app.post("/api/holdings")
def add_holding():
    body = request.get_json(force=True) or {}
    symbol = clean_symbol(body.get("symbol"))
    try:
        shares = float(body.get("shares"))
        cost = float(body.get("cost"))
    except (TypeError, ValueError):
        abort(400, "Shares and cost must be numbers")
    if shares <= 0 or cost < 0:
        abort(400, "Shares must be positive and cost cannot be negative")
    try:
        cached(("q", symbol), lambda: fetch_quote(symbol))
    except Exception as e:
        abort(400, f"Could not find {symbol}: {e}")
    with _lock:
        items = load_holdings()
        existing = next((h for h in items if h["symbol"] == symbol), None)
        if existing:  # merge into one position with a weighted average cost
            total = existing["shares"] + shares
            existing["cost"] = round((existing["shares"] * existing["cost"] + shares * cost) / total, 4)
            existing["shares"] = total
        else:
            items.append({"symbol": symbol, "shares": shares, "cost": cost})
        save_holdings(items)
    return jsonify(items), 201


@app.put("/api/holdings/<symbol>")
def edit_holding(symbol):
    symbol = clean_symbol(symbol)
    body = request.get_json(force=True) or {}
    with _lock:
        items = load_holdings()
        h = next((h for h in items if h["symbol"] == symbol), None)
        if not h:
            abort(404)
        try:
            h["shares"] = float(body.get("shares", h["shares"]))
            h["cost"] = float(body.get("cost", h["cost"]))
        except (TypeError, ValueError):
            abort(400, "Shares and cost must be numbers")
        save_holdings(items)
    return jsonify(items)


@app.delete("/api/holdings/<symbol>")
def delete_holding(symbol):
    symbol = clean_symbol(symbol)
    with _lock:
        items = [h for h in load_holdings() if h["symbol"] != symbol]
        save_holdings(items)
    return jsonify(items)


@app.get("/api/quotes")
def quotes():
    symbols = [clean_symbol(s) for s in request.args.get("symbols", "").split(",") if s.strip()]
    out = {}
    for s in symbols:
        try:
            out[s] = cached(("q", s), lambda s=s: fetch_quote(s))
        except Exception as e:
            out[s] = {"symbol": s, "error": str(e)}
    return jsonify(out)


@app.get("/api/history")
def history():
    symbol = clean_symbol(request.args.get("symbol"))
    period = request.args.get("range", "6mo")
    if period not in RANGES:
        abort(400, "range must be one of " + ", ".join(RANGES))
    try:
        return jsonify(cached(("h", symbol, period), lambda: fetch_history(symbol, period)))
    except Exception as e:
        abort(502, f"Could not load history for {symbol}: {e}")


@app.errorhandler(400)
@app.errorhandler(404)
@app.errorhandler(502)
def json_error(e):
    return jsonify({"error": e.description}), e.code


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"Stock dashboard running at http://127.0.0.1:{port}" + ("  (DEMO prices)" if DEMO else ""))
    app.run(host="127.0.0.1", port=port, debug=False)

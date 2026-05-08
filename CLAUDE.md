# CTS Global Screener — Project Context for Claude

## Who I Am

I am a professional swing-to-position trader focused on US and global markets. I have **no coding background** — please explain all code changes, technical decisions, and file structures in plain English. Avoid jargon. If you need to reference code, always explain what it does in simple terms alongside it.

---

## What This Project Is

A stock screener web app built as a single HTML file (`screener.html`). The goal is to take a watchlist exported from TradingView, run it through a set of technical criteria, and rank every ticker from best match (100%) to worst match (0%) — so I immediately know which stocks to look at first.

Think of it like a grading system: each stock gets a score out of 100 based on how closely its chart matches what I normally look for when trading.

---

## The File

Everything lives in one file: `screener.html`. 

The file has three parts inside it:
- **CSS** (the styling — colors, fonts, layout)
- **HTML** (the structure — what appears on screen)
- **JavaScript** (the logic — what happens when you click buttons, how scoring works)

---

## How the App Works (Plain English)

1. I export my TradingView watchlist as a `.txt` file (from TradingView: Watchlist → Share → Export)
2. I drag and drop that file into the app
3. I choose Setup A or Setup B (see below)
4. I press **Run Scan**
5. The app goes through every ticker in the list, scores each one, and shows them ranked top to bottom
6. The top result's chart loads automatically in the bottom half of the screen (TradingView chart widget)
7. I can press the arrow keys to move through the list and the chart updates to whichever stock I'm on
8. I can hide either the list or the chart to get a bigger view of whichever I want
9. After the scan, I can download a filtered `.txt` file with all the tickers that were removed (those below the daily EMA50) already stripped out — ready to re-import into TradingView

---

## The Two Trading Setups

### Setup A — Momentum → Flag → Entry
This is for stocks already in a strong uptrend. I look for:
- A powerful move already in place on the monthly chart
- The stock "resting" in a tight sideways pattern (flag) on the weekly chart
- A quiet, low-volatility entry point forming on the daily chart

These are continuation trades — the buying is already there, I'm just entering the next leg up.

### Setup B — Flag → Coil → Reset
This is for longer-duration setups where the stock has been consolidating for a long time and has pulled back significantly on the daily chart. These need a fundamental catalyst to move but tend to produce large moves when they do.

---

## The Hard Filter (Not Scored — Just Removed)

Before any scoring happens, every ticker is checked against one rule:

**Is the current price above the 50-period Exponential Moving Average on the daily chart?**

An EMA is a moving average that gives more weight to recent prices. The 50 EMA on the daily chart is a widely-watched line — stocks above it are generally in a healthier short-term trend. Any ticker that fails this check is removed from the ranked list entirely and shown as a red ✗ in the sidebar. They are also excluded from the exported `.txt` file.

In real terms: `current price > average of last 50 daily closes (weighted to recent data)`

---

## Scoring Criteria — Both Setups (100 points total)

Every criterion produces a score between 0 and 1 (think of it as 0% to 100% for that individual check). That score is then multiplied by the point weight to get the contribution to the total. All contributions are added up to get the final score out of 100.

### Setup A Criteria

| # | Criterion | Timeframe | Points | What It Checks |
|---|---|---|---|---|
| 1 | Monthly uptrend | Monthly | 10 | Price is above the 50-period EMA on the monthly chart — long-term trend pointing up |
| 2 | Monthly BB position | Monthly | 10 | Price is in the upper half of the Bollinger Bands on the monthly chart, and the bands are getting wider (expanding momentum) |
| 3 | Prior month close — top 25% | Monthly | **15** | The candle that just closed last month ended near its high — specifically in the top 25% of that month's high-to-low range. Strong close = strong hands holding |
| 4 | Weekly tight flag | Weekly | 10 | The Bollinger Bands on the weekly chart are very tight (less than 8% wide relative to the midline) and price is near the upper band — a compressed coil ready to break |
| 5 | Weekly EMA alignment | Weekly | 10 | The short-term EMA (10) is above the medium-term EMA (20), which is above the longer-term EMA (50) on the weekly chart — all moving averages stacked in bullish order |
| 6 | Prior week close — top 25% | Weekly | **15** | Same logic as #3 but for the most recently completed week — closed in the top 25% of that week's range |
| 7 | Daily consolidation | Daily | 10 | Price is moving in a very tight range day-to-day: ATR (Average True Range, a measure of daily volatility) is below 3% of price, the Bollinger Bands are contracting, and price is within 3% of the short-term EMA (10) |
| 8 | Price above prior week's high | Daily | 10 | Today's closing price is higher than the highest price reached during last week — a breakout signal |
| 9 | Close in top 25% of WTD range | Daily | 10 | Today's close is in the top 25% of the price range from Monday to today. If it's Monday, just that day's range. If it's Friday, the full week's range so far |
| 10 | Positive 1-year return | Yearly | 10 | The stock costs more today than it did exactly 52 weeks ago — binary, either full 10 points or zero |

### Setup B Criteria

| # | Criterion | Timeframe | Points | What It Checks |
|---|---|---|---|---|
| 1 | Monthly flag/base | Monthly | 10 | The monthly chart shows a long consolidation (6+ months) with very tight Bollinger Bands and price near a historical resistance level |
| 2 | Monthly EMA200 support | Monthly | 10 | Price is above or very close to the 200-period EMA on the monthly chart — the long-term structural trend is still intact |
| 3 | Prior month close — top 25% | Monthly | **15** | Same as Setup A #3 |
| 4 | Weekly coil | Weekly | 10 | Bollinger Bands on the weekly chart are extremely tight (less than 6% wide) over multiple weeks — extreme compression |
| 5 | Weekly volume decline | Weekly | 10 | Volume has been declining for 4 or more consecutive weeks — sellers are exhausting themselves |
| 6 | Prior week close — top 25% | Weekly | **15** | Same as Setup A #6 |
| 7 | Daily price reset | Daily | 10 | The stock has pulled back more than 20% from its highest point in the last 60 trading days — a significant mean reversion that creates a lower-risk entry |
| 8 | Price above prior week's high | Daily | 10 | Same as Setup A #8 |
| 9 | Close in top 25% of WTD range | Daily | 10 | Same as Setup A #9 |
| 10 | Positive 1-year return | Yearly | 10 | Same as Setup A #10 |

---

## The Score Display

Each stock in the ranked list shows:
- **Total score** (0–100%) with a colored bar — green for strong match (70%+), amber for partial (40–69%), red for weak (below 40%)
- **Per-timeframe scores** — separate mini-scores for Monthly, Weekly, Daily, and Yearly so I can see exactly which timeframe is strong or weak
- **Signal tags** — small labels that highlight key conditions like "MTH CLOSE TOP", "ABOVE PWH", "1YR POSITIVE", "VOL SURGE"

Clicking any row opens a full breakdown modal showing the score for each individual criterion with a pass (green dot) / partial (amber dot) / fail (red dot) indicator.

---
- **EMA (Exponential Moving Average)** — A line on the chart showing the average price over N periods, but giving more weight to recent prices. A rising EMA means the trend is up. EMA10 reacts fast, EMA200 is very slow and shows the long-term picture.
- **Bollinger Bands (BB)** — Three lines on the chart: a middle line (20-period simple moving average) with an upper and lower band 2 standard deviations away. When the bands are wide, the stock is volatile. When they are tight (a "squeeze"), it means price has been very quiet and a big move is likely coming.
- **ATR (Average True Range)** — A number that measures how much a stock moves per day on average. Low ATR = quiet, consolidating. High ATR = volatile, moving a lot.
- **BB Width** — The distance between the upper and lower Bollinger Bands expressed as a percentage of the middle line. Narrow = squeeze. We measure this to identify coiling setups.

---

## Data Source 
The real data will come from the **Yahoo Finance API** — a free data source that provides historical price data (open, high, low, close, volume) for stocks.

Key endpoints needed:
- Daily prices (1 year): to calculate EMA50 filter, WTD range, prior week's high
- Weekly prices (2 years): to calculate BB squeeze, EMA alignment, prior week close position
- Monthly prices (5 years): to calculate monthly trend, BB position, prior month close position
- 52-week comparison: weekly prices going back 2 years gives us both the current price and the price from 52 weeks ago

---

## Important Preferences

- **No coding background** — always explain what code does in plain English before or after showing it
- **Light mode UI** — the app uses a white/light gray color scheme, not dark mode
- **No sliders or adjustable weights** — the scoring weights are fixed in the code and shown read-only in the sidebar
- **Single HTML file** — keep everything in one file for simplicity until the backend is needed
- **Font:** IBM Plex Mono (for data/numbers) + IBM Plex Sans (for labels/text)
- **Accent color:** Dark green `#0a7c4e`
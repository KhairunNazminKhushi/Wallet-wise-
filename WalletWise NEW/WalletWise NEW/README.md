# WalletWise — Personal Budget Planner for University Students

A simple desktop app (built with Electron) that helps a student track income
and expenses, set a monthly budget, and see a real time-series forecast of
their spending for the rest of the month — trend, weekly patterns, a
confidence-scored prediction, and the reasoning behind it, not just a rule
of three.

## Design idea

The interface is styled like a student's paper **ledger / bank passbook**:
faint ruled lines in the background, a stamped circular badge for the
remaining balance, numbered entries (like passbook entry numbers), and
ruler-style progress bars instead of charts.

The **Forecast** tab is deliberately a little different: it sits on a faint
**graph-paper** canvas instead of ruled notebook paper, and uses a cool
ink-blue accent instead of the ledger's green/red/gold palette — like an
analyst's report clipped into the same notebook. It reuses the same stamped
circular badge motif from the Dashboard (just recolored) to show forecast
confidence, so it still feels like part of the same app.

## Running the app

```bash
npm install
npm start
```

This opens a single Electron window loading `index.html`. All data is saved
to the browser's Local Storage, so it's still there next time you open the
app or refresh the window.

## Project structure

```text
WalletWise/
├── index.html          Page structure: dashboard, transactions, budget, forecast, modal
├── css/
│   ├── style.css        Main styling (colors, layout, components)
│   ├── forecast.css     Styling for the Forecast & Time-Series Analysis tab
│   └── responsive.css   Media queries for tablet/mobile + bottom nav
├── js/
│   ├── app.js           Shared state, Local Storage helpers, navigation, modal
│   ├── transactions.js  Add / delete / list income & expense transactions
│   ├── budget.js        Budget totals, category breakdown, dashboard + budget page rendering
│   ├── timeseries.js    The forecasting engine: trend + weekly-seasonality model, backtesting
│   ├── charts.js        Dependency-free SVG chart renderer (no external library, works offline)
│   ├── forecast.js      Dashboard's small forecast panel (uses timeseries.js under the hood)
│   └── forecast-page.js Renders the full "Spending Forecast & Time-Series Analysis" tab
├── WalletWise Gallery/
│   └── How_to_Use_WalletWise.mp4   Tutorial video played by the "How to use" modal
├── main.js               Minimal Electron window setup
└── package.json          Electron config (npm start → electron .)
```

## How the code fits together (for explaining it out loud)

1. **`app.js` loads first.** It declares two shared variables —
   `transactions` (an array) and `monthlyBudget` (a number) — and loads
   them from Local Storage with `loadData()`. It also handles switching
   between the three tabs and opening/closing the "Add Transaction" modal.
2. **`transactions.js`** listens for the modal's form submit. It builds a
   simple object like `{ id, type, amount, category, description, date }`
   and pushes it into the shared `transactions` array, then saves and
   re-renders. Deleting works the same way, just filtering the array.
3. **`budget.js`** does the math: it filters `transactions` down to the
   current month, adds up income and expenses, and works out the remaining
   balance (`monthlyBudget - totalExpenses`). It also groups expenses by
   category for the breakdown bars on the Budget page.
4. **`timeseries.js`** is the forecasting engine — pure calculation, no DOM
   access, so it can be unit-tested on its own (see "How the forecast
   works" below for the model itself).
5. **`charts.js`** draws the three Forecast-tab charts as hand-rolled SVG
   (no charting library, so the app keeps working fully offline in
   Electron) and wires up the hover tooltips.
6. **`forecast.js`** is just the Dashboard's small "Spending forecast"
   panel. It calls `TS.summarize(...)` from `timeseries.js` and shows the
   headline predicted total, so the number here always agrees with the
   full Forecast tab.
7. **`forecast-page.js`** renders the full **Forecast & Time-Series
   Analysis** tab: the confidence badge, the three KPI cards, all three
   charts, the budget comparison bar, the auto-generated insights list, and
   the plain-language explanation paragraph. It's DOM wiring only — every
   number it displays comes from `TS.summarize(...)`.
8. Whenever data changes (a transaction is added/deleted, or the budget is
   saved), the app calls `renderAll()`, which re-draws the Dashboard,
   Transactions, Budget, and Forecast pages from the current `transactions`
   and `monthlyBudget` values. There's no separate "state management"
   system — the two shared variables *are* the state.

## How the forecast works

`js/timeseries.js` treats daily expense totals as a small time series and
splits them into two learned parts plus whatever's left over:

```text
actual(day) = trend(day) + weeklyPattern(day of week) + noise
```

- **Trend** — a linear regression over your daily spending, so a steady
  climb or decline gets picked up instead of assumed away.
- **Weekly pattern** — how far each weekday typically sits above or below
  the trend line (e.g. weekends often running higher), found by averaging
  what's left after removing the trend.
- **Noise** — whatever's left. How spread out it is becomes the basis for
  the shaded confidence band on the forecast chart.

The fitted model is projected forward to predict the rest of the current
month. To score how reliable that tends to be, the engine **backtests**:
it re-fits the same model with the last 7 days held out, checks how close
it landed, and turns that error into the 0–100 score on the confidence
badge — so the score reflects the model tested against real outcomes, not
just how well it fits data it already saw. A single unusually large
purchase (rent, a laptop) is capped out before it reaches the model, so
one big transaction can't single-handedly warp the whole month's forecast.

With less than two weeks of history there isn't enough to detect a weekly
pattern yet, so the model gracefully falls back to trend-only, then to a
simple average, and says so in the "Model:" badge and the confidence tier
rather than pretending to a precision it doesn't have.

## "How to use" tutorial video

The Dashboard has a **"How to use WalletWise"** panel with a **▶ Watch
Tutorial** button. Clicking it opens a popup (reusing the same modal style
as the "Add Transaction" form) and plays a video from:

```text
WalletWise Gallery/How_to_Use_WalletWise.mp4
```

It uses a normal HTML5 `<video>` element with the browser's built-in
controls, so play, pause, seek, and volume all work out of the box. The
video starts playing automatically when the popup opens and pauses
automatically when it's closed (× button, Cancel-style backdrop click).

**The `.mp4` currently in that folder is only a placeholder** (a few
seconds long, generated to prove the folder/wiring works) — replace
`WalletWise Gallery/How_to_Use_WalletWise.mp4` with your own real screen
recording, keeping the exact same filename, and it will just work with no
code changes.

The relevant code:
- HTML: the `#videoModal` block near the bottom of `index.html`, and the
  `.gallery-panel` block at the end of the Dashboard `<section>`.
- JS: `openVideoModal()`, `closeVideoModal()`, and `setupVideoModal()` in
  `js/app.js`.
- CSS: the `/* How-to-use / tutorial video */` section at the bottom of
  `css/style.css`.

## Notes

- Expense categories are fixed (Food, Transport, Books, Bills,
  Entertainment, Shopping, Other). Income uses a free-text "Source" field
  (e.g. Allowance, Part-time job).
- Dashboard and Budget summaries are based on the **current calendar
  month**; the Transactions page lists full history so nothing is ever
  hidden.
- Currency is shown in Bangladeshi Taka (৳); change the `৳` symbol in
  `formatMoney()` inside `js/app.js` if you need a different currency.
- The Forecast tab needs at least one recorded expense to show anything,
  and needs about two weeks of history spread across different days before
  it detects weekly spending patterns and backtests a confidence score.
  Before that it still shows a rough trend-based estimate, just labeled as
  an early estimate rather than a scored forecast.

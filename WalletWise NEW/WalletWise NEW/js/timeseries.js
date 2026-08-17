// timeseries.js
// ---------------------------------------------------------------------------
// WalletWise Time-Series Forecasting Engine
// ---------------------------------------------------------------------------
// Pure calculation module (no DOM access) so it can run identically in the
// browser/Electron renderer and under Node for testing.
//
// APPROACH
// Rather than a flat "average so far x days left" projection, this module
// decomposes daily expense history into two learned components and a
// residual:
//
//    actual(t) = trend(t) + weeklySeasonal(dayOfWeek(t)) + noise
//
//   - trend(t)        a linear regression over the daily totals, capturing
//                      whether spending is drifting up or down over time.
//   - weeklySeasonal   the average amount each weekday sits above/below the
//                      trend line (e.g. weekend spending usually runs
//                      higher) — a classic seasonal-decomposition technique.
//   - noise            what's left over. Its spread (standard deviation)
//                      becomes the basis for the forecast's confidence band.
//
// The fitted model is then projected forward to predict the remaining days
// of the current month. Reliability is estimated by backtesting: fitting the
// same model on all-but-the-last-7-days and checking how close it landed to
// what actually happened, using symmetric mean absolute percentage error
// (sMAPE) so that low/zero-spend days don't break the metric.
//
// This is intentionally a transparent, explainable statistical model
// (linear trend + additive weekly seasonality) rather than a opaque
// black-box, because a budgeting tool's forecasts need to be auditable by
// the person relying on them.
// ---------------------------------------------------------------------------

(function (global) {
  'use strict';

  // ---------------- Tunable constants ----------------

  var MAX_HISTORY_DAYS = 120;      // cap how far back the model looks
  var MIN_TREND_DAYS = 10;         // below this, slope is forced to 0
  var MIN_SEASONAL_DAYS = 14;      // below this, weekly seasonality is disabled
  var BACKTEST_MIN_DAYS = 21;      // below this, no holdout backtest is run
  var BACKTEST_HOLDOUT = 7;
  var Z_80 = 1.2816;               // z-score for an ~80% interval
  var WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var WEEKDAY_LABELS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // ---------------- Date helpers ----------------
  // Mirrors the local-date handling already used elsewhere in WalletWise
  // (app.js#todayISO / date + 'T00:00:00') so results line up with the rest
  // of the app.

  function parseLocalDate(dateStr) {
    return new Date(dateStr + 'T00:00:00');
  }

  function toDateKey(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function addDays(date, n) {
    var d = new Date(date.getTime());
    d.setDate(d.getDate() + n);
    return d;
  }

  function startOfDay(date) {
    var d = new Date(date.getTime());
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function daysBetween(a, b) {
    var msPerDay = 24 * 60 * 60 * 1000;
    return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / msPerDay);
  }

  function daysInMonth(year, monthIndex) {
    return new Date(year, monthIndex + 1, 0).getDate();
  }

  // ---------------- Basic stats ----------------

  function mean(arr) {
    if (!arr.length) return 0;
    var sum = 0;
    for (var i = 0; i < arr.length; i++) sum += arr[i];
    return sum / arr.length;
  }

  function sampleStdDev(arr) {
    var n = arr.length;
    if (n < 2) return 0;
    var m = mean(arr);
    var sumSq = 0;
    for (var i = 0; i < n; i++) sumSq += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(sumSq / (n - 1));
  }

  function median(sortedArr) {
    var n = sortedArr.length;
    if (!n) return 0;
    var mid = Math.floor(n / 2);
    return n % 2 ? sortedArr[mid] : (sortedArr[mid - 1] + sortedArr[mid]) / 2;
  }

  function percentile(sortedArr, p) {
    var n = sortedArr.length;
    if (!n) return 0;
    var idx = clamp(Math.round(p * (n - 1)), 0, n - 1);
    return sortedArr[idx];
  }

  // Caps single-day totals using a median + robust-MAD threshold so that one
  // unusually large purchase (e.g. rent, a laptop) can't single-handedly
  // distort the trend/seasonality the model projects forward. Actual spend
  // totals shown elsewhere in the UI are never altered by this — only the
  // copy of the series used to *fit* the forward-looking model is.
  function winsorizeForModeling(series) {
    var totals = series.map(function (p) { return p.total; });
    var sorted = totals.slice().sort(function (a, b) { return a - b; });
    var med = median(sorted);
    var absDevs = totals.map(function (v) { return Math.abs(v - med); }).sort(function (a, b) { return a - b; });
    var mad = median(absDevs);
    var robustSigma = mad * 1.4826; // consistency constant vs. normal std dev
    var cap;
    if (robustSigma > 0) {
      cap = med + 5 * robustSigma;
    } else {
      var p90 = percentile(sorted, 0.9);
      cap = Math.max(med * 3, p90 * 3, 50);
    }
    cap = Math.max(cap, med * 2, 50);
    return series.map(function (p) {
      return { date: p.date, dow: p.dow, total: Math.min(p.total, cap) };
    });
  }

  // Ordinary least squares over y = intercept + slope * index
  function linearRegression(values) {
    var n = values.length;
    if (n === 0) return { slope: 0, intercept: 0, r2: 0 };
    if (n === 1) return { slope: 0, intercept: values[0], r2: 0 };

    var sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (var i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumXX += i * i;
    }
    var denom = (n * sumXX - sumX * sumX);
    var slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
    var intercept = (sumY - slope * sumX) / n;

    var meanY = sumY / n;
    var ssTot = 0, ssRes = 0;
    for (var j = 0; j < n; j++) {
      var pred = intercept + slope * j;
      ssTot += (values[j] - meanY) * (values[j] - meanY);
      ssRes += (values[j] - pred) * (values[j] - pred);
    }
    var r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
    return { slope: slope, intercept: intercept, r2: r2 };
  }

  // Symmetric MAPE — robust to zero/near-zero actual values, which are
  // common and legitimate on a no-spend day.
  function smape(actual, predicted) {
    var sum = 0, count = 0;
    for (var i = 0; i < actual.length; i++) {
      var a = actual[i], p = predicted[i];
      var denom = (Math.abs(a) + Math.abs(p)) / 2;
      if (denom < 1e-9) continue; // both ~0: perfect, ignore in denominator-based metric
      sum += Math.abs(a - p) / denom;
      count++;
    }
    return count ? (sum / count) * 100 : 0;
  }

  // ---------------- Daily series construction ----------------

  // Builds a zero-filled daily expense series from `startDate` through
  // `endDate` (inclusive), summing expense transactions per calendar day.
  function buildDailySeries(transactions, startDate, endDate) {
    var totals = Object.create(null);
    for (var i = 0; i < transactions.length; i++) {
      var t = transactions[i];
      if (t.type !== 'expense' || !t.date || !(t.amount > 0)) continue;
      totals[t.date] = (totals[t.date] || 0) + t.amount;
    }

    var series = [];
    var cursor = startOfDay(startDate);
    var end = startOfDay(endDate);
    var guard = 0;
    while (cursor.getTime() <= end.getTime() && guard < 5000) {
      var key = toDateKey(cursor);
      series.push({
        date: key,
        total: totals[key] || 0,
        dow: cursor.getDay() // 0 = Sunday .. 6 = Saturday
      });
      cursor = addDays(cursor, 1);
      guard++;
    }
    return series;
  }

  // ---------------- Model fitting ----------------

  function fitModel(series) {
    var n = series.length;
    var totals = series.map(function (p) { return p.total; });

    var trend = { slope: 0, intercept: mean(totals), r2: 0 };
    if (n >= MIN_TREND_DAYS) {
      trend = linearRegression(totals);
    }

    var seasonal = [0, 0, 0, 0, 0, 0, 0];
    if (n >= MIN_SEASONAL_DAYS) {
      var buckets = [[], [], [], [], [], [], []];
      for (var i = 0; i < n; i++) {
        var fittedTrend = trend.intercept + trend.slope * i;
        buckets[series[i].dow].push(totals[i] - fittedTrend);
      }
      var raw = buckets.map(function (arr) { return arr.length ? mean(arr) : 0; });
      var observedCount = buckets.filter(function (arr) { return arr.length > 0; }).length;
      var centerBy = observedCount ? mean(raw.filter(function (_, idx) { return buckets[idx].length > 0; })) : 0;
      seasonal = raw.map(function (s) { return s - centerBy; });
    }

    var fitted = series.map(function (p, i) {
      return trend.intercept + trend.slope * i + seasonal[p.dow];
    });
    var residuals = totals.map(function (v, i) { return v - fitted[i]; });
    var std = n >= 2 ? sampleStdDev(residuals) : 0;

    var maxObserved = totals.length ? Math.max.apply(null, totals) : 0;
    var avgLevel = mean(totals);
    // Safety backstop so a short, volatile history can't extrapolate into an
    // absurd number over the (short, <=31 day) forecast horizon.
    var dailyCap = Math.max(avgLevel * 4, maxObserved * 1.75, 50);

    return {
      n: n,
      trend: trend,
      seasonal: seasonal,
      fitted: fitted,
      residuals: residuals,
      std: std,
      avgLevel: avgLevel,
      maxObserved: maxObserved,
      dailyCap: dailyCap
    };
  }

  function predictDay(model, index, dow) {
    var raw = model.trend.intercept + model.trend.slope * index + model.seasonal[dow];
    return Math.min(model.dailyCap, Math.max(0, raw));
  }

  // ---------------- Backtest (out-of-sample reliability) ----------------

  function backtest(series) {
    var n = series.length;
    if (n < BACKTEST_MIN_DAYS) return null;

    var trainSeries = series.slice(0, n - BACKTEST_HOLDOUT);
    var testSeries = series.slice(n - BACKTEST_HOLDOUT);
    var trainModel = fitModel(trainSeries);

    var preds = testSeries.map(function (p, idx) {
      return predictDay(trainModel, trainSeries.length + idx, p.dow);
    });
    var actuals = testSeries.map(function (p) { return p.total; });

    var errPct = smape(actuals, preds);
    var mae = mean(actuals.map(function (v, i) { return Math.abs(v - preds[i]); }));

    return { smape: errPct, mae: mae, holdoutDays: BACKTEST_HOLDOUT, preds: preds, actuals: actuals };
  }

  // ---------------- Reliability scoring ----------------

  function scoreReliability(model, bt) {
    if (bt) {
      var score = clamp(Math.round(100 - bt.smape), 0, 100);
      return {
        tier: 'backtested',
        score: score,
        label: score >= 80 ? 'High' : (score >= 60 ? 'Moderate' : 'Low'),
        detail: bt
      };
    }
    if (model.n >= MIN_TREND_DAYS) {
      // In-sample fit only — optimistic, so score is discounted and capped.
      var inSamplePreds = model.fitted.map(function (v) { return Math.max(0, v); });
      var inSampleActual = model.fitted.map(function (v, i) { return v + model.residuals[i]; });
      var inSampleErr = smape(inSampleActual, inSamplePreds);
      var raw = 90 - inSampleErr * 1.3;
      var capped = clamp(Math.round(raw), 0, 70);
      return {
        tier: 'preliminary',
        score: capped,
        label: capped >= 55 ? 'Moderate' : 'Low',
        detail: null
      };
    }
    return { tier: 'building', score: null, label: 'Building', detail: null };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ---------------- Weekly aggregates (for the trend chart) ----------------

  function buildWeeklyAggregates(series, maxWeeks) {
    if (!series.length) return [];
    var chunks = [];
    var i = series.length;
    while (i > 0) {
      var start = Math.max(0, i - 7);
      chunks.unshift(series.slice(start, i));
      i = start;
    }
    if (chunks.length > maxWeeks) chunks = chunks.slice(chunks.length - maxWeeks);

    return chunks.map(function (chunk) {
      var total = 0;
      for (var k = 0; k < chunk.length; k++) total += chunk[k].total;
      return {
        startDate: chunk[0].date,
        endDate: chunk[chunk.length - 1].date,
        total: total,
        days: chunk.length
      };
    });
  }

  // ---------------- Weekday pattern (for the pattern chart + insight) ----------------

  function buildWeekdayPattern(series) {
    var sums = [0, 0, 0, 0, 0, 0, 0];
    var counts = [0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < series.length; i++) {
      sums[series[i].dow] += series[i].total;
      counts[series[i].dow]++;
    }
    // Reorder Mon..Sun for a more natural-reading chart, keep Sun..Sat also available.
    var order = [1, 2, 3, 4, 5, 6, 0];
    return order.map(function (dow) {
      return {
        dow: dow,
        label: WEEKDAY_LABELS[dow],
        avg: counts[dow] ? sums[dow] / counts[dow] : 0,
        count: counts[dow]
      };
    });
  }

  // ---------------- Category trend comparison ----------------

  function buildCategoryTrends(transactions, today, windowDays) {
    var end = startOfDay(today);
    var midStart = addDays(end, -windowDays + 1);
    var prevStart = addDays(midStart, -windowDays);
    var prevEnd = addDays(midStart, -1);

    var recent = Object.create(null);
    var previous = Object.create(null);

    for (var i = 0; i < transactions.length; i++) {
      var t = transactions[i];
      if (t.type !== 'expense' || !t.date) continue;
      var d = parseLocalDate(t.date);
      var cat = t.category || 'Other';
      if (d.getTime() >= midStart.getTime() && d.getTime() <= end.getTime()) {
        recent[cat] = (recent[cat] || 0) + t.amount;
      } else if (d.getTime() >= prevStart.getTime() && d.getTime() <= prevEnd.getTime()) {
        previous[cat] = (previous[cat] || 0) + t.amount;
      }
    }

    var categories = {};
    Object.keys(recent).forEach(function (c) { categories[c] = true; });
    Object.keys(previous).forEach(function (c) { categories[c] = true; });

    var results = Object.keys(categories).map(function (cat) {
      var r = recent[cat] || 0;
      var p = previous[cat] || 0;
      var pctChange = null;
      if (p > 0) pctChange = ((r - p) / p) * 100;
      else if (r > 0) pctChange = null; // brand-new category — no prior baseline to compare
      return { category: cat, recent: r, previous: p, pctChange: pctChange, amountChange: r - p };
    });

    return results;
  }

  // ---------------- Insight generation ----------------

  function buildInsights(ctx) {
    var insights = [];
    var model = ctx.model;
    var avg = model.avgLevel;

    // 1) Overall trend
    if (model.n >= MIN_TREND_DAYS && avg > 0) {
      var weeklyChange = model.trend.slope * 7;
      var pct = (weeklyChange / avg) * 100;
      if (Math.abs(pct) < 4) {
        insights.push({ type: 'neutral', text: 'Your day-to-day spending has been fairly steady over the last ' + model.n + ' days, without a clear upward or downward trend.' });
      } else if (pct > 0) {
        insights.push({ type: 'up', text: 'Your spending has been trending upward by roughly ' + pct.toFixed(0) + '% per week over the last ' + model.n + ' days.' });
      } else {
        insights.push({ type: 'down', text: 'Your spending has been trending downward by roughly ' + Math.abs(pct).toFixed(0) + '% per week over the last ' + model.n + ' days.' });
      }
    }

    // 2) Weekday pattern
    if (model.n >= MIN_SEASONAL_DAYS) {
      var pattern = ctx.weekdayPattern;
      var withData = pattern.filter(function (p) { return p.count > 0; });
      if (withData.length >= 5) {
        var highest = withData.reduce(function (a, b) { return b.avg > a.avg ? b : a; });
        var lowest = withData.reduce(function (a, b) { return b.avg < a.avg ? b : a; });
        if (highest.label !== lowest.label && avg > 0 && (highest.avg - lowest.avg) / avg > 0.08) {
          insights.push({ type: 'neutral', text: 'You tend to spend the most on ' + WEEKDAY_LABELS_LONG[highest.dow] + 's and the least on ' + WEEKDAY_LABELS_LONG[lowest.dow] + 's.' });
        }
      }
    }

    // 3) Category movers
    var catTrends = ctx.categoryTrends
      .filter(function (c) { return c.pctChange !== null && (c.recent >= 200 || c.previous >= 200); })
      .sort(function (a, b) { return Math.abs(b.pctChange) - Math.abs(a.pctChange); });

    catTrends.slice(0, 2).forEach(function (c) {
      if (Math.abs(c.pctChange) < 10) return;
      if (c.pctChange > 0) {
        insights.push({ type: 'up', text: c.category + ' spending is up ' + c.pctChange.toFixed(0) + '% versus the previous period.' });
      } else {
        insights.push({ type: 'down', text: c.category + ' spending is down ' + Math.abs(c.pctChange).toFixed(0) + '% versus the previous period.' });
      }
    });

    // 4) Volatility note (helps explain a wide confidence band)
    if (model.n >= MIN_TREND_DAYS && avg > 0) {
      var cv = model.std / avg;
      if (cv > 0.9) {
        insights.push({ type: 'neutral', text: 'Your daily spending varies quite a bit day to day, which widens the forecast range below.' });
      }
    }

    // 5) Budget pace
    if (ctx.budget > 0) {
      var diff = ctx.predictedTotal - ctx.budget;
      var diffPct = (diff / ctx.budget) * 100;
      if (diff > 0 && diffPct > 3) {
        insights.push({ type: 'up', text: 'At your current pace, you are on track to go over budget by about ' + ctx.formatMoney(diff) + ' this month.' });
      } else if (diff < 0 && Math.abs(diffPct) > 3) {
        insights.push({ type: 'down', text: 'At your current pace, you are on track to stay about ' + ctx.formatMoney(Math.abs(diff)) + ' under budget this month.' });
      }
    }

    return insights;
  }

  // ---------------- Explanation copy ----------------

  function buildExplanation(ctx) {
    var m = ctx.model;
    var parts = [];

    if (ctx.dataQuality === 'minimal') {
      parts.push('This is an early estimate based on just ' + m.n + ' day' + (m.n === 1 ? '' : 's') + ' of recorded spending, so treat it as a rough placeholder rather than a firm number.');
      parts.push('It will sharpen automatically as you log more days.');
      return parts.join(' ');
    }

    parts.push(
      'Based on your spending pattern over the last ' + m.n + ' days, WalletWise expects you to spend about ' +
      ctx.formatMoney(ctx.predictedTotal) + ' in total this month' +
      (ctx.budget > 0 ? (ctx.predictedTotal > ctx.budget
        ? (', which is ' + ctx.formatMoney(ctx.predictedTotal - ctx.budget) + ' over your ' + ctx.formatMoney(ctx.budget) + ' budget.')
        : (', staying ' + ctx.formatMoney(ctx.budget - ctx.predictedTotal) + ' under your ' + ctx.formatMoney(ctx.budget) + ' budget.'))
        : '.')
    );

    var methodBits = ['your overall spending trend'];
    if (m.n >= MIN_SEASONAL_DAYS) methodBits.push('typical day-of-week patterns');
    parts.push('The estimate combines ' + methodBits.join(' and ') + ', then projects it across the ' + ctx.daysRemaining + ' day' + (ctx.daysRemaining === 1 ? '' : 's') + ' left in the month.');

    if (ctx.daysRemaining > 0) {
      parts.push('The shaded band on the chart is a likely range, not a guarantee \u2014 about 8 times out of 10, a month like this one lands somewhere inside it.');
    }

    if (ctx.reliability.tier === 'building') {
      parts.push('WalletWise needs a bit more history before it can score how reliable this forecast tends to be \u2014 keep logging expenses and that will unlock automatically.');
    } else if (ctx.reliability.tier === 'preliminary') {
      parts.push('The reliability score is preliminary since there isn\u2019t yet enough history to fully test it against real outcomes.');
    }

    return parts.join(' ');
  }

  // ---------------- Chart-ready cumulative series (Actual vs Forecast) ----------------

  function buildCumulativeMonthSeries(series, model, today, monthlyBudget) {
    var year = today.getFullYear();
    var month = today.getMonth();
    var totalDays = daysInMonth(year, month);
    var todayDom = today.getDate(); // 1-based day of month

    // Map series entries by date for quick lookup of actuals within this month.
    var byDate = {};
    series.forEach(function (p) { byDate[p.date] = p; });
    var n = series.length;

    var points = [];
    var running = 0;
    for (var dom = 1; dom <= totalDays; dom++) {
      var d = new Date(year, month, dom);
      var key = toDateKey(d);
      var isFuture = dom > todayDom;
      var isPast = dom <= todayDom;
      var actualVal = null;
      var predictedVal = null;
      var low = null, high = null;

      if (isPast) {
        var entry = byDate[key];
        var val = entry ? entry.total : 0;
        running += val;
        actualVal = running;
      }
      if (dom === todayDom) {
        // Anchor forecast line to the actual cumulative so the two segments
        // connect visually with no gap/jump.
        predictedVal = running;
        low = running;
        high = running;
      } else if (isFuture) {
        var stepsAhead = dom - todayDom;
        var idx = n - 1 + stepsAhead;
        var dow = d.getDay();
        var dayPred = predictDay(model, idx, dow);
        var prevPredCum = points.length ? points[points.length - 1].predicted : running;
        predictedVal = prevPredCum + dayPred;
        var sdCum = model.std * Math.sqrt(stepsAhead);
        low = Math.max((points.length ? points[points.length - 1].low : running), predictedVal - Z_80 * sdCum);
        high = predictedVal + Z_80 * sdCum;
      }

      points.push({
        dom: dom,
        date: key,
        actual: actualVal,
        predicted: predictedVal,
        low: low,
        high: high,
        isToday: dom === todayDom
      });
    }

    return { points: points, totalDays: totalDays, todayDom: todayDom, budget: monthlyBudget };
  }

  // ---------------- Top-level entry point ----------------

  function summarize(options) {
    var transactions = options.transactions || [];
    var monthlyBudget = options.monthlyBudget || 0;
    var today = startOfDay(options.today ? new Date(options.today) : new Date());
    var formatMoney = options.formatMoney || function (v) { return String(Math.round(v)); };

    var expenseTx = transactions.filter(function (t) { return t.type === 'expense' && t.date && t.amount > 0; });

    if (!expenseTx.length) {
      return {
        hasEnoughData: false,
        dataQuality: 'none',
        expenseCount: 0
      };
    }

    var dates = expenseTx.map(function (t) { return parseLocalDate(t.date); });
    var earliest = dates.reduce(function (a, b) { return b.getTime() < a.getTime() ? b : a; });

    var windowStart = earliest;
    var cappedStart = addDays(today, -(MAX_HISTORY_DAYS - 1));
    if (windowStart.getTime() < cappedStart.getTime()) windowStart = cappedStart;
    // Never build a window that starts after today (e.g. all transactions post-dated oddly).
    if (windowStart.getTime() > today.getTime()) windowStart = today;

    var series = buildDailySeries(transactions, windowStart, today);
    var historyDays = series.length;

    var dataQuality;
    if (historyDays < 3) dataQuality = 'minimal';
    else if (historyDays < MIN_SEASONAL_DAYS) dataQuality = 'partial';
    else dataQuality = 'full';

    var modelSeries = winsorizeForModeling(series);
    var model = fitModel(modelSeries);
    var bt = backtest(modelSeries);
    var reliability = scoreReliability(model, bt);

    var year = today.getFullYear();
    var month = today.getMonth();
    var totalDaysInMonth = daysInMonth(year, month);
    var todayDom = today.getDate();
    var daysRemaining = Math.max(0, totalDaysInMonth - todayDom);

    var monthToDateActual = 0;
    series.forEach(function (p) {
      var d = parseLocalDate(p.date);
      if (d.getFullYear() === year && d.getMonth() === month) monthToDateActual += p.total;
    });

    var n = series.length;
    var remainingForecast = 0;
    for (var h = 1; h <= daysRemaining; h++) {
      var futureDate = addDays(today, h);
      var idx = n - 1 + h;
      remainingForecast += predictDay(model, idx, futureDate.getDay());
    }

    var predictedTotal = monthToDateActual + remainingForecast;
    var sdTotal = model.std * Math.sqrt(daysRemaining);
    var low = Math.max(monthToDateActual, predictedTotal - Z_80 * sdTotal);
    var high = predictedTotal + Z_80 * sdTotal;

    var weeklyAggregates = buildWeeklyAggregates(series, 12);
    var weeklyTrendLine = linearRegression(weeklyAggregates.map(function (w) { return w.total; }));
    var weekdayPattern = buildWeekdayPattern(series);
    var categoryTrends = buildCategoryTrends(transactions, today, Math.max(7, Math.min(30, Math.floor(historyDays / 2))));

    var ctx = {
      model: model,
      weekdayPattern: weekdayPattern,
      categoryTrends: categoryTrends,
      budget: monthlyBudget,
      predictedTotal: predictedTotal,
      formatMoney: formatMoney
    };
    var insights = buildInsights(ctx);

    var explanationCtx = {
      model: model,
      dataQuality: dataQuality,
      predictedTotal: predictedTotal,
      budget: monthlyBudget,
      daysRemaining: daysRemaining,
      reliability: reliability,
      formatMoney: formatMoney
    };
    var explanation = buildExplanation(explanationCtx);

    var cumulative = buildCumulativeMonthSeries(series, model, today, monthlyBudget);

    var weeklyChangePct = model.avgLevel > 0 ? (model.trend.slope * 7 / model.avgLevel) * 100 : 0;

    return {
      hasEnoughData: true,
      dataQuality: dataQuality,
      expenseCount: expenseTx.length,
      historyDays: historyDays,
      firstDate: toDateKey(windowStart),
      lastDate: toDateKey(today),
      series: series,
      model: {
        avgDailySpend: model.avgLevel,
        trendPerDay: model.trend.slope,
        weeklyChangePct: weeklyChangePct,
        r2: model.trend.r2,
        residualStd: model.std,
        seasonalByDow: model.seasonal
      },
      reliability: reliability,
      monthProgress: {
        year: year,
        month: month,
        daysInMonth: totalDaysInMonth,
        daysPassed: todayDom,
        daysRemaining: daysRemaining,
        monthToDateActual: monthToDateActual
      },
      forecast: {
        remainingForecast: remainingForecast,
        predictedTotal: predictedTotal,
        low: low,
        high: high,
        ciLevel: 80
      },
      budgetComparison: {
        budget: monthlyBudget,
        monthToDateActual: monthToDateActual,
        predictedTotal: predictedTotal,
        variance: predictedTotal - monthlyBudget,
        status: monthlyBudget <= 0 ? 'no-budget' : (predictedTotal > monthlyBudget ? 'over' : 'under')
      },
      weeklyAggregates: weeklyAggregates,
      weeklyTrendLine: weeklyTrendLine,
      weekdayPattern: weekdayPattern,
      categoryTrends: categoryTrends,
      insights: insights,
      explanation: explanation,
      cumulativeMonth: cumulative
    };
  }

  var TS = {
    summarize: summarize,
    // exposed for testing / advanced use
    linearRegression: linearRegression,
    buildDailySeries: buildDailySeries,
    fitModel: fitModel,
    predictDay: predictDay,
    backtest: backtest,
    smape: smape,
    buildWeeklyAggregates: buildWeeklyAggregates,
    buildWeekdayPattern: buildWeekdayPattern,
    buildCategoryTrends: buildCategoryTrends,
    winsorizeForModeling: winsorizeForModeling,
    constants: {
      MAX_HISTORY_DAYS: MAX_HISTORY_DAYS,
      MIN_TREND_DAYS: MIN_TREND_DAYS,
      MIN_SEASONAL_DAYS: MIN_SEASONAL_DAYS,
      BACKTEST_MIN_DAYS: BACKTEST_MIN_DAYS
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TS;
  } else {
    global.TS = TS;
  }
})(typeof window !== 'undefined' ? window : globalThis);

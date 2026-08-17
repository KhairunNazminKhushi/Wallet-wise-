// charts.js
// ---------------------------------------------------------------------------
// WalletWise Forecast Charts
// ---------------------------------------------------------------------------
// Small, dependency-free SVG chart renderer built specifically for the
// Forecast & Time-Series Analysis section. No external charting library is
// used so the app keeps working fully offline inside Electron.
//
// Every chart is built in two layers:
//   1. A pure "build*Chart" function that takes plain data and returns
//      { markup, meta }. No DOM access — safe to unit test under Node.
//   2. A thin "render*Chart" function (browser only) that injects the
//      markup into a container and wires up hover tooltips.
// ---------------------------------------------------------------------------

(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  // ---------------- Shared helpers ----------------

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function scaleLinear(domainMin, domainMax, rangeMin, rangeMax) {
    var span = (domainMax - domainMin) || 1;
    return function (v) {
      var t = (v - domainMin) / span;
      return rangeMin + t * (rangeMax - rangeMin);
    };
  }

  // Rounds a value up to a "nice" axis maximum (1/2/2.5/5/10 x 10^n).
  function niceMax(value) {
    if (!isFinite(value) || value <= 0) return 10;
    var magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    var normalized = value / magnitude;
    var niceNormalized;
    if (normalized <= 1) niceNormalized = 1;
    else if (normalized <= 2) niceNormalized = 2;
    else if (normalized <= 2.5) niceNormalized = 2.5;
    else if (normalized <= 5) niceNormalized = 5;
    else niceNormalized = 10;
    return niceNormalized * magnitude;
  }

  function compactMoney(v, symbol) {
    var sym = symbol || '৳';
    var abs = Math.abs(v);
    var sign = v < 0 ? '-' : '';
    if (abs >= 1000000) return sign + sym + (abs / 1000000).toFixed(abs >= 10000000 ? 0 : 1) + 'M';
    if (abs >= 1000) return sign + sym + (abs / 1000).toFixed(abs >= 10000 ? 0 : 1) + 'K';
    return sign + sym + Math.round(abs);
  }

  function line(x1, y1, x2, y2, cls) {
    return '<line x1="' + x1.toFixed(2) + '" y1="' + y1.toFixed(2) + '" x2="' + x2.toFixed(2) + '" y2="' + y2.toFixed(2) + '" class="' + cls + '"/>';
  }

  function pathFromPoints(pts, closeToBaseline) {
    if (!pts.length) return '';
    var d = 'M ' + pts[0].x.toFixed(2) + ' ' + pts[0].y.toFixed(2);
    for (var i = 1; i < pts.length; i++) d += ' L ' + pts[i].x.toFixed(2) + ' ' + pts[i].y.toFixed(2);
    return d;
  }

  function bandPath(lowPts, highPts) {
    if (!lowPts.length || !highPts.length) return '';
    var d = 'M ' + lowPts[0].x.toFixed(2) + ' ' + lowPts[0].y.toFixed(2);
    for (var i = 1; i < lowPts.length; i++) d += ' L ' + lowPts[i].x.toFixed(2) + ' ' + lowPts[i].y.toFixed(2);
    for (var j = highPts.length - 1; j >= 0; j--) d += ' L ' + highPts[j].x.toFixed(2) + ' ' + highPts[j].y.toFixed(2);
    d += ' Z';
    return d;
  }

  // ============================================================
  // CHART A — Actual vs. Forecasted Spending (cumulative, hero chart)
  // ============================================================

  function buildForecastChart(cumulativeMonth, opts) {
    opts = opts || {};
    var width = opts.width || 760;
    var height = opts.height || 320;
    var formatMoney = opts.formatMoney || function (v) { return String(Math.round(v)); };
    var padLeft = 54, padRight = 14, padTop = 18, padBottom = 30;
    var innerW = width - padLeft - padRight;
    var innerH = height - padTop - padBottom;

    var pts = cumulativeMonth.points;
    var totalDays = cumulativeMonth.totalDays;
    var todayDom = cumulativeMonth.todayDom;
    var budget = cumulativeMonth.budget;

    var allVals = [];
    pts.forEach(function (p) {
      if (p.actual !== null) allVals.push(p.actual);
      if (p.predicted !== null) allVals.push(p.predicted);
      if (p.high !== null) allVals.push(p.high);
    });
    if (budget > 0) allVals.push(budget);
    var maxRaw = allVals.length ? Math.max.apply(null, allVals) : 1;
    var yMax = niceMax(maxRaw * 1.12);

    var xScale = scaleLinear(1, Math.max(totalDays, 2), padLeft, padLeft + innerW);
    var yScale = scaleLinear(0, yMax, padTop + innerH, padTop);

    var markup = '';

    // Horizontal gridlines + $ labels (4 bands)
    var gridSteps = 4;
    for (var g = 0; g <= gridSteps; g++) {
      var val = (yMax / gridSteps) * g;
      var y = yScale(val);
      markup += line(padLeft, y, padLeft + innerW, y, 'fc-gridline');
      markup += '<text x="' + (padLeft - 8).toFixed(2) + '" y="' + (y + 3).toFixed(2) + '" text-anchor="end" class="fc-axis-label">' + esc(compactMoney(val)) + '</text>';
    }

    // Light vertical week gridlines
    for (var wd = 7; wd < totalDays; wd += 7) {
      var xw = xScale(wd);
      markup += line(xw, padTop, xw, padTop + innerH, 'fc-gridline-v');
    }

    // X-axis day labels (start, today, end)
    [1, todayDom, totalDays].forEach(function (dom, idx) {
      if (dom < 1 || dom > totalDays) return;
      if (idx === 1 && (dom === 1 || dom === totalDays)) return; // avoid overlap at edges
      var x = xScale(dom);
      var anchor = dom === 1 ? 'start' : (dom === totalDays ? 'end' : 'middle');
      markup += '<text x="' + x.toFixed(2) + '" y="' + (padTop + innerH + 20).toFixed(2) + '" text-anchor="' + anchor + '" class="fc-axis-label">Day ' + dom + '</text>';
    });

    // Budget reference line
    if (budget > 0 && budget <= yMax * 1.5) {
      var yb = yScale(budget);
      markup += line(padLeft, yb, padLeft + innerW, yb, 'fc-budget-line');
      markup += '<text x="' + (padLeft + 4).toFixed(2) + '" y="' + (yb - 6).toFixed(2) + '" class="fc-budget-label">Budget ' + esc(compactMoney(budget)) + '</text>';
    }

    // Confidence band (today .. end of month)
    var bandLow = [], bandHigh = [];
    pts.forEach(function (p) {
      if (p.dom >= todayDom && p.low !== null && p.high !== null) {
        bandLow.push({ x: xScale(p.dom), y: yScale(p.low) });
        bandHigh.push({ x: xScale(p.dom), y: yScale(p.high) });
      }
    });
    if (bandLow.length > 1) {
      markup += '<path d="' + bandPath(bandLow, bandHigh) + '" class="fc-band"/>';
    }

    // Forecast dashed line (today .. end of month)
    var forecastPts = pts.filter(function (p) { return p.dom >= todayDom && p.predicted !== null; })
      .map(function (p) { return { x: xScale(p.dom), y: yScale(p.predicted) }; });
    if (forecastPts.length > 1) {
      markup += '<path d="' + pathFromPoints(forecastPts) + '" class="fc-forecast-line"/>';
    }

    // Actual solid line (1 .. today)
    var actualPts = pts.filter(function (p) { return p.actual !== null; })
      .map(function (p) { return { x: xScale(p.dom), y: yScale(p.actual) }; });
    if (actualPts.length > 1) {
      markup += '<path d="' + pathFromPoints(actualPts) + '" class="fc-actual-line"/>';
    } else if (actualPts.length === 1) {
      markup += '<circle cx="' + actualPts[0].x.toFixed(2) + '" cy="' + actualPts[0].y.toFixed(2) + '" r="3.5" class="fc-actual-dot"/>';
    }

    // "Today" vertical marker
    var xToday = xScale(todayDom);
    markup += line(xToday, padTop, xToday, padTop + innerH, 'fc-today-line');
    markup += '<text x="' + xToday.toFixed(2) + '" y="' + (padTop - 6).toFixed(2) + '" text-anchor="middle" class="fc-today-label">Today</text>';

    // Junction dot where actual meets forecast
    var todayPt = pts.filter(function (p) { return p.dom === todayDom; })[0];
    if (todayPt) {
      markup += '<circle cx="' + xToday.toFixed(2) + '" cy="' + yScale(todayPt.actual).toFixed(2) + '" r="3.5" class="fc-junction-dot"/>';
    }

    // Invisible hover targets (one per day) for tooltip hit-testing
    var hoverPoints = pts.map(function (p) {
      return {
        dom: p.dom,
        date: p.date,
        x: xScale(p.dom),
        actual: p.actual,
        predicted: p.predicted,
        low: p.low,
        high: p.high,
        isFuture: p.dom > todayDom
      };
    });

    var svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" class="fc-svg fc-chart-a" preserveAspectRatio="xMidYMid meet">' + markup + '</svg>';

    return {
      markup: svg,
      meta: {
        width: width, height: height, padLeft: padLeft, padRight: padRight, padTop: padTop, padBottom: padBottom,
        innerW: innerW, innerH: innerH, xMinData: 1, xMaxData: totalDays, yMax: yMax,
        points: hoverPoints
      }
    };
  }

  // ============================================================
  // CHART B — Weekly Spending Trend (bars + regression trend line)
  // ============================================================

  function buildWeeklyTrendChart(weeklyAggregates, trendLine, opts) {
    opts = opts || {};
    var width = opts.width || 480;
    var height = opts.height || 230;
    var formatMoney = opts.formatMoney || function (v) { return String(Math.round(v)); };
    var padLeft = 50, padRight = 10, padTop = 16, padBottom = 28;
    var innerW = width - padLeft - padRight;
    var innerH = height - padTop - padBottom;

    var n = weeklyAggregates.length;
    var totals = weeklyAggregates.map(function (w) { return w.total; });
    var maxRaw = totals.length ? Math.max.apply(null, totals) : 1;
    if (trendLine && n > 0) {
      var trendEndVal = trendLine.intercept + trendLine.slope * (n - 1);
      var trendStartVal = trendLine.intercept;
      maxRaw = Math.max(maxRaw, trendEndVal, trendStartVal);
    }
    var yMax = niceMax(maxRaw * 1.15);

    var xScale = scaleLinear(-0.5, n - 0.5, padLeft, padLeft + innerW);
    var yScale = scaleLinear(0, yMax, padTop + innerH, padTop);
    var barWidth = n > 0 ? Math.min(38, (innerW / n) * 0.56) : 0;

    var markup = '';

    var gridSteps = 3;
    for (var g = 0; g <= gridSteps; g++) {
      var val = (yMax / gridSteps) * g;
      var y = yScale(val);
      markup += line(padLeft, y, padLeft + innerW, y, 'fc-gridline');
      markup += '<text x="' + (padLeft - 8).toFixed(2) + '" y="' + (y + 3).toFixed(2) + '" text-anchor="end" class="fc-axis-label">' + esc(compactMoney(val)) + '</text>';
    }

    var barMeta = [];
    weeklyAggregates.forEach(function (w, i) {
      var xCenter = xScale(i);
      var yTop = yScale(w.total);
      var h = (padTop + innerH) - yTop;
      var x = xCenter - barWidth / 2;
      markup += '<rect x="' + x.toFixed(2) + '" y="' + yTop.toFixed(2) + '" width="' + barWidth.toFixed(2) + '" height="' + Math.max(0, h).toFixed(2) + '" rx="2.5" class="fc-bar' + (i === n - 1 ? ' fc-bar-current' : '') + '"/>';
      var showLabel = (n <= 8) || (i % Math.ceil(n / 8) === 0) || i === n - 1;
      if (showLabel) {
        markup += '<text x="' + xCenter.toFixed(2) + '" y="' + (padTop + innerH + 18).toFixed(2) + '" text-anchor="middle" class="fc-axis-label">' + esc(shortDateLabel(w.endDate)) + '</text>';
      }
      barMeta.push({ index: i, x: xCenter, startDate: w.startDate, endDate: w.endDate, total: w.total, days: w.days });
    });

    if (trendLine && n > 1) {
      var p1 = { x: xScale(0), y: yScale(Math.max(0, trendLine.intercept)) };
      var p2 = { x: xScale(n - 1), y: yScale(Math.max(0, trendLine.intercept + trendLine.slope * (n - 1))) };
      markup += '<path d="' + pathFromPoints([p1, p2]) + '" class="fc-trend-line"/>';
    }

    var svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" class="fc-svg fc-chart-b" preserveAspectRatio="xMidYMid meet">' + markup + '</svg>';

    return {
      markup: svg,
      meta: { width: width, height: height, points: barMeta }
    };
  }

  function shortDateLabel(dateStr) {
    // dateStr: 'YYYY-MM-DD' -> 'Mon D'
    var d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d)) return dateStr;
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[d.getMonth()] + ' ' + d.getDate();
  }

  // ============================================================
  // CHART C — Day-of-Week Spending Pattern
  // ============================================================

  function buildWeekdayChart(weekdayPattern, opts) {
    opts = opts || {};
    var width = opts.width || 480;
    var height = opts.height || 190;
    var padLeft = 50, padRight = 10, padTop = 16, padBottom = 26;
    var innerW = width - padLeft - padRight;
    var innerH = height - padTop - padBottom;

    var n = weekdayPattern.length;
    var vals = weekdayPattern.map(function (p) { return p.avg; });
    var maxRaw = vals.length ? Math.max.apply(null, vals) : 1;
    var overallAvg = vals.length ? (vals.reduce(function (a, b) { return a + b; }, 0) / n) : 0;
    var yMax = niceMax(Math.max(maxRaw, overallAvg) * 1.2);

    var xScale = scaleLinear(-0.5, n - 0.5, padLeft, padLeft + innerW);
    var yScale = scaleLinear(0, yMax, padTop + innerH, padTop);
    var barWidth = n > 0 ? Math.min(44, (innerW / n) * 0.6) : 0;

    var markup = '';
    var maxIdx = 0;
    for (var i = 1; i < n; i++) if (vals[i] > vals[maxIdx]) maxIdx = i;

    if (overallAvg > 0) {
      var yAvg = yScale(overallAvg);
      markup += line(padLeft, yAvg, padLeft + innerW, yAvg, 'fc-avg-line');
    }

    var barMeta = [];
    weekdayPattern.forEach(function (p, i) {
      var xCenter = xScale(i);
      var yTop = yScale(p.avg);
      var h = (padTop + innerH) - yTop;
      var x = xCenter - barWidth / 2;
      markup += '<rect x="' + x.toFixed(2) + '" y="' + yTop.toFixed(2) + '" width="' + barWidth.toFixed(2) + '" height="' + Math.max(0, h).toFixed(2) + '" rx="2.5" class="fc-weekday-bar' + (i === maxIdx && p.avg > 0 ? ' fc-weekday-bar-max' : '') + '"/>';
      markup += '<text x="' + xCenter.toFixed(2) + '" y="' + (padTop + innerH + 18).toFixed(2) + '" text-anchor="middle" class="fc-axis-label">' + esc(p.label) + '</text>';
      barMeta.push({ index: i, x: xCenter, label: p.label, avg: p.avg, count: p.count });
    });

    var svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" class="fc-svg fc-chart-c" preserveAspectRatio="xMidYMid meet">' + markup + '</svg>';

    return { markup: svg, meta: { width: width, height: height, points: barMeta } };
  }

  var Charts = {
    buildForecastChart: buildForecastChart,
    buildWeeklyTrendChart: buildWeeklyTrendChart,
    buildWeekdayChart: buildWeekdayChart,
    compactMoney: compactMoney,
    _internal: { scaleLinear: scaleLinear, niceMax: niceMax }
  };

  // ---------------- Browser-only DOM + interactivity layer ----------------

  if (typeof document !== 'undefined') {

    function ensureTooltip(wrap) {
      var tip = wrap.querySelector('.fc-tooltip');
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'fc-tooltip hidden';
        wrap.appendChild(tip);
      }
      return tip;
    }

    function positionTooltip(wrap, tip, pxRatioX, pxY, svgWidth, svgHeight) {
      var rect = wrap.getBoundingClientRect();
      var scale = rect.width / svgWidth;
      var left = pxRatioX * scale;
      var top = pxY * scale;
      tip.style.left = Math.min(rect.width - 8, Math.max(8, left)) + 'px';
      tip.style.top = Math.max(8, top - 10) + 'px';
    }

    Charts.renderForecastChart = function (container, cumulativeMonth, opts) {
      opts = opts || {};
      var built = buildForecastChart(cumulativeMonth, opts);
      container.innerHTML = '<div class="fc-chart-wrap">' + built.markup + '</div>';
      var wrap = container.querySelector('.fc-chart-wrap');
      var svgEl = wrap.querySelector('svg');
      var tip = ensureTooltip(wrap);
      var meta = built.meta;
      var formatMoney = opts.formatMoney || function (v) { return String(Math.round(v)); };

      function findNearest(px) {
        var pts = meta.points;
        var nearest = pts[0];
        var best = Infinity;
        for (var i = 0; i < pts.length; i++) {
          var d = Math.abs(pts[i].x - px);
          if (d < best) { best = d; nearest = pts[i]; }
        }
        return nearest;
      }

      svgEl.addEventListener('mousemove', function (evt) {
        var rect = svgEl.getBoundingClientRect();
        var scaleX = meta.width / rect.width;
        var px = (evt.clientX - rect.left) * scaleX;
        var pt = findNearest(px);
        if (!pt) return;

        var lines = [];
        lines.push('<div class="fc-tooltip-date">' + esc(formatDateLabel(pt.date)) + '</div>');
        if (pt.actual !== null) {
          lines.push('<div class="fc-tooltip-row"><span class="fc-dot fc-dot-actual"></span>Actual so far: <strong>' + esc(formatMoney(pt.actual)) + '</strong></div>');
        }
        if (pt.isFuture && pt.predicted !== null) {
          lines.push('<div class="fc-tooltip-row"><span class="fc-dot fc-dot-forecast"></span>Forecast: <strong>' + esc(formatMoney(pt.predicted)) + '</strong></div>');
          if (pt.low !== null && pt.high !== null) {
            lines.push('<div class="fc-tooltip-range">Likely range: ' + esc(formatMoney(pt.low)) + ' \u2013 ' + esc(formatMoney(pt.high)) + '</div>');
          }
        }
        tip.innerHTML = lines.join('');
        tip.classList.remove('hidden');
        positionTooltip(wrap, tip, px, (meta.padTop), meta.width, meta.height);
      });

      svgEl.addEventListener('mouseleave', function () {
        tip.classList.add('hidden');
      });

      return built;
    };

    Charts.renderWeeklyTrendChart = function (container, weeklyAggregates, trendLine, opts) {
      opts = opts || {};
      var built = buildWeeklyTrendChart(weeklyAggregates, trendLine, opts);
      container.innerHTML = '<div class="fc-chart-wrap">' + built.markup + '</div>';
      var wrap = container.querySelector('.fc-chart-wrap');
      var svgEl = wrap.querySelector('svg');
      var tip = ensureTooltip(wrap);
      var meta = built.meta;
      var formatMoney = opts.formatMoney || function (v) { return String(Math.round(v)); };

      svgEl.querySelectorAll('rect.fc-bar, rect.fc-bar-current').forEach(function () {});

      var rects = wrap.querySelectorAll('rect');
      rects.forEach(function (rect, i) {
        var pt = meta.points[i];
        if (!pt) return;
        rect.addEventListener('mouseenter', function () {
          tip.innerHTML = '<div class="fc-tooltip-date">' + esc(shortDateLabel(pt.startDate)) + ' \u2013 ' + esc(shortDateLabel(pt.endDate)) + '</div>' +
            '<div class="fc-tooltip-row"><strong>' + esc(formatMoney(pt.total)) + '</strong></div>';
          tip.classList.remove('hidden');
          var rectBox = rect.getBoundingClientRect();
          var wrapBox = wrap.getBoundingClientRect();
          tip.style.left = Math.min(wrapBox.width - 8, Math.max(8, rectBox.left - wrapBox.left + rectBox.width / 2)) + 'px';
          tip.style.top = Math.max(8, rectBox.top - wrapBox.top - 8) + 'px';
        });
        rect.addEventListener('mouseleave', function () { tip.classList.add('hidden'); });
      });

      return built;
    };

    Charts.renderWeekdayChart = function (container, weekdayPattern, opts) {
      opts = opts || {};
      var built = buildWeekdayChart(weekdayPattern, opts);
      container.innerHTML = '<div class="fc-chart-wrap">' + built.markup + '</div>';
      var wrap = container.querySelector('.fc-chart-wrap');
      var tip = ensureTooltip(wrap);
      var meta = built.meta;
      var formatMoney = opts.formatMoney || function (v) { return String(Math.round(v)); };

      var rects = wrap.querySelectorAll('rect');
      rects.forEach(function (rect, i) {
        var pt = meta.points[i];
        if (!pt) return;
        rect.addEventListener('mouseenter', function () {
          tip.innerHTML = '<div class="fc-tooltip-date">' + esc(pt.label) + 'day average</div>' +
            '<div class="fc-tooltip-row"><strong>' + esc(formatMoney(pt.avg)) + '</strong></div>';
          tip.classList.remove('hidden');
          var rectBox = rect.getBoundingClientRect();
          var wrapBox = wrap.getBoundingClientRect();
          tip.style.left = Math.min(wrapBox.width - 8, Math.max(8, rectBox.left - wrapBox.left + rectBox.width / 2)) + 'px';
          tip.style.top = Math.max(8, rectBox.top - wrapBox.top - 8) + 'px';
        });
        rect.addEventListener('mouseleave', function () { tip.classList.add('hidden'); });
      });

      return built;
    };

    var formatDateLabel = function (dateStr) {
      var d = new Date(dateStr + 'T00:00:00');
      if (isNaN(d)) return dateStr;
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Charts;
  } else {
    global.Charts = Charts;
  }
})(typeof window !== 'undefined' ? window : globalThis);

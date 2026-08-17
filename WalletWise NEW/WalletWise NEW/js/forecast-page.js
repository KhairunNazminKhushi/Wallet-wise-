// forecast-page.js
// Renders the dedicated "Spending Forecast & Time-Series Analysis" page.
// This file is DOM wiring only — all the actual math lives in
// timeseries.js (TS.summarize) and all chart drawing lives in charts.js
// (Charts.render*Chart). Called from renderAll() in app.js whenever the
// underlying data changes, same as every other page.

function renderForecastPage() {
  var emptyState = document.getElementById('forecastEmptyState');
  var content = document.getElementById('forecastContent');
  if (!emptyState || !content) return; // page not present in this build

  var summary = TS.summarize({
    transactions: transactions,
    monthlyBudget: monthlyBudget,
    today: new Date(),
    formatMoney: formatMoney
  });

  if (!summary.hasEnoughData) {
    emptyState.classList.remove('hidden');
    content.classList.add('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  content.classList.remove('hidden');

  renderModelBadge(summary);
  renderConfidenceStamp(summary);
  renderKpiCards(summary);
  renderHeroChart(summary);
  renderExplanation(summary);
  renderBudgetComparison(summary);
  renderSecondaryCharts(summary);
  renderInsights(summary);
}

// ---------------- Model badge ----------------

function renderModelBadge(summary) {
  var badge = document.getElementById('forecastModelBadge');
  if (!badge) return;

  var methodLabel;
  if (summary.dataQuality === 'full') methodLabel = 'Trend + Weekly Seasonality';
  else if (summary.dataQuality === 'partial') methodLabel = 'Trend Analysis';
  else methodLabel = 'Early Estimate';

  var days = summary.historyDays;
  badge.textContent = 'Model: ' + methodLabel + ' \u00b7 Last ' + days + ' day' + (days === 1 ? '' : 's');
}

// ---------------- Confidence stamp ----------------

function renderConfidenceStamp(summary) {
  var stamp = document.getElementById('forecastConfidenceStamp');
  var valueEl = document.getElementById('forecastConfidenceValue');
  var labelEl = document.getElementById('forecastConfidenceLabel');
  if (!stamp || !valueEl || !labelEl) return;

  var rel = summary.reliability;

  stamp.classList.remove('reliability-high', 'reliability-moderate', 'reliability-low', 'reliability-building');
  var toneClass = 'reliability-' + rel.label.toLowerCase();
  if (['reliability-high', 'reliability-moderate', 'reliability-low', 'reliability-building'].indexOf(toneClass) === -1) {
    toneClass = 'reliability-building';
  }
  stamp.classList.add(toneClass);

  valueEl.textContent = rel.score !== null ? rel.score + '%' : '\u2014';
  labelEl.textContent = rel.label + ' Confidence';
}

// ---------------- KPI cards ----------------

function renderKpiCards(summary) {
  var predictedEl = document.getElementById('kpiPredictedTotal');
  var rangeEl = document.getElementById('kpiPredictedRange');
  if (predictedEl) predictedEl.textContent = formatMoney(summary.forecast.predictedTotal);
  if (rangeEl) {
    rangeEl.textContent = summary.monthProgress.daysRemaining > 0
      ? ('Likely ' + formatMoney(summary.forecast.low) + ' \u2013 ' + formatMoney(summary.forecast.high))
      : 'Month complete';
  }

  var daysRemEl = document.getElementById('kpiDaysRemaining');
  var daysRemSubEl = document.getElementById('kpiDaysRemainingSub');
  if (daysRemEl) daysRemEl.textContent = String(summary.monthProgress.daysRemaining);
  if (daysRemSubEl) daysRemSubEl.textContent = summary.monthProgress.daysPassed + ' of ' + summary.monthProgress.daysInMonth + ' days elapsed';

  var deltaEl = document.getElementById('kpiBudgetDelta');
  var deltaSubEl = document.getElementById('kpiBudgetDeltaSub');
  if (deltaEl && deltaSubEl) {
    deltaEl.classList.remove('credit-text', 'debit-text');
    if (summary.budgetComparison.status === 'no-budget') {
      deltaEl.textContent = 'No budget set';
      deltaSubEl.textContent = 'Set one in the Budget tab';
    } else {
      var variance = summary.budgetComparison.variance;
      if (variance > 0) {
        deltaEl.textContent = '+' + formatMoney(variance);
        deltaEl.classList.add('debit-text');
        deltaSubEl.textContent = 'projected over budget';
      } else if (variance < 0) {
        deltaEl.textContent = '\u2212' + formatMoney(Math.abs(variance));
        deltaEl.classList.add('credit-text');
        deltaSubEl.textContent = 'projected under budget';
      } else {
        deltaEl.textContent = formatMoney(0);
        deltaSubEl.textContent = 'right on budget';
      }
    }
  }
}

// ---------------- Hero chart (Chart A) ----------------

function renderHeroChart(summary) {
  var container = document.getElementById('chartAContainer');
  if (!container) return;
  Charts.renderForecastChart(container, summary.cumulativeMonth, { formatMoney: formatMoney });

  var periodLabel = document.getElementById('chartAPeriodLabel');
  if (periodLabel) {
    var monthDate = new Date(summary.monthProgress.year, summary.monthProgress.month, 1);
    periodLabel.textContent = monthDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
}

// ---------------- Explanation ----------------

function renderExplanation(summary) {
  var el = document.getElementById('forecastExplanation');
  if (el) el.textContent = summary.explanation;
}

// ---------------- Budget comparison bar ----------------

function renderBudgetComparison(summary) {
  var bc = summary.budgetComparison;
  var noBudgetNote = document.getElementById('budgetCompareNoBudgetNote');
  var wrap = document.getElementById('budgetCompareBarWrap');
  var statusLine = document.getElementById('budgetCompareStatusLine');
  if (!wrap) return;

  if (bc.status === 'no-budget') {
    if (noBudgetNote) noBudgetNote.classList.remove('hidden');
    wrap.classList.add('hidden');
    if (statusLine) statusLine.classList.add('hidden');
    return;
  }

  if (noBudgetNote) noBudgetNote.classList.add('hidden');
  wrap.classList.remove('hidden');

  var scaleMax = Math.max(bc.budget, bc.predictedTotal, summary.forecast.high, 1) * 1.08;
  var actualPct = clampPct((bc.monthToDateActual / scaleMax) * 100);
  var projectedPct = clampPct((bc.predictedTotal / scaleMax) * 100);
  var budgetPct = clampPct((bc.budget / scaleMax) * 100);

  var actualEl = document.getElementById('budgetCompareActual');
  var projectedEl = document.getElementById('budgetCompareProjected');
  var targetEl = document.getElementById('budgetCompareTargetLine');

  if (actualEl) actualEl.style.width = actualPct + '%';
  if (projectedEl) {
    projectedEl.style.left = actualPct + '%';
    projectedEl.style.width = Math.max(0, projectedPct - actualPct) + '%';
  }
  if (targetEl) targetEl.style.left = budgetPct + '%';

  setText('budgetCompareSpentLabel', formatMoney(bc.monthToDateActual));
  setText('budgetCompareProjectedLabel', formatMoney(bc.predictedTotal));
  setText('budgetCompareBudgetLabel', formatMoney(bc.budget));

  if (statusLine) {
    statusLine.classList.remove('hidden', 'over', 'under');
    var variance = bc.variance;
    if (variance > 0) {
      statusLine.textContent = 'Projected to finish ' + formatMoney(variance) + ' over budget at the current pace.';
      statusLine.classList.add('over');
    } else if (variance < 0) {
      statusLine.textContent = 'Projected to finish ' + formatMoney(Math.abs(variance)) + ' under budget at the current pace.';
      statusLine.classList.add('under');
    } else {
      statusLine.textContent = 'Projected to land right on budget.';
    }
  }
}

function clampPct(v) { return Math.max(0, Math.min(100, v)); }

function setText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ---------------- Secondary charts (Chart B + Chart C) ----------------

function renderSecondaryCharts(summary) {
  var chartBContainer = document.getElementById('chartBContainer');
  if (chartBContainer) {
    Charts.renderWeeklyTrendChart(chartBContainer, summary.weeklyAggregates, summary.weeklyTrendLine, { formatMoney: formatMoney });
  }

  var chartCContainer = document.getElementById('chartCContainer');
  if (chartCContainer) {
    Charts.renderWeekdayChart(chartCContainer, summary.weekdayPattern, { formatMoney: formatMoney });
  }
}

// ---------------- Insights ----------------

function renderInsights(summary) {
  var list = document.getElementById('insightList');
  var emptyNote = document.getElementById('insightEmptyNote');
  if (!list) return;

  list.innerHTML = '';

  if (!summary.insights.length) {
    if (emptyNote) emptyNote.classList.remove('hidden');
    return;
  }
  if (emptyNote) emptyNote.classList.add('hidden');

  summary.insights.forEach(function (insight) {
    var li = document.createElement('li');
    li.className = 'insight-row insight-' + insight.type;
    var tagChar = insight.type === 'up' ? '\u25b2' : (insight.type === 'down' ? '\u25bc' : '\u25cf');
    li.innerHTML = '<span class="insight-tag">' + tagChar + '</span><span>' + escapeHtml(insight.text) + '</span>';
    list.appendChild(li);
  });
}

// ---------------- Dashboard -> Forecast tab link ----------------

function setupForecastDashboardLink() {
  var link = document.getElementById('viewFullForecastLink');
  if (!link) return;
  link.addEventListener('click', function () { showPage('forecast'); });
}

document.addEventListener('DOMContentLoaded', setupForecastDashboardLink);

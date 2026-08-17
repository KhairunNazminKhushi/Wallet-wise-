// forecast.js
// Dashboard-facing spending forecast summary.
//
// This used to be a plain rule-of-three projection (average daily spend so
// far x days in month). It now shares the same trend + weekly-seasonality
// time-series model used by the full "Spending Forecast & Time-Series
// Analysis" tab (see js/timeseries.js for the model, js/forecast-page.js
// for the full breakdown) so the number shown here always matches the one
// on that page.

function renderForecast(monthlyBudgetArg, totalExpensesArg) {
  var predictedEl = document.getElementById('forecastPredicted');
  var noteEl = document.getElementById('forecastNote');
  if (!predictedEl || !noteEl) return;

  noteEl.classList.remove('over', 'ok');

  var summary = TS.summarize({
    transactions: transactions,
    monthlyBudget: monthlyBudget,
    today: new Date(),
    formatMoney: formatMoney
  });

  if (!summary.hasEnoughData) {
    predictedEl.textContent = 'Predicted Monthly Spending: ' + formatMoney(0);
    noteEl.textContent = 'Add an expense to see your forecast.';
    return;
  }

  predictedEl.textContent = 'Predicted Monthly Spending: ' + formatMoney(summary.forecast.predictedTotal);

  if (monthlyBudget <= 0) {
    noteEl.textContent = 'Set a monthly budget in the Budget tab to see if you\u2019re on track.';
    return;
  }

  if (summary.forecast.predictedTotal > monthlyBudget) {
    var excess = summary.forecast.predictedTotal - monthlyBudget;
    noteEl.textContent = 'Likely to exceed your budget by ' + formatMoney(excess) + ' this month.';
    noteEl.classList.add('over');
  } else {
    noteEl.textContent = 'On track to stay within your budget this month.';
    noteEl.classList.add('ok');
  }
}

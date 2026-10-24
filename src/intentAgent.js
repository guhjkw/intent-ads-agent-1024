/*
 * src/intentAgent.js
 * The logic behind the buying-signal and ad agent preview. Loaded by the page (index.html) and the tests (tests/verify.js).
 *
 *   scoreAccounts(data)    agent 1: score every account from its buying signals, tier it, name likely interests,
 *                          and decide who goes on the follow-up list (verified email only)
 *   adBriefs(scored, data) agent 2: one static ad and one short-video script per industry and interest,
 *                          each waiting for approval before it is scheduled
 *   adReport(rows, data)   agent 2: spend and results per ad, with pause / keep / scale decisions
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IntentAgent = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 86400000;

  // Tunable settings: thresholds, how fast a signal fades, and the ad rules.
  var DEFAULTS = {
    today: '2026-10-24',
    halfLife: 30,          // a signal is worth half as much after this many days
    maxAge: 120,           // older signals are ignored
    hot: 70, warm: 45,
    targetCpl: 40,         // target cost per lead in dollars
    minSpend: 60,          // judge an ad only after this much spend
    ctrFloor: 0.8,         // percent
    scaleStep: 0.2, dailyCap: 80
  };

  // Each signal type: base weight, and what it suggests the company may buy.
  var SIGNALS = {
    'hiring-marketing': { label: 'Hiring for marketing or social media', weight: 30, interests: ['social media management', 'short video ads'] },
    'leadership-change': { label: 'New marketing lead or owner', weight: 25, interests: ['agency review', 'paid social campaigns'] },
    'funding': { label: 'Raised money or got a loan announcement', weight: 25, interests: ['paid social campaigns'] },
    'new-location': { label: 'Opened a new location', weight: 20, interests: ['local awareness ads'] },
    'product-launch': { label: 'Launching a new service', weight: 20, interests: ['launch campaign', 'short video ads'] },
    'ads-started': { label: 'Started running Meta ads', weight: 15, interests: ['creative refresh', 'short video ads'] },
    'ads-stopped': { label: 'Stopped running ads', weight: 10, interests: ['paid social campaigns'] },
    'review-drop': { label: 'Google rating dropped', weight: 10, interests: ['reputation content'] },
    'site-visit': { label: 'Visited your pricing page', weight: 30, interests: [] }
  };

  function settingsOf(o) { var s = JSON.parse(JSON.stringify(DEFAULTS)); Object.keys(o || {}).forEach(function (k) { s[k] = o[k]; }); return s; }
  function d(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; }
  function r1(x) { return Math.round(x * 10) / 10; }

  function signalValue(sig, s) {
    var def = SIGNALS[sig.type]; if (!def) return null;
    var age = Math.round((d(s.today) - d(sig.date)) / DAY);
    if (isNaN(age) || age < 0) return null;
    if (age > s.maxAge) return { type: sig.type, label: def.label, age: age, value: 0, note: sig.note || '', stale: true };
    return { type: sig.type, label: def.label, age: age, value: r1(def.weight * Math.pow(0.5, age / s.halfLife)), note: sig.note || '', stale: false };
  }

  /*
   * Agent 1. Bad rows are skipped and reported, never guessed at.
   */
  function scoreAccounts(data, opts) {
    var s = settingsOf(Object.assign({}, data.settings || {}, opts || {})), fit = {}, skipped = [];
    (data.industries || []).forEach(function (i) { fit[i.id] = i; });
    var accounts = [];
    (data.accounts || []).forEach(function (a, n) {
      if (!a || !a.company) { skipped.push({ row: n + 1, reason: 'no company name' }); return; }
      if (!fit[a.industry]) { skipped.push({ row: n + 1, company: a.company, reason: 'industry "' + a.industry + '" is not one of the 5 targets' }); return; }
      var sigs = [], unknown = [];
      (a.signals || []).forEach(function (g) { var v = signalValue(g, s); if (v) sigs.push(v); else unknown.push(g.type); });
      var raw = sigs.reduce(function (t, x) { return t + x.value; }, 0);
      var score = Math.min(100, Math.round(raw * fit[a.industry].fit));
      var tier = score >= s.hot ? 'hot' : score >= s.warm ? 'warm' : 'cold';
      // Likely interests: each signal votes for its interests with its current value.
      var votes = {};
      sigs.forEach(function (x) { if (!x.value) return; SIGNALS[x.type].interests.forEach(function (i) { votes[i] = (votes[i] || 0) + x.value; }); });
      var interests = Object.keys(votes).sort(function (p, q) { return votes[q] - votes[p] || (p < q ? -1 : 1); }).slice(0, 2);
      var c = a.contact || {}, es = c.emailStatus || 'none';
      var visited = sigs.some(function (x) { return x.type === 'site-visit' && x.age <= 7; });
      var next = tier === 'cold' ? 'Watch: no outreach yet'
        : es === 'valid' && visited ? 'Call within a day (visited your pricing page), then add to follow-up list'
        : es === 'valid' ? 'Add to follow-up list'
        : es === 'catch-all' ? 'Hold: catch-all domain, verify again or reach on LinkedIn'
        : 'Find another contact: no usable email';
      accounts.push({ company: a.company, city: a.city, industry: a.industry, industryName: fit[a.industry].name, score: score, tier: tier, visited: visited, signals: sigs.sort(function (p, q) { return q.value - p.value; }), unknownSignals: unknown, interests: interests, contact: c, emailStatus: es, followUp: tier !== 'cold' && es === 'valid', next: next });
    });
    accounts.sort(function (p, q) { return q.score - p.score || (p.company < q.company ? -1 : 1); });
    var followUp = accounts.filter(function (x) { return x.followUp; });
    return { accounts: accounts, skipped: skipped, followUp: followUp, counts: { hot: accounts.filter(function (x) { return x.tier === 'hot'; }).length, warm: accounts.filter(function (x) { return x.tier === 'warm'; }).length, cold: accounts.filter(function (x) { return x.tier === 'cold'; }).length } };
  }

  /*
   * Agent 2, part 1: ads are tailored to a group of similar prospects (industry + top interest), never to a named
   * person, and every brief starts as "needs approval".
   */
  function adBriefs(scored, data) {
    var groups = {}, copy = data.copy || {};
    scored.accounts.forEach(function (a) {
      if (a.tier === 'cold' || !a.interests.length) return;
      var key = a.industry + '|' + a.interests[0];
      if (!groups[key]) groups[key] = { id: 'AD-' + a.industry + '-' + a.interests[0].replace(/\W+/g, '-'), industry: a.industry, industryName: a.industryName, interest: a.interests[0], accounts: [], cities: [] };
      groups[key].accounts.push(a.company);
      if (a.city && groups[key].cities.indexOf(a.city) < 0) groups[key].cities.push(a.city);
    });
    return Object.keys(groups).sort().map(function (k) {
      var g = groups[k], tpl = copy[g.interest] || copy['default'] || { hook: 'More {customers} this month', body: 'We help {industry} businesses get found.' };
      var ind = data.industries.filter(function (i) { return i.id === g.industry; })[0] || {};
      function f(x) { return String(x).replace(/\{business\}/g, ind.noun || 'business').replace(/\{industry\}/g, g.industryName.toLowerCase()).replace(/\{customers\}/g, (data.industries.filter(function (i) { return i.id === g.industry; })[0] || {}).customers || 'customers').replace(/\{city\}/g, g.cities[0] || 'your city'); }
      return {
        id: g.id, industry: g.industryName, interest: g.interest, audience: g.accounts.length + ' account' + (g.accounts.length > 1 ? 's' : '') + ' in ' + g.cities.join(', '),
        accounts: g.accounts,
        staticAd: { headline: f(tpl.hook), text: f(tpl.body) },
        video: [f('0-3 s: ' + tpl.hook), f('3-10 s: ' + (tpl.scene || 'Show the before and after for a {business} in {city}.')), '10-15 s: Book a 15-minute call. Link below.'],
        status: 'needs approval'
      };
    });
  }

  /*
   * Agent 2, part 2: results per ad. Nothing is judged before minSpend.
   */
  function adReport(rows, opts) {
    var s = settingsOf(opts), out = [], skipped = [], tot = { spend: 0, impressions: 0, clicks: 0, leads: 0 };
    (rows || []).forEach(function (r, n) {
      var bad = ['spend', 'impressions', 'clicks', 'leads', 'daily'].filter(function (k) { return typeof r[k] !== 'number' || r[k] < 0 || isNaN(r[k]); });
      if (bad.length) { skipped.push({ row: n + 1, id: r.id, reason: 'not a number: ' + bad.join(', ') }); return; }
      if (r.clicks > r.impressions) { skipped.push({ row: n + 1, id: r.id, reason: 'more clicks than impressions' }); return; }
      var ctr = r.impressions ? r.clicks / r.impressions * 100 : 0, cpl = r.leads ? r.spend / r.leads : null, action, why, daily = r.daily;
      if (r.spend < s.minSpend) { action = 'keep'; why = 'under $' + s.minSpend + ' spent: too early to judge'; }
      else if (!r.leads) { action = 'pause'; why = 'spent $' + r.spend + ' with no leads'; daily = 0; }
      else if (cpl > s.targetCpl * 1.5) { action = 'pause'; why = 'cost per lead $' + r1(cpl) + ' is over 1.5x the $' + s.targetCpl + ' target'; daily = 0; }
      else if (cpl <= s.targetCpl && ctr >= s.ctrFloor) { daily = Math.min(s.dailyCap, Math.round(r.daily * (1 + s.scaleStep))); action = daily > r.daily ? 'scale' : 'keep'; why = daily > r.daily ? 'under target at $' + r1(cpl) + ' a lead: daily budget $' + r.daily + ' to $' + daily : 'under target, already at the $' + s.dailyCap + ' daily cap'; }
      else { action = 'keep'; why = 'within range: $' + r1(cpl) + ' a lead, ' + r1(ctr) + '% click rate'; }
      tot.spend += r.spend; tot.impressions += r.impressions; tot.clicks += r.clicks; tot.leads += r.leads;
      out.push({ id: r.id, spend: r.spend, ctr: r1(ctr), cpl: cpl === null ? null : r1(cpl), action: action, why: why, daily: daily, oldDaily: r.daily });
    });
    tot.ctr = tot.impressions ? r1(tot.clicks / tot.impressions * 100) : 0;
    tot.cpl = tot.leads ? r1(tot.spend / tot.leads) : null;
    return { rows: out, skipped: skipped, totals: tot };
  }

  return { DEFAULTS: DEFAULTS, SIGNALS: SIGNALS, scoreAccounts: scoreAccounts, adBriefs: adBriefs, adReport: adReport, signalValue: signalValue };
});

/*
 * tests/verify.js: node tests for src/intentAgent.js (the same file index.html loads).
 * Run: node tests/verify.js      (expects "0 failed" on the last line)
 */
'use strict';
var A = require('../src/intentAgent.js'), D = require('../data/sample.json');
var passed = 0, failed = 0;
function check(name, cond) { if (cond) { passed++; console.log('PASS: ' + name); } else { failed++; console.log('FAIL: ' + name); } }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
var S = A.scoreAccounts(D);
function acc(name, s) { return (s || S).accounts.filter(function (a) { return a.company === name; })[0]; }

console.log('1. Agent 1: scoring buying signals');
check('10 accounts scored: 3 hot, 4 warm, 3 cold', S.accounts.length === 10 && S.counts.hot === 3 && S.counts.warm === 4 && S.counts.cold === 3);
check('Northline Roofing is first at 81 (hiring + financing + pricing-page visit)', S.accounts[0].company === 'Northline Roofing' && S.accounts[0].score === 81);
check('a signal loses half its value after 30 days', A.signalValue({ type: 'funding', date: '2026-09-24' }, A.DEFAULTS).value === 12.5);
check('a signal older than 120 days counts for nothing', A.signalValue({ type: 'funding', date: '2026-05-01' }, A.DEFAULTS).value === 0);
check('a future-dated signal is ignored, not counted', A.signalValue({ type: 'funding', date: '2026-11-30' }, A.DEFAULTS) === null);
check('real estate counts at 0.8: same signals score lower than in dental', (function () { var d = clone(D); d.accounts = [{ company: 'X', industry: 'dental', signals: [{ type: 'funding', date: '2026-10-24' }] }, { company: 'Y', industry: 'realty', signals: [{ type: 'funding', date: '2026-10-24' }] }]; var s = A.scoreAccounts(d); return acc('X', s).score === 25 && acc('Y', s).score === 20; })());
check('scores cap at 100', (function () { var d = clone(D); d.accounts = [{ company: 'Z', industry: 'dental', signals: ['hiring-marketing', 'site-visit', 'funding', 'leadership-change', 'new-location'].map(function (t) { return { type: t, date: '2026-10-24' }; }) }]; return A.scoreAccounts(d).accounts[0].score === 100; })());
check('likely interests come from the strongest signals: short video ads first for Lakeshore', acc('Lakeshore Family Dental').interests[0] === 'short video ads');

console.log('\n2. Agent 1: who gets followed up');
check('only warm or hot accounts with a verified email go on the follow-up list (5)', S.followUp.length === 5 && S.followUp.every(function (a) { return a.emailStatus === 'valid' && a.tier !== 'cold'; }));
check('a pricing-page visit this week: call within a day first', /^Call within a day/.test(acc('Northline Roofing').next));
check('a catch-all email is held, not sent', /^Hold: catch-all/.test(acc('Bloor West Smiles').next) && !acc('Bloor West Smiles').followUp);
check('no usable email: find another contact', /^Find another contact/.test(acc('Capital Comfort HVAC').next));
check('cold accounts are watched, not contacted, even with a valid email', acc('Maple Key Homes').next === 'Watch: no outreach yet');
check('an industry outside the 5 is skipped with the reason', S.skipped.some(function (x) { return x.company === 'Riverside Auto Repair' && /not one of the 5 targets/.test(x.reason); }));
check('a row with no company name is skipped, not crashed', S.skipped.some(function (x) { return x.reason === 'no company name'; }));

console.log('\n3. Agent 2: ad briefs');
var B = A.adBriefs(S, D);
check('one brief per industry and interest, from warm and hot accounts only (6)', B.length === 6);
check('the two home-services accounts share one brief (Hamilton, Ottawa)', B.filter(function (b) { return b.id === 'AD-home-short-video-ads'; })[0].audience === '2 accounts in Hamilton, Ottawa');
check('copy is tailored: "15-second videos that bring in new patients" for dental', B.filter(function (b) { return b.id === 'AD-dental-short-video-ads'; })[0].staticAd.headline === '15-second videos that bring in new patients');
check('no ad names a person', B.every(function (b) { return JSON.stringify(b).indexOf('Anika') < 0 && JSON.stringify(b).indexOf('Dave') < 0; }));
check('every brief waits for approval', B.every(function (b) { return b.status === 'needs approval'; }));
check('each brief has a 3-part, 15-second video script', B.every(function (b) { return b.video.length === 3 && /^10-15 s/.test(b.video[2]); }));

console.log('\n4. Agent 2: spend and performance');
var R = A.adReport(D.adResults);
function row(id) { return R.rows.filter(function (r) { return r.id === id; })[0]; }
check('dental video ad at $28 a lead: scale daily budget $30 to $36', row('AD-dental-short-video-ads').action === 'scale' && row('AD-dental-short-video-ads').daily === 36);
check('$95 spent with no leads: pause', row('AD-home-paid-social-campaigns').action === 'pause' && row('AD-home-paid-social-campaigns').daily === 0);
check('under $60 spent: too early to judge', row('AD-medspa-launch-campaign').action === 'keep' && /too early/.test(row('AD-medspa-launch-campaign').why));
check('exactly 1.5x target ($60) is kept, over it ($66.70) is paused', row('AD-fitness-local-awareness-ads').action === 'keep' && row('AD-realty-short-video-ads').action === 'pause');
check('totals: $600 spent, 11 leads, $54.50 a lead', R.totals.spend === 600 && R.totals.leads === 11 && R.totals.cpl === 54.5);
check('scaling stops at the $80 daily cap', A.adReport([{ id: 'x', spend: 300, impressions: 30000, clicks: 600, leads: 20, daily: 75 }]).rows[0].daily === 80);
var bad = A.adReport([{ id: 'b1', spend: 'lots', impressions: 1, clicks: 0, leads: 0, daily: 5 }, { id: 'b2', spend: 10, impressions: 10, clicks: 50, leads: 0, daily: 5 }]);
check('bad rows are skipped with reasons (not a number, more clicks than impressions)', bad.rows.length === 0 && /not a number: spend/.test(bad.skipped[0].reason) && /more clicks/.test(bad.skipped[1].reason));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;

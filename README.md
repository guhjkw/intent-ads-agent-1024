# Buying Signal and Ad Agents (preview)

Two agents for a team selling social media and short video ads to five industries.
Agent 1 scores companies by buying signals (hiring for marketing, new location, funding, new marketing lead, ads started or stopped, rating drop, pricing-page visit), names likely interests, and exports only verified emails for follow-up.
Agent 2 writes ad briefs per industry and interest (never per person), waits for approval, and decides pause / keep / scale for each running ad by cost per lead.

Live: https://guhjkw.github.io/intent-ads-agent-1024/

## Files
```
index.html               the interface (Clay-style table, ad briefs, ad results)
src/intentAgent.js       scoreAccounts(), adBriefs(), adReport(), signalValue()
data/sample.json         invented Ontario companies, signals, ad copy, last week's ad results
tests/verify.js          28 node tests
tests/browser-check.py   22 Playwright checks
```
The page and the tests load the same `src/intentAgent.js`.

## Run the tests
```
node tests/verify.js            # 28 passed, 0 failed
python3 tests/browser-check.py  # 22 passed, 0 failed
```

## Rules
| Area | Rule |
|---|---|
| Signal value | Base weight x 0.5^(age / 30 days); ignored after 120 days; future dates refused |
| Score | Sum of signal values x industry fit (real estate 0.8, fitness 0.9, others 1.0), capped at 100 |
| Tier | Hot 70+, warm 45+, cold below |
| Follow-up | Warm or hot with a verified email; pricing-page visit in the last 7 days means call within a day first; catch-all held; none or invalid means find another contact |
| Briefs | One per industry and top interest from warm and hot accounts; static ad + 15-second script; "needs approval" until approved |
| Ad decisions | Under $60 spent: keep. No leads: pause. Cost per lead over 1.5x target: pause. At or under target with click rate 0.8%+: scale daily budget 20%, cap $80 |

In the delivered build, scoring and follow-up rules run as columns in Clay tables, and the ad agent runs on Claude with the client's ad accounts.

Built by Taiwo, Pathfinder Automation Solutions.

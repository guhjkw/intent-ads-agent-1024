"""
tests/browser-check.py
Playwright checks that drive the real page (index.html), which loads the
same src/intentAgent.js that tests/verify.js tests.
Run:  python3 tests/browser-check.py      (expects "0 failed" on the last line)
"""
import functools, http.server, pathlib, threading
from html.parser import HTMLParser
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"
passed = failed = 0
def check(name, cond):
    global passed, failed
    if cond: passed += 1; print(f"PASS: {name}")
    else: failed += 1; print(f"FAIL: {name}")

class Balance(HTMLParser):
    VOID = {"meta","link","br","input","img","hr","source","wbr","col"}
    def __init__(self): super().__init__(); self.stack, self.errors = [], []
    def handle_starttag(self, tag, attrs):
        if tag not in self.VOID: self.stack.append(tag)
    def handle_endtag(self, tag):
        if tag in self.VOID: return
        if not self.stack or self.stack[-1] != tag: self.errors.append(f"unexpected </{tag}> open {self.stack[-3:]}")
        else: self.stack.pop()

print("0. HTML tag balance")
b = Balance(); b.feed((ROOT / "index.html").read_text())
check("all tags closed and nested", not b.errors and not b.stack)
if b.errors: print(b.errors[:5])

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT)); handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler); threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"
problems = []

with sync_playwright() as pw:
    br = pw.chromium.launch()
    p = br.new_page(viewport={"width": 1366, "height": 950})
    p.on("console", lambda m: problems.append(m.text) if m.type == "error" else None)
    p.on("pageerror", lambda e: problems.append(str(e)))
    p.goto(url); p.wait_for_selector("[data-testid=row]")
    txt = lambda t: p.locator(f"[data-testid={t}]").first.text_content()
    rows = lambda: p.locator("[data-testid=row]").count()
    def pick(name): p.click(f"[data-testid=row][data-c='{name}']")

    print("1. Agent 1 table")
    check("10 scored rows: 3 hot, 4 warm, 3 cold", rows() == 10 and txt("counts") == "3 hot · 4 warm · 3 cold")
    check("first row is Northline Roofing at 81", "Northline Roofing" in p.locator("[data-testid=row]").first.text_content() and "81" in p.locator("[data-testid=row]").first.text_content())
    check("follow-up list has 5 verified rows, Bloor West Smiles (catch-all) is not on it", txt("fu-n") == "5 verified" and "Bloor West" not in p.input_value("[data-testid=csv]"))
    check("skipped rows are reported with reasons", "Riverside Auto Repair" in txt("skipped") and "no company name" in txt("skipped"))
    p.click("[data-testid=f-hot]")
    check("Hot filter shows 3 rows", rows() == 3)
    p.click("[data-testid=f-all]"); p.select_option("[data-testid=f-ind]", "home")
    check("Home services filter shows 2 rows", rows() == 2)
    p.select_option("[data-testid=f-ind]", "")
    p.screenshot(path=str(TESTS / "screenshot-default.png"), full_page=False)

    print("\n2. Change the inputs")
    pick("Capital Comfort HVAC")
    check("Capital Comfort: no usable email, find another contact", "Find another contact" in txt("d-next"))
    p.select_option("[data-testid=d-es]", "valid")
    check("set its email to valid: it joins the follow-up list (6)", txt("fu-n") == "6 verified" and "Add to follow-up list" in txt("d-next"))
    pick("Maple Key Homes")
    before = int(txt("d-tier").split("·")[1])
    p.select_option("[data-testid=s-type]", "site-visit"); p.fill("[data-testid=s-date]", "2026-10-24"); p.click("[data-testid=s-add]")
    after = int(txt("d-tier").split("·")[1])
    check(f"a pricing-page visit today lifts Maple Key Homes ({before} to {after})", after > before + 20)
    p.fill("[data-testid=s-date]", "2026-11-20"); p.click("[data-testid=s-add]")
    check("a signal dated next month is refused with a reason", "future" in txt("s-err"))
    p.click("[data-testid=d-sigs] button >> nth=0")
    check("removing a signal lowers the score again", int(txt("d-tier").split("·")[1]) < after)

    print("\n3. Agent 2")
    briefs = p.locator("[data-testid=brief]").count()
    check(f"{briefs} ad briefs, all waiting for approval", briefs >= 6 and p.locator("[data-testid=bstat]", has_text="Needs approval").count() == briefs)
    p.click("[data-testid=brief][data-id=AD-dental-short-video-ads] [data-testid=approve]")
    check("approving one schedules it; the rest still wait", p.locator("[data-testid=bstat]", has_text="Approved").count() == 1 and p.locator("[data-testid=bstat]", has_text="Needs approval").count() == briefs - 1)
    acts = [p.locator("[data-testid=prow]").nth(i).get_attribute("data-act") for i in range(5)]
    check("last week's ads: scale, pause, keep, keep, pause", acts == ["scale", "pause", "keep", "keep", "pause"])
    p.fill("[data-testid=leads-0]", "0"); p.locator("[data-testid=leads-0]").dispatch_event("change")
    check("set the dental ad's leads to 0: it pauses", p.locator("[data-testid=prow]").nth(0).get_attribute("data-act") == "pause")
    p.fill("[data-testid=leads-0]", "lots"); p.locator("[data-testid=leads-0]").dispatch_event("change")
    check("a non-number is refused with the reason", "not a number: leads" in txt("p-err"))
    p.fill("[data-testid=cpl]", "70")
    check("raise the target to $70 a lead and the real estate ad is no longer paused", p.locator("[data-testid=prow]").nth(4).get_attribute("data-act") != "pause")
    p.click("[data-testid=reset]")
    check("reset restores the sample", txt("fu-n") == "5 verified" and p.locator("[data-testid=bstat]", has_text="Approved").count() == 0)
    p.locator("#app").scroll_into_view_if_needed()
    p.screenshot(path=str(TESTS / "screenshot-app.png"), full_page=False)

    print("\n4. Phone width")
    m = br.new_page(viewport={"width": 390, "height": 844})
    m.on("pageerror", lambda e: problems.append(str(e)))
    m.goto(url); m.wait_for_selector("[data-testid=row]")
    check("no horizontal page scroll at 390px", m.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"))
    m.locator("#app").scroll_into_view_if_needed(); m.screenshot(path=str(TESTS / "screenshot-mobile.png"), full_page=False)

    print("\n5. Off disk (file://, fallback data)")
    f = br.new_page(); f.on("pageerror", lambda e: problems.append(str(e)))
    f.goto((ROOT / "index.html").as_uri()); f.wait_for_selector("[data-testid=row]")
    check("file:// copy works on the embedded data", f.locator("[data-testid=row]").count() == 10)

    print("\n6. Console")
    check("zero console or page errors", not [x for x in problems if "Failed to fetch" not in x and "ERR_FILE" not in x and "CORS" not in x])
    if problems: print(problems)
    br.close()
srv.shutdown()
print(f"\n{passed} passed, {failed} failed")

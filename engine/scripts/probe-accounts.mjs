// Throwaway live probe (Task 2). Read-only unless a step says otherwise. Never clicks anything named "Sign out".
import { chromium } from "playwright-core";
const step = process.argv[2] ?? "look";
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const pages = browser.contexts().flatMap(c => c.pages());
const page = pages.find(p => p.url().includes("flow.google")) ?? pages[0];
console.log("URL:", page.url());
if (step === "look") {
  const btns = await page.locator("button, a, [role=button]").evaluateAll(els => els
    .map(e => (e.getAttribute("aria-label") || "").trim())
    .filter(t => /account|google|sign|avatar|profile/i.test(t)));
  console.log("account-ish controls:", [...new Set(btns)]);
  const snap = await page.locator("body").ariaSnapshot();
  console.log(snap.split("\n").slice(0, 60).join("\n"));
}
await browser.close().catch(() => {}); // connectOverCDP close only disconnects
if (step === "menu") {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const p = b.contexts().flatMap(c => c.pages()).find(x => x.url().includes("flow.google"));
  await p.getByRole("button", { name: "Account details" }).click();
  await p.waitForTimeout(2500);
  for (const f of p.frames()) {
    const t = await f.locator("body").ariaSnapshot().catch(() => "");
    if (/@/.test(t)) console.log("FRAME", f.url().slice(0, 80), "\n" + t.split("\n").slice(0, 80).join("\n"));
  }
  await p.keyboard.press("Escape");
  await b.close().catch(() => {});
}
if (step === "walk") {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const p = b.contexts().flatMap(c => c.pages()).find(x => x.url().includes("flow.google"));
  for (let n = 0; n <= 10; n++) {
    await p.goto(`https://flow.google.com/u/${n}/?hl=en`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(3000);
    const btn = await p.getByRole("button", { name: /Google Account:/ }).first().getAttribute("aria-label").catch(() => null);
    let credits = null, refresh = null;
    if (btn) {
      await p.getByRole("button", { name: "Account details" }).click();
      await p.waitForTimeout(1500);
      credits = await p.getByRole("link", { name: /Google Flow credits/ }).first().textContent().catch(() => null);
      refresh = await p.getByText(/Credits refresh/).first().textContent().catch(() => null);
      await p.keyboard.press("Escape");
    }
    const email = (btn ?? "").match(/\(([^)]+)\)/)?.[1] ?? "";
    console.log(`n=${n} url=${p.url().replace(/Email=[^&]+/, "Email=*")} acct=${email ? email.slice(0, 3) + "***" : "none"} credits=${credits} refresh=${refresh}`);
  }
  await p.goto("https://flow.google.com/u/0/?hl=en");
  await b.close().catch(() => {});
}
if (step === "projects") {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const p = b.contexts().flatMap(c => c.pages()).find(x => x.url().includes("flow.google"));
  let sample = null;
  for (let n = 0; n <= 3; n++) {
    await p.goto(`https://flow.google.com/u/${n}/?hl=en`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(3000);
    const hrefs = await p.locator("a[href*='/project/']").evaluateAll(as => as.map(a => a.getAttribute("href")));
    console.log(`n=${n} projects=${hrefs.length} first=${hrefs[0] ?? "-"}`);
    if (hrefs[0] && !sample) sample = { n, href: hrefs[0] };
  }
  if (sample) {
    const other = (sample.n + 1) % 4;
    const url = new URL(sample.href.replace(/\/u\/\d+\//, `/u/${other}/`), "https://flow.google.com").href;
    await p.goto(url, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(4000);
    console.log(`project of u/${sample.n} opened as u/${other}: landed ${p.url()}`);
    console.log((await p.locator("body").innerText()).slice(0, 300).replace(/\s+/g, " "));
  }
  await p.goto("https://flow.google.com/u/0/?hl=en");
  await b.close().catch(() => {});
}

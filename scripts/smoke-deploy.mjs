/**
 * Post-deploy smoke test: load a DEPLOYED page in a real browser and fail on
 * anything that would greet a visitor with a broken app.
 *
 * A build passing proves the code compiles. It does not prove the page runs -
 * a duplicate React, a bad base path, a missing asset or a thrown exception on
 * mount all build green and white-screen in the browser. This runs against the
 * URL that was actually published, so it also covers the deploy itself: asset
 * paths, redirects and headers, not just the bundle.
 *
 * Checks per URL:
 *   1. the navigation itself returns < 400
 *   2. no uncaught exception (pageerror)
 *   3. no console.error
 *   4. no failed subresource request, and no subresource response >= 400
 *   5. the app actually rendered something (the mount point has children)
 *
 * Usage:
 *   node scripts/smoke-deploy.mjs <url> [<url>...]
 *     [--mount "#root"]        selector that must have children (default #root, falls back to body)
 *     [--ignore "<regex>"]     message/URL patterns to tolerate; repeatable
 *     [--settle 2500]          ms to wait after load for late errors
 *     [--timeout 45000]        ms navigation timeout
 *     [--retries 3]            navigation attempts, for a CDN that is still warming
 *
 * Uses playwright-core against the Chrome that GitHub's runner images already
 * ship, so there is no browser download. Set SMOKE_BROWSER_CHANNEL to override
 * (e.g. "msedge"), or SMOKE_BROWSER_PATH for an explicit executable.
 */
import { chromium } from 'playwright-core';

const argv = process.argv.slice(2);
const urls = [];
const ignores = [];
let mount = '#root';
let settle = 2500;
let timeout = 45000;
let retries = 3;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--ignore') ignores.push(new RegExp(argv[++i], 'i'));
  else if (a === '--mount') mount = argv[++i];
  else if (a === '--settle') settle = Number(argv[++i]);
  else if (a === '--timeout') timeout = Number(argv[++i]);
  else if (a === '--retries') retries = Number(argv[++i]);
  else if (a.startsWith('--')) { console.error(`unknown flag ${a}`); process.exit(2); }
  else urls.push(a);
}

if (urls.length === 0) {
  console.error('usage: node scripts/smoke-deploy.mjs <url> [<url>...] [--mount sel] [--ignore re]');
  process.exit(2);
}

/** Noise that is expected on a headless runner and must not fail the gate. */
const DEFAULT_IGNORES = [
  /favicon\.ico/i,                       // browsers request it whether or not it exists
  /\bWebGL\b.*(unavailable|disabled|swiftshader)/i,
  /GPU stall|Automatic fallback to software webgl/i,
  /navigator\.xr|WebXR|immersive-vr|xr-spatial-tracking/i, // no XR device on a runner
  // Chrome logs a bare "Failed to load resource: ... 404" with NO url in the
  // text, so it cannot be filtered by target. The response/requestfailed
  // handlers below report the same failures WITH the url and are filterable,
  // so this console duplicate is dropped rather than double-counted.
  /^Failed to load resource:/i,
];

const tolerated = (text) =>
  DEFAULT_IGNORES.some((re) => re.test(text)) || ignores.some((re) => re.test(text));

const launchOpts = { args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] };
if (process.env.SMOKE_BROWSER_PATH) launchOpts.executablePath = process.env.SMOKE_BROWSER_PATH;
else launchOpts.channel = process.env.SMOKE_BROWSER_CHANNEL || 'chrome';

const browser = await chromium.launch(launchOpts);
let failed = 0;

for (const url of urls) {
  const problems = [];
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  page.on('pageerror', (err) => {
    const text = `uncaught ${err.name}: ${err.message}`;
    if (!tolerated(text)) problems.push(text);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (!tolerated(text)) problems.push(`console.error: ${text}`);
  });
  page.on('requestfailed', (req) => {
    const text = `request failed: ${req.url()} (${req.failure()?.errorText ?? 'unknown'})`;
    if (!tolerated(text)) problems.push(text);
  });
  page.on('response', (res) => {
    if (res.status() < 400) return;
    const text = `HTTP ${res.status()}: ${res.url()}`;
    if (!tolerated(text)) problems.push(text);
  });

  console.log(`\n-> ${url}`);
  let response = null;
  let navError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      response = await page.goto(url, { waitUntil: 'load', timeout });
      navError = null;
      break;
    } catch (err) {
      navError = err;
      if (attempt < retries) {
        console.log(`   navigation attempt ${attempt} failed, retrying...`);
        await page.waitForTimeout(3000 * attempt);
      }
    }
  }

  if (navError) {
    problems.push(`navigation failed after ${retries} attempts: ${navError.message}`);
  } else {
    if (response && response.status() >= 400) {
      problems.push(`document returned HTTP ${response.status()}`);
    }
    // Late errors surface during hydration and first paint, not during load.
    await page.waitForTimeout(settle);

    const rendered = await page.evaluate((sel) => {
      const el = document.querySelector(sel) ?? document.body;
      if (!el) return { found: false, children: 0, text: 0 };
      return {
        found: Boolean(document.querySelector(sel)),
        children: el.childElementCount,
        text: (el.textContent ?? '').trim().length,
      };
    }, mount);

    if (!rendered.found) {
      console.log(`   note: "${mount}" not present, fell back to <body>`);
    }
    if (rendered.children === 0 && rendered.text === 0) {
      problems.push(`the page rendered nothing - "${mount}" is empty (white screen)`);
    } else {
      console.log(`   rendered: ${rendered.children} child element(s), ${rendered.text} chars of text`);
    }
  }

  await context.close();

  if (problems.length === 0) {
    console.log('   ok - no runtime errors');
  } else {
    failed++;
    console.log(`   FAIL - ${problems.length} problem(s):`);
    for (const p of problems.slice(0, 20)) console.log(`     - ${p}`);
    if (problems.length > 20) console.log(`     ... and ${problems.length - 20} more`);
  }
}

await browser.close();

console.log('');
if (failed > 0) {
  console.error(`smoke test FAILED for ${failed} of ${urls.length} URL(s).`);
  process.exit(1);
}
console.log(`smoke test passed - ${urls.length} URL(s) load and run cleanly.`);

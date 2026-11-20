// Runs the real staged app page (.web/src/index.html) in headless Edge/Chrome with a
// stub Tauri bridge and the app's CSP, then screenshots the cat while it sits.
//   node scripts/stage-web.mjs && node tools/mesh25d/app_check.mjs
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = path.join(ROOT, '.web');
const require = createRequire(path.join(ROOT, 'tools', 'cat3d', 'package.json'));
const { chromium } = require('playwright-core');
const conf = JSON.parse(await readFile(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const CSP = conf.app.security.csp;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.mp3': 'audio/mpeg' };
const server = createServer(async (req, res) => {
  const file = path.join(WEB, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(WEB)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${server.address().port}/src/index.html`;

const exe = ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap((e) => (process.env[e] ? [
  `${process.env[e]}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env[e]}\\Microsoft\\Edge\\Application\\msedge.exe`] : []))
  .find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const errors = [];
const out = path.join(ROOT, 'rsrc', '_check', 'mesh25d');
await mkdir(out, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  // Stub of the Tauri globals bridge.js uses. The cursor sits up and to the right of the cat.
  await page.addInitScript(() => {
    const listeners = {};
    window.__TAURI__ = {
      core: { invoke: async (cmd) => (cmd === 'stage' ? { width: 800, height: 400, paused: false } : null) },
      event: { listen: async (ev, fn) => { (listeners[ev] ||= []).push(fn); } },
    };
    window.__emit = (ev, payload) => (listeners[ev] || []).forEach((fn) => fn({ payload }));
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__catDebug?.brain, null, { timeout: 20000 });
  const report = {};
  for (const [name, cursor] of [['look-right', { x: 640, y: 120 }], ['look-left', { x: 120, y: 120 }]]) {
    await page.evaluate((c) => { const b = window.__catDebug.brain; b.queue = []; b._begin({ action: 'sit', hold: 60 }); window.__emit('pet:cursor', c); }, cursor);
    // Keep the cursor "moving" so it holds the cat's attention.
    for (let i = 0; i < 12; i += 1) {
      await page.evaluate(([c, j]) => window.__emit('pet:cursor', { x: c.x + (j % 2) * 3, y: c.y }), [cursor, i]);
      await page.waitForTimeout(100);
    }
    report[name] = await page.evaluate(() => {
      const { brain, overCatAt, floorTop } = window.__catDebug;
      const size = document.getElementById('cat').width;
      return {
        action: brain.action,
        webgl: !!document.getElementById('cat').getContext('webgl'),
        hitCentre: overCatAt(brain.x + size / 2, floorTop() + size * 0.6),
        hitCorner: overCatAt(brain.x + 2, floorTop() + 2),
      };
    });
    await page.locator('#cat').screenshot({ path: path.join(out, `app-${name}.png`) });
  }
  // Force a blink and catch it mid-way.
  await page.evaluate(() => { const b = window.__catDebug.brain; b._enqueue([{ action: 'blink' }, { action: 'sit', hold: 60 }]); });
  await page.waitForTimeout(260);
  await page.locator('#cat').screenshot({ path: path.join(out, 'app-blink.png') });
  // Walk: a non-family clip must still draw.
  await page.evaluate(() => { const b = window.__catDebug.brain; b._enqueue([{ action: 'walk_left', hold: 5, vx: -40 }]); });
  await page.waitForTimeout(500);
  await page.locator('#cat').screenshot({ path: path.join(out, 'app-walk.png') });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.close();
}
const real = errors.filter((e) => !/favicon/.test(e));
if (real.length) { console.error(real.join('\n')); process.exit(1); }
console.log('no page errors');

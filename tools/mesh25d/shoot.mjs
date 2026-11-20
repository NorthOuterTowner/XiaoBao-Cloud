// Screenshot the 2.5D preview in headless Chrome/Edge -> rsrc/_check/mesh25d/.
//   node tools/mesh25d/shoot.mjs                       default contact sheet
//   node tools/mesh25d/shoot.mjs "yaw:-0.4,yaw:0.4" name   custom cells
// Uses playwright-core from tools/cat3d/node_modules (run `npm install` there once).
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'tools', 'cat3d', 'package.json'));
const { chromium } = require('playwright-core');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${server.address().port}/tools/mesh25d/index.html`;

const candidates = [
  process.env.CHROME_PATH,
  ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap((e) => (process.env[e] ? [
    `${process.env[e]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env[e]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ] : [])),
].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));

const [cells = '', name = 'sheet'] = process.argv.slice(2);
const out = path.join(ROOT, 'rsrc', '_check', 'mesh25d');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
  // `live` as the cells argument runs the live idle page for a few seconds instead.
  const isLive = cells === 'live';
  await page.goto(isLive ? url : `${url}?sheet=${encodeURIComponent(cells)}&guides=1`);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 20000 });
  if (isLive) await page.waitForTimeout(4000);
  const file = path.join(out, `${name}.png`);
  await page.locator(isLive ? '#live' : '#sheet').screenshot({ path: file });
  console.log(file);
} finally {
  await browser.close();
  server.close();
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }

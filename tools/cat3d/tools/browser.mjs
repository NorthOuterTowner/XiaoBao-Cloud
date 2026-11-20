import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startServer } from '../server.mjs';

// Windows: fall back to Chrome, then Edge (Chromium), both installed per-machine or per-user.
const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ...['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'].flatMap((env) => (process.env[env] ? [
    `${process.env[env]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env[env]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ] : [])),
];
const MAC_CHROME = CANDIDATES.find((p) => existsSync(p));
// ANGLE backend: Metal exists only on macOS; D3D11 is the Windows default.
const ANGLE = process.platform === 'darwin' ? 'metal' : process.platform === 'win32' ? 'd3d11' : 'gl';

/**
 * Start a private preview server, open it in real Chrome, wait for the page, run fn(page, url).
 * Page errors fail the run. Set CHROME_PATH to use a different Chrome/Chromium binary.
 */
export async function withPage(query, fn, { viewport = { width: 1280, height: 720 } } = {}) {
  const { server, url } = await startServer(0);
  const executablePath = process.env.CHROME_PATH || MAC_CHROME;
  const browser = await chromium.launch({
    executablePath,
    channel: executablePath ? undefined : 'chrome',
    headless: true,
    args: [`--use-angle=${ANGLE}`, '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    page.goto_ = async (q) => {
      await page.goto(`${url}${q}`, { waitUntil: 'networkidle' });
      try {
        await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 60000 });
      } catch (e) {
        throw new Error(errors.length ? errors.join('\n') : e.message);
      }
    };
    await page.goto_(query);
    const result = await fn(page, url);
    if (errors.length) throw new Error(errors.join('\n'));
    return result;
  } finally {
    await browser.close();
    server.close();
  }
}

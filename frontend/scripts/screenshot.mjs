#!/usr/bin/env node
/**
 * Takes a screenshot of TmuxDeck in mock mode using Playwright.
 *
 * Usage:
 *   node scripts/screenshot.mjs
 *
 * Output:
 *   docs/screenshot.png (relative to repo root)
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(FRONTEND_DIR, '..');
const OUTPUT = resolve(REPO_ROOT, 'docs', 'screenshot.png');

/** Parse the local URL from Vite's stdout output. */
function waitForViteUrl(server, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Vite did not print a URL within ${timeoutMs}ms`)),
      timeoutMs,
    );

    const onData = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(`[vite] ${text}`);
      const match = text.match(/Local:\s+(https?:\/\/localhost:\d+)/);
      if (match) {
        clearTimeout(timer);
        server.stdout.off('data', onData);
        server.stdout.on('data', (d) => process.stdout.write(`[vite] ${d}`));
        resolve(match[1]);
      }
    };

    server.stdout.on('data', onData);
    server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  });
}

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Dev server did not respond within ${timeoutMs}ms`);
}

async function main() {
  // 1. Start the mock dev server
  console.log('Starting mock dev server...');
  const server = spawn('npm', ['run', 'dev:mock', '--', '--host'], {
    cwd: FRONTEND_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VITE_USE_MOCK: 'true' },
  });

  try {
    // 2. Detect the URL Vite is actually listening on
    const devUrl = await waitForViteUrl(server);
    console.log(`Dev server URL: ${devUrl}`);

    await waitForServer(devUrl);
    console.log('Dev server is ready.');

    // 3. Launch headless Chromium
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    // Mock auth API endpoints (no backend in mock mode)
    await page.route('**/api/v1/auth/**', (route) => {
      const url = route.request().url();
      if (url.includes('/auth/status')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ authenticated: true, pinSet: true }),
        });
      }
      // For any other auth endpoint, return success
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    // 4. Navigate to app
    console.log('Navigating to app...');
    await page.goto(devUrl, { waitUntil: 'networkidle' });
    console.log('Page loaded.');

    // 5. Wait for the sidebar to load with containers
    await page.waitForSelector('text=my-project', { timeout: 10_000 });
    console.log('Sidebar loaded.');

    // 6. Click on the "claude" window under "my-project" to select it
    //    The window text is "1: claude" in the sidebar
    const claudeWindow = page.locator('text=1: claude').first();
    await claudeWindow.click();
    console.log('Selected claude window.');

    // 7. Wait for UI to settle
    await page.waitForTimeout(1000);

    // 8. Take screenshot
    await page.screenshot({ path: OUTPUT, type: 'png' });
    console.log(`Screenshot saved to ${OUTPUT}`);

    await browser.close();
  } finally {
    // 9. Kill the dev server
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (!server.killed) server.kill('SIGKILL');
  }
}

main().catch((err) => {
  console.error('Screenshot failed:', err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Capture a screenshot of any framework demo.
 *
 * Usage: node lib/xyflow/demo/framework-screenshot.mjs <react|vue|svelte> [sampleIdx] [outPath]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.env.OUT_DIR || '/tmp';

const fw = process.argv[2] || 'vue';
const sampleIdx = Number(process.argv[3] || 4);
const outPath = process.argv[4] || path.join(outDir, `xyflow-${ fw }-${ sampleIdx }.png`);

const PORT = 5194;
const proc = spawn(process.execPath, [ path.join(__dirname, 'serve.mjs') ], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: [ 'ignore', 'pipe', 'inherit' ]
});
proc.stdout.on('data', () => {});

async function waitForServer() {
  for (let i = 0; i < 240; i++) {
    try { const r = await fetch(`http://localhost:${ PORT }/${ fw }`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server timeout');
}

let exit = 0;
try {
  await waitForServer();
  const browser = await puppeteer.launch({ headless: 'shell' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(`http://localhost:${ PORT }/${ fw }`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => /^Loaded/.test(document.getElementById('status')?.textContent || ''), { timeout: 30000 });

  await page.evaluate((idx) => {
    const sel = document.querySelector('select');
    sel.value = String(idx);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, sampleIdx);

  await page.waitForFunction(() => /^Loaded/.test(document.getElementById('status').textContent), { timeout: 30000 });
  await new Promise(r => setTimeout(r, 800));

  await page.evaluate(() => {
    const shape = document.querySelector('.bpmn-xyflow-shape');
    if (!shape) return;
    const rect = shape.getBoundingClientRect();
    const opts = { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    shape.dispatchEvent(new PointerEvent('pointerdown', opts));
    shape.dispatchEvent(new PointerEvent('pointerup', opts));
  });
  await new Promise(r => setTimeout(r, 200));

  await page.screenshot({ path: outPath });
  console.log('wrote', outPath);
  await browser.close();
} catch (e) {
  console.error(e);
  exit = 1;
} finally {
  proc.kill('SIGTERM');
}

process.exit(exit);

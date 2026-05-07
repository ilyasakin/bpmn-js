#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname is lib/demo/react/. Default screenshots to /tmp.
const outDir = process.env.OUT_DIR || '/tmp';

const PORT = 5192;
const sampleIdx = Number(process.argv[2] || 4);
const outPath = process.argv[3] || path.join(outDir, `xyflow-react-${ sampleIdx }.png`);

const proc = spawn(process.execPath, [ path.join(__dirname, '..', 'serve.mjs') ], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: [ 'ignore', 'pipe', 'inherit' ]
});
proc.stdout.on('data', () => {});

async function waitForServer() {
  for (let i = 0; i < 240; i++) {
    try { const r = await fetch(`http://localhost:${ PORT }/react`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server timeout');
}

let exit = 0;
try {
  await waitForServer();
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(`http://localhost:${ PORT }/react`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => /^Loaded/.test(document.getElementById('status')?.textContent || ''), { timeout: 30000 });

  await page.evaluate((idx) => {
    const sel = document.querySelector('select');
    sel.value = String(idx);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, sampleIdx);

  await page.waitForFunction(() => /^Loaded/.test(document.getElementById('status').textContent), { timeout: 30000 });
  await new Promise(r => setTimeout(r, 800));

  // select the first shape via wrapper to verify selection event reaches React
  await page.evaluate(() => {
    const shape = document.querySelector('.bpmn-xyflow-shape');
    if (!shape) return;
    const id = shape.getAttribute('data-element-id');
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

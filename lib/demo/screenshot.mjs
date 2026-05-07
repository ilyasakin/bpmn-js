#!/usr/bin/env node
/**
 * Screenshot the demo for visual verification.
 *
 * Usage: node lib/xyflow/demo/screenshot.mjs [sampleIndex] [outputPath]
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.env.OUT_DIR || '/tmp';

const PORT = 5189;
const sampleIdx = Number(process.argv[2] || 8);
const outPath = process.argv[3] || path.join(outDir, `xyflow-demo-${ sampleIdx }.png`);

const proc = spawn(process.execPath, [ path.join(__dirname, 'serve.mjs') ], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: [ 'ignore', 'pipe', 'inherit' ]
});
proc.stdout.on('data', () => {});

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://localhost:${ PORT }`);
      if (r.ok) return;
    } catch {}
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
  await page.goto(`http://localhost:${ PORT }`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => /Loaded/.test(document.getElementById('status').textContent), { timeout: 30000 });

  await page.evaluate((idx) => {
    const sel = document.getElementById('sample-select');
    sel.value = String(idx);
    sel.dispatchEvent(new Event('change'));
  }, sampleIdx);

  await page.waitForFunction(() => /^Loaded/.test(document.getElementById('status').textContent), { timeout: 30000 });
  await new Promise(r => setTimeout(r, 500)); // settle fitView animation

  if (process.env.SELECT_FIRST) {
    await page.evaluate(() => {
      const shape = document.querySelector('.bpmn-xyflow-shape');
      if (shape) window.viewer.select(shape.getAttribute('data-element-id'));
    });
    await new Promise(r => setTimeout(r, 100));
  }

  await page.screenshot({ path: outPath, fullPage: false });
  console.log('wrote', outPath);
  await browser.close();
} catch (e) {
  console.error(e);
  exit = 1;
} finally {
  proc.kill('SIGTERM');
}

process.exit(exit);

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const PORT = 5197;
const outBefore = process.argv[2] || path.join(repoRoot, 'xyflow-modeler-bends-before.png');
const outAfter  = process.argv[3] || path.join(repoRoot, 'xyflow-modeler-bends-after.png');

const proc = spawn(process.execPath, [ path.join(__dirname, '..', 'serve.mjs') ], {
  env: { ...process.env, PORT: String(PORT) }, stdio: [ 'ignore', 'pipe', 'inherit' ]
});
proc.stdout.on('data', () => {});

async function waitForServer() {
  for (let i = 0; i < 240; i++) {
    try { const r = await fetch(`http://localhost:${ PORT }/modeler`); if (r.ok) return; } catch {}
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
  await page.goto(`http://localhost:${ PORT }/modeler`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => /^Loaded/.test(document.getElementById('status').textContent), { timeout: 30000 });

  await page.evaluate(async () => {
    const res = await fetch('/test/fixtures/bpmn/draw/conditional-flow.bpmn');
    await window.modeler.importXML(await res.text());
  });
  await new Promise(r => setTimeout(r, 600));
  await page.screenshot({ path: outBefore });

  // pick a shape connected via a multi-point edge and drag it
  const dragInfo = await page.evaluate(() => {
    const m = window.modeler;
    const edge = m.getGraph().edges.find(e => e.waypoints.length > 2);
    if (!edge) return null;
    return { id: edge.source.id };
  });

  if (dragInfo) {
    const r = await page.evaluate((id) => {
      const g = document.querySelector(`[data-element-id="${ id }"]`);
      const r = g.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, dragInfo.id);

    await page.mouse.move(r.x, r.y);
    await page.mouse.down();
    await page.mouse.move(r.x - 80, r.y + 60, { steps: 10 });
    await page.mouse.up();
    await new Promise(r => setTimeout(r, 200));
  }

  await page.screenshot({ path: outAfter });
  console.log('wrote', outBefore);
  console.log('wrote', outAfter);
  await browser.close();
} catch (e) {
  console.error(e);
  exit = 1;
} finally {
  proc.kill('SIGTERM');
}

process.exit(exit);

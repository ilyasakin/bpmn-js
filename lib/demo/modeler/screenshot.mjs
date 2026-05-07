#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.env.OUT_DIR || '/tmp';

const PORT = 5196;
const outPath = process.argv[2] || path.join(outDir, 'xyflow-modeler.png');

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
  const browser = await puppeteer.launch({ headless: 'shell' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(`http://localhost:${ PORT }/modeler`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => /^Loaded/.test(document.getElementById('status').textContent), { timeout: 30000 });

  // build a tiny model: Task at (300,150), connect Start→Task, rename Task to "Process"
  await page.evaluate(() => {
    const m = window.modeler;
    const task = m.addShape('bpmn:Task', { x: 360, y: 200 });
    const gateway = m.addShape('bpmn:ExclusiveGateway', { x: 540, y: 220 });
    const end = m.addShape('bpmn:EndEvent', { x: 700, y: 220 });
    const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    m.connect(start, task);
    m.connect(task, gateway);
    m.connect(gateway, end);
    task.businessObject.name = 'Do work';
    end.businessObject.name = 'Done';
    m.viewer._internals.redrawShape(task);
    m.viewer._internals.redrawShape(end);
  });

  await new Promise(r => setTimeout(r, 200));

  // open the export panel
  await page.evaluate(() => document.getElementById('export-btn').click());
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

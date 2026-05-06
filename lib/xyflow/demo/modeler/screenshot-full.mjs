#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');

const PORT = 5199;
const out = process.argv[2] || path.join(repoRoot, 'xyflow-modeler-full.png');

const proc = spawn(process.execPath, [ path.join(__dirname, '..', 'serve.mjs') ], {
  env: { ...process.env, PORT: String(PORT) }, stdio: [ 'ignore', 'pipe', 'inherit' ]
});
proc.stdout.on('data', () => {});

async function waitForServer() {
  for (let i = 0; i < 240; i++) {
    try { const r = await fetch(`http://localhost:${ PORT }/modeler`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
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
    const m = window.modeler;
    const start = m.getGraph().nodes.find(n => n.type === 'bpmn:StartEvent');
    const task = m.addShape('bpmn:Task', { x: 360, y: 200 });
    const gateway = m.addShape('bpmn:ExclusiveGateway', { x: 540, y: 220 });
    const end = m.addShape('bpmn:EndEvent', { x: 700, y: 220 });
    m.connect(start, task);
    m.connect(task, gateway);
    m.connect(gateway, end);
    task.businessObject.name = 'Do work';
    end.businessObject.name = 'Done';
    m.viewer._internals.redrawShape(task);
    m.viewer._internals.redrawShape(end);
    // select the task to show context pad + resize handles
    m.select(task.id);
  });

  await new Promise(r => setTimeout(r, 600));
  await page.screenshot({ path: out });
  console.log('wrote', out);
  await browser.close();
} catch (e) {
  console.error(e);
  exit = 1;
} finally {
  proc.kill('SIGTERM');
}

process.exit(exit);

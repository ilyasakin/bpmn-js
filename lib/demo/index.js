import { BpmnXyflowViewer } from '../index';

const SAMPLES = [
  { label: 'Basic (start + task)', path: 'basic.bpmn' },
  { label: 'Task types', path: 'draw/task-types.bpmn' },
  { label: 'Events', path: 'draw/events.bpmn' },
  { label: 'Gateways', path: 'draw/gateways.bpmn' },
  { label: 'Pools (collaboration)', path: 'collaboration.bpmn' },
  { label: 'Conditional flows', path: 'draw/conditional-flow.bpmn' },
  { label: 'Data objects', path: 'draw/data-objects.bpmn' },
  { label: 'Boundary events', path: 'boundary-events.bpmn' },
  { label: 'Complex', path: 'complex.bpmn' }
];

const FIXTURE_BASE = '/test/fixtures/bpmn/';

const container = document.getElementById('viewer');
const select = document.getElementById('sample-select');
const fileInput = document.getElementById('file-input');
const fitBtn = document.getElementById('fit-view');
const resetBtn = document.getElementById('reset-zoom');
const status = document.getElementById('status');
const selectionInfo = document.getElementById('selection');

SAMPLES.forEach((s, i) => {
  const opt = document.createElement('option');
  opt.value = i;
  opt.textContent = s.label;
  select.appendChild(opt);
});

const viewer = new BpmnXyflowViewer({
  container,
  fitViewOnInit: true,
  minimap: true
});

window.viewer = viewer;

viewer.on('selection.change', ({ ids, elements }) => {
  if (!ids.length) {
    selectionInfo.textContent = '';
    return;
  }
  const labels = elements.map(el => {
    const name = el.businessObject && el.businessObject.name;
    return `${ el.type.replace('bpmn:', '') }${ name ? ` "${ name }"` : '' } (${ el.id })`;
  });
  selectionInfo.textContent = `Selected: ${ labels.join(', ') }`;
});

viewer.on('element.click', ({ id }) => {
  console.log('clicked', id);
});

async function loadSample(idx) {
  const sample = SAMPLES[idx];
  status.textContent = `Loading ${ sample.label }...`;
  try {
    const res = await fetch(FIXTURE_BASE + sample.path);
    if (!res.ok) {
      throw new Error(`HTTP ${ res.status }`);
    }
    const xml = await res.text();
    const result = await viewer.importXML(xml);
    status.textContent = `Loaded ${ sample.label } (${ result.warnings.length } warnings)`;
    if (result.warnings.length) {
      console.warn('import warnings', result.warnings);
    }
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
    console.error(e);
  }
}

select.addEventListener('change', () => loadSample(+select.value));

fileInput.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  const xml = await file.text();
  status.textContent = `Loading ${ file.name }...`;
  try {
    const result = await viewer.importXML(xml);
    status.textContent = `Loaded ${ file.name } (${ result.warnings.length } warnings)`;
    if (result.warnings.length) {
      console.warn('import warnings', result.warnings);
    }
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
    console.error(e);
  }
});

fitBtn.addEventListener('click', () => viewer.fitView());

resetBtn.addEventListener('click', () => viewer.setViewport({ x: 0, y: 0, zoom: 1 }));

loadSample(0);

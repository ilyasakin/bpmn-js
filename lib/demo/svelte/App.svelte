<script>
  import { onMount } from 'svelte';
  import BpmnViewer from '../../svelte/BpmnViewer.svelte';

  const SAMPLES = [
    { label: 'Basic', path: 'basic.bpmn' },
    { label: 'Task types', path: 'draw/task-types.bpmn' },
    { label: 'Conditional flows', path: 'draw/conditional-flow.bpmn' },
    { label: 'Pools', path: 'collaboration.bpmn' },
    { label: 'Complex', path: 'complex.bpmn' }
  ];
  const FIXTURE_BASE = '/test/fixtures/bpmn/';

  let idx = $state(0);
  let xml = $state('');
  let status = $state('');
  let selection = $state([]);
  let viewer;

  async function loadSample(i) {
    status = 'Fetching ' + SAMPLES[i].label + '...';
    const res = await fetch(FIXTURE_BASE + SAMPLES[i].path);
    xml = await res.text();
  }

  onMount(() => loadSample(idx));

  function onChange(e) {
    idx = Number(e.target.value);
    loadSample(idx);
  }

  function handleLoad(result) {
    status = `Loaded (${ result.warnings.length } warnings)`;
  }
  function handleError(err) {
    status = 'Error: ' + err.message;
  }
  function handleSelection(payload) {
    selection = payload.elements;
  }
</script>

<div class="app">
  <div class="toolbar">
    <select value={idx} onchange={onChange}>
      {#each SAMPLES as s, i}
        <option value={i}>{s.label}</option>
      {/each}
    </select>
    <button onclick={() => viewer?.fitView()}>Fit view</button>
    <button onclick={() => viewer?.setViewport({ x: 0, y: 0, zoom: 1 })}>Reset</button>
    <span class="spacer"></span>
    <span class="info" id="selection">
      {#if selection.length}
        Selected: {selection.map(e => e.type.replace('bpmn:', '') + (e.businessObject.name ? ` "${ e.businessObject.name }"` : '')).join(', ')}
      {/if}
    </span>
    <span class="info" id="status">{status}</span>
  </div>
  <div class="viewer-host">
    {#if xml}
      <BpmnViewer
        bind:this={viewer}
        {xml}
        minimap={true}
        onload={handleLoad}
        onerror={handleError}
        onselectionChange={handleSelection}
      />
    {/if}
  </div>
</div>

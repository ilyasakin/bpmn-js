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

  let idx = 0;
  let xml = '';
  let status = '';
  let selection = [];
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

  function onLoad(e) {
    status = `Loaded (${ e.detail.warnings.length } warnings)`;
  }
  function onError(e) {
    status = 'Error: ' + e.detail.message;
  }
  function onSelection(e) {
    selection = e.detail.elements;
  }
</script>

<div class="app">
  <div class="toolbar">
    <select value={idx} on:change={onChange}>
      {#each SAMPLES as s, i}
        <option value={i}>{s.label}</option>
      {/each}
    </select>
    <button on:click={() => viewer?.fitView()}>Fit view</button>
    <button on:click={() => viewer?.setViewport({ x: 0, y: 0, zoom: 1 })}>Reset</button>
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
        on:load={onLoad}
        on:error={onError}
        on:selection-change={onSelection}
      />
    {/if}
  </div>
</div>

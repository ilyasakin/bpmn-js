<script>
  import { onMount, onDestroy } from 'svelte';
  import BpmnXyflowViewer from '../Viewer';

  let {
    xml = '',
    bpmnDiagramId = '',
    config = undefined,
    minZoom = undefined,
    maxZoom = undefined,
    fitPadding = undefined,
    fitViewOnInit = true,
    selectOnClick = true,
    minimap = false,
    keyboard = true,
    refitOnResize = true,
    onelementClick,
    onelementHover,
    onelementOut,
    onselectionChange,
    onviewportChange,
    onload,
    onerror
  } = $props();

  let container;
  let viewer;
  const offs = [];

  const VIEWER_EVENTS = [
    [ 'onelementClick', 'element.click' ],
    [ 'onelementHover', 'element.hover' ],
    [ 'onelementOut', 'element.out' ],
    [ 'onselectionChange', 'selection.change' ],
    [ 'onviewportChange', 'viewport.change' ]
  ];

  const callbacks = () => ({
    onelementClick,
    onelementHover,
    onelementOut,
    onselectionChange,
    onviewportChange
  });

  onMount(() => {
    viewer = new BpmnXyflowViewer({
      container,
      config, minZoom, maxZoom, fitPadding,
      fitViewOnInit, selectOnClick, minimap,
      keyboard, refitOnResize
    });

    for (const [ name, evt ] of VIEWER_EVENTS) {
      offs.push(viewer.on(evt, payload => {
        const fn = callbacks()[name];
        if (typeof fn === 'function') fn(payload);
      }));
    }

    if (xml) importNow();
  });

  onDestroy(() => {
    offs.forEach(off => off());
    offs.length = 0;
    if (viewer) {
      viewer.destroy();
      viewer = null;
    }
  });

  function importNow() {
    if (!viewer || !xml) return;
    viewer.importXML(xml, bpmnDiagramId || undefined)
      .then(result => onload?.(result))
      .catch(err => onerror?.(err));
  }

  $effect(() => {
    // re-import whenever xml changes
    if (viewer && xml) importNow();
  });

  export function fitView(padding) { return viewer?.fitView(padding); }
  export function setViewport(v, opts) { return viewer?.setViewport(v, opts); }
  export function getViewport() { return viewer?.getViewport(); }
  export function select(ids) { return viewer?.select(ids); }
  export function deselect(ids) { return viewer?.deselect(ids); }
  export function getSelection() { return viewer?.getSelection() || []; }
  export function clearSelection() { return viewer?.clearSelection(); }
  export function getGraph() { return viewer?.getGraph(); }
  export function getDefinitions() { return viewer?.getDefinitions(); }
  export function setMinimap(value) { return viewer?.setMinimap(value); }
  export function getViewer() { return viewer; }
</script>

<div bind:this={container} class="bpmn-xyflow-svelte"></div>

<style>
  .bpmn-xyflow-svelte { width: 100%; height: 100%; }
</style>

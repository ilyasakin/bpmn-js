<script>
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import BpmnXyflowViewer from '../Viewer';

  export let xml = '';
  export let bpmnDiagramId = '';
  export let config = undefined;
  export let minZoom = undefined;
  export let maxZoom = undefined;
  export let fitPadding = undefined;
  export let fitViewOnInit = true;
  export let selectOnClick = true;
  export let minimap = false;
  export let keyboard = true;
  export let refitOnResize = true;

  let container;
  let viewer;
  const offs = [];

  const dispatch = createEventDispatcher();

  const VIEWER_EVENTS = [
    [ 'element-click', 'element.click' ],
    [ 'element-hover', 'element.hover' ],
    [ 'element-out', 'element.out' ],
    [ 'selection-change', 'selection.change' ],
    [ 'viewport-change', 'viewport.change' ]
  ];

  onMount(() => {
    viewer = new BpmnXyflowViewer({
      container,
      config, minZoom, maxZoom, fitPadding,
      fitViewOnInit, selectOnClick, minimap,
      keyboard, refitOnResize
    });

    for (const [ name, evt ] of VIEWER_EVENTS) {
      offs.push(viewer.on(evt, payload => dispatch(name, payload)));
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
      .then(result => dispatch('load', result))
      .catch(err => dispatch('error', err));
  }

  // re-import on xml change
  $: if (viewer && xml) importNow();

  // expose imperative methods on the component instance
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

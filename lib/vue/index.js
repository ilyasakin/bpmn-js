/* eslint-env browser */
import { defineComponent, h, onMounted, onBeforeUnmount, ref, watch } from 'vue';

import BpmnXyflowViewer from '../Viewer';

const VIEWER_EVENTS = [
  [ 'elementClick', 'element.click' ],
  [ 'elementHover', 'element.hover' ],
  [ 'elementOut', 'element.out' ],
  [ 'selectionChange', 'selection.change' ],
  [ 'viewportChange', 'viewport.change' ]
];

/**
 * <BpmnViewer /> — Vue 3 wrapper around BpmnXyflowViewer.
 *
 * Props:
 *   xml, bpmnDiagramId, config, minZoom, maxZoom, fitPadding, fitViewOnInit,
 *   selectOnClick, minimap, keyboard, refitOnResize
 *
 * Emits:
 *   load (result), error (err),
 *   element-click, element-hover, element-out, selection-change, viewport-change
 *
 * Imperative methods are exposed via `defineExpose`. Use a template ref
 * (`<BpmnViewer ref="v" />`) and call `v.value.fitView()` etc.
 */
export const BpmnViewer = defineComponent({
  name: 'BpmnViewer',
  props: {
    xml: { type: String, default: '' },
    bpmnDiagramId: { type: String, default: '' },
    config: { type: Object, default: undefined },
    minZoom: { type: Number, default: undefined },
    maxZoom: { type: Number, default: undefined },
    fitPadding: { type: Number, default: undefined },
    fitViewOnInit: { type: Boolean, default: true },
    selectOnClick: { type: Boolean, default: true },
    minimap: { type: [ Boolean, Object ], default: false },
    keyboard: { type: Boolean, default: true },
    refitOnResize: { type: Boolean, default: true }
  },
  emits: [
    'load', 'error',
    'element-click', 'element-hover', 'element-out',
    'selection-change', 'viewport-change'
  ],
  setup(props, { emit, expose }) {
    const containerRef = ref(null);
    let viewer = null;
    const offs = [];

    onMounted(() => {
      viewer = new BpmnXyflowViewer({
        container: containerRef.value,
        config: props.config,
        minZoom: props.minZoom,
        maxZoom: props.maxZoom,
        fitPadding: props.fitPadding,
        fitViewOnInit: props.fitViewOnInit,
        selectOnClick: props.selectOnClick,
        minimap: props.minimap,
        keyboard: props.keyboard,
        refitOnResize: props.refitOnResize
      });

      for (const [ kebab, evt ] of VIEWER_EVENTS) {
        const dashed = kebab.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
        offs.push(viewer.on(evt, payload => emit(dashed, payload)));
      }

      if (props.xml) importNow();
    });

    onBeforeUnmount(() => {
      offs.forEach(off => off());
      offs.length = 0;
      if (viewer) {
        viewer.destroy();
        viewer = null;
      }
    });

    function importNow() {
      if (!viewer || !props.xml) return;
      viewer.importXML(props.xml, props.bpmnDiagramId || undefined)
        .then(result => emit('load', result))
        .catch(err => emit('error', err));
    }

    watch(() => [ props.xml, props.bpmnDiagramId ], () => {
      importNow();
    });

    expose({
      fitView: (padding) => viewer?.fitView(padding),
      setViewport: (v, opts) => viewer?.setViewport(v, opts),
      getViewport: () => viewer?.getViewport(),
      select: (ids) => viewer?.select(ids),
      deselect: (ids) => viewer?.deselect(ids),
      getSelection: () => viewer?.getSelection() || [],
      clearSelection: () => viewer?.clearSelection(),
      getGraph: () => viewer?.getGraph(),
      getDefinitions: () => viewer?.getDefinitions(),
      setMinimap: (value) => viewer?.setMinimap(value),
      getViewer: () => viewer
    });

    return () => h('div', {
      ref: containerRef,
      class: 'bpmn-xyflow-vue',
      style: 'width: 100%; height: 100%;'
    });
  }
});

export default BpmnViewer;

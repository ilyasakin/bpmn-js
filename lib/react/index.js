/* eslint-env browser */

import {
  createElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef
} from 'react';

import BpmnXyflowViewer from '../Viewer';

const VIEWER_EVENTS = [
  [ 'onElementClick', 'element.click' ],
  [ 'onElementHover', 'element.hover' ],
  [ 'onElementOut', 'element.out' ],
  [ 'onSelectionChange', 'selection.change' ],
  [ 'onViewportChange', 'viewport.change' ]
];

/**
 * <BpmnViewer /> — React wrapper around BpmnXyflowViewer.
 *
 * Props:
 *   - xml: BPMN XML to render. Re-imports when it changes.
 *   - bpmnDiagramId?: optional diagram id
 *   - config?: renderer config (colors, fonts)
 *   - minZoom, maxZoom, fitPadding, fitViewOnInit?
 *   - selectOnClick?: boolean
 *   - className, style: applied to the container <div>
 *   - onLoad: ({ graph, warnings }) => void
 *   - onError: (err) => void
 *   - onElementClick, onElementHover, onElementOut, onSelectionChange, onViewportChange
 *
 * Imperative ref:
 *   { fitView, setViewport, getViewport, select, deselect, getSelection,
 *     clearSelection, getGraph, getDefinitions, getViewer }
 */
export const BpmnViewer = forwardRef(function BpmnViewer(props, ref) {
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const propsRef = useRef(props);

  // keep latest props for handlers without re-creating the viewer
  propsRef.current = props;

  // create viewer once
  useEffect(() => {
    if (!containerRef.current) return;

    const viewer = new BpmnXyflowViewer({
      container: containerRef.current,
      config: propsRef.current.config,
      minZoom: propsRef.current.minZoom,
      maxZoom: propsRef.current.maxZoom,
      fitPadding: propsRef.current.fitPadding,
      fitViewOnInit: propsRef.current.fitViewOnInit !== false,
      selectOnClick: propsRef.current.selectOnClick !== false,
      minimap: propsRef.current.minimap || false,
      keyboard: propsRef.current.keyboard !== false,
      refitOnResize: propsRef.current.refitOnResize !== false
    });
    viewerRef.current = viewer;

    return () => {
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  // import xml on change
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !props.xml) return;

    let cancelled = false;
    viewer.importXML(props.xml, props.bpmnDiagramId)
      .then(result => {
        if (cancelled) return;
        propsRef.current.onLoad?.(result);
      })
      .catch(err => {
        if (cancelled) return;
        propsRef.current.onError?.(err);
      });

    return () => { cancelled = true; };
  }, [ props.xml, props.bpmnDiagramId ]);

  // wire viewer events
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;

    const offs = [];
    for (const [ propName, evtName ] of VIEWER_EVENTS) {
      offs.push(viewer.on(evtName, (payload) => {
        const handler = propsRef.current[propName];
        if (handler) handler(payload);
      }));
    }
    return () => offs.forEach(off => off());
  }, []);

  useImperativeHandle(ref, () => ({
    fitView: (padding) => viewerRef.current?.fitView(padding),
    setViewport: (v, opts) => viewerRef.current?.setViewport(v, opts),
    getViewport: () => viewerRef.current?.getViewport(),
    select: (ids) => viewerRef.current?.select(ids),
    deselect: (ids) => viewerRef.current?.deselect(ids),
    getSelection: () => viewerRef.current?.getSelection() || [],
    clearSelection: () => viewerRef.current?.clearSelection(),
    getGraph: () => viewerRef.current?.getGraph(),
    getDefinitions: () => viewerRef.current?.getDefinitions(),
    setMinimap: (value) => viewerRef.current?.setMinimap(value),
    getViewer: () => viewerRef.current
  }), []);

  return createElement('div', {
    ref: containerRef,
    className: props.className,
    style: Object.assign({ width: '100%', height: '100%' }, props.style || {})
  });
});

/**
 * useBpmnViewer — imperative hook variant.
 *
 * Returns a stable ref callback to attach to a container, plus a viewer
 * instance once mounted.
 */
export function useBpmnViewer(options = {}) {
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const optsRef = useRef(options);
  optsRef.current = options;

  useEffect(() => {
    if (!containerRef.current) return;
    const viewer = new BpmnXyflowViewer({
      container: containerRef.current,
      ...optsRef.current
    });
    viewerRef.current = viewer;
    return () => {
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  return {
    containerRef,
    viewer: viewerRef.current,
    getViewer: () => viewerRef.current
  };
}

export default BpmnViewer;

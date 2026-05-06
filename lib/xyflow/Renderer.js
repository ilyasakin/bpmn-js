import BpmnRenderer from '../draw/BpmnRenderer';
import TextRenderer from '../draw/TextRenderer';
import PathMap from '../draw/PathMap';

import Styles from 'diagram-js/lib/draw/Styles';

const NOOP = function() {};

const stubEventBus = {
  on: NOOP,
  off: NOOP,
  fire: NOOP,
  once: NOOP,
  createEvent: function() { return { stopPropagation: NOOP, preventDefault: NOOP }; }
};

export default function Renderer(options = {}) {
  const { rootSvg, config = {} } = options;

  if (!rootSvg) {
    throw new Error('Renderer requires a rootSvg element');
  }

  const styles = new Styles();
  const pathMap = new PathMap();
  const textRenderer = new TextRenderer(config.textRenderer);

  const stubCanvas = { _svg: rootSvg };

  const bpmnRenderer = new BpmnRenderer(
    config.bpmnRenderer,
    stubEventBus,
    styles,
    pathMap,
    stubCanvas,
    textRenderer
  );

  this.bpmnRenderer = bpmnRenderer;
  this.textRenderer = textRenderer;

  this.canRender = function(element) {
    return bpmnRenderer.canRender(element);
  };

  this.drawShape = function(parentGfx, shape, attrs) {
    return bpmnRenderer.drawShape(parentGfx, shape, attrs);
  };

  this.drawConnection = function(parentGfx, connection, attrs) {
    return bpmnRenderer.drawConnection(parentGfx, connection, attrs);
  };
}

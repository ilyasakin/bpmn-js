# bpmn-xyflow — BPMN 2.0 for the web (xyflow-based)

View and edit BPMN 2.0 diagrams in the browser. Built on
[@xyflow/system](https://github.com/xyflow/xyflow) for pan/zoom and the
original
[BpmnRenderer](./lib/draw/BpmnRenderer.js) /
[TextRenderer](./lib/draw/TextRenderer.js) /
[PathMap](./lib/draw/PathMap.js) (carried over from
[bpmn-js](https://github.com/bpmn-io/bpmn-js), this project's upstream).

This is a fork: the diagram-js stack has been replaced; the public API
is smaller and direct.

## Quick start

```js
import { Viewer, Modeler } from 'bpmn-xyflow';

const viewer = new Viewer({ container: document.getElementById('app') });
await viewer.importXML(xml);
viewer.fitView();
```

For full editing:

```js
const modeler = new Modeler({
  container: document.getElementById('app'),
  minimap: true
});
await modeler.importXML(xml);

const xml = await modeler.getXML();
```

## Framework wrappers

```js
import { BpmnViewer } from 'bpmn-xyflow/lib/react';   // React 18+
import { BpmnViewer } from 'bpmn-xyflow/lib/vue';     // Vue 3
import BpmnViewer from 'bpmn-xyflow/lib/svelte/BpmnViewer.svelte';  // Svelte 4
```

`react`, `react-dom`, `vue`, and `svelte` are declared as **optional
peer dependencies** — install only the ones you actually use.

Each wrapper takes the same `xml` prop, forwards every viewer event
(`onElementClick` / `onSelectionChange` / `onViewportChange` / etc.)
and exposes the imperative API (`fitView`, `select`, `setViewport`,
…) via the framework's standard ref / `bind:this` mechanism.

## Modeler features

- Move shapes (drag); edges follow with bend preservation
- Resize shapes (8 handles) — descendants of a Lane / SubProcess
  follow; attached BoundaryEvents slide along the perimeter
- Connect shapes — context-pad button, hover-edge handle, or
  Shift+drag — with BPMN-aware type inference (SequenceFlow /
  MessageFlow / Association / DataAssociation)
- Reconnect by dragging an edge endpoint to a different shape
- Inline label editing (seamless: editor matches renderer font and
  position, follows zoom while open)
- Undo / redo (`Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`); compound steps —
  one user gesture = one undo
- Copy / paste (`Cmd+C` / `Cmd+V` / `Cmd+D` to duplicate)
- Modeling rules + connection-type inference
- BoundaryEvent attach / detach on drop
- SubProcess drill-in / collapse, with a per-level command stack
- Snap to siblings + 5px grid + alignment guides; `Shift` constrains
  to dominant axis
- BPMN XML round-trip via `bpmn-moddle`'s writer

## Demo

```sh
pnpm install
pnpm start
```

Then open the routes the dev server prints:

| Route       | What |
|-------------|------|
| `/`         | vanilla viewer demo (read-only) |
| `/modeler/` | full modeler with palette, minimap, export |
| `/react/`   | React-wrapped demo |
| `/vue/`     | Vue-wrapped demo |
| `/svelte/`  | Svelte-wrapped demo |

## Tests

```sh
pnpm test                    # all puppeteer-driven smoke suites
pnpm test:smoke              # modeler (~56 cases)
pnpm test:react              # React wrapper
pnpm test:multi              # React, Vue, and Svelte wrappers
```

## Tooling

- Build / dev: [Vite](https://vitejs.dev) (no webpack, no babel-loader)
- Lint: [oxlint](https://oxc.rs) — `pnpm lint`
- Format: oxfmt — `pnpm format`
- Package manager: [pnpm](https://pnpm.io)

## Repo layout

```
lib/
├── Viewer.js         read-only viewer
├── Modeler.js        full editor
├── Importer.js       BPMN XML → graph
├── Renderer.js       wraps the upstream BpmnRenderer
├── modeling/         CommandStack + Rules
├── react/  vue/  svelte/   framework wrappers
├── demo/             dev server + smoke tests
├── draw/             reused: BpmnRenderer, TextRenderer, PathMap
├── import/           reused: BpmnTreeWalker
├── util/             reused: ModelUtil, LabelUtil, DiUtil, …
└── model/            BPMN type definitions
```

## License

[MIT](./LICENSE). Forked from the original [bpmn-js](https://github.com/bpmn-io/bpmn-js)
under its MIT-style license; the original Camunda Services GmbH
copyright is preserved in `LICENSE`.

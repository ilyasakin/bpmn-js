import { mount } from 'svelte';
import App from './App.svelte';

const app = mount(App, {
  target: document.getElementById('root')
});

window.__bpmn_svelte_app = app;

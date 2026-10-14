import { createGpuSession } from './gpu/device.ts';
import './gpu/shader-overlay.css';
import { mountApp } from './shell/app.ts';

if (import.meta.env.DEV) {
  const { installShaderOverlay } = await import('./gpu/shader-overlay.ts');
  installShaderOverlay();
}

// A single device is shared by every canvas on the page. `?nogpu` shows the site as a browser
// without WebGPU would see it: posters and a notice instead of canvases.
const session = await createGpuSession({
  simulateUnsupported: new URLSearchParams(location.search).has('nogpu'),
});
mountApp(document.querySelector<HTMLElement>('#app')!, { session });

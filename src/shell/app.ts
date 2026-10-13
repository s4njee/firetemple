import { hasEffect } from '../effects/registry.ts';
import { lazyMount } from './lazy.ts';
import {
  getIntensity,
  getMotionChoice,
  INTENSITY_STEPS,
  motionAllowed,
  onMotionChange,
  setIntensity,
  setMotionChoice,
} from './motion.ts';
import { hrefFor, onQueryChange, readQuery, startRouter } from './router.ts';
import type { ShellContext, Unmount } from './types.ts';
import './theme.css';
import './app.css';

// Dark is the default, not the system setting: these are emissive effects (see theme.css).
// `auto` follows the system for anyone who wants that.
type Theme = 'dark' | 'light' | 'auto';
const THEMES: readonly Theme[] = ['dark', 'light', 'auto'];
const THEME_KEY = 'ft-theme';

function storedTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'auto' ? value : 'dark';
  } catch {
    return 'dark';
  }
}

function applyTheme(theme: Theme) {
  if (theme === 'dark') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === 'dark') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be blocked; the choice then lasts for this page view only.
  }
}

function themeToggle(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ft-button ft-button--quiet';
  let theme = storedTheme();
  const render = () => {
    button.textContent = `Theme: ${theme}`;
    button.setAttribute('aria-label', `Colour theme: ${theme}. Activate to change.`);
  };
  button.addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;
    applyTheme(theme);
    render();
  });
  render();
  return button;
}

/** Pause or play every effect on the site. With no choice made it follows the system setting. */
function motionToggle(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ft-button ft-button--quiet';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const render = () => {
    const playing = motionAllowed(reduced.matches);
    button.textContent = playing ? 'Pause motion' : 'Play motion';
    const followed = getMotionChoice() === 'auto' && reduced.matches;
    button.title = followed
      ? 'Paused because your system asks for reduced motion.'
      : 'Applies to every effect on the site.';
  };
  button.addEventListener('click', () =>
    setMotionChoice(motionAllowed(reduced.matches) ? 'pause' : 'play'),
  );
  reduced.addEventListener('change', render);
  onMotionChange(render);
  render();
  return button;
}

/** Caps the brightness of every effect, which shrinks any flicker with it. */
function intensityToggle(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ft-button ft-button--quiet';
  const render = () => {
    const percent = Math.round(getIntensity() * 100);
    button.textContent = `Intensity: ${percent}%`;
    button.setAttribute(
      'aria-label',
      `Effect brightness capped at ${percent}%. Activate to change.`,
    );
  };
  button.addEventListener('click', () => {
    const index = INTENSITY_STEPS.findIndex((step) => step === getIntensity());
    setIntensity(INTENSITY_STEPS[(index + 1) % INTENSITY_STEPS.length]!);
  });
  onMotionChange(render);
  render();
  return button;
}

export function mountApp(root: HTMLElement, shell: ShellContext): void {
  const header = document.createElement('header');
  header.className = 'ft-app__header';
  const home = document.createElement('a');
  home.className = 'ft-app__home';
  home.href = hrefFor({}, '');
  home.dataset.link = '';
  home.textContent = 'Fire Temple';
  const tagline = document.createElement('span');
  tagline.className = 'ft-app__tagline ft-muted';
  tagline.textContent = 'WebGPU fire effects, measured';
  const spacer = document.createElement('span');
  spacer.className = 'ft-app__spacer';
  header.append(home, tagline, spacer, motionToggle(), intensityToggle(), themeToggle());

  const outlet = document.createElement('main');
  outlet.className = 'ft-app__outlet';
  root.append(header, outlet);

  let page: Unmount | undefined;
  let shown: string | null | undefined;
  let galleryScroll = 0;

  function show(query: URLSearchParams) {
    const requested = query.get('effect');
    const effect = requested && hasEffect(requested) ? requested : null;
    if (effect === shown) return;
    if (shown === null) galleryScroll = scrollY;
    shown = effect;
    page?.();
    outlet.replaceChildren();
    scrollTo(0, 0);
    page = effect
      ? lazyMount(outlet, 'effect page', async () =>
          (await import('./effect-page.ts')).mountEffectPage(outlet, shell, effect),
        )
      : lazyMount(outlet, 'gallery', async () => {
          const unmount = (await import('./gallery.ts')).mountGallery(outlet, shell);
          // Coming back from an effect, land where the reader left the grid.
          scrollTo(0, galleryScroll);
          return unmount;
        });
  }

  startRouter();
  onQueryChange(show);
  show(readQuery());
}

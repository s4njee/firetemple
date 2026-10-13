import measured from '../effects/measured.json';
import type { EffectMeta, Scorecard, Tier } from '../effects/types.ts';
import type { PassTiming } from '../gpu/profiler.ts';
import type { EffectHost, FrameStats } from './host.ts';
import type { Unmount } from './types.ts';
import './scorecard.css';

export const NOT_MEASURED = 'not measured yet';

/** The tiers and budgets from plan.md ("Practicality tiers"). */
export const TIERS: Readonly<
  Record<Tier, { name: string; shape: string; budgetMs: number; reference: string }>
> = {
  A: {
    name: 'Drop-in',
    shape: 'One or two fragment passes, no compute. Safe as ambient decoration, including mobile.',
    budgetMs: 2,
    reference: 'an integrated GPU',
  },
  B: {
    name: 'Feature',
    shape: 'Multi-pass or a small compute sim. For hero sections and interactive set pieces.',
    budgetMs: 6,
    reference: 'an integrated GPU',
  },
  C: {
    name: 'Showpiece',
    shape: 'Heavy compute and/or a full 3D scene. A dedicated page, desktop-first.',
    budgetMs: 12,
    reference: 'a discrete GPU or Apple Silicon',
  },
};

export function tierLabel(tier: Tier): string {
  return `Tier ${tier} · ${TIERS[tier].name}`;
}

export function budgetText(tier: Tier): string {
  const { budgetMs, reference } = TIERS[tier];
  return `≤ ${budgetMs} ms per frame at 1080p on ${reference}`;
}

export function formatMs(ms: number): string {
  return `${ms < 10 ? ms.toFixed(2) : ms.toFixed(1)} ms`;
}

export function formatKb(kb: number | undefined): string {
  return kb === undefined ? NOT_MEASURED : `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} kB gzipped`;
}

export function computeText(compute: boolean): string {
  return compute ? 'Yes. Compute shaders, so there is no WebGL2 fallback path.' : 'No';
}

export function mobileText(mobile: Scorecard['mobile']): string {
  if (mobile === 'untested') return 'Untested';
  return mobile === 'yes' ? 'Yes, holds its tier budget on phones' : 'No';
}

export function flashText(flash: Scorecard['flash']): string {
  if (flash === 'none') return 'None. No rapid large-area brightness change';
  if (flash === 'low') return 'Low. Flickers, but well under the three-flashes-a-second threshold';
  if (flash === 'high') return 'High. Can exceed the flash threshold; cap the flicker or warn';
  return 'Not measured';
}

export function lightPageText(lightPage: Scorecard['lightPage']): string {
  if (lightPage === 'yes') return 'Yes, reads over a light page as it is';
  if (lightPage === 'underlay') return 'Only with a dark underlay or backplate behind it';
  if (lightPage === 'no') return 'No. Needs a dark region of its own';
  return 'Untested';
}

export type FeatureStatus = 'available' | 'missing' | 'unknown';

/** `deviceFeatures` is undefined while it is still being looked up. */
export function featureStatus(
  feature: string,
  deviceFeatures: ReadonlySet<string> | undefined,
): FeatureStatus {
  if (!deviceFeatures) return 'unknown';
  return deviceFeatures.has(feature) ? 'available' : 'missing';
}

export function featureStatusText(status: FeatureStatus): string {
  return { available: 'available here', missing: 'not available here', unknown: 'checking' }[
    status
  ];
}

export interface CostRow {
  device: string;
  value: string;
  /** Against the tier budget; the reference devices are the ones the budget is defined on. */
  verdict: string;
}

/** One row per measured reference device; empty when nothing has been measured. */
export function costRows(tier: Tier, gpuMs: Scorecard['gpuMs']): CostRow[] {
  const { budgetMs } = TIERS[tier];
  return (gpuMs ?? []).map(({ device, ms }) => ({
    device,
    value: formatMs(ms),
    verdict: ms <= budgetMs ? `within the ${budgetMs} ms budget` : `over the ${budgetMs} ms budget`,
  }));
}

/** What `npm run study` recorded for one effect (src/effects/measured.json). */
export type Measured = Pick<Scorecard, 'gpuMs' | 'bundleKb'>;

const MEASURED: Readonly<Record<string, Measured>> = measured;

/** The hand-written verdict with the benchmark's numbers laid over it; measurements win. */
export function withMeasured(
  card: Scorecard | undefined,
  numbers: Measured | undefined,
): Scorecard | undefined {
  if (!card || !numbers) return card;
  return {
    ...card,
    gpuMs: numbers.gpuMs ?? card.gpuMs,
    bundleKb: numbers.bundleKb ?? card.bundleKb,
  };
}

export function sumPasses(passes: readonly PassTiming[]): number {
  return passes.reduce((total, pass) => total + pass.ms, 0);
}

/** Exponential moving average; the first reading is taken as is. */
export function smooth(previous: number | undefined, next: number, alpha = 0.15): number {
  return previous === undefined ? next : previous + (next - previous) * alpha;
}

export function resolutionText(width: number, height: number): string {
  const megapixels = (width * height) / 1e6;
  return `${width} × ${height} (${megapixels.toFixed(2)} MP)`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(list: HTMLElement, label: string, ...value: (Node | string)[]): HTMLElement {
  const wrapper = el('div', 'ft-scorecard__row');
  const dd = el('dd', 'ft-scorecard__value');
  dd.append(...value);
  wrapper.append(el('dt', 'ft-label', label), dd);
  list.append(wrapper);
  return dd;
}

function unknown(text: string): HTMLElement {
  return el('span', 'ft-muted', text);
}

function panel(title: string): { section: HTMLElement; list: HTMLElement } {
  const section = el('section', 'ft-panel ft-scorecard__panel');
  const list = el('dl', 'ft-scorecard__list');
  section.append(el('h2', 'ft-label', title), list);
  return { section, list };
}

let adapterFeatures: Promise<ReadonlySet<string>> | undefined;

/** Features this browser's adapter offers; empty if there is no WebGPU at all. */
function loadDeviceFeatures(): Promise<ReadonlySet<string>> {
  adapterFeatures ??= (async () => {
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      return new Set<string>(adapter?.features ?? []);
    } catch {
      return new Set<string>();
    }
  })();
  return adapterFeatures;
}

function featureList(
  features: readonly GPUFeatureName[] | undefined,
  none: string,
): { node: HTMLElement; mark(set: ReadonlySet<string>): void } {
  if (!features || features.length === 0) return { node: unknown(none), mark() {} };
  const list = el('ul', 'ft-scorecard__features');
  const marks = features.map((feature) => {
    const item = el('li', '');
    const status = el('span', 'ft-muted');
    item.append(el('code', 'ft-data', feature), ' ', status);
    list.append(item);
    return { feature, item, status };
  });
  const update = (set: ReadonlySet<string> | undefined) => {
    for (const { feature, item, status } of marks) {
      const state = featureStatus(feature, set);
      item.dataset.state = state;
      status.textContent = featureStatusText(state);
    }
  };
  update(undefined);
  return { node: list, mark: update };
}

export function mountScorecard(
  container: HTMLElement,
  meta: EffectMeta,
  host?: EffectHost,
): Unmount {
  const root = el('section', 'ft-scorecard');
  root.setAttribute('aria-label', 'Practicality scorecard');
  const grid = el('div', 'ft-scorecard__grid');
  root.append(grid);
  container.append(root);

  const card = withMeasured(meta.scorecard, MEASURED[meta.id]);
  if (!card) {
    root.append(
      el('p', 'ft-muted', 'No scorecard yet. Add one to this effect’s meta.ts once it is known.'),
    );
    return () => root.remove();
  }

  // Verdict
  const verdict = panel('Verdict');
  const tier = el('span', 'ft-chip', tierLabel(meta.tier));
  tier.dataset.tier = meta.tier;
  const tierRow = row(verdict.list, 'Tier', tier);
  tierRow.append(
    el('span', 'ft-muted', ` ${TIERS[meta.tier].shape}`),
    el('span', 'ft-data ft-scorecard__budget', `Budget: ${budgetText(meta.tier)}`),
  );
  row(verdict.list, 'Needs compute', computeText(card.compute));
  row(verdict.list, 'Mobile-safe', mobileText(card.mobile));
  row(verdict.list, 'Flash risk', flashText(card.flash));
  row(verdict.list, 'Light pages', lightPageText(card.lightPage));
  row(verdict.list, 'Fallback', card.fallback);
  const uses = el('ul', 'ft-scorecard__uses');
  for (const useCase of card.useCases) uses.append(el('li', '', useCase));
  row(verdict.list, 'Best for', card.useCases.length > 0 ? uses : unknown('not decided yet'));

  // Requirements and cost
  const cost = panel('Requirements and cost');
  const required = featureList(card.features?.required, 'none');
  const optional = featureList(card.features?.optional, 'none');
  row(cost.list, 'Required features', required.node);
  row(cost.list, 'Optional features', optional.node);
  row(
    cost.list,
    'Bundle',
    card.bundleKb === undefined ? unknown(NOT_MEASURED) : formatKb(card.bundleKb),
  );

  const rows = costRows(meta.tier, card.gpuMs);
  if (rows.length === 0) {
    row(cost.list, 'GPU time at 1080p', unknown(NOT_MEASURED));
  } else {
    const table = el('table', 'ft-scorecard__table');
    const head = el('tr', '');
    for (const title of ['Device', 'Time', 'Against budget']) head.append(el('th', '', title));
    const thead = el('thead', '');
    thead.append(head);
    table.append(el('caption', 'ft-muted', 'Per frame, per reference device'), thead);
    const body = el('tbody', '');
    for (const entry of rows) {
      const tr = el('tr', '');
      tr.append(
        el('th', '', entry.device),
        el('td', 'ft-data', entry.value),
        el('td', 'ft-muted', entry.verdict),
      );
      body.append(tr);
    }
    table.append(body);
    row(cost.list, 'GPU time at 1080p', table);
  }

  grid.append(verdict.section, cost.section);

  let disposed = false;
  void loadDeviceFeatures().then((set) => {
    if (disposed) return;
    required.mark(set);
    optional.mark(set);
  });

  // Live reading: only when the host reports pass timings.
  const live = panel('This device, right now');
  live.section.hidden = true;
  live.section.classList.add('ft-scorecard__live');
  const liveTime = row(live.list, 'GPU time', '');
  const liveSize = row(live.list, 'Resolution', '');
  const liveNote = el(
    'p',
    'ft-muted ft-scorecard__note',
    'Measured on this device at this resolution. Not comparable with the 1080p reference numbers.',
  );
  live.section.append(liveNote);
  grid.append(live.section);

  let averaged: number | undefined;
  let lastPaint = 0;
  const releaseTiming = host?.requestTiming();
  const stopStats = host?.onStats((stats: FrameStats) => {
    if (stats.passes.length === 0) return;
    // Not the sum of the passes: their intervals overlap on tile-based GPUs.
    averaged = smooth(averaged, stats.gpuMs ?? sumPasses(stats.passes));
    const now = performance.now();
    if (now - lastPaint < 500) return;
    lastPaint = now;
    liveTime.textContent = `${formatMs(averaged)} across ${stats.passes.length} ${stats.passes.length === 1 ? 'pass' : 'passes'}`;
    liveTime.classList.add('ft-data');
    liveSize.textContent = resolutionText(stats.width, stats.height);
    liveSize.classList.add('ft-data');
    live.section.hidden = false;
  });

  return () => {
    disposed = true;
    stopStats?.();
    releaseTiming?.();
    root.remove();
  };
}

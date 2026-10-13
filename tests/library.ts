// The whole shared WGSL library, for tests that compile ad-hoc shaders against it. Application
// code never does this: it imports the `.wgsl` files it needs, so only those reach its bundle.
const files = import.meta.glob<string>('../src/wgsl/*.wgsl', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const LIBRARY_CHUNKS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(files).map(([path, source]) => [path.slice(path.lastIndexOf('/') + 1), source]),
);

export function chunkNames(): string[] {
  return Object.keys(LIBRARY_CHUNKS).sort();
}

export function getChunk(name: string): string | undefined {
  return LIBRARY_CHUNKS[name];
}

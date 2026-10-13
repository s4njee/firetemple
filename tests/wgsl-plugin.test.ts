import { describe, expect, it } from 'vitest';
import { resolveShader, libraryChunks, withChunks } from '../src/gpu/shader.ts';
import hello from '../src/effects/hello/hello.wgsl';
import helloRaw from '../src/effects/hello/hello.wgsl?raw';
import fbm from '../src/wgsl/fbm.wgsl';
import fullscreen from '../src/wgsl/fullscreen.wgsl';
import { listIncludes } from '../src/wgsl/preprocess.ts';
import { includeClosure, shaderLabel } from '../vite-plugin-wgsl.ts';
import { getChunk } from './library.ts';

// Per-effect shader packaging (story 1.3): a `.wgsl` import carries the files it includes and
// nothing else, so there is no global library for the first page load to pay for.

describe('listIncludes', () => {
  it('lists direct includes once each, in order', () => {
    expect(
      listIncludes('#include "a.wgsl"\n  #include "b.wgsl" // why\n#include "a.wgsl"\nfn f() {}'),
    ).toEqual(['a.wgsl', 'b.wgsl']);
  });

  it('ignores commented-out and malformed directives', () => {
    expect(
      listIncludes(
        '// #include "a.wgsl"\n/*\n#include "b.wgsl"\n*/\n#include nonsense\n#include "c.wgsl"',
      ),
    ).toEqual(['c.wgsl']);
  });
});

describe('includeClosure', () => {
  const files: Record<string, string> = {
    '/p/src/effects/fx/main.wgsl':
      '#include "local.wgsl"\n#include "noise.wgsl"\n#include "params.wgsl"',
    '/p/src/effects/fx/local.wgsl': '#include "hash.wgsl"',
    '/p/src/wgsl/noise.wgsl': '#include "hash.wgsl"\n#include "math.wgsl"',
    '/p/src/wgsl/hash.wgsl': '// leaf',
    '/p/src/wgsl/math.wgsl': '#include "noise.wgsl" // a cycle is harmless',
  };
  const closure = (file: string) =>
    includeClosure(
      file,
      '/p/src/wgsl',
      (path) => files[path]!,
      (path) => path in files,
    );

  it('follows includes transitively, beside the file first and then in the library', () => {
    const { files: found, runtime } = closure('/p/src/effects/fx/main.wgsl');
    expect([...found]).toEqual([
      ['local.wgsl', '/p/src/effects/fx/local.wgsl'],
      ['hash.wgsl', '/p/src/wgsl/hash.wgsl'],
      ['noise.wgsl', '/p/src/wgsl/noise.wgsl'],
      ['math.wgsl', '/p/src/wgsl/math.wgsl'],
    ]);
    expect(runtime).toEqual(['params.wgsl']);
  });

  it('never lists the file itself, even through a cycle', () => {
    const { files: found } = closure('/p/src/wgsl/noise.wgsl');
    expect([...found.keys()]).toEqual(['hash.wgsl', 'math.wgsl']);
  });
});

describe('shaderLabel', () => {
  it('names effect and gpu shaders by their last directories and library files by base name', () => {
    const label = (file: string) => shaderLabel('/p', '/p/src/wgsl', file);
    expect(label('/p/src/effects/hello/hello.wgsl')).toBe('hello/hello.wgsl');
    expect(label('/p/src/gpu/post/output.wgsl')).toBe('post/output.wgsl');
    expect(label('/p/src/wgsl/noise.wgsl')).toBe('noise.wgsl');
    expect(label('/p/tests/fixture.wgsl')).toBe('tests/fixture.wgsl');
  });
});

describe('a .wgsl import', () => {
  it('is a shader source labelled by path, with the raw text as its code', () => {
    expect(hello.label).toBe('hello/hello.wgsl');
    expect(hello.code).toBe(helloRaw);
    expect(fbm.label).toBe('fbm.wgsl');
  });

  it('carries exactly the library files it reaches, with their real text', () => {
    const names = Object.keys(hello.chunks).sort();
    expect(names).toContain('fullscreen.wgsl');
    expect(names).toContain('fbm.wgsl');
    expect(names).toContain('noise.wgsl');
    // Generated at run time by the effect, so the build cannot supply it.
    expect(names).not.toContain('params.wgsl');
    // Not included by hello, so not in its bundle.
    expect(names).not.toContain('sdf.wgsl');
    expect(names).not.toContain('voronoi.wgsl');
    for (const name of names) expect(hello.chunks[name]).toBe(getChunk(name));
  });

  it('resolves once the run-time chunks are added, and not before', () => {
    expect(() => resolveShader(hello)).toThrowError('#include "params.wgsl" not found');
    const { code } = resolveShader(
      withChunks(hello, { 'params.wgsl': 'struct Params { x: f32 }' }),
    );
    expect(code).toContain('struct Params { x: f32 }');
    expect(code).not.toMatch(/^\s*#include/m);
  });

  it('lets a shader written in TypeScript include the library files it imports', () => {
    const chunks = libraryChunks(fullscreen, fbm);
    expect(chunks['fbm.wgsl']).toBe(fbm.code);
    expect(chunks['fullscreen.wgsl']).toBe(fullscreen.code);
    expect(Object.keys(chunks)).toEqual(expect.arrayContaining(Object.keys(fbm.chunks)));
    const { code } = resolveShader({
      label: 'inline.wgsl',
      code: '#include "fullscreen.wgsl"\n#include "fbm.wgsl"',
      chunks,
    });
    expect(code).toContain('fn fullscreen_vs');
  });
});

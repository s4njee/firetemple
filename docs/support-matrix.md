# WebGPU support matrix (Fire Temple story 1.11, "Support matrix refresh")

**First written 2026-10-08 for Water Temple (its story 1.10). Re-checked on 2026-10-13 for Fire Temple story 1.11.** Feeds story 12.6 (compatibility notes) and the "optional features required" column of the scorecard.

What changed in this re-check (2026-10-13)

The re-check was done in two passes on the same day. The second pass covered everything the first had left out; nothing in this file is now "not re-checked". What could not be confirmed is listed at the end of this block with the reason, and is marked "unverified" in place.

Moved:

- **Firefox 158 is out** (released 2026-10-13, not 2026-10-09 as the earlier snapshot expected) [S41][S29: 158]. It ships `float32-blendable` and, on macOS only, `clip-distances` [S29: 158][S5]. Rows in 2.1, implication 4 and the unverified list are updated.
- **Firefox and service workers (new conflict).** The gate was removed in Firefox 148 according to Bugzilla and current source, while BCD and this file said "except service workers" [S48][S58]. See 1.1 and 5.4.
- **Survey tables (2.2, 2.3, section 3) re-read in full.** Most cells moved by under a point. The Samsung Internet column moved by 2.4 to 4.4 points on seven features (and 1.2 to 1.7 on four more), and iOS / Safari `clip-distances` and `texture-formats-tier2` rose about 1.7 points. One limit changed materially: iOS / Safari `maxComputeInvocationsPerWorkgroup` reads 1024 today against 512 on 2026-10-08, which removes one of the three Apple-limit conflicts [S4]. A `maxTextureDimension3D` row was added.
- **Share of users (1.3).** caniuse live page unchanged (85.8% + 2.02%) [S1]; its JSON now reads 85.8% + 3.66% [S2]. web3dsurvey adapter rates drifted by under one point [S4].
- **`GPUAdapterInfo` (5.5).** Firefox is no longer unknown: source returns empty strings for all four text fields [S58]. WebKit trunk returns `isFallbackAdapter` = false always [S33]. Chromium gates `powerPreference` behind the developer flag [S34].
- **Compatibility mode (5.1).** Platform coverage unchanged, but the restriction list is now verified rule by rule against the spec source rather than taken from a secondary one, with five rules added [S22].
- **Two earlier "unverified" items are settled.** CSS `mix-blend-mode: plus-lighter` is in Chrome 100, Firefox 99, Safari 9.1 and their mobile counterparts, so it is available wherever WebGPU is (0.2) [S5]. `readonly_and_readwrite_storage_textures` is reported by 100% of Firefox and 99.83% of Safari survey browsers, so BCD's "no" is stale (0.4, 4.3) [S4].
- **New section 0, "What Fire Temple leans on"**, added below. New sources are [S47]-[S58].
- **Story numbers** now follow Fire Temple's `plan.md`: this file is 1.11 (was Water Temple 1.10); HDR is story 1.6 (was 3.10); the fallback path is 12.5 (was "1.8, 12.5"; 1.8 is the benchmark harness here); smoke is 3.10. Stories 2.6 (scorecard), 9.1, 12.6 and 12.7 keep the same numbers in both projects.

Confirmed unchanged:

- **Firefox on Linux, Android and Intel Macs.** Still Nightly-only / flag-only. The wiki page is still the 2026-10-02 edit [S3]; BCD still lists Linux and Intel Macs as unsupported and Firefox for Android as no [S5: GPU]; the tracking bugs are still open [S48]; the Firefox 158 notes mention no WebGPU platform change [S29: 158]; and the pref default in source is on only for Windows and Apple Silicon macOS [S58].
- **Chrome.** 155 is still stable; 156 is still due 2026-10-20 (it is already being served to 0.5% of the stable channel) [S40][S47]. The 155-156 "What's new" post was still last updated 2026-10-07 [S19].
- **Safari.** 27 is current, 27.2 is in beta [S49][S55]. Safari Technology Preview 253 and 254 (2026-09-23, 2026-10-08) add fixes only [S50]. Apple's Safari 27 release notes were read in full: one new WebGPU feature (`clip_distances`), six fixes, nothing on HDR canvas [S55]. BCD dates the Safari 27 release 2026-09-14; WebKit's post is dated 2026-09-17 (listed as a conflict).
- **Samsung Internet.** 30.0 (2026-05-11) is still current and is still Chromium 143; 24 = 117 and 25 = 121 as before [S45].
- **Edge.** Stable is 155 (released 2026-10-08), tracking Chrome [S56][S5]. Compatibility mode appears in the Edge 146 notes as in Chrome 146 [S57].
- **Compatibility mode coverage (5.1).** Still Android 10+ with OpenGL ES 3.1 only; no Chrome post since 146 changes that [S5][S16][S21].
- **Workers and OffscreenCanvas (5.4)** for Chrome and Safari [S5].
- **HDR canvas (5.3).** No status change. Firefox's blocker bug (accepting `rgba16float` as a canvas format) is still open [S48]. WebKit trunk turns its WebGPU HDR preference on by default on Apple platforms [S54] (trunk, not a release guarantee).
- **HTML-in-Canvas (5.2).** The Chrome updates page was still last updated 2026-09-29 and the trial still runs through Chrome 160 [S36]. The Edge trial page still shows expiry 2026-10-20 and the older API names [S39].
- **Spec.** The W3C Candidate Recommendation Draft is still the 2026-09-15 one; core and compat default limits re-read and unchanged [S22].

Could not be confirmed, and why (each is also marked in place and listed in section 7):

- **Edge-specific WebGPU rollout on Linux and Android.** No Microsoft source states it. BCD only mirrors Chrome, and the Edge 144 and 147 web platform notes omit Chrome's Linux rollout items [S57].
- **Whether Safari 27 displays HDR for an `extended` WebGPU canvas.** No written source says either way; it needs a test on an HDR display.
- **What each browser displays for premultiplied colour greater than alpha,** and the same with an `extended` canvas. No primary per-browser source exists that I could find; it needs device tests.
- **Release-build behaviour that was only read from source:** `depthSlice` in Safari and Firefox, `GPUAdapterInfo` fields in Safari and Firefox, Firefox service workers since 148, Firefox rejecting an `rgba16float` canvas. No release browser was run in this check.
- **Safari and Firefox GPU/OS blocklist contents.** Not published in any source found.
- **Third-party browsers on iOS.** No primary source found.
- **One source could not be re-read:** the blink-dev Intent to Experiment for HTML-in-canvas [S38]. Google Groups is script-rendered and only the thread title loaded, so the Safari and Firefox "no signal" entries in 5.2 rest on the 2026-10-08 read.
- **Source access note.** GitHub raw files failed to resolve intermittently in the second pass (DNS). BCD was then read through the jsDelivr mirror of its `main` branch, Chromium source from chromium.googlesource.com and Firefox source from hg.mozilla.org; the mirror may lag `main` by some hours. Nothing was skipped because of it.

How to read this file

- Source tags like `[S3]` point to the numbered list at the bottom. A suffix names the sub-page, file, or version inside that source (for example `[S4: float32-filterable]` is the per-feature page on web3dsurvey.com, `[S5: GPU]` is `api/GPU.json` in MDN BCD, `[S29: 147]` is the Firefox 147 release notes).
- "unverified" means I could not confirm it from a primary or otherwise reliable source this session. "Conflict" means two sources disagree and both are given.
- web3dsurvey percentages are **share of survey reports**, not share of users. For feature pages they are "among reports tested for that feature". The site shows no date stamp on its pages, so treat the numbers as a snapshot taken on the day they were read: 2026-10-08 unless a table or note says 2026-10-13 [S4].
- Version snapshot on 2026-10-13: Chrome 155 stable (155.0.8059.40, released 2026-10-06, serving about 99% of the stable channel; 156.0.8078.12 has been on 0.5% of stable since 2026-10-07 and goes fully stable 2026-10-20) [S40][S47]; Firefox 158.0 (released 2026-10-13; 159 is beta, 160 is Nightly) [S41][S29: 158]; Safari 27 (current; 27.2 is beta; latest Technology Preview is 254, 2026-10-08) [S49][S50][S55]; Samsung Internet 30.0 = Chromium 143 (released 2026-05-11, still current) [S45][S1]; Edge 155 (released 2026-10-08) [S56].
- Snapshot on 2026-10-08, for comparison: Chrome 155, Firefox 157.0.1 (with 158 expected 2026-10-09), Safari 27.0, Samsung Internet 30.
- **Conflict** on the next Firefox date: Mozilla product-details gives `NEXT_RELEASE_DATE` 2026-10-23 [S41]; MDN's Firefox 159 page says 159 ships 2026-10-27 [S29: 159].

---

## 0. What Fire Temple leans on

Added 2026-10-13 for story 1.11. "Core" means guaranteed by the spec on a core adapter with no `requiredFeatures`. Browser columns assume the browser has WebGPU on that platform at all (section 1). Core format capabilities are taken from the spec's format table; they were **not** individually tested in each browser.

### 0.1 Summary

| What fire uses | Core or optional | Chrome / Edge | Safari | Firefox | When it is missing |
|---|---|---|---|---|---|
| `rgba16float` as render target, blendable, linearly filterable (HDR scene target, bloom chain) | **Core.** Renderable, blendable, resolvable, sample type `float` (filterable). Multisampling needs `core-features-and-limits`, so not in compat mode [S22: #texture-format-caps] | 113 | 26 | 141 | Cannot be missing on a core adapter. In compat mode do not multisample it. Costs 8 B of the 32 B `maxColorAttachmentBytesPerSample` budget |
| `rg11b10ufloat` as render target (cheaper HDR target) | **Optional**: `rg11b10ufloat-renderable` adds render, blend, multisample, resolve. Sampling and linear filtering are core [S22] | 113 [S5] | 26 [S5] | In the source feature list [S32]; survey 99.98% [S4]; BCD says no [S5] (stale, see 2.1) | Fall back to `rgba16float`. Survey: 99.99% overall, Android 99.83% [S4]. No alpha channel, so not for targets that carry coverage. Its attachment byte cost is 8, same as `rgba16float`, although the texel is 4 B [S22] |
| `float32-filterable` (sim state in `r32float` / `rgba32float`) | **Optional** | 119 (Android 121) [S5] | Per device: 55-57% of reports [S4]; BCD says no | In source [S32]; survey 99.5% | `textureLoad` plus manual bilinear/trilinear in the shader, or keep the state in `rgba16float`, which filters in core. Android 70.47%, Adreno 6xx 10%, Adreno 7xx 47% [S4] |
| `float32-blendable` (additive splats into float32 state) | **Optional** | 132 [S5] | 26 [S5] | **158**, released 2026-10-13 [S29: 158] | Do the add in the shader (ping-pong) or accumulate in `rgba16float`. Android 55.03%, Mali Bifrost 0%, Valhall 11% [S4]. Firefox survey share (4.82%) will lag the release |
| `timestamp-query` (performance HUD) | **Optional** | 121. **Quantized to 100 microseconds** unless the "WebGPU Developer Features" flag is on [S7] | 26, if Metal offers a timestamp counter set [S5][S33] | In source and survey (99.85%) [S32][S4]; BCD says no | HUD shows rAF frame time and says so; never label it GPU time. See 0.5 |
| Canvas `alphaMode: 'premultiplied'` | **Core** (the option). Displaying colour greater than alpha is **undefined** [S22: #gpucanvasalphamode] | Yes | Yes (trunk IDL [S54]) | Yes (IDL [S32]) | See 0.2 |
| Canvas `rgba16float` + `toneMapping: { mode: 'extended' }` (HDR output) | Core in the spec text, which itself notes that some user agents may not implement it yet [S22: #canvas-configuration] | **129**; honoured [S10][S5] | Option accepted; HDR display **unverified** [S28][S54] | **Not exposed**; `rgba16float` canvas itself unsupported [S32][S48] | See 0.3 |
| `texture_3d` sampling | **Core.** Every plain colour format supports dimension `3d`; depth formats do not [S22: #texture-format-caps] | 113 | 26 | 141 | Cannot be missing. Filtering follows the format (row 1 and row 3) |
| Rendering to 3D slices (`depthSlice`) | **Core** [S22: GPURenderPassColorAttachment] | **125** [S53][S5: GPUCommandEncoder] | **Conflict**: BCD no [S5]; in trunk IDL [S54] | **Conflict**: BCD no [S5]; in IDL [S32] | Write the volume from compute through `texture_storage_3d`. See 0.4 |
| `texture_storage_3d` | **Core** type; format and access rules are the ones in section 4 [S22][S23] | 113 | 26 | 141 | See 0.4 |
| Compute shaders | **Core**, no feature flag | 113 | 26 | 141 | No WebGPU without compute. Compat mode keeps compute with smaller workgroups (section 5.1) |
| `dual-source-blending` (smoke that absorbs and emits in one pass) | **Optional** | 130 [S21: 130] | **No** [S5][S26] | 155, desktop [S29: 155] | Premultiplied "over" covers the grey-absorption case with no feature. See 0.6 |

### 0.2 Premultiplied canvas and colour greater than alpha

Additive fire drawn over a transparent canvas leaves pixels such as `[0.9, 0.4, 0.1, 0.2]`: colour above alpha. The spec calls this an out-of-gamut premultiplied RGBA value (any of R, G, B exceeds A) [S22: #color-spaces].

- For a `premultiplied` canvas holding such values when it is **displayed to the screen**, the spec says: "Compositing results are undefined." [S22: #gpucanvasalphamode]. Its note adds that this holds even when colour conversion would bring the values back in gamut, because the compositor's intermediate format is unspecified.
- When the same canvas is **used as an image source** (copy, `drawImage`, readback) the values are preserved [S22: #gpucanvasalphamode].
- Only what is in the canvas texture at presentation matters. Offscreen targets may hold any value. This is the clarification merged in gpuweb PR 4476 (2024-04-12) [S51].
- A draft PR (4526, open since 2024-03, still a draft, last touched 2025-10) would narrow the undefined case to values the canvas format cannot represent. Not merged, so the text above is current [S51].
- **What each browser does: unverified.** I found no primary source describing Chrome's, Safari's or Firefox's compositor behaviour. WebGPU Fundamentals (secondary) shows a visibly wrong result for `[1, 0, 0, 0.01]` and says the outcome is up to the browser [S52]. Compositors that happen to compute `src + dst * (1 - a)` will look additive; nothing guarantees it, and it can differ by browser, by platform compositor path and by display colour space.

What an effect should do:

1. **Default: opaque canvas.** Composite fire over its own backdrop inside WebGPU, in the offscreen `rgba16float` target where additive blending is fully defined, tone-map, and present with `alphaMode: 'opaque'`.
2. **Fire over the page:** keep the presented value legal. In the final pass, after tone mapping, clamp colour to `[0, 1]` and write `alpha = max(alpha, max(r, g, b))`. This turns pure addition into "over, with coverage equal to brightness": bright flame hides the page behind it, dim glow lets it through. It is not the same picture as true addition and the scorecard should say so.
3. **True addition over page content** needs the page compositor to do the adding: an opaque black-backed canvas with CSS `mix-blend-mode: plus-lighter` (or `screen`, which is not the same arithmetic). Support, checked 2026-10-13 in BCD: `plus-lighter` is Chrome 100, Firefox 99, Safari 9.1, with Edge, Chrome Android, Firefox Android, Safari iOS and Samsung Internet mirroring their desktop engines; `screen` is Chrome 41, Firefox 32, Safari 8 [S5: css/properties/mix-blend-mode]. So every browser that has WebGPU at all also has `plus-lighter`, and this is the well-defined route to additive light. Its rendering cost and its behaviour on an HDR canvas were **not measured** here; see the compositing study.
4. Never ship superluminant values to a `premultiplied` canvas on the strength of a test in one browser.

In this repo (read 2026-10-13, story 1.6 tail, `src/gpu/post/output.ts`): the `luminance` alpha mode is option 2 and is the overlay default; `opaque` is option 1; `additive` writes alpha 0 and is therefore always in the undefined case; `coverage` is legal only where the scene's colour does not exceed its own alpha, so flame and bloom with no coverage are still in the undefined case. `configureCanvas` defaults to `alphaMode: 'premultiplied'`.

### 0.3 HDR output: `rgba16float` canvas with `toneMapping: { mode: 'extended' }`

Spec: `bgra8unorm`, `rgba8unorm` and `rgba16float` must all be accepted as canvas formats. `toneMapping` is required, but the spec notes that an implementation without it should leave the member out so `getConfiguration()` can be used to detect it. `extended` leaves values inside the screen's extended range unchanged, which may include values above 1 [S22: #canvas-configuration, #gpucanvastonemappingmode].

| Engine | Honours it? | Source |
|---|---|---|
| Chrome / Edge | **Yes**, from 129 on Windows, macOS, ChromeOS; Linux from 144; Android mirrors desktop in BCD | [S10][S5: GPUCanvasContext] |
| Safari | **Unverified.** The option exists and is echoed by `getConfiguration()`. In Aug 2025 macOS still displayed SDR while iOS with the "WebGPU HDR" flag displayed HDR [S28]. WebKit trunk now defaults its "WebGPU support for HDR" preference on wherever WebGPU is on by default and the platform supports HDR displays (macOS, iOS, visionOS), and exposes `toneMapping` under the plain WebGPU setting, so the echo proves nothing [S54] (trunk, not a release guarantee). Safari 27.0 notes and Technology Preview 253-254 say nothing about it [S26][S50]. Apple's own Safari 27 release notes, read in full on 2026-10-13, have a WebGPU section with one new feature (`clip_distances`) and six fixes and no mention of `toneMapping`, HDR canvas or `rgba16float`; the only tone-mapping item is for the `<model>` element. The Safari 27.2 beta notes list one WebGPU fix (render bundles with indirect draws) [S55]. BCD says no [S5] | [S28][S54][S55][S5] |
| Firefox | **No.** `toneMapping` and `colorSpace` are commented out of the IDL, and the bug they point to (1834395, which asks for `rgba16float` as a `GPUCanvasConfiguration` format; status NEW, last changed 2026-09-12) means there is no float canvas either (inferred from the bug title; not tested here) | [S32][S48] |

What an effect should do:

- Render HDR internally everywhere (`rgba16float` offscreen). Present SDR by default: tone-map in the last pass to a canvas in `navigator.gpu.getPreferredCanvasFormat()`.
- HDR presentation is an opt-in enhancement, gated on all of: `matchMedia('(dynamic-range: high)')`, `configure()` with `rgba16float` and `extended` not throwing, `getConfiguration().toneMapping?.mode === 'extended'`, and a browser allowlist (Chromium today). The `getConfiguration()` test alone is not enough because of Safari.
- Use `alphaMode: 'opaque'` for an HDR canvas. `premultiplied` plus `extended` stacks the undefined case in 0.2 on top of values above 1; the draft PR discussion calls it complicated and leaves it unsettled [S51]. **Unverified** in every browser.

In this repo (read 2026-10-13, `configureCanvasHdr` in `src/gpu/canvas.ts`): the gate is a display check, a `try`/`catch` around `configure()`, and the `getConfiguration()` read-back. There is no browser allowlist, so if Safari on macOS still behaves as in the Aug 2025 report it would be classed as HDR while displaying SDR. The HDR path also inherits the `premultiplied` default. Both are for story 12.6 to decide; this story changes no code.

### 0.4 3D textures for volumetric simulation

- **Sampling.** `texture_3d<f32>` with a filtering sampler is core for `rgba16float`, `rg11b10ufloat` and the 8-bit unorm formats. `r32float`, `rg32float`, `rgba32float` volumes need `float32-filterable` or manual trilinear from eight `textureLoad`s [S22].
- **Rendering to slices.** A colour attachment whose view is `3d` must give `depthSlice`, one slice per attachment per pass [S22: GPURenderPassColorAttachment]. Chrome 125 [S53]. Safari and Firefox: BCD says unsupported [S5: GPUCommandEncoder] while both engines' current IDL has the member [S32][S54]. **Conflict; release behaviour unverified.** Do not make a Tier A effect depend on it. Depth-stencil formats cannot be 3D, so a slice pass that needs depth must attach a separate 2D depth texture [S22].
- **Storage.** `texture_storage_3d<format, access>` is a core WGSL type [S22][S23]. Access rules are per format, not per dimension (section 4):
  - Write-only and read-only in core: `rgba8unorm/snorm/uint/sint`, `rgba16float/uint/sint`, `r32float/uint/sint`, `rgba32float/uint/sint`. `rg32float/uint/sint` too, but not in compat mode.
  - **Read-write in core: only `r32float`, `r32uint`, `r32sint`.**
  - Read-write `rgba16float` (and `r16float`, `rgba32float`, others) needs `texture-formats-tier2`: Chrome 142; Safari about a third of reports; Firefox not implemented (section 4.4).
  - `r16float` and `rg16float` are not storage formats at all without `texture-formats-tier1` (Firefox lacks it).
  - Read-only and read-write access also depend on the WGSL language feature `readonly_and_readwrite_storage_textures`: Chrome 124 [S8]. **Conflict** for Safari and Firefox, settled in favour of the survey on 2026-10-13: BCD says no [S5: WGSLLanguageFeatures], but the survey's page for this language feature reads 99.03% overall, Firefox 100%, Safari 99.83%, Chrome 98.98%, Samsung Internet 98.07% [S4: wgsl-language-features/readonly_and_readwrite_storage_textures]. BCD is stale. Still check `navigator.gpu.wgslLanguageFeatures.has('readonly_and_readwrite_storage_textures')` at run time and fall back to write-only.
- **Default pattern (no optional feature):** two `rgba16float` 3D textures, ping-pong. Read the previous step through `texture_3d<f32>` with a trilinear sampler; write the next through `texture_storage_3d<rgba16float, write>`. A step that writes several fields is bounded by `maxStorageTexturesPerShaderStage` (default 4, section 3).
- **Size.** `maxTextureDimension3D` is 2048 by default and in compat mode [S22]. The survey shows 100% of reports at 2048 and almost nobody above it (Linux 7% at 4096, Firefox 2%) [S4: limits/maxTextureDimension3D]. Memory binds long before the limit: a 128^3 `rgba16float` volume is 16 MiB and a 256^3 one is 128 MiB, each doubled for ping-pong (my arithmetic, 8 B per texel).
- **Compat mode.** A texture may have only one view dimension (`textureBindingViewDimension`), and vertex stages get no storage textures [S22]. Checked 2026-10-13: none of the 17 compatibility-mode blocks in the Editor's Draft source is specific to 3D textures beyond that rule, and `maxTextureDimension3D` is 2048 in both columns [S22].

### 0.5 Compute, limits and timing

Compute shaders are core; every browser that has WebGPU has them. Defaults that size particle and grid simulations [S22 limits table]:

| Limit | Core default | Compat default | Real devices [S4] | What it means for fire |
|---|---|---|---|---|
| `maxStorageBuffersPerShaderStage` | 8 | 8 (vertex stage 0, fragment stage 4) | 10 on 95-100% of reports per platform; 16 on most Windows/Linux/Android but only 30% of macOS (section 3) | Pack particle attributes into few buffers. In compat mode a vertex shader gets no storage buffer by default, so drawing particles straight from the sim buffer needs a core adapter or a raised `maxStorageBuffersInVertexStage` |
| `maxComputeWorkgroupStorageSize` | 16384 B | 16384 B | 32768 on 94% of Android, 69% of Adreno 6xx (section 3) | Tile-local scratch (blur, prefix sum) must fit 16 KiB |
| `maxTextureDimension3D` | 2048 | 2048 | 2048 on 100%; essentially no headroom [S4: limits/maxTextureDimension3D] | Never the binding constraint; memory is (0.4) |
| `maxStorageBufferBindingSize` | 128 MiB | 128 MiB | section 3 | 4,194,304 particles at 32 B each in one binding (my arithmetic) |
| `maxComputeInvocationsPerWorkgroup` | 256 | 128 | section 3 | For volumes, 8x8x4 = 256 fits every core device and 4x4x8 = 128 also fits compat; 8x8x8 = 512 fits neither default |

A device only gets the defaults unless the effect asks for more in `requiredLimits` (section 3). Chrome 146 raised what it will grant for `maxStorageBuffersPerShaderStage` to 16 [S16]; that is a ceiling to request against, not a default.

Timing with `timestamp-query`: in Chrome a pass shorter than 100 microseconds reads as 0 or 100, so the HUD must average over many frames (60 or more) and show per-pass numbers as approximate; discard negative deltas [S7]. Without the feature, show rAF frame time only.

### 0.6 `dual-source-blending`

- Optional feature. Adds `@blend_src(0)` / `@blend_src(1)` in WGSL and the blend factors `src1`, `one-minus-src1`, `src1-alpha`, `one-minus-src1-alpha`; it works only with the single colour attachment at location 0 [S22: #dom-gpufeaturename-dual-source-blending].
- Chrome 130, Firefox 155 (desktop), Safari no (2.1). Survey on 2026-10-13: 81.96% overall; iOS 0.08%; Android 67.66%, Mali Bifrost 73%, Mali Valhall 36% [S4].
- When missing: write premultiplied output (`rgb` = emitted light, `a` = opacity) and blend with source factor `one`, destination factor `one-minus-src-alpha`. That is emission plus absorption in one pass with no feature, as long as absorption is the same for all three channels. Dual-source is only needed for per-channel (coloured) transmittance; the fallback for that is two passes (a multiply pass, then an additive pass) or accepting grey smoke. This is standard blend arithmetic, stated here as design guidance rather than from a source.
- Because Safari lacks it entirely, it can only ever be a Tier B or C enhancement.

---

## 1. Browser and platform support

### 1.1 Matrix

| Browser | Windows | macOS | Linux | ChromeOS | Android | iOS / iPadOS |
|---|---|---|---|---|---|---|
| **Chrome** | **113** (needs Direct3D 12) [S3][S6]. Windows ARM64: behind `chrome://flags/#enable-unsafe-webgpu` [S3]. | **113** [S3]. Dawn requires macOS 13+ as of Chrome 153-154 [S18]. | **144**: Intel Gen12+ only [S15]. **147**: NVIDIA (driver 535.183.01+) on Wayland [S3][S17]. Everything else (incl. AMD): behind flags [S3]. Caniuse: "depends on hardware and drivers" [S2]. | **113**, devices with Vulkan [S6][S44]. | **121**, Android 12+ with Qualcomm and ARM GPUs [S7]; the wiki also lists Intel [S3]. Imagination GPUs: **139**, Android 16+. Samsung Xclipse and others: "TBD" [S3]. | n/a (third-party browsers on iOS: **unverified**, see section 7) |
| **Edge** | **113** [S1][S2]. Stable on 2026-10-13 is 155.0.4283.45 [S56] | **113** [S1][S2] | BCD has Edge mirror Chrome (so 144 for Intel Gen12+) [S5: GPU], and Edge 155 has a Linux stable build [S56]. **Edge-specific rollout still unverified** after a second look on 2026-10-13: Microsoft's Edge 144 and 147 web platform notes do not carry Chrome's "WebGPU on Linux" items (144 lists two other WebGPU items, 147 lists none), and I found no Microsoft page that states which Linux GPUs are allowed [S57] | Not applicable: Microsoft's update service lists Edge builds for Windows, macOS, Linux, Android and iOS only [S56] | BCD has Edge mirror Chrome [S5: GPU]; Edge for Android stable is 155.0.4283.48 [S56]. **Edge-specific rollout still unverified**: no Microsoft source found that states WebGPU availability or GPU coverage in Edge for Android. The Edge 146 notes list compatibility mode as shipped without naming a platform [S57] | n/a (Edge for iOS 155 exists [S56]; its WebGPU status is **unverified**, see section 7) |
| **Safari** | n/a | **26**, default-on only on **macOS 26 Tahoe+**. Safari 26/27 on older macOS needs the `WebGPU` feature flag [S2 notes 2 and 7][S3]. | n/a | n/a | n/a | **26** (iOS 26 / iPadOS 26) on by default [S3][S24]. iOS 17.4-18.7: feature flag only, off by default [S2]. |
| **Firefox** | **141**, all contexts except service workers [S29: 141][S30]. **Conflict** found 2026-10-13: the service-worker gate was removed in Firefox **148** (bug 1942431, RESOLVED FIXED, target milestone 148) and current source defaults `dom.webgpu.service-workers.enabled` to on for Windows and Apple Silicon macOS [S48][S58]; BCD still excludes service workers [S5: GPU] (BCD looks stale) | Apple Silicon: **145** on macOS 26+, **147** on all macOS versions [S29: 147][S5: GPU]. Intel Macs: not shipped (Nightly only) [S3][S5: GPU]. Re-checked 2026-10-13: unchanged in Firefox 158; bug 2004105 ("Enable WebGPU on Intel Macs") is still NEW [S48]. | Nightly only [S3]. A user report says the Firefox 152 release channel works behind `dom.webgpu.enabled` in `about:config` [S31] (single report, not a Mozilla statement). Mozilla "expects to ship in 2026" [S3]. Re-checked 2026-10-13: unchanged in Firefox 158; the release meta-bug 2006676 is still NEW (last changed 2026-09-22) and the Firefox 159 beta notes list no WebGPU items yet [S48][S29: 158, 159]. Source confirms it: `dom.webgpu.enabled` defaults to on only for Windows and macOS on AArch64; everywhere else it is on only in Nightly and early Beta builds [S58]. | n/a | Behind a flag, Beta/Nightly only (`gfx.webgpu.ignore-blocklist`) [S3]. Caniuse says `dom.webgpu.enabled` [S2]. **Conflict** on the pref name. Re-checked 2026-10-13: unchanged [S3][S5: GPU][S1]. The conflict is explained by source: both prefs exist. `dom.webgpu.enabled` is the feature switch (off in release builds outside Windows and Apple Silicon macOS) and `gfx.webgpu.ignore-blocklist` (default false) bypasses the GPU blocklist [S58]. Which of the two an Android user needs was not tested. | n/a |
| **Samsung Internet** | n/a | n/a | n/a | n/a | Caniuse says **24** [S2]. But Samsung 24 is Chromium 117 and Android WebGPU first shipped in Chromium 121 = Samsung **25** [S45][S7]. **Conflict**; treat 25+ as the safe floor. Samsung 30 = Chromium 143, about 12 milestones behind Chrome 155, so it lacks Chrome 144+ items such as compat mode (146) and the per-stage storage limits (146) [S45][S40]. Re-checked 2026-10-13: unchanged. BCD lists 30.0 (released 2026-05-11, Blink 143) as the current release, with 24.0 = Blink 117 and 25.0 = Blink 121 [S45]; caniuse also shows 30 as latest [S1]. | n/a |

Other rows worth knowing: Opera 99+ (desktop), Opera Mobile 80+ [S2]. UC, QQ, Baidu, KaiOS, Opera Mini: no [S2]. Safari on visionOS 26 [S3].

### 1.2 Caveats that decide "adapter or null"

- `navigator.gpu` existing does not mean an adapter is available. Chrome returns `null` from `requestAdapter()` when the GPU is blocklisted (`chrome://gpu` shows "WebGPU has been disabled via blocklist or the command line"), when "Use graphics acceleration when available" is off, or when no GPU is found [S20].
- Chrome on Windows uses a single adapter at a time and `powerPreference` has no effect there [S20].
- `chrome://gpu` can show "WebGPU: Software only, hardware acceleration unavailable" [S20]. Detect software adapters with `adapter.info.isFallbackAdapter` (Chromium sets it for CPU-type adapters) [S34][S5: GPUAdapterInfo]. Only 0.05% of working survey adapters were fallback (same figure on 2026-10-13) [S4]. Re-checked 2026-10-13 in source: Chromium still sets it for CPU-type adapters [S34]; **WebKit trunk returns `false` unconditionally**, so the check can never fire in Safari [S33]; Firefox returns true for a CPU device type, and false when resisting fingerprinting [S58].
- Secure context only (HTTPS or localhost) [S20].
- GPU and OS blocklists for Safari and Firefox: **unverified**. Firefox has a blocklist pref (`gfx.webgpu.ignore-blocklist`) but I could not find its contents [S3].

### 1.3 Share of users

| Measure | Value | Source |
|---|---|---|
| caniuse global usage, full support | **85.8%** (+2.02% partial = 87.82%), as returned by the live page on 2026-10-13 (same as 2026-10-08) | [S1] |
| caniuse JSON in the repo | **85.8%** full, 3.66% partial on 2026-10-13 (it read 85.72% + 3.05% on 2026-10-08). Full support now matches the live page; partial does not | [S2] |
| web3dsurvey, all reports with a working adapter | **83%** as read on 2026-10-13 (whole-number figure as fetched; it read 82.71% on 2026-10-08) | [S4] |
| web3dsurvey by platform (2026-10-13) | ChromeOS 92.06%, macOS 89.96%, Windows 87.67%, iOS 86.01%, Android 73.31%, **Linux 17.96%** | [S4] |
| web3dsurvey by browser (2026-10-13) | Edge 92.9%, Opera 88.65%, Chrome 84.69%, Safari 80.5%, Samsung Internet 77.24%, **Firefox 60.07%** | [S4] |
| web3dsurvey on 2026-10-08, for comparison | ChromeOS 92.7%, macOS 90%, Windows 87.48%, iOS 85.26%, Android 73.81%, Linux 17.46%; Edge 93.09%, Opera 88.97%, Chrome 85.01%, Safari 80.38%, Samsung Internet 77.32%, Firefox 60.39% | [S4] |

Read: roughly 15-17% of visitors have no WebGPU adapter today (unchanged by the re-check; every adapter-rate figure above moved by less than one point in five days). That is large enough that the poster/video fallback is a primary path, not an edge case. Both figures are survey/market-share approximations, not measurements of our audience.

---

## 2. Optional features

### 2.1 Which browsers expose each feature

Versions are first stable release on Windows/macOS/ChromeOS per MDN BCD unless noted [S5: GPUSupportedFeatures]. Chrome Android is 121 or the same version as desktop, whichever is later [S5]. Linux (Intel Gen12+) follows from 144 [S15]. Edge mirrors Chrome. Survey percentages in this table were re-read on 2026-10-13 [S4].

| Feature | Chrome / Edge | Safari (macOS 26+, iOS 26+) | Firefox | Notes |
|---|---|---|---|---|
| `timestamp-query` | **121**. Timestamps are quantized to 100 microseconds unless the "WebGPU Developer Features" flag is on [S7] | **26** [S5]. WebKit only exposes it if Metal offers a timestamp counter set (trunk source) [S33] | Implemented in source [S32]; survey 99.85% [S4]; **Conflict**: MDN BCD says no [S5] (appears stale) | Counter resets can give negative deltas [S7] |
| `float32-filterable` | **119** (Android 121) [S5] | **Conflict**: BCD says no [S5]; survey shows 57.37% of Safari and 54.9% of iOS reports have it [S4: float32-filterable]. Trunk source gates it on `supports32BitFloatFiltering` [S33], i.e. per-device | Implemented in source [S32]; survey 99.47% | Without it, `r32float`/`rg32float`/`rgba32float` are `unfilterable-float` only [S22] |
| `float32-blendable` | **132** [S5]. Since 134, filterable no longer implies blendable [S21: 134] | **26** [S5] | Firefox **158**, released 2026-10-13 [S29: 158][S41]. BCD marks it partial only because Firefox has no WebGPU on Linux or Intel Macs [S5]. Survey: 3.3% on 2026-10-08, 4.82% on 2026-10-13 [S4]; it will lag the release | Independent of filterable |
| `shader-f16` | **120** (Android 121) [S5]. Linux NVIDIA gets it in 155-156 [S19] | **26** [S5] | Implemented in source [S32]; survey 93.06% [S4]; BCD says no (stale) | Needs `enable f16;` in WGSL [S22] |
| `bgra8unorm-storage` | **113** (Android 121) [S5]. Read-only bgra8unorm storage was removed in 143 [S14] | **26** [S5] | Implemented in source [S32]; survey 98.89% | Only write-only storage for this format [S22] |
| `rg11b10ufloat-renderable` | **113** [S5] | **26** [S5] | Implemented in source [S32] | Also implied by `texture-formats-tier1` [S22] |
| `depth32float-stencil8` | **113** [S5] | **26** [S5] | Implemented in source [S32] | |
| `dual-source-blending` | **130** [S21: 130] | No (BCD [S5]; Safari 27.0 notes list only `clip_distances`) [S26]; survey iOS 0.08%, Safari 0.06% | **155**, desktop [S29: 155] | |
| `clip-distances` | **131** [S21: 131] | **27.0** [S26][S27]. BCD still says no (**conflict**, BCD stale). Survey: Safari 32.97%, iOS 35.42% and rising (31.4% and 33.7% on 2026-10-08) [S4] | Firefox **158** (2026-10-13), **macOS only** per the release notes; BCD adds not Windows, not Intel Macs, not Linux [S29: 158][S5]. Survey: 1.3% on 2026-10-08, 2.01% on 2026-10-13 [S4] | Safari 27.0: WebKit post dated 2026-09-17 [S26]; BCD dates the release 2026-09-14 [S49] |
| `subgroups` | **134** [S5]; `subgroup_id` in 144 [S15]; `subgroup-size-control` in 151-152 [S21] | Not shipped. BCD marks `subgroupMinSize/MaxSize` as "preview" [S5: GPUAdapterInfo]; survey 0.46% [S4]. Trunk source enables it on Metal 3 (not released) [S33] | **Not implemented** (Mozilla bug 1955417, still NEW on 2026-10-13) [S32][S48]. The IDL enum now lists `subgroups` and `primitive-index`, but the adapter code has both commented out [S32] | Never assume it |
| `texture-compression-bc` | **113** [S5] | Per-device: survey 57.38% Safari, 54.91% iOS [S4]; BCD says no [S5]; trunk gates on `supportsBCTextureCompression` [S33] | Implemented in source [S32]; survey 99.49% | Desktop-class GPUs |
| `texture-compression-etc2` | **113** [S5] | **26** [S5]; survey 99.23% [S4] | Implemented in source; survey 24.34% (Apple Silicon only) [S4] | Mobile and Apple GPUs |
| `texture-compression-astc` | **113** (Android 121) [S5] | **26** [S5]; survey 99.23% [S4] | Implemented in source; survey 23.77% | Windows reports 0.04% [S4] |
| `texture-formats-tier1` | **142** [S13][S5]. JS-visible in `wgslLanguageFeatures` only from 153 [S18] | **26.2** per BCD [S5]; **not mentioned** in WebKit's 26.2 notes [S25]; survey 97.61% [S4] | **Not implemented** (absent from Firefox's feature switch and IDL) [S32] | See section 4 |
| `texture-formats-tier2` | **142** [S13][S5] | Partial: survey 32.53% Safari, 35.12% iOS [S4]. Trunk gates tier1/tier2 on ARM64 [S33]. BCD: no | Not implemented [S32] | Read-write storage textures |
| `core-features-and-limits` | **139** [S12] | **26** [S5] | Always set [S32] | Absent only on compat-defaulting adapters [S22] |

### 2.2 Share of devices (web3dsurvey, % of reports tested for the feature)

**Read on 2026-10-13** (every per-feature page re-fetched; values as the site prints them). Source for every row is the per-feature page, `[S4: <feature>]`. Platform columns are by OS across all browsers; browser columns across all OSes. The 2026-10-08 values are not kept here; the rows that moved by more than a point are listed under the table.

| Feature | All | Android | iOS | macOS | Windows | Linux | ChromeOS | Chrome | Safari | Firefox | Samsung |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `timestamp-query` | 98.77 | 97.52 | 99.99 | 96.05 | 99.89 | 99.78 | 99.99 | 99.39 | 93.13 | 99.85 | 97.53 |
| `float32-filterable` | 91.11 | 70.47 | 54.9 | 87.06 | 99.92 | 91.44 | 99.99 | 95.11 | 57.37 | 99.47 | 71.48 |
| `float32-blendable` | 89.47 | 55.03 | 99.99 | 95.1 | 92.01 | 74.91 | 81.87 | 92.62 | 99.95 | 4.82 | 62.74 |
| `shader-f16` | 93.95 | 86 | 99.99 | 99.81 | 91.11 | 73.53 | 99.82 | 93.15 | 99.98 | 93.06 | 91.25 |
| `bgra8unorm-storage` | 96.02 | 69.01 | 100 | 100 | 97.27 | 88.18 | 100 | 95.02 | 100 | 98.89 | 70.15 |
| `rg11b10ufloat-renderable` | 99.99 | 99.83 | 100 | 100 | 100 | 99.93 | 100 | 99.98 | 100 | 99.98 | 100 |
| `depth32float-stencil8` | 99.99 | 99.81 | 100 | 100 | 100 | 100 | 100 | 99.98 | 100 | 100 | 100 |
| `dual-source-blending` | 81.96 | 67.66 | 0.08 | 68.77 | 99.21 | 84.84 | 99.74 | 93.47 | 0.06 | 93.62 | 71.86 |
| `clip-distances` | 79.4 | 50.33 | 35.42 | 74.86 | 91.89 | 74.55 | 81.87 | 90.12 | 32.97 | 2.01 | 61.98 |
| `subgroups` | 68.29 | 81.87 | 0.18 | 62.64 | 77.78 | 76 | 71.33 | 82.81 | 0.46 | 0.02 | 83.65 |
| `texture-compression-bc` | 86.96 | 35.1 | 54.91 | 87.34 | 99.99 | 82.02 | 81.94 | 89.35 | 57.38 | 99.49 | 47.72 |
| `texture-compression-etc2` | 47.11 | 99.94 | 99.96 | 95.26 | 0.04 | 71.07 | 99.9 | 45.99 | 99.23 | 24.34 | 100 |
| `texture-compression-astc` | 46.87 | 99.94 | 99.96 | 95.26 | 0.04 | 61.93 | 98.28 | 45.69 | 99.23 | 23.77 | 100 |
| `texture-formats-tier1` | 93.3 | 97.41 | 99.11 | 93.55 | 91.12 | 82.82 | 99.31 | 98.62 | 97.61 | 1.26 | 94.8 |
| `texture-formats-tier2` | 82.7 | 97.41 | 35.12 | 71.76 | 89.89 | 82.82 | 99.31 | 95.06 | 32.53 | 0.34 | 94.8 |
| `core-features-and-limits` | 99.07 | 98.17 | 99.95 | 99.25 | 98.98 | 98.68 | 99.36 | 98.92 | 99.88 | 100 | 94.8 |

What moved by more than one point since the 2026-10-08 read (old to new): Samsung Internet `float32-filterable` 75.9 to 71.48, `float32-blendable` 59.3 to 62.74, `shader-f16` 93.7 to 91.25, `bgra8unorm-storage` 73.6 to 70.15, `dual-source-blending` 69.4 to 71.86, `clip-distances` 58.6 to 61.98, `subgroups` 87.9 to 83.65, `texture-compression-bc` 46.5 to 47.72, tier1/tier2/core 96.5 to 94.8; iOS `texture-compression-bc` 53.8 to 54.91 (Safari 56.3 to 57.38); Chrome `texture-compression-etc2` 47.1 to 45.99 and `texture-compression-astc` 46.9 to 45.69; Android `float32-blendable` 56.8 to 55.03 and `dual-source-blending` 69.5 to 67.66; iOS `clip-distances` 33.7 to 35.42 and `texture-formats-tier2` 33.4 to 35.12 (Safari 31.4 to 32.97 and 30.9 to 32.53); Firefox `float32-blendable` 3.3 to 4.82; Linux `bgra8unorm-storage` 89.4 to 88.18, `subgroups` 77.5 to 76, tier1/tier2 84.6 to 82.82; ChromeOS `subgroups` 72.9 to 71.33. Everything else moved by a point or less. The Samsung Internet column is the least stable, which suggests a small sample; the site does not publish sample sizes. The Firefox column still predates Firefox 158 in practice (158 shipped today).

Survey also reports the non-standard `float16-renderable` / `float32-renderable` at 14.69% overall, 99.91% on iOS and 99.89% on Safari (Apple-only extensions, not portable) [S4: float32-renderable].

### 2.3 Commonly missing on mobile

**Read on 2026-10-13.** Android (Chrome / Samsung Internet), from [S4] per-feature pages and GPU-architecture rows:

| Feature | Android | Where it is missing |
|---|---|---|
| `float32-blendable` | 55.03% | Arm Mali Bifrost 0%, Valhall 10.65% (Adreno 99-100%) |
| `texture-compression-bc` | 35.1% | Mali 0%, Adreno 6xx 29.64%, Adreno 7xx and 8xx 100%. Use ASTC/ETC2 on mobile (99.94%) |
| `clip-distances` | 50.33% | Mali 0%; Adreno 99-100% |
| `dual-source-blending` | 67.66% | Mali Bifrost 72.58%, Valhall 36.15% (Adreno 99-100%) |
| `bgra8unorm-storage` | 69.01% | Adreno 6xx 0.84%, Adreno 7xx 46.4% (Adreno 8xx and Mali 100%) |
| `float32-filterable` | 70.47% | Adreno 6xx 9.98%, Adreno 7xx 47.39% (Adreno 8xx and Mali 100%) |
| `shader-f16` | 86% | Adreno 6xx 32.41% |
| `subgroups` | 81.87% | Adreno 6xx 17.14%, Mali Bifrost 83.69% |

iOS / Safari (read on 2026-10-13):

| Feature | iOS | Note |
|---|---|---|
| `float32-filterable` | 54.9% | Device-dependent (see 2.1) |
| `clip-distances` | 35.42% | Safari 27.0 shipped it; up from 33.7% on 2026-10-08 |
| `dual-source-blending` | 0.08% | Not available |
| `subgroups` | 0.18% | Not available |
| `texture-compression-bc` | 54.91% | Use ASTC (99.96%) |
| `texture-formats-tier2` | 35.12% | tier1 is 99.11% |

Present on essentially all mobile reports (97% or more): `timestamp-query` (Android 97.52%, iOS 99.99%), `rg11b10ufloat-renderable`, `depth32float-stencil8`, ASTC and ETC2 [S4].

---

## 3. Limits that bite on mobile

Key spec facts [S22]:

- Every adapter must support the **default** limits or better. A **device only gets the default limits unless you request better ones in `requestDevice({ requiredLimits })`**. Reading `adapter.limits` does not change what the device enforces.
- The spec says to request better-than-default limits only when needed, because they can cost performance. User agents may bucket or understate the real hardware limits for privacy; no more than 32 distinguishable configurations are allowed [S22 section 2.2.1].
- Spec ED and the W3C Candidate Recommendation Draft of 2026-09-15 have identical default limits [S22].

Table below, **read on 2026-10-13** (every limit page re-fetched): web3dsurvey gives "share of reports whose value is at least X". "Typical" below is the highest value held by most reports on that platform. Source for all real-world columns is `[S4: limits/<name>]`. Spec and compat defaults re-read from the Editor's Draft source the same day [S22].

| Limit | Spec default (guaranteed) | Compat default | Android (Chrome) | iOS / Safari | Desktop | Bites when |
|---|---|---|---|---|---|---|
| `maxTextureDimension2D` | **8192** | 4096 | 16384 (98%) | 16384 (99%) | 16384 (100% Windows/ChromeOS, 98% Linux, 99% macOS); 32767 on 4% of Linux, 1% of macOS, 4% of Firefox | Almost never; 8192 covers 8K |
| `maxStorageBuffersPerShaderStage` | **8** | 8 (vertex 0, fragment 4) | 10 (100%), 16 (91%) | 10 (99%) | Windows 16 (98%), Linux 16 (92%), ChromeOS 16 (88%); **macOS 16 only 30%** (10 on 95%); Firefox 31+ (77%) | SPH/MPM with many SSBOs |
| `maxStorageTexturesPerShaderStage` | **4** | 4 (vertex 0) | 8 (100%) | 8 (99%) | Windows 8 (100%), macOS 8 (99%); **Linux 8 only 68%; ChromeOS 8 only 20%** (the rest sit at 4); Firefox 16+ (100%) | Multi-field compute sims writing more than 4 images |
| `maxComputeWorkgroupStorageSize` | **16384** B | 16384 | 32768 (94%); **Adreno 6xx only 69%** | 32768 (99%) | 32768 (100% Windows); macOS 32767 (99%); Linux 49152 (64%) | Tiled blur, prefix sums, FFT |
| `maxComputeInvocationsPerWorkgroup` (also `maxComputeWorkgroupSizeX/Y`) | **256** | 128 | **1024 on only 63%**: Mali Bifrost 256, Valhall 1024 on 25%, Adreno 1024 (100%); Samsung Internet 65% | **1024** (99%) on 2026-10-13. The 2026-10-08 read was 512 (99%); see the note below | Windows 1024 (100%), macOS 1024 (99%), Linux 85%, **ChromeOS 35%** | 32x32 workgroups |
| `maxBufferSize` | **256 MiB** (268435456) | 256 MiB | 1 GiB (100%), 2 GiB-4 (77%) | about 307 MiB (98%), about 614 MiB (95%), 1 GiB (80%) | Windows 2 GiB-4 (100%); macOS about 1.17 GiB (84%) | Large particle or grid buffers |
| `maxStorageBufferBindingSize` (coupled to the above) | **128 MiB** | 128 MiB | 256 MiB (75%), 512 MiB (48%), 1 GiB (35%); **Adreno 7xx: 256 MiB on only 7%**; Adreno 6xx 512 MiB on 70% | about 307 MiB (100%), about 614 MiB (iOS 96%, Safari 90%) | Windows 1 GiB (100%) | Single large SSBO |
| `maxColorAttachmentBytesPerSample` | **32** | 32 | 128 (91%); **Samsung Internet 32 only** | **64** (99%) | Windows 128 (100%); macOS 128 (65%, 64 on 99%); Firefox 128 (76%) | MRT/G-buffer: 4x `rgba16float` = 32 B (fits), `rgba32float` costs 16 B each |
| `maxTextureDimension3D` (added 2026-10-13) | **2048** | 2048 | 2048 (100%), nothing higher | 2048 (100%), nothing higher | 2048 (100%); above that only Linux (4096 on 7%) and Firefox (4096 on 2%) | Never; volume memory binds first (0.4) |

Moved since the 2026-10-08 read: ChromeOS 16 storage buffers 86% to 88%; Linux 8 storage textures 65% to 68%; ChromeOS 19% to 20%; Adreno 6xx 32768 B workgroup storage 71% to 69%; Android 1024 invocations 64% to 63%, Valhall 26% to 25%, Samsung Internet 61% to 65%, Linux 86% to 85%, ChromeOS 36% to 35%; iOS 1 GiB `maxBufferSize` 81% to 80%; Android 512 MiB binding 50% to 48% and 1 GiB 36% to 35%; Adreno 7xx 6% to 7%; Firefox 128 B attachments 75% to 76%. The one large change is iOS / Safari `maxComputeInvocationsPerWorkgroup`, 512 to 1024.

Render-target cost per sample (spec table [S22 section 26.1.1]): `rgba8unorm` 8 B, `rgba16float` 8 B, `rgba32float` 16 B, `r32float` 4 B, `rg11b10ufloat` 8 B, `rgb10a2unorm` 8 B.

**Conflict on Apple limits (re-read 2026-10-13; narrower than before).** web3dsurvey's iOS and Safari rows show 10 storage buffers (99%) and 8 storage textures (99%), with no higher threshold listed. Its "apple - apple" GPU-architecture rows (same feature profile as iOS) show 44 storage buffers and 44 storage textures on 98% [S4]. That disagreement stands and I cannot reconcile it. The third part of the earlier conflict is gone: on 2026-10-08 the iOS and Safari rows read 512 invocations per workgroup, today they read 1024 (99%), matching the "apple - apple" row (98%) and WebKit trunk source, which sets 1024 [S33]. I cannot tell whether the survey data changed or the earlier read was wrong. Safari 27.0 notes mention "restored `maxStorageBuffersInFragmentStage` and related limits" [S26]. Treat Safari as "default limits plus a little" and request limits only after reading `adapter.limits`.

Newer per-stage limits: `maxStorageBuffersInVertexStage`, `maxStorageBuffersInFragmentStage`, `maxStorageTexturesInVertexStage`, `maxStorageTexturesInFragmentStage` exist in the spec [S22]. Chrome 146, Firefox 151 (partial, reports the per-shader-stage value), Safari 27 [S5: GPUSupportedLimits][S29: 151]. Chrome 146 also lifted `maxStorageBuffersPerShaderStage` up to 16 and `maxSampledTexturesPerShaderStage` up to 48 [S16].

---

## 4. Storage texture formats

Source for this section: WebGPU spec "Plain color formats" table and feature definitions [S22 sections 25.19, 25.20, 26.1.1], WGSL "storage texel formats" [S23]. "WO / RO / RW" = write-only / read-only / read-write access.

### 4.1 What works with no optional feature (core feature level)

| Format | WO | RO | RW | Notes |
|---|---|---|---|---|
| `rgba8unorm` | yes | yes | needs tier2 | Also filterable, blendable, renderable |
| `rgba8snorm` | yes | yes | never | |
| `rgba8uint`, `rgba8sint` | yes | yes | needs tier2 | |
| `rgba16float` | yes | yes | needs tier2 | Filterable, blendable, renderable; multisample needs `core-features-and-limits` |
| `rgba16uint`, `rgba16sint` | yes | yes | needs tier2 | |
| `r32float`, `r32uint`, `r32sint` | yes | yes | **yes** | The only formats with RW in core. `r32float` is unfilterable unless `float32-filterable` |
| `rg32float`, `rg32uint`, `rg32sint` | yes, only with `core-features-and-limits` | same | never | **Not usable in compatibility mode** |
| `rgba32float`, `rgba32uint`, `rgba32sint` | yes | yes | needs tier2 | |
| `bgra8unorm` | needs `bgra8unorm-storage` | no | no | RO was removed in Chrome 143 [S14] |

### 4.2 The ones people ask about

| Format | Core | With `texture-formats-tier1` | With `texture-formats-tier2` |
|---|---|---|---|
| `rgba16float` | WO, RO | same | **adds RW** |
| `r32float` | WO, RO, RW | same | same |
| `rg32float` | WO, RO (not compat) | same | no RW ever |
| `rg16float` | **none** | **adds WO, RO** | no RW |
| `r16float` | **none** | **adds WO, RO** | **adds RW** |

### 4.3 What tier 1 and tier 2 add

- **`texture-formats-tier1`**: enables `rg11b10ufloat-renderable`; adds `r16/rg16/rgba16 unorm and snorm` (render attachment, blendable, multisample, WO and RO storage); render/blend/multisample/resolve for `r8snorm`, `rg8snorm`, `rgba8snorm`; and **WO + RO storage** for `r8*`, `rg8*`, `r16uint/sint/float`, `rg16uint/sint/float`, `rgb10a2uint/unorm`, `rg11b10ufloat`.
- **`texture-formats-tier2`**: implies tier1; adds **RW storage** for `r8unorm/uint/sint`, `rgba8unorm/uint/sint`, `r16uint/sint/float`, `rgba16uint/sint/float`, `rgba32uint/sint/float`.
- WGSL must declare `requires texture_formats_tier1;` to use the tier1 texel formats in `texture_storage_*` types [S23]. RW storage access also relies on the `readonly_and_readwrite_storage_textures` WGSL language feature, shipped in Chrome 124 [S8] and present on 99.0% of survey browsers [S4]. **Conflict** (found 2026-10-13): BCD lists it as unsupported in Firefox and Safari [S5: WGSLLanguageFeatures], but the survey page for the feature reads 99.03% overall, Firefox 100%, Safari 99.83% [S4: wgsl-language-features/readonly_and_readwrite_storage_textures], so BCD is stale. Check `navigator.gpu.wgslLanguageFeatures` at run time anyway.
- Detect with `adapter.features.has('texture-formats-tier1')`. Chrome's 142 post uses both "texture-formats-tier1" and "texture-format-tier1" in different places; the spec name is plural [S13][S22]. `wgslLanguageFeatures` only lists `texture_formats_tier1` from Chrome 153 [S18], so do not feature-detect via WGSL on older Chrome.

### 4.4 Where tiers have shipped

| Engine | tier1 | tier2 |
|---|---|---|
| Chrome / Edge | 142 (Oct 2025) [S13][S5] | 142 [S5] |
| Safari | 26.2 per BCD [S5], but not in WebKit's 26.2 notes [S25]; survey 97.61% of Safari reports [S4] | Partial: survey 32.53% Safari / 35.12% iOS [S4]. Trunk source: ARM64 only [S33] |
| Firefox | Not implemented [S32]; survey 1.26% [S4] | Not implemented; survey 0.34% |
| Survey, Android (read 2026-10-13) | 97.41% | 97.41% |

### 4.5 Compat-mode storage restrictions

`rg32uint/sint/float` cannot be storage textures; vertex stages get 0 storage buffers and 0 storage textures; fragment stages 4 and 4 [S22 limits table][S42].

---

## 5. Related platform APIs

### 5.1 Compatibility mode (`requestAdapter({ featureLevel: "compatibility" })`)

| Engine | Status | Source |
|---|---|---|
| Chrome / Edge | Shipped in **146** (post dated 2026-02-25). BCD marks it "partial": **Android 10+ with OpenGL ES 3.1+** only. Windows (Direct3D 11) and ChromeOS were "being explored" at launch. Origin trial ran Chrome 139-145. Re-checked 2026-10-13: unchanged. BCD still carries the Android-only note; the Chrome 146 post was last updated 2026-02-25 and still describes ChromeOS and Windows Direct3D 11 as being explored; no "What's new" entry from 147-148 through 155-156 mentions compatibility mode [S5: GPU][S16][S21]. Edge 146 lists it under shipped Web APIs with no platform named [S57] | [S16][S5: GPU][S12][S21][S57] |
| Safari | Not supported | [S5: GPU] |
| Firefox | Not supported (the IDL accepts `featureLevel` but BCD says no) | [S5: GPU][S32] |

Rules [S22][S42]:

- If the implementation cannot enforce compat validation it silently returns a **core** adapter. A compat-defaulting adapter does not list `core-features-and-limits`. Request that feature on the device (if the adapter has it) to remove the restrictions.
- Compat default limits: `maxTextureDimension1D/2D` 4096, `maxComputeInvocationsPerWorkgroup` 128, `maxComputeWorkgroupSizeX/Y` 128, `maxColorAttachments` 4, `maxInterStageShaderVariables` 15, `maxUniformBufferBindingSize` 16384, storage buffers/textures in vertex stage 0, in fragment stage 4/4 [S22]. Re-read from the Editor's Draft source on 2026-10-13: all of these match. The same in both columns: `maxTextureDimension3D` 2048, `maxComputeWorkgroupSizeZ` 64, `maxComputeWorkgroupStorageSize` 16384, `maxStorageBuffersPerShaderStage` 8, `maxStorageTexturesPerShaderStage` 4, `maxColorAttachmentBytesPerSample` 32 [S22].
- Other restrictions. Verified against the Editor's Draft source on 2026-10-13 [S22]: one view dimension per texture; no cube-array views; no `sample_mask` or `sample_index` in fragment shaders; equal blend state on all color targets; `rgba16float` and `r32float` not multisampleable; `bgra8unorm-srgb` needs `core-features-and-limits`. Also in the spec and not listed before: `depthBiasClamp` must be 0; `textureLoad` cannot be used on depth textures; a bound texture view must cover all array layers; copies from compressed-format textures are not allowed; all bindings of one texture in a pass must use compatible views. No texture format reinterpretation is in the spec too: a view format that differs from the texture format only by `-srgb` is allowed only with `core-features-and-limits` [S22: texture view format compatible]. The secondary source [S42], re-read the same day, lists the same rules plus interpolation limits (`@interpolate(flat)` must be `flat, either`; no `linear` or `sample` interpolation) and no multisampling of integer formats, which I did not look up individually in the spec.

### 5.2 HTML-in-Canvas (WICG `html-in-canvas`)

**Status: Chromium origin trial / flag only. Not shipped anywhere.**

| Item | Detail | Source |
|---|---|---|
| Chrome | Dev trial behind `chrome://flags/#canvas-draw-element`. **Origin trial** approved for Chrome 148-151 [S38]; the OT post says 148-150 [S35]; the latest update (page last updated 2026-09-29) says the trial is **extended through Chrome 160** [S36]. Tokens must be renewed | [S35][S36][S38] |
| Edge | Own origin trial page; lists the older API names; **trial expiration 2026-10-20**. Re-read 2026-10-13: same expiry date and same older names; the Edge 155 notes (released 2026-10-08) still list HTML in canvas among origin trials | [S39][S57] |
| Safari (WebKit) | "No signal" in the Intent to Experiment (2026-10-08 read; the thread could not be re-read on 2026-10-13, see the header) | [S38] |
| Firefox (Gecko) | "No signal" (an earlier draft said "Negative", corrected) | [S38] |
| Spec | Explainer at WICG; HTML spec PR whatwg/html#11588 | [S37][S38] |

API names changed. **Both name sets exist in the wild**:

| Concept | Chrome 148-154 (OT announcement) | Chrome 155+ (per the OT-changes post) |
|---|---|---|
| Opt-in on canvas | `<canvas layoutsubtree>` | `<canvas content="drawable">`, with `drawable` on descendants |
| 2D draw | `drawElementImage()` (returned a transform) | `drawElementImage()` returns void; hit-test sync is handled by the browser |
| WebGL | `texElementImage2D(target, internalFormat, element)` (arguments trimmed in 150) | `texElementSubImage2D`; storage must be allocated first with `texImage2D` |
| WebGPU | `queue.copyElementImageToTexture(element, { texture })` | `queue.drawElementImageToTexture(...)` with `texture`, `size`, `sourceX/Y/Width/Height` |
| Events | `paint` event (`canvas.onpaint`) | same; `requestPaint()`, `captureElementImage()`, `updateElementGeometry()` also appear |

Sources: [S35][S36] for the 148-154 and 155+ columns; the WICG README [S37] already uses the 155+ names. Chrome 155 became stable on 2026-10-06 [S40], so the renamed API is what OT participants on stable will see. Cross-origin iframe content, visited-link state, and several other items are excluded from painting by design [S37][S35]. Three.js has an experimental `THREE.HTMLTexture` using it [S35].

### 5.3 HDR canvas output (`toneMapping: { mode: "extended" }`)

| Engine | Status | Source |
|---|---|---|
| Chrome / Edge | **129** on ChromeOS, macOS, Windows; Linux (Intel Gen12+) from 144; Android mirrors Chrome. Example uses `format: "rgba16float"` | [S10][S5: GPUCanvasContext] |
| Safari | MDN says no [S5]. WebKit implemented the config under bug 279816 (`toneMapping.mode`). In **Aug 2025** a tester found macOS Safari accepted `extended` in `getConfiguration()` but still **displayed SDR**; iOS Safari with the "WebGPU HDR" flag worked [S28]. **2026 status unverified**: Safari 27 notes add `srgb-linear` and `display-p3-linear` predefined canvas color spaces but say nothing about WebGPU tone mapping [S27][S26]. Re-checked 2026-10-13: still unverified. Technology Preview 253 and 254 say nothing about it [S50]. WebKit trunk exposes `toneMapping` under the plain WebGPU setting and defaults a separate "WebGPU support for HDR" preference to on wherever WebGPU is on by default and the platform has HDR display support (macOS, iOS, visionOS) [S54]; that is trunk source, not evidence of what Safari 27 displays. | [S28][S27][S50][S54] |
| Firefox | Not exposed. `toneMapping` and `colorSpace` are commented out in the IDL (`TODO bug 1834395`). Re-checked 2026-10-13: unchanged; that bug is about accepting `rgba16float` as a canvas format at all and is still NEW (last changed 2026-09-12), so assume no float canvas in Firefox either | [S32][S48] |

Also in Chrome 155-156: canvas contexts can use `srgb-linear` and `display-p3-linear` for wide-gamut HDR rendering; status "intent to ship" linked, not stated as shipped [S19]. Re-checked 2026-10-13: the Edge 155 web platform notes (released 2026-10-08) list both color spaces as usable with the Canvas API, so Chromium 155 shipped them; those notes do not say whether WebGPU canvas configuration is covered [S57].

### 5.4 WebGPU in workers with `OffscreenCanvas`

| Engine | Status | Source |
|---|---|---|
| Chrome / Edge | `navigator.gpu` in dedicated workers and `OffscreenCanvas.getContext('webgpu')` from the first release; service and shared workers from **124**. Re-checked 2026-10-13: unchanged (BCD: 113 desktop, 121 Android, Linux from 144; the "What's new" index still lists service and shared worker support under Chrome 124) | [S5: OffscreenCanvas, WorkerNavigator][S8][S21] |
| Safari | **26** (`WorkerNavigator.gpu` and the OffscreenCanvas WebGPU context). Re-checked 2026-10-13: unchanged | [S5] |
| Firefox | **141**, all contexts **except service workers** (bug 1942431) per BCD and the 141 notes. **Conflict** found 2026-10-13: that bug ("Remove Nightly gate on WebGPU in service workers") is RESOLVED FIXED with target milestone 148, and current source defaults `dom.webgpu.service-workers.enabled` to on wherever WebGPU itself is on (Windows, Apple Silicon macOS). So service workers have probably worked since Firefox 148; BCD is stale and the MDN 148 notes do not mention it. Not tested in a release build. BCD's note on the OffscreenCanvas WebGPU context also still says Windows only, which predates the macOS releases | [S5][S29: 141][S48][S58] |

`OffscreenCanvas` itself: Chrome 69, Firefox 105, Safari 16.4 [S5]. Per-engine perf behavior is unmeasured (story 12.7).

### 5.5 `GPUAdapterInfo`

| Topic | Finding | Source |
|---|---|---|
| Availability | `adapter.info` (sync) since Chrome **127**; `device.adapterInfo` since **132**; `requestAdapterInfo()` removed in **131**. Firefox 141 and Safari 26 have `info`. `isFallbackAdapter` moved here in 136 (Chrome); `powerPreference` added in 137. Re-checked 2026-10-13 against BCD: all of the versions above match, and the old `GPUAdapter.isFallbackAdapter` was removed in Chrome 140. In current Chromium IDL `powerPreference` is gated behind WebGPU Developer Features, like `driver`, `backend`, `type`, `memoryHeaps`, `d3dShaderModel` and `vkDriverVersion`, so it is not visible to ordinary pages [S34] | [S9][S11][S5: GPUAdapterInfo, GPUAdapter, GPUDevice][S34] |
| Spec rule | Every field may be an empty string; "applications must be able to handle any possible `GPUAdapterInfo` values, including the absence of those values" | [S22 section 3.6.2.4] |
| Chrome (stable) | Without the "WebGPU Developer Features" flag the object has only `vendor`, `architecture`, `subgroupMinSize/MaxSize`, `isFallbackAdapter`. **`device` and `description` are empty strings**, populated only with the developer flag. Architecture is reported for recent GPUs (e.g. `blackwell`, `rdna4`, `valhall`). Re-checked 2026-10-13 in the canonical Chromium repository (main): unchanged. Without the flag the constructor is passed only `vendor`, `architecture`, the two subgroup sizes and the fallback bit | [S34][S9][S11] |
| Survey view | Vendor and architecture are populated for the large majority of reports. Vendor shares read on 2026-10-13: intel 33.9%, apple 31.9%, nvidia 14.87%, amd 8.88%, arm 5.84%, qualcomm 4.45% (99.84% together) | [S4] |
| Safari | **Unverified for release builds.** WebKit trunk derives vendor, architecture, device and description from the first word of the Metal device name, so they are likely all the same token (for example `apple`). Re-read 2026-10-13: unchanged; the same file also returns `isFallbackAdapter` = false unconditionally. Release builds were not tested (no Safari available to this check) | [S33: GPUAdapterInfo.h] (trunk, not a shipped guarantee) |
| Firefox | Source read on 2026-10-13 (mozilla-central tip): `vendor`, `architecture`, `device` and `description` all return an empty string; `isFallbackAdapter` is true for a CPU device type and forced false when resisting fingerprinting; the real adapter name, vendor id, driver and backend are exposed only through non-standard, privileged getters. **Unverified for release builds** (not tested), but this code has no release-channel switch | [S58: Adapter.h, Adapter.cpp] |
| Privacy | MDN: the information shared is kept to a minimum and different vendors share different types and granularities (fingerprinting risk) | [S43] |
| Unmasking | An old design doc by Toji proposed a permission-gated `requestUnmaskedAdapterInfo()`. It does not appear anywhere in the current spec text, so assume it does not exist | [S46][S22] |

---

## 6. Design implications for this project

1. **Treat spec defaults as the contract for Tier A and B.** Effects that need no `requiredLimits` work on every WebGPU device: 8 storage buffers and 4 storage textures per stage, 16 KiB workgroup memory, 256 invocations per workgroup, 128 MiB storage binding, 256 MiB buffers, 32 B per sample across color attachments, 8192 textures. Request more only per effect, only after reading `adapter.limits`, and record it in the scorecard (story 2.6). Devices get defaults even if the adapter supports more [S22].
2. **Workgroups: 256 invocations (16x16 or 64x4), 16 KiB shared memory.** Mali Bifrost is 256-only, Safari/iOS read 512 on 2026-10-08 and 1024 on 2026-10-13 (section 3), Samsung Internet (65%) and ChromeOS (35%) often lack 1024, and 31% of Adreno 6xx stay at 16 KiB shared memory [S4]. Never default to 1024 or 32 KiB.
3. **Simulation state formats.** Use `rgba16float` (renderable, filterable, blendable, WO/RO storage in core) for velocity/density/temperature state, and `r32float` or `r32uint` where RW storage is needed. Avoid `rg32float`, `r16float` and `rg16float` as storage textures (`rg32float` is not allowed in compat; `r16float`/`rg16float` need tier1). Do **not** assume `texture-formats-tier2` RW on `rgba16float`: Firefox lacks it and Safari has about a third. Default to ping-pong with a sampled read texture and a write-only storage target, which works everywhere [S22].
4. **Float32 textures are not linearly filterable by default.** `float32-filterable` is missing on 45% of iOS and 43% of Safari reports, 90% of Adreno 6xx and about half of Adreno 7xx [S4]. Sample `r32float` with `textureLoad` and bilinear in the shader, or avoid float32 render targets. `float32-blendable` is missing on Mali and on Firefox before 158 (158 shipped 2026-10-13, so older Firefox will be in the field for weeks), so no additive blending into `rgba32float` [S4][S5][S29: 158].
5. **Optional features are enhancements with a fallback, never requirements.** `timestamp-query` powers the HUD only (100 microsecond quantization in Chrome [S7], so average over frames) with a rAF/CPU-time fallback; `shader-f16` needs two shader variants chosen at pipeline-creation time; do not use `subgroups` (Safari and Firefox lack it), `dual-source-blending` or `clip-distances` (absent on Mali; dual-source absent on Safari) in any Tier A effect; ship textures as KTX2/Basis and transcode to whichever of ASTC, ETC2 or BC is exposed, else `rgba8unorm` [S4].
6. **Compatibility mode widens Android reach for fragment-only Tier A effects.** Write Tier A effects within compat limits (no storage resources in vertex stages, no `rg32*` storage, 4096 textures, 128 invocations, same blend on all targets, no cube arrays), request `featureLevel: "compatibility"` first on Chrome 146+, then check for `core-features-and-limits` to upgrade. Safari and Firefox return core adapters anyway; compute-based Tier B and C require a core adapter [S16][S22][S42].
7. **Plan for roughly 15-17% of visitors with no adapter.** Linux (about 18% have WebGPU), Firefox on Linux, Android and Intel Macs, Safari or macOS older than 26, and blocklisted GPUs are all "no". `navigator.gpu` being defined is not enough: null-check `requestAdapter()`, treat `info.isFallbackAdapter` as no-WebGPU for Tier B and C (it is always false in Safari per trunk source, so it only helps in Chromium and Firefox [S33][S34][S58]), and keep the poster/video path first-class (story 12.5, the fallback ladder) [S1][S4][S20].
8. **Backdrop capture (story 9.1): HTML-in-Canvas is Chrome-only and unstable.** It is an origin trial with different API names before and after Chrome 155, extended to Chrome 160; Safari and Firefox have no signal. Use it only as progressive enhancement, feature-detect both name sets, and make image/video/`createImageBitmap` the baseline (`copyExternalImageToTexture` with HTMLImageElement/ImageData sources is unsupported in Safari and Firefox per BCD; use ImageBitmap) [S36][S38][S5: GPUQueue].
9. **HDR (story 1.6, the HDR tail): render into an offscreen `rgba16float` chain and tone-map to an SDR canvas by default.** `toneMapping: { mode: "extended" }` is Chrome-only in practice; Firefox does not expose the option and has no `rgba16float` canvas; Safari echoes `extended` from `getConfiguration()` without necessarily displaying HDR (macOS, Aug 2025 report; still unverified on 2026-10-13). Gate HDR behind an explicit opt-in and a real-device check. Details in 0.3 [S10][S28][S32][S48].
10. **Defensive plumbing.** Never branch on `adapterInfo.device/description` (empty in stable Chrome) or on `vendor/architecture` (empty in Firefox per source [S58]); use `adapter.limits/features` snapshots for the scorecard instead. Always pass `GPUTextureView`s to render-pass attachments (Safari 26.2 and 27 only recently fixed passing a bare `GPUTexture` as depth-stencil or resolve attachment). Wire `device.lost` and `uncapturederror` and test Safari below 27, where the `onuncapturederror` handler attribute was broken [S25][S26][S27][S34].
11. **Fire-specific (added 2026-10-13, details in section 0).** Never present colour greater than alpha on a `premultiplied` canvas: the result is undefined by the spec and unverified per browser, so overlay effects use the `luminance` alpha mode or an opaque canvas (0.2). Volumes ping-pong two `rgba16float` 3D textures with a sampled read and a write-only storage write; do not depend on `depthSlice` rendering or read-write storage outside Chrome (0.4). Smoke (story 3.10) uses premultiplied "over" for grey absorption plus emission; `dual-source-blending` is an optional upgrade that Safari can never take (0.6). Safari Technology Preview 254 fixed a case where a fragment shader using `discard` before a loop wrote NaN to the render target on some Apple silicon GPUs [S50]; whether Safari 27 release has the bug is unverified, but NaN in an HDR target spreads through bloom, so keep `discard` out of loop-heavy fire shaders or clamp before the bloom chain.

---

## 7. Unverified items and source conflicts

Unverified:

- Edge-specific platform rollout (Linux, Android) and any Edge-specific blocklist. Looked for again on 2026-10-13 and still unverified: BCD only mirrors Chrome, Microsoft's Edge 144 and 147 web platform notes omit Chrome's Linux rollout items, and no Microsoft page found states GPU coverage for Linux or Android [S5][S57]. What is confirmed: Edge 155 stable builds exist for Windows, Linux, Android and iOS [S56].
- GPU/OS blocklists for Safari and Firefox.
- Which `GPUAdapterInfo` fields Safari and Firefox populate in release builds. Narrowed on 2026-10-13: both engines' source is now read (Safari: one vendor token in all four fields; Firefox: four empty strings) [S33][S58]; what stays unverified is only that release builds behave like source, because no release browser was run.
- Whether Chrome, Edge or Firefox on iOS inherit Safari's WebGPU status. Still not established: no primary source was found on 2026-10-13, and it needs a device test.
- Safari WebGPU HDR display behavior in 2026 (latest evidence is Aug 2025). Still unverified on 2026-10-13 after reading every written source available: Apple's Safari 27 and 27.2 beta release notes, WebKit's 27.0 post and Technology Preview 253-254 notes say nothing about WebGPU `toneMapping` or HDR canvas [S55][S26][S50]; trunk source defaults the HDR preference on [S54]. Only a test on an HDR display can settle it.
- The end date of the Chrome HTML-in-Canvas origin trial beyond "through Chrome 160".
- Safari 27.0 exact public release date: now a conflict rather than unknown (see the table below).
- When Firefox adds `timestamp-query` etc. to its documented feature list (it already works in survey data; the source tree shows them implemented, but only `dual-source-blending` 155, `float32-blendable` 158, `clip-distances` 158 on macOS and the per-stage limits 151 have release-note citations). When `clip-distances` reaches Firefox on Windows is unverified.

Added 2026-10-13 (section 0):

- What Chrome, Safari and Firefox each actually display for a `premultiplied` canvas whose colour exceeds alpha. The spec says undefined; no primary per-browser source was found.
- Whether an `rgba16float` + `extended` canvas with `alphaMode: 'premultiplied'` behaves sensibly in any browser.
- Whether Firefox rejects `rgba16float` as a canvas format (inferred from the title of the open bug 1834395, not tested).
- Whether `depthSlice` (rendering to a 3D texture slice) works in Safari 27 and Firefox 158 release builds.
- Whether Safari 27 release has the `discard`-before-loop NaN bug that Technology Preview 254 fixed.
- The rendering cost of CSS `mix-blend-mode: plus-lighter`, and how it behaves over an HDR (`extended`) canvas. Browser support itself is now confirmed (0.2) [S5: css/properties/mix-blend-mode].
- Per-browser conformance for the core `rgba16float` capabilities (render, blend, filter); taken from the spec table, not tested.
- Why the earlier snapshot expected Firefox 158 on 2026-10-09 (a slip or a misread; it shipped 2026-10-13).
- Whether Firefox release builds really expose WebGPU in service workers since 148 (bug status and pref default say yes, BCD says no; not tested).
- Whether the 2026-10-08 read of 512 invocations for iOS / Safari was a survey change or a misread (section 3).
- Which of Firefox's two prefs an Android user actually has to flip.
- The compat-mode interpolation rules and the integer-format multisampling rule: listed by the secondary source [S42], not looked up individually in the spec.

Conflicts:

| Topic | Source A | Source B |
|---|---|---|
| Samsung Internet first version | caniuse: 24 [S2] | Chromium mapping: 25 [S45][S7] |
| Firefox Android enable pref | caniuse: `dom.webgpu.enabled` [S2] | gpuweb wiki: `gfx.webgpu.ignore-blocklist` in Beta/Nightly [S3]. Source on 2026-10-13: both prefs exist and do different jobs [S58] |
| Firefox Linux | gpuweb wiki: Nightly only [S3] | GitHub issue: Firefox 152 release works behind `dom.webgpu.enabled` [S31] |
| Firefox optional features | MDN BCD: most "no" [S5] | Firefox source and survey: implemented [S32][S4] |
| Safari `float32-filterable` | MDN BCD: no [S5] | Survey: 55-57% [S4]; trunk source: per-device [S33] |
| Safari `clip-distances` | MDN BCD: no [S5] | WebKit 27.0 notes: supported [S26] |
| Safari `texture-formats-tier1` | MDN BCD: 26.2 [S5] | WebKit's 26.2 notes: not mentioned [S25] |
| Safari limits | Survey iOS/Safari rows: 10 / 8 / 1024 on 2026-10-13 (10 / 8 / 512 on 2026-10-08) | Survey "apple - apple" rows: 44 / 44 / 1024 [S4] |
| caniuse global share | live page 85.8% + 2.02% [S1] | JSON on 2026-10-13: 85.8% + 3.66% (85.72% + 3.05% on 2026-10-08) [S2] |
| Linux NVIDIA requirement | Wiki: driver 535.183.01+ on Wayland [S3] | Chrome post: "drivers from 2024-05" on Wayland [S17] |
| Android GPU vendors | Chrome 121 post: Qualcomm and ARM [S7] | Wiki: ARM, Qualcomm and Intel [S3] |
| HTML-in-Canvas names | OT post, Edge OT page, Intent to Experiment: `layoutsubtree`, `copyElementImageToTexture` [S35][S38][S39] | WICG README and Chrome 155 changes: `content="drawable"`, `drawElementImageToTexture` [S36][S37] |
| HTML-in-Canvas OT window | Intent: Chrome 148-151 [S38]; OT post: 148-150 [S35] | Update post: through Chrome 160 [S36] |
| Chrome 142 post feature name | Prose: `texture-formats-tier1` | Code sample: `texture-format-tier1` [S13] (spec uses plural [S22]) |
| Safari 27 release date (added 2026-10-13) | MDN BCD browser table: 2026-09-14 [S49] | WebKit "features" post: published 2026-09-17 [S26] |
| Next Firefox release date (added 2026-10-13) | Mozilla product-details: 2026-10-23 [S41] | MDN Firefox 159 page: 2026-10-27 [S29: 159] |
| `depthSlice` in Safari and Firefox (added 2026-10-13) | MDN BCD: not supported [S5: GPUCommandEncoder] | Both engines' current IDL has the member [S32][S54] |
| `readonly_and_readwrite_storage_textures` in Safari and Firefox (added 2026-10-13) | MDN BCD: not supported [S5: WGSLLanguageFeatures] | Survey page for the feature: Firefox 100%, Safari 99.83% [S4]. Treat BCD as stale |
| Firefox WebGPU in service workers (added 2026-10-13) | MDN BCD and the 141 notes: not supported [S5][S29: 141] | Bugzilla 1942431 fixed in 148; pref defaults on in source [S48][S58] |
| Edge latest version (added 2026-10-13) | caniuse live page: 154 [S1] | BCD and Microsoft's update service: 155, released 2026-10-08 [S5][S56] |

---

## Sources

Checked 2026-10-08 unless noted. Re-fetched on 2026-10-13: [S1], [S2], [S3], [S4] (overview, all 16 feature pages in 2.2 plus `float16-renderable` and `float32-renderable`, the nine limit pages in section 3 plus `maxComputeWorkgroupSizeX`, and one WGSL language feature page), [S5] (`GPU.json`, `GPUSupportedFeatures.json`, `GPUCanvasContext.json`, `GPUAdapterInfo.json`, `GPUAdapter.json`, `GPUDevice.json`, `OffscreenCanvas.json`, `WorkerNavigator.json`, plus `GPUCommandEncoder.json`, `WGSLLanguageFeatures.json`, `css/properties/mix-blend-mode.json` and the `browsers/` tables for the first time), [S10], [S16], [S19], [S21], [S22], [S26], [S28], [S29: 148, 158, 159], [S32], [S33], [S34], [S36], [S39], [S40], [S41], [S45]. [S47]-[S58] are new on 2026-10-13. The older sources were also re-fetched on 2026-10-13 and their cited claims found still present: [S6]-[S9], [S11]-[S15], [S17], [S18], [S20], [S23]-[S25], [S27], [S30], [S31] (issue still open, no comments, last updated 2026-09-15), [S35], [S37], [S42]-[S44], [S46]. None of the Chrome posts shows a "last updated" date after 2026-10-08. The one exception is [S38]: the Google Groups thread is script-rendered and only its title could be read on 2026-10-13, so the "no signal" quotations attributed to it rest on the 2026-10-08 read.

- [S1] caniuse WebGPU: https://caniuse.com/webgpu
- [S2] caniuse data: https://github.com/Fyrd/caniuse/blob/main/features-json/webgpu.json
- [S3] gpuweb wiki, Implementation Status (page shows "edited Oct 2, 2026"): https://github.com/gpuweb/gpuweb/wiki/Implementation-Status
- [S4] web3dsurvey. Overview: https://web3dsurvey.com/webgpu. Feature pages: `https://web3dsurvey.com/webgpu/features/<name>`. Limit pages: `https://web3dsurvey.com/webgpu/limits/<name>`. WGSL language feature pages: `https://web3dsurvey.com/webgpu/wgsl-language-features/<name>`.
- [S5] MDN browser-compat-data (`api/GPU.json`, `GPUSupportedFeatures.json`, `GPUSupportedLimits.json`, `GPUAdapterInfo.json`, `GPUCanvasContext.json`, `GPUCommandEncoder.json`, `GPUDevice.json`, `GPUQueue.json`, `OffscreenCanvas.json`, `WGSLLanguageFeatures.json`, `WorkerNavigator.json`, `GPUAdapter.json`): https://github.com/mdn/browser-compat-data/tree/main/api ; also `css/properties/mix-blend-mode.json` and `browsers/edge.json`, `browsers/chrome.json` in the same repository
- [S6] Chrome 113 release: https://developer.chrome.com/blog/webgpu-release
- [S7] What's New in WebGPU, Chrome 121: https://developer.chrome.com/blog/new-in-webgpu-121
- [S8] Chrome 124: https://developer.chrome.com/blog/new-in-webgpu-124
- [S9] Chrome 127: https://developer.chrome.com/blog/new-in-webgpu-127
- [S10] Chrome 129: https://developer.chrome.com/blog/new-in-webgpu-129
- [S11] Chrome 138: https://developer.chrome.com/blog/new-in-webgpu-138
- [S12] Chrome 139: https://developer.chrome.com/blog/new-in-webgpu-139
- [S13] Chrome 142: https://developer.chrome.com/blog/new-in-webgpu-142
- [S14] Chrome 143: https://developer.chrome.com/blog/new-in-webgpu-143
- [S15] Chrome 144: https://developer.chrome.com/blog/new-in-webgpu-144
- [S16] Chrome 146: https://developer.chrome.com/blog/new-in-webgpu-146
- [S17] Chrome 147-148: https://developer.chrome.com/blog/new-in-webgpu-147-148
- [S18] Chrome 153-154: https://developer.chrome.com/blog/new-in-webgpu-153-154
- [S19] Chrome 155-156 (page last updated 2026-10-07): https://developer.chrome.com/blog/new-in-webgpu-155-156
- [S20] Chrome WebGPU troubleshooting: https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips
- [S21] "What's New in WebGPU" index (titles by version, used for 128-134 items): https://developer.chrome.com/docs/web-platform/webgpu/news
- [S22] WebGPU spec, Editor's Draft: https://gpuweb.github.io/gpuweb/ ; W3C Candidate Recommendation Draft 2026-09-15: https://www.w3.org/TR/webgpu/
- [S23] WGSL spec: https://gpuweb.github.io/gpuweb/wgsl/
- [S24] WebKit features in Safari 26.0: https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
- [S25] WebKit features for Safari 26.2 (2025-12-12): https://webkit.org/blog/17640/webkit-features-for-safari-26-2/
- [S26] WebKit features for Safari 27.0 (2026-09-17): https://webkit.org/blog/18325/webkit-features-for-safari-27-0/
- [S27] News from WWDC26, WebKit in Safari 27 beta: https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/
- [S28] WebKit bug 272702 (toneMapping): https://bugs.webkit.org/show_bug.cgi?id=272702
- [S29] Firefox release notes for developers: https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/141 (and `/147`, `/151`, `/155`, `/157`; `/158` and `/159` read 2026-10-13). User-facing 158 notes, also read 2026-10-13: https://www.firefox.com/en-US/firefox/158.0/releasenotes/
- [S30] Mozilla GFX blog, "Shipping WebGPU on Windows in Firefox 141": https://mozillagfx.wordpress.com/2025/07/15/shipping-webgpu-on-windows-in-firefox-141/
- [S31] gpuweb issue 6331 (Firefox 152 on Linux): https://github.com/gpuweb/gpuweb/issues/6331
- [S32] Firefox source (main): https://github.com/mozilla-firefox/firefox/blob/main/dom/webgpu/Adapter.cpp and https://github.com/mozilla-firefox/firefox/blob/main/dom/webidl/WebGPU.webidl
- [S33] WebKit source (trunk, not a release guarantee): https://github.com/WebKit/WebKit/blob/main/Source/WebGPU/WebGPU/HardwareCapabilities.mm and https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/WebGPU/GPUAdapterInfo.h
- [S34] Chromium source (main): https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/webgpu/gpu_adapter.cc ; on 2026-10-13 read from the canonical repository, with `gpu_adapter_info.cc` and `gpu_adapter_info.idl` beside it: https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webgpu/
- [S35] HTML-in-Canvas origin trial post (page last updated 2026-05-19): https://developer.chrome.com/blog/html-in-canvas-origin-trial
- [S36] HTML-in-Canvas updates (page last updated 2026-09-29): https://developer.chrome.com/blog/html-in-canvas-ot-changes
- [S37] WICG html-in-canvas: https://github.com/WICG/html-in-canvas
- [S38] Intent to Experiment: HTML-in-canvas (2026-04-09): https://groups.google.com/a/chromium.org/g/blink-dev/c/t_nGEmJ_v4s
- [S39] Edge origin trial page: https://developer.microsoft.com/en-us/microsoft-edge/origin-trials/trials/a297467e-0030-4c4c-8739-48e130026c03
- [S40] Chromium milestone schedule: https://chromiumdash.appspot.com/fetch_milestone_schedule?mstone=155 and MDN BCD `browsers/chrome.json`
- [S41] Mozilla product details: https://product-details.mozilla.org/1.0/firefox_versions.json
- [S42] WebGPU Fundamentals, compatibility mode (secondary): https://webgpufundamentals.org/webgpu/lessons/webgpu-compatibility-mode.html
- [S43] MDN GPUAdapterInfo: https://developer.mozilla.org/en-US/docs/Web/API/GPUAdapterInfo
- [S44] Chrome WebGPU overview: https://developer.chrome.com/docs/web-platform/webgpu/overview
- [S45] MDN BCD Samsung Internet release table: https://github.com/mdn/browser-compat-data/blob/main/browsers/samsunginternet_android.json
- [S46] Toji's early adapter-info design doc (old; points readers to the spec): https://hackmd.io/@Toji/S1rvjZD6t
- [S47] Chrome version history API, Windows stable channel (2026-10-13): https://versionhistory.googleapis.com/v1/chrome/platforms/win/channels/stable/versions/all/releases?filter=endtime=none&order_by=version%20desc
- [S48] Mozilla Bugzilla (status read 2026-10-13 through the REST API): 1942431 "Remove Nightly gate on WebGPU in service workers" https://bugzilla.mozilla.org/show_bug.cgi?id=1942431 ; 2006676 "[meta] Release WebGPU on Linux" https://bugzilla.mozilla.org/show_bug.cgi?id=2006676 ; 2004105 "Enable WebGPU on Intel Macs" https://bugzilla.mozilla.org/show_bug.cgi?id=2004105 ; 1834395 (`rgba16float` in `GPUCanvasConfiguration`) https://bugzilla.mozilla.org/show_bug.cgi?id=1834395 ; 1955417 (`subgroups`) https://bugzilla.mozilla.org/show_bug.cgi?id=1955417
- [S49] MDN BCD Safari release table: https://github.com/mdn/browser-compat-data/blob/main/browsers/safari.json
- [S50] Safari Technology Preview release notes: 253 (2026-09-23) https://webkit.org/blog/18357/release-notes-for-safari-technology-preview-253/ ; 254 (2026-10-08) https://webkit.org/blog/18420/release-notes-for-safari-technology-preview-254/
- [S51] gpuweb PR 4476, "Clarify behavior of out-of-gamut canvas" (merged 2024-04-12): https://github.com/gpuweb/gpuweb/pull/4476 ; PR 4526, "Allow out-of-standard-gamut colors with float canvases" (open draft): https://github.com/gpuweb/gpuweb/pull/4526
- [S52] WebGPU Fundamentals, transparency and blending (secondary): https://webgpufundamentals.org/webgpu/lessons/webgpu-transparency.html
- [S53] What's New in WebGPU, Chrome 125 (render to slice of 3D texture): https://developer.chrome.com/blog/new-in-webgpu-125
- [S54] WebKit source (trunk, not a release guarantee): `GPUCanvasConfiguration.idl`, `GPUCanvasToneMapping.idl`, `GPURenderPassColorAttachment.idl` under https://github.com/WebKit/WebKit/tree/main/Source/WebCore/Modules/WebGPU ; preference defaults in https://github.com/WebKit/WebKit/blob/main/Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml (`WebGPUHDREnabled`) and https://github.com/WebKit/WebKit/blob/main/Source/WTF/wtf/PlatformHave.h (`HAVE_SUPPORT_HDR_DISPLAY`)
- [S55] Apple Safari release notes: index https://developer.apple.com/documentation/safari-release-notes ; Safari 27 https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes ; Safari 27.2 beta https://developer.apple.com/documentation/safari-release-notes/safari-27_2-release-notes (the pages are script-rendered; the full text was read on 2026-10-13 from the JSON the pages load, under `https://developer.apple.com/tutorials/data/documentation/safari-release-notes/`)
- [S56] Microsoft Edge update service, current builds per channel and platform (2026-10-13): https://edgeupdates.microsoft.com/api/products
- [S57] Microsoft Edge web platform release notes: https://learn.microsoft.com/en-us/microsoft-edge/web-platform/release-notes/144 (and `/146`, `/147`, `/148`, `/155`)
- [S58] Firefox source, mozilla-central tip (2026-10-13): pref defaults in https://hg.mozilla.org/mozilla-central/raw-file/tip/modules/libpref/init/StaticPrefList.yaml (`dom.webgpu.enabled`, `dom.webgpu.service-workers.enabled`, `gfx.webgpu.ignore-blocklist`); https://hg.mozilla.org/mozilla-central/raw-file/tip/dom/webgpu/Adapter.h ; https://hg.mozilla.org/mozilla-central/raw-file/tip/dom/webgpu/Adapter.cpp ; https://hg.mozilla.org/mozilla-central/raw-file/tip/dom/webgpu/Instance.cpp

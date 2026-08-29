# Diff renderer benchmark

Run: 2026-08-29. Machine-readable results: [diff-renderers-results.json](diff-renderers-results.json).

## Environment and command

- Linux 6.8.0-124-generic, Intel Core i9-14900K, 24 logical CPUs, 31.3 GiB RAM
- Google Chrome 145.0.7632.75, headless, controlled locally over CDP
- Bun 1.3.9; benchmark task working tree based on `80b9f6543670ae8309988a630d1d815c5ff6d8c8` (`gitDirty: true` in the JSON because the harness/instrumentation were the changes under test)
- Desktop viewport: 1440×1000 at DPR 1
- Mobile-sized viewport: 390×844 at DPR 3 with Chromium mobile emulation
- Normal CPU and CDP `Emulation.setCPUThrottlingRate({ rate: 4 })` profiles at both viewport sizes

```sh
bun scripts/diff-renderer-benchmark.ts \
  --repetitions=5 \
  --idle-ms=2000 \
  --output=docs/benchmarks/diff-renderers-results.json
```

The script creates isolated Git repositories and a temporary Reins database, builds a development frontend, starts Reins and headless Chrome, runs every combination, and removes the temporary browser state on the next run. Use `--no-build` only when the development bundle is already current. Dimension filters such as `--renderers=classic,virtualized`, `--fixtures=small`, and `--profiles=desktop-normal` support smoke runs.

## Fixtures

All renderers receive the same Git diff for each fixture.

| Fixture | Contents |
|---|---|
| Small | 5 files; modification, addition, deletion, rename, and Markdown modification |
| Many files | 300 small files; 280 modifications, 10 additions, and 10 deletions |
| Large file | One 25,000-line file with 250 separated changed regions |

The payload sizes below confirm the renderer input difference, not different source changes: on desktop-normal the many-file classic JSON response decoded to 226.1 KiB, while the identical raw patch used by CodeView and Virtualized decoded to 106.7 KiB. The large-file values were 176.9 KiB and 66.7 KiB respectively.

## Methodology

Each scenario has one cold observation after clearing Chromium's browser cache and four warm observations in fresh pages with the cache retained. Tables report the warm median and range for first-visible latency; other range tables include all five observations. “Cold” only means Chromium's HTTP cache was cleared. It does not clear OS filesystem caches or Git/backend process effects.

Timing begins at `Page.navigate`. The harness waits for the routed project, selects Changes, and waits for an intersecting file/diff row. On mobile-sized runs, all panes are mounted; if the classic payload is still idle after project routing, the harness invokes the same `DiffStore.fetchFullDiff()` entry point that selecting a desktop pane invokes.

Development-only `performance.measure` entries record payload decoding, parsing, and the first Lit/renderer setup update for each payload version. Production builds compile this path to inert checks. CDP records diff API duration, transfer and decoded body bytes, heap usage, and trace events. DOM totals recursively include open shadow roots. Mounted wrapper counts use `diff-file-card`, `review-file-diff`, and visible Pierre file containers respectively.

After first visible, the harness records a 2-second no-input interval. It then performs a deterministic 120-frame top-to-bottom-to-top scroll and reports frame-delay proxies. For Virtualized, it activates the first available context control and waits for the wrapper height to change and remain stable for eight frames.

## Results

### Navigation to first visible diff

Warm median milliseconds, with warm range in brackets:

| Profile | Fixture | Classic | CodeView | Virtualized |
|---|---|---:|---:|---:|
| Desktop normal | Small | 125.7 [122.2–129.3] | 247.7 [239.8–253.0] | 131.1 [115.2–136.9] |
| Desktop normal | Many files | 364.4 [361.8–364.8] | 315.8 [301.1–325.9] | **170.9 [166.3–189.9]** |
| Desktop normal | Large file | 230.3 [224.2–236.3] | 273.1 [235.6–285.8] | **133.4 [131.2–149.5]** |
| Desktop 4× CPU | Small | 384.6 [374.1–399.0] | 690.5 [677.3–799.0] | 394.3 [383.6–401.8] |
| Desktop 4× CPU | Many files | 1446.0 [1443.2–1449.1] | 966.0 [952.5–976.8] | **598.5 [579.7–603.3]** |
| Desktop 4× CPU | Large file | 842.8 [835.6–847.5] | 674.9 [657.1–713.0] | **393.0 [385.2–400.6]** |
| Mobile normal | Small | 136.3 [129.3–142.5] | 236.1 [230.2–239.6] | **113.6 [111.7–117.4]** |
| Mobile normal | Many files | 367.8 [358.7–370.9] | 310.3 [306.7–324.0] | **162.7 [158.9–168.4]** |
| Mobile normal | Large file | 230.6 [230.4–233.8] | 248.9 [239.1–268.4] | **111.0 [108.7–119.5]** |
| Mobile 4× CPU | Small | **367.3 [364.1–379.5]** | 668.0 [660.6–675.3] | 377.6 [371.6–394.2] |
| Mobile 4× CPU | Many files | 1368.6 [1358.8–1387.2] | 925.9 [883.6–942.4] | **559.0 [555.9–563.7]** |
| Mobile 4× CPU | Large file | 795.8 [769.0–802.2] | 656.5 [639.5–662.4] | **382.3 [372.7–397.7]** |

Cold first-visible observations were close to the warm ranges in most scenarios. Exact cold values remain separate in the JSON rather than being folded into warm medians.

### Load composition, DOM, and memory

Desktop-normal medians across all five observations:

| Fixture / renderer | API ms | Parse ms | Setup render ms | Mounted wrappers | DOM nodes | Heap growth MiB | Load long tasks |
|---|---:|---:|---:|---:|---:|---:|---:|
| Small / Classic | 6.3 | 5.2 | 0.2 | 5 | 733 | 3.6 | 0 |
| Small / CodeView | 5.5 | 1.0 | 4.0 | 3 | 991 | 10.3 | 0 |
| Small / Virtualized | 6.3 | 1.1 | 1.2 | 3 | 543 | 5.6 | 0 |
| Many / Classic | 16.5 | 16.8 | 1.4 | 300 | 20,702 | 10.3 | 1 |
| Many / CodeView | 13.8 | 5.6 | 11.1 | 5 | 3,631 | 12.0 | 0 |
| Many / Virtualized | 13.1 | 6.6 | 1.2 | 6 | 3,412 | 8.1 | 0 |
| Large / Classic | 12.5 | 9.2 | 0.2 | 1 | 8,298 | 6.6 | 1 |
| Large / CodeView | 14.0 | 3.0 | 6.5 | 1 | 609 | 9.2 | 0 |
| Large / Virtualized | 10.0 | 3.9 | 1.2 | 1 | 359 | 5.2 | 0 |

Representative all-run ranges:

- Many-file API: Classic 16.5 ms [14.8–23.7], CodeView 13.8 [12.9–14.3], Virtualized 13.1 [12.8–13.9].
- Many-file parse: Classic 16.8 ms [15.2–17.0], CodeView 5.6 [3.9–5.8], Virtualized 6.6 [6.5–7.6].
- Many-file heap growth: Classic 10.3 MiB [10.2–10.3], CodeView 12.0 [11.7–12.1], Virtualized 8.1 [7.6–8.5].
- Large-file heap growth: Classic 6.6 MiB [6.5–8.6], CodeView 9.2 [9.2–9.3], Virtualized 5.2 [4.5–8.3].

The trace also records script, layout, and paint summaries per run. For desktop-normal many-file load, median script/layout/paint milliseconds were Classic 29.3/121.1/43.6, CodeView 27.8/41.1/30.2, and Virtualized 11.7/31.5/15.5. These categories can overlap and must not be added as an exclusive CPU total.

### Controlled scroll, context expansion, and idle work

The controlled scroll is intentionally harsher than ordinary wheel scrolling: it changes the target substantially on every animation frame. Desktop-normal many-file median p95 frame delays were 16.8 ms for Classic, 16.8 ms for CodeView, and 33.4 ms for Virtualized. Under desktop 4× CPU throttling they were 83.4, 83.4, and 200.0 ms, with median >50 ms frame counts of 61, 110, and 91 out of 120. This is a jank proxy, not FPS or a touch-scroll measurement.

Virtualized context interaction-to-stable-layout results:

| Fixture | Desktop normal | Desktop 4× CPU | Mobile normal | Mobile 4× CPU |
|---|---:|---:|---:|---:|
| Small | 152.6 [142.7–154.3] | 144.6 [142.9–158.1] | 143.5 median | 145.6 median |
| Many files | 151.3 [145.5–157.1] | 186.9 [181.4–195.9] | 148.9 median | 214.6 median |
| Large file | 341.9 [324.3–350.5] | 909.8 [894.3–913.2] | 322.0 median | 926.8 median |

The no-input interval starts immediately after first visible, so it deliberately captures deferred initial work. Desktop-normal large-file median main-thread task time during those 2 seconds was 3.3 ms Classic, 3.1 ms CodeView, and 153.0 ms Virtualized; under desktop 4× CPU it was 2.7, 3.1, and 977.8 ms. This indicates that Virtualized reaches first-visible earlier while substantial large-file work can continue afterward. It is not an energy or battery measurement.

## Conclusions

1. **Bounded top-level mounting is validated for many-file input.** Classic mounted 300 file wrappers and 20,702 DOM nodes; CodeView mounted about 4–5 visible Pierre containers and Virtualized 6 wrappers, with roughly 3,400–3,600 total nodes including the non-virtualized file tree and surrounding app.
2. **Virtualized had the best first-visible latency on the representative many-file and large-file inputs in every profile.** The small fixture was effectively tied with Classic except that Classic was slightly ahead under mobile 4× CPU throttling. Direct CodeView had the highest small-input startup latency.
3. **The API was not the dominant measured bottleneck.** Payload calls were generally 10–24 ms on desktop-normal large fixtures, versus 133–364 ms warm first-visible times. This run does not support prioritizing patch streaming from first-visible latency alone.
4. **First-visible does not mean settled.** Virtualized's large-file post-visible idle work and context-expansion latency increased strongly under CPU throttling. Those measurements should remain decision inputs before claiming a complete large-file win.
5. **Aggressive controlled scrolling is a concern for the Reins-owned virtual list.** Its many-file p95 proxy was worse despite lower mounted DOM. Reproduce with user-like wheel/touch traces and inspect mount/measurement work before changing the renderer; this benchmark alone does not identify the cause.
6. **No renderer optimization or redesign is included in this work.** The measurements establish where further focused investigation is warranted rather than selecting an implementation from assumptions.

## Limitations

- Chromium mobile emulation does **not** represent iOS Safari battery use, thermal behavior, GPU behavior, touch input, compositor behavior, or device memory pressure. No actual battery measurements were made or claimed.
- CDP CPU throttling slows the renderer process; it does not throttle the local Git/backend process or emulate a specific phone CPU.
- Headless Chrome and synthetic scroll assignment differ from visible Chrome and physical wheel/touch gestures.
- The classic parse mark spans response-body JSON decoding/parsing; patch-backed parse marks cover Pierre patch parsing after text decoding. Setup-render marks end at the component update/renderer setup seam, not after every highlighting worker finishes. First-visible, traces, and post-visible idle work provide the broader view.
- Heap growth is `Runtime.getHeapUsage` before navigation versus first visible and is sensitive to GC scheduling. It is not retained-size attribution.
- Trace category durations can overlap. DOM counts include open shadow DOM but cannot include browser-internal or closed-shadow nodes.
- CodeView wrapper count is inferred from visible Pierre file containers because CodeView owns its internal wrapper markup.
- The many-file tree itself remains mounted and contributes to all three total DOM counts, so renderer-wrapper count is the cleaner top-level virtualization comparison.
- One cold run is reported separately from four warm runs. More cold process-level repetitions would be needed to characterize machine-start variance.

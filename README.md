# Preset Lite

A third-party extension for **TauriTavern** that keeps the chat-completion **preset / prompt panel**
light and smooth: prompt rows are reconciled instead of rebuilt, token recounts move out of the
interaction path, and the preset-apply event storm is coalesced.

Nothing inside the application source is modified. Every patched path delegates back to upstream the
moment the extension is switched off, so the panel can always be returned to stock behaviour without
a reload.

> Status: implemented and covered by unit + DOM integration tests. Device-side numbers (FPS, long
> tasks) are measured by the built-in benchmark — run it once on your own device, see
> [Benchmark](#benchmark).

---

## What it changes

| Panel interaction | Upstream | With Preset Lite |
| --- | --- | --- |
| Toggle / edit / delete / add a prompt | `#completion_prompt_manager` is cleared and fully rebuilt, ~4 listeners re-attached per row, scroll restored | only the affected row is replaced; unchanged rows keep their DOM nodes |
| Token numbers | rebuilt list waits for a full dry run of the whole generation pipeline | interaction paints immediately, the dry run is coalesced and runs once while the browser is idle, numbers are then written in place |
| Switching a preset | ~100 form writes each fire their own `input` handlers, then the panel rebuilds twice | the panel reacts once; identical preset `input` events are merged and replayed once at the end of the apply window |
| Long lists | every row is laid out and painted on every interaction | rows scrolled out of view are skipped by the renderer (`content-visibility`), measurements are forced back on during drag & drop |

**It does not** touch: text-completion/Kobold/NovelAI preset panels, the World Info or Advanced
Formatting drawers, the preset JSON format, or the tokenizer itself. Token counting keeps using the
same host endpoint it always did — only *when* and *how often* it runs changes.

---

## Requirements

- TauriTavern with the SillyTavern 1.18-compatible frontend (`PromptManager` in the left navigation).
- The extension refuses to patch and says so in the console when the upstream surface it depends on
  is missing — it never guesses.

## Install

Through the extension installer (recommended, updatable):

```
https://github.com/lin293387-del/Preset-list
```

Or manually: copy this folder to `<data_root>/default-user/extensions/Preset-list/` (local) or
`<data_root>/extensions/third-party/Preset-list/` (global), then enable **Preset Lite** in the
extension list. `manifest.json` must stay at the root of the folder.

Uninstall = disable or delete the extension; no data outside the extension store is written.

---

## Settings

`Extensions → Preset Lite`

| Setting | Default | Meaning |
| --- | --- | --- |
| Enable Preset Lite | on | Master switch. Off restores stock rendering instantly. |
| Keep last known token numbers | on | While a recount is pending the numbers stay visible (dimmed). Off shows `-` like upstream. |
| Coalesce preset apply events | on | Merges the preset-apply `input` storm; `change` events and everything outside the left navigation panel keep their original timing. |
| Report preset field conflicts | on | If a replayed handler rewrites a field the preset just wrote, that field is listed in the status area instead of being silently swallowed. |
| Persist the token cache | on | Counts are cached per model + content, so returning to a preset (or restarting) is instant. |
| Recount delay (ms) | 250 | Quiet time after the last panel interaction before a recount may start. |
| Token cache entries | 4000 | LRU bound. |
| Verbose diagnostics | off | Console logging plus the diagnostics list. |

Buttons: **Run benchmark**, **Clear token cache**, **Copy report**, **Enable perf HUD** (writes the
host flag `tt:perf=1`; the HUD appears after a restart, `Ctrl+Alt+P`).

Runtime API for the console:

```js
__PRESET_LITE__.snapshot()      // scheduler, cache, panel sync stats, diagnostics, host HUD (if on)
__PRESET_LITE__.report()        // last benchmark report
__PRESET_LITE__.enable(false)   // A/B without touching settings
__PRESET_LITE__.recountNow()    // force an exact recount
__PRESET_LITE__.bench({ mode: 'ab' })
```

---

## Benchmark

The benchmark drives the real UI: 60 prompt toggles, preset switches, and a 2 s scroll, first with
the extension disabled (**baseline** = upstream) and then enabled (**optimized**), on the same chat,
preset and device. Each phase records frame deltas, long tasks and event-loop lag; the settle phases
show whether a recount ran.

1. Import `tools/bench-stress-60.preset.json` (60 extra prompts) and select it, or use your own
   prompt-heavy preset.
2. Open the **AI Response Configuration** panel (the benchmark refuses to run while it is closed).
3. Run the benchmark and keep your hands off the device.
4. Copy the report.

### What a run looks like

The benchmark drives the real UI, so it *is* visible — keep the AI Response Configuration panel in
view:

| When | On screen |
| --- | --- |
| immediately | the settings block logs `benchmark started` plus a `sample:` line saying how many toggleable rows, presets and scrollable pixels were found; the run button locks |
| ~0-10 s | prompt rows flip on and off, 60 times (~120 ms apart) — this is the **baseline** pass, so it deliberately feels like stock |
| ~10-13 s | quiet settle window (this is where upstream runs its dry run) |
| ~13-22 s | the preset dropdown switches ~6 times |
| ~22-25 s | second quiet settle |
| ~25-27 s | the left panel scrolls up and down for 2 s |
| then again | the same sequence with Preset Lite **enabled** |
| end | `benchmark finished (n phases)` and the report table below |

Progress lines are appended with a timestamp and are never overwritten by the periodic status line;
the same messages are mirrored to the DevTools console. If a phase has nothing to exercise (no
toggleable rows, fewer than two presets, panel not scrollable) the `sample:` line says so instead of
the run quietly doing nothing. A full A/B run takes about a minute.

Targets used for acceptance:

| Phase | Target |
| --- | --- |
| 60 toggles (~120 ms apart) | 0 long tasks > 50 ms, frame p95 ≤ 16.7 ms |
| 6 preset switches (~1.5 s apart) | per-switch plugin-attributable work ≤ 50 ms, frame p95 ≤ 16.7 ms |
| 2 s scroll | frame p95 ≤ 16.7 ms, 0 long tasks > 50 ms |
| Recount | only after interactions stop; never slower than baseline; faster on repeat thanks to the cache |

Regenerate the sample preset with `node tools/build-stress-preset.mjs`.

---

## How it works

Everything is a runtime takeover of the upstream modules — no patched app files:

| Upstream | Taken over |
| --- | --- |
| `PromptManager.prototype.init` | hook for instance-level patching (the headless assembly instance is left alone) |
| `render`, `renderNowAndRefresh`, `renderDebounced`, `renderDryRunLatest` | immediate incremental paint + idle recount scheduling |
| `renderPromptManager`, `renderPromptManagerListItems` | header/footer built once, rows reconciled by `data-pm-identifier` |
| instance `handleToggle` / `handleInspect` | keeps the last known number instead of blanking it; inspect refreshes itself when the assembly was stale |
| `tokenHandler.countTokenAsyncFn` | memoized counting (results only, identical inputs) |
| `jQuery.fn.trigger` | preset window coalescing (`input` + `{ source: 'preset' }` only) |
| `OAI_PRESET_CHANGED_BEFORE/AFTER`, `PRESET_CHANGED` | window bracket, with a safety timeout because upstream can leave the window without firing `AFTER` |

Upstream markup stays the single source of truth: rows are built by the **original** renderer into a
detached list and then diffed, so nothing here duplicates the row template. Before diffing, the
rendered rows are cross-checked against `getPromptsForCharacter()`; a mismatch means the markup
changed, and the extension falls back to stock rendering (listed as `degraded` in the status area)
instead of dropping rows.

Recounts are single-flight and only start when the panel is visible, no generation is running, and
the user has stopped interacting/scrolling/dragging. Stale results are discarded by epoch.

---

## Compatibility notes

- **Upstream changes** are the main risk of any runtime takeover. The extension asserts the surface it
  needs at start, verifies rendered rows against the prompt model at every sync, and degrades to
  stock rendering (with a visible note) rather than mis-rendering.
- **Other panel-patching extensions**: the extension detects when its entry points were replaced by
  someone else and reports it in the status area instead of fighting over them.
- **Event coalescing** is scoped to the preset-apply window and to `input` events carrying
  `{ source: 'preset' }` that target the left navigation panel. Handlers therefore observe the final
  field values (upstream lets them observe partially applied ones). Fields a handler changes
  afterwards are reported; turn the option off if a third-party extension depends on that ordering.
- **Token numbers may lag** behind an interaction by one idle window. They are always exact once the
  recount finishes; the dry run itself is unchanged.

---

## Development

```
npm install          # devDependencies: typescript, happy-dom
npm test             # 72 tests: pure logic, panel DOM reconciliation, patch layer, runtime smoke
npm run typecheck    # tsc --noEmit with checkJs (JSDoc types, no build step)
```

The test suite is layered: pure functions (diff planning, scheduler state machine, cache, preset
window) run without a DOM; the reconciliation layer runs against happy-dom with faithful copies of
the upstream markup; the patch layer runs against a fake class; and the runtime smoke test boots the
whole composition with the upstream modules replaced through a Node resolve hook.

Layout:

```
index.js                extension entry (manifest hook "activate")
settings.html           extension settings block
style.css               panel containment + settings styles
i18n/zh-cn.json         Chinese strings (English is the source text)
src/host.js             page/context/host boundary
src/config.js           settings defaults, validation, persistence
src/storage.js          TauriTavern extension store -> localStorage -> memory
src/runtime.js          composition: patches, scheduling, events, global API
src/patches/*.js        runtime takeover of PromptManager and of the preset window
src/render/plan.js      pure row parsing + diff planning (unit tested)
src/render/apply.js     DOM executor for a plan
src/render/panel.js     structure/rows/total/stale-marker rendering
src/tokens/scheduler.js recount state machine (unit tested)
src/tokens/cache.js     memoized token counts, persistent LRU (unit tested)
src/perf/metrics.js     frame/long-task/lag sampling
src/perf/bench.js       A/B benchmark
src/ui/settings-panel.js settings drawer wiring
tests/                  unit, DOM reconciliation, patch-layer and runtime smoke tests
tests/fixtures/         upstream markup copies, module doubles, Node resolve hook
tools/                  benchmark sample preset generator
```

There is no build step: the repo is exactly what gets installed, and `package.json` only exists for
development tooling.

## Manual checklist (after changes)

Toggle / edit / delete / add / append / save a prompt · import & export presets and prompt lists ·
rename, save-as, restore and delete a preset · drag & drop reorder (order survives a panel reopen) ·
character-scoped prompt order · quick edit fields (main / nsfw / jailbreak) · inspect popup content ·
`/prompt`, `/preset` slash commands · switching presets with "bind preset to connection" · toggling
the master switch while a recount is pending · disabling the extension restores stock behaviour.

## License

MIT — see [LICENSE](LICENSE).

---

## 中文速览

**它做什么**：把左栏「AI 响应配置」里的对话补全预设 + Prompts 面板改成增量渲染（只更新变化的行），
把 token 重算从交互路径挪到空闲时执行（先出画面，算完原地写回数字），并合并预设切换产生的上百次
`input` 事件。**不改任何应用源码**，关掉开关就立刻回到原生行为。

**装**：在扩展安装器里填 `https://github.com/lin293387-del/Preset-list`，或把整个文件夹放进
`<数据目录>/default-user/extensions/Preset-list/`，然后在扩展列表里启用。

**验证**：导入 `tools/bench-stress-60.preset.json`，打开左栏面板，点设置里的
「Run benchmark」（会先跑一遍原生再跑一遍插件并给出对照），完成后「Copy report」把结果发我。

**注意**：token 数字在交互后会滞后一个空闲窗口才刷新（默认保留上次数字并灰显）；上游若大改
PromptManager 结构，插件会自动降级为原生渲染并在状态区标注，不会把面板画坏。

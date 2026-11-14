# Prompt for the next session

Paste everything below the line into a new session opened in this folder.

---

Continue building **Lumen**, the macOS video player in this repository (Tauri 2 + Rust, React 18 + TypeScript, libmpv, FFmpeg LGPL). Milestones 1–3 are finished. **Milestone 4 (subtitles, audio, equaliser, video tuner) was stopped part-way**: the backend is done and tested; the interface is written but has not been looked at or tested. Finish Milestone 4, then go on to Milestones 5–8 in order.

Read these first, in this order, before touching anything:

1. Your memory files for this project (the brief, the working rules, the dev environment notes, the milestone status).
2. `PRODUCT.md`, `DESIGN.md` (§7 has the rules for the new tabs) and `README.md`.
3. The global rules in `~/.claude/CLAUDE.md`: audit every UI change for layout, line by line, before calling it done.

Standing rules, unchanged: decide open questions yourself; fluid, elegant UI comes first; do not commit or push unless I ask (nothing is committed yet); never photograph the whole screen and never take focus from me when verifying (use `scripts/shot.sh`, which captures only the app's own window); update `DESIGN.md` before making a design choice it does not cover; no placeholder UI or fake data in a finished milestone; say so if something is not feasible and propose an alternative; keep `NOTICES` current; after each milestone summarise what works, what is stubbed and how to test it.

## Where Milestone 4 stands

**Done and tested (243 Rust tests, clippy and fmt clean):**

- `src-tauri/src/engine/adjust.rs`: the adjustment model as plain values and what each comes to in mpv's terms (picture levels, sharpen, noise reduction, shape, centred crop, 10-band equaliser chain with headroom, output channels, subtitle style).
- `src-tauri/src/engine/player/adjustments.rs`: the player's methods for them. Track choice, second subtitle track, adding subtitle files, subtitles on and off, audio and subtitle delay, shape (aspect, crop, zoom, rotation, flip, mirror, deinterlace), picture tuner, equaliser (inserted once, then turned live with `af-command`), output device, channels, passthrough, subtitle style, visualiser for audio-only files (`lavfi-complex` with `showwaves`), subtitle lift.
- Per-file memory: `FileState` (tracks, delays, subtitle files, shape) is stored in a new `history.state` column (migration `0003_file_state.sql`), written by the conductor and set again before the file next loads.
- Settings: new `video`, `audio` and `subtitles` sections; only the changed section is saved and applied.
- Commands and bindings: `player_select_track`, `player_select_second_subtitle`, `player_add_subtitles`, `player_add_subtitles_dialog`, `player_toggle_subtitles`, `player_set_audio_delay`, `player_set_subtitle_delay`, `player_set_shape`, `player_set_subtitle_lift`, `fonts_list`. Subtitle files dropped on the window while a film is open are added to it rather than opened.

**Written, type-checks and lints, but never verified:**

- Primitives: `src/components/ui/{switch,picker,group,swatches,band}.tsx`; `scale.tsx` gained `origin` and a neutral reading.
- The panel now has five icon tabs (`src/features/inspector/Inspector.tsx`), with `PanelBody.tsx` as the shared tab body.
- `src/features/video/` (picture tuner with presets, frame controls), `src/features/audio/` (track list, equaliser with presets, output), `src/features/subtitles/` (track list, second track, delay, look, font picker), `src/features/presets/PresetPicker.tsx`, `src/features/player/{tracks.ts,TrackList.tsx,adjust.ts}`.
- Actions with shortcuts for all of it, and new Video and Subtitles menus plus additions to Audio in `src/features/shell/menuBar.ts`.
- `src/features/settings/store.ts` now sends one save at a time and ignores echoes of its own saves; `src/dev/mockBackend.ts` knows the new commands and gives `#mock-film` real tracks.

Only the Video tab has been seen once, in a browser against the mock backend. The Audio and Subtitles tabs have never been rendered. Nothing new has been run in the real app.

**Known to be wrong or missing:**

- Three unit tests failed after the design changes and were not updated: `Inspector.test.tsx` (tabs are icons now), `PlaylistPanel.test.tsx` (an unnamed playlist is headed "Playlist"), `shell/menuBar.test.ts` (not re-run since the new menus were added). The browser suite (`pnpm e2e`) has not been run since this work began; expect failures around the panel header and the playlist heading.
- The focus ring of the first control in each new tab is clipped by the top edge of the tab's scrolling area.
- `DESIGN.md` says a group shows Reset when it differs from neutral, but Picture and Equaliser rely on the first entry of their preset picker ("Neutral", "Flat") instead; and it calls the mark on a tab whose adjustments are in effect a lamp, where the code draws a 4 px dot. Decide, and make the document and the code agree.
- Nothing calls `playerSetSubtitleLift` yet.
- No tests exist for any of the new interface code.

## What is left in Milestone 4 (updated 2026-11-14, second session)

Done in the second session (not by the subtitles agent):

- The three failing unit tests and the browser tests around the panel header and the playlist heading are repaired. The panel is the region "Panel", its tab list "Panel tabs".
- The active tab's underline and ink were never drawn: the tooltip's `data-state` overwrote the tab's. Keyed to `aria-selected` now.
- The focus ring of a tab's first control is no longer clipped. DESIGN.md now matches the code on the in-effect mark (a 4 px dot) and on Reset: groups led by a preset picker reset through it; Output has none; the Audio Track group has Reset for its delay; `GroupReset` ends its word at the column's edge.
- Tests: 149 new unit tests and `e2e/adjustments.spec.ts` (Video and Audio tabs), `e2e/hdr.spec.ts`; the new primitives are in the gallery. Subtitles are not covered: they belong to the other agent.
- HDR: `DynamicRangeChanged` event and `window_is_hdr`; while HDR the stage chrome is outlined like the on-screen display (DESIGN.md §2).
- Real app (`scripts/shot.sh`): tracks, track switching, menus, equaliser toggle, rotation, crop, mirror, per-file memory (crop came back on reopen), visualiser. Fixed there: the window did not change shape for a quarter turn or a crop (and would have been wrong for a phone video with rotation metadata); the visualiser was transparent (the window showed through) and is now an opaque oscilloscope trace; noise reduction and mirror/flip were silently dropped by mpv on hardware-decoded video, and now switch decoding to copy-back while a software filter is in. 4K30 HEVC: 0 dropped frames with full noise reduction, mirror, or deinterlacing.

Still open:

1. Subtitles (owned by another agent in parallel): lifting them clear of the control bar, OpenSubtitles, the Subtitles tab's tests, and its Reset (use `GroupReset`).
2. Once that lands: the full browser suite, the Impeccable critique as a background delegate, audit, polish and the detector; then the Milestone 4 summary (mention SAMI for "SMIL").

## Packaging, as it stands

`src-tauri/tauri.conf.json` now bundles the libraries and the two FFmpeg tools, signed ad hoc **without** the hardened runtime. With the hardened runtime an ad-hoc build crashes at launch, because library validation refuses libraries that share no Team ID. Proper signing with a Developer ID, the hardened runtime and notarisation belong to Milestone 8.

`/Applications/Lumen.app` is a build of this unfinished state. To rebuild and replace it:

```sh
pnpm tauri build --bundles app
rm -rf /Applications/Lumen.app
ditto src-tauri/target/release/bundle/macos/Lumen.app /Applications/Lumen.app
```

The scratch folder of the previous session (test media, probe scripts, screenshots) may be gone. Test media can be made again with `vendor/bin/ffmpeg` (see `src-tauri/src/engine/test_support.rs` for how; this build has no `lavfi` input device, so sources are filters in a `-filter_complex` graph).

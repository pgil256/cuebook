# Cuebook

Sound cue playback for theater. The script sits on the left, the cue list on the right, and there is one big **GO**.

## Run it

```bash
npm install
npm start
```

To build a Windows app: `npm run dist`. The installer and a portable `.exe` go to `dist/`.

## How a show works

- **A show is a folder.** It holds `show.cuebook` (the cue list), `script/` and `audio/`. Every file you add is copied in, so you can copy the folder to a USB stick and open it on the venue computer. Changes save automatically, and the previous save is kept as `show.cuebook.bak`.
- **Script (left).** Drop in a PDF, a Word `.docx` or a text file, or paste the text.
- **Cues (right).** Drop sound files on the cue list to add cues. Drop them on the script instead and each cue is pinned to that line and slotted into the right place in the list. New cues get stage-manager numbers (2.5 between 2 and 3).
- **Pins.** Drag a cue from the list onto the script, Alt+click the script, or use *Pin to script…* in the inspector. Drag a marker to move it. In a run, the script scrolls to the next cue's marker and highlights it.
- **Per-cue settings.** Volume (heard live while playing), trim start/end on the waveform, loop, fade in, fade out at end, fade when stopped, notes, and auto-follow (GO the next cue when this one ends, or after a delay).
- **When a cue starts** it fades out whatever is playing, unless it's set to *Keep other sounds playing*.
- **Fade/Stop cues** fade everything (or one cue) out, or to a new volume.

## Running a show

| Key | Action |
| --- | --- |
| Space | GO: fire the standby cue |
| Esc | STOP ALL: fade everything out. Press twice to cut instantly. |
| ↑ / ↓ | Move the standby cue |
| Double-click a cue | Jump to it (make it the standby) |
| Ctrl+Z / Ctrl+Y | Undo / redo (Edit mode) |
| Delete | Delete the selected cue (Edit mode) |

- **Show mode** locks the cue list against accidental edits and keeps the screen awake. Switching back to Edit asks for confirmation.
- **Double-GO protection** ignores a second GO within 0.5 s. You can change this in Settings.
- **Output.** Pick the device in the top bar. It's saved with the show, and if it's unplugged Cuebook falls back to the system default and warns you.
- **Crash safety.** If the window's renderer ever crashes, Cuebook reloads straight back into the show with the same next cue.
- Every sound is loaded into memory ahead of time, so GO is instant. Missing or unreadable files are flagged in red when the show opens.

## Code map

- `main.js`: Electron main process. Show folders, file import, Word conversion, the `app://` protocol, close guard, crash recovery.
- `preload.js`: the IPC bridge (`window.cuebook`).
- `src/js/audio.js`: Web Audio engine (decoding cache, voices, fades, trims, loops).
- `src/js/player.js`: GO, standby, auto-follow chains, fade cues, stop all, preview.
- `src/js/script-view.js`: PDF (pdf.js) / Word / text rendering and cue markers.
- `src/js/cue-list.js`, `inspector.js`, `transport.js`, `home.js`: the UI.
- `src/js/store.js`: show data, undo/redo, autosave.

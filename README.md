# Cuebook

A simple media player for running sound in a show. Your script is on the left, your playlist is on the right, and the player controls run along the bottom.

## Run it

Double-click `release\Cuebook 0.2.0.exe` (no install needed), or install with `release\Cuebook Setup 0.2.0.exe`.

From the code:

```bash
npm install
npm start
```

To build the exe files yourself: `npm run dist` (they go to `release/`).

## Using it

1. **Create a show.** It's a folder, saved under `Documents\Cuebook Shows` unless you pick somewhere else.
2. **Drop your script** on the left: PDF, Word (.docx) or a text file.
3. **Drop your music** on the right. Drag songs to reorder them. Hover a song and click × to remove it (with Undo).
4. **Play.** Double-click a song, or press the big play button.

Every file you add is copied into the show folder, so you can copy the folder to a USB stick and open it on another computer. Changes save automatically.

When a song finishes, the next one is cued up and waits for you. It doesn't start by itself.

## Controls

| | |
| --- | --- |
| Seek bar | Click anywhere to jump there, or drag the handle |
| Space | Play / pause |
| Esc | Stop (back to the start of the song) |
| ← / → | Jump back / forward 5 seconds |
| ↑ / ↓ | Select the previous / next song |
| Enter | Play the selected song |
| Delete | Remove the selected song |
| ⏮ | Back to the start of the song, or the previous song if you're at the start |
| ⏭ | Next song |

## Code map

- `main.js`: Electron main process. Show folders, copying files in, Word conversion, serving files to the window (with byte ranges so songs can seek).
- `preload.js`: the bridge to the window (`window.cuebook`).
- `src/js/app.js`: playlist, player bar, keyboard, drag and drop, saving.
- `src/js/player.js`: the audio player.
- `src/js/script-view.js`: shows the script (pdf.js for PDFs, mammoth for Word).
- `src/js/home.js`: the start screen.

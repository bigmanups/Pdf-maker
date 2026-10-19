# PDF Maker

A simple Windows desktop app for making, combining and editing PDFs. Drag in your files, arrange the pages, change the text, and save one clean PDF. Everything runs on your own computer, with no uploads and no account.

## Features

### Make PDFs from almost anything
Drop in files and each one becomes pages in the same document:

| Type | Formats |
| --- | --- |
| PDF | `.pdf` |
| Images | `.jpg` `.jpeg` `.png` `.webp` `.gif` `.bmp` |
| Documents | `.docx` (Word), `.txt`, `.md` (Markdown), `.html`, `.csv`, `.json`, `.log` |

Photos are fitted onto A4 pages and turned the right way up automatically.

### Arrange pages
- Drag thumbnails to reorder them
- Rotate, duplicate or delete pages
- Select several pages with Ctrl-click or Shift-click
- Undo any change with Ctrl+Z

### Edit text in place
Click any line of text in a PDF and type over it:
- The new text matches the original's size, colour, background and style (serif, sans or mono, bold, italic)
- When you save, the old text is **removed from the file**, not just covered up, so it won't show up in copy or search
- Clear a line to delete it

You can also add new text anywhere, move things you've added or changed, and white-out any area.

### Zoom
Zoom in on a page with the mouse wheel (50% to 800%). Pan with right-drag or Space+drag.

### Save
- **Save PDF**: all pages as one file
- **Save selected**: only the pages you've picked
- **Split**: every page as its own PDF

## Install

Download `PDF Maker Setup x.x.x.exe` from [Releases](../../releases) and run it. The installer adds Start Menu and desktop shortcuts, and lists PDF Maker under **Open with** for PDF files.

> The installer isn't code-signed, so Windows SmartScreen may warn you. Click **More info → Run anyway**.

## Keyboard shortcuts

| Main view | |
| --- | --- |
| `Ctrl+O` | Add files |
| `Ctrl+S` | Save PDF |
| `Ctrl+Z` | Undo |
| `Ctrl+A` | Select all pages |
| `Ctrl+D` | Duplicate selected |
| `Del` | Delete selected |
| `R` / `Shift+R` | Rotate right / left |
| `Enter` or double-click | Open the page editor |

| Page editor | |
| --- | --- |
| `E` / `T` / `V` / `W` | Edit text / Add text / Move / White-out |
| Mouse wheel, `Ctrl +` / `Ctrl −` | Zoom |
| `Ctrl+0` | Fit page to window |
| Right-drag, `Space`+drag | Pan |
| `PgUp` / `PgDn` | Previous / next page |
| `Del` | Delete selected item |
| `Esc` | Close editor |

## Limitations

- **Fonts are approximated.** Edited and added text uses the closest PDF standard font (Helvetica, Times or Courier), so it can look slightly different from fonts like Calibri.
- **Text is edited line by line.** Longer replacement text doesn't wrap onto the next line.
- **Western characters only** in added or edited text. Other characters are saved as `?`.
- **Scanned PDFs** are images of text, so their text can't be edited.
- **Some unusual fonts can't be measured safely.** For these, the original text is covered rather than removed, so it may still appear when copying or searching.
- **Word conversion** keeps text, headings, lists, tables and images, but complex layouts won't match Word exactly.

## Building from source

Requires [Node.js](https://nodejs.org/) 18 or later.

```bash
npm install
npm start          # run the app
npm run dist       # build the Windows installer into dist/
```

## How it works

Built with [Electron](https://www.electronjs.org/) and:
- [pdf.js](https://mozilla.github.io/pdf.js/) for showing pages and finding text
- [pdf-lib](https://pdf-lib.js.org/) for building, merging and editing PDFs
- [mammoth](https://github.com/mwilliamson/mammoth.js) for converting Word documents
- [marked](https://marked.js.org/) for converting Markdown

Word, Markdown, text, HTML and CSV files are converted to HTML and printed to PDF by Chromium. Text editing works directly on each page's content stream: the original text is removed, and the replacement is drawn in its place.

| File | Purpose |
| --- | --- |
| `main.js` | Electron main process: windows, file dialogs, document → PDF conversion |
| `preload.js` | Safe bridge between the page and the main process |
| `renderer/renderer.js` | The app UI: page grid, editor, zoom, export |
| `renderer/textremove.js` | Removes replaced text from page content streams |

# Inkwrap

**Read PDF books on your phone without zooming.**

Inkwrap re-wraps a PDF's text to the width of your screen. Instead of extracting the text and re-typesetting it (which loses fonts, italics, symbols and sometimes whole words), it **cuts each word out of the original page as an image and lays those images out again**, line by line. What you read is the book's own typography, at the size you choose.

Everything runs on the device: no upload, no server, no account.

## What it does

- Re-wraps body text to the screen with optimal line breaking (minimum raggedness), justified or ragged right
- Hyphenates English text with TeX patterns, drawing the **book's own hyphen glyph** at the break; never cuts inside ligatures
- Rejoins words hyphenated at line ends, including across page breaks, and joins paragraphs that continue on the next page
- Removes running headers, footers and page numbers
- Keeps headings, indents, block quotes, centred lines and poetry line-by-line; keeps code blocks unwrapped (shrunk to fit, soft-wrapped if very long)
- Shows figures, ruled tables and picture pages (covers) as images; drop caps become normal capitals
- Light / sepia / dark themes (only text is recoloured, pictures keep their colours)
- Contents (PDF outline), original-page view with zoom that stays in sync with your reading position, remembered position per book
- Opens PDFs from the app or via Android's "Open with"

## How it works

```
PDF ──PDFium (WASM)──► per-character boxes, fonts, page objects
    ──analyze.ts────► words → lines → reading order (XY-cut) → paragraphs, figures, headers/footers
    ──layout.ts─────► line breaking for the screen width → list of "copy this rectangle from page N" ops
    ──worker.ts─────► renders the needed page regions and composites them into one bitmap per page chunk
```

- `src/engine/` – the platform-independent engine (runs in a Web Worker in the app and in Node for tools)
- `src/reader.ts` – the reading view: continuous scroll of lazily painted chunks
- `tools/snap.ts` – renders reflowed output and an analysis overlay to PNG (for engine work)
- `tools/e2e.ts` – opens a PDF in headless Chromium emulating a Pixel 7 and takes screenshots

## Development

```sh
npm install
npm run dev                                  # web app at http://localhost:5173
npx tsx tools/snap.ts book.pdf --pages 10-12 --debug --out snaps   # engine previews
npm run build && npx tsx tools/e2e.ts book.pdf --out snaps/e2e    # phone-sized smoke test
```

### Android

Requires JDK 21 and the Android SDK (platform 36, build-tools 35).

```sh
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
```

Building on **Linux ARM64**: Google's `aapt2` is x86-64 only. Install `qemu-user-static` plus `libc6:amd64 libstdc++6:amd64` (Ubuntu multiarch) and it runs transparently. Use command-line tools ≤ 22.0, whose `sdkmanager` is still Java (23.0 ships an x86-64 binary).

## Status

Early prototype. Built for born-digital books (text PDFs). Scanned PDFs, complex multi-column layouts, tables without rules and mathematics are not handled well yet.

## License

MIT, see [LICENSE](LICENSE). PDFium is BSD/Apache-2.0; the `@embedpdf/pdfium` binding is MIT; hyphenation patterns via `hyphen` (ISC).

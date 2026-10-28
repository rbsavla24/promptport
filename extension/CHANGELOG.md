# Changelog

Full user guide: see the README at the root of this repository.

- **v3.2.4 — line breaks on import (both sites):** a line break you type in a .md file now stays a line break (before, two lines like “**Q:** …” and “**A:** …” were joined into one). Exports still re-import as “Nothing to change”.

- **v3.2.3 — safety fix (Ringg):** the background data reader now only ever repeats a page *read* (GET). Before, if the assistant data had last come from a save, it could re-send that save without its content when you exported after a lot of page activity. It also keeps the latest assistant data so names stay correct.

- **v3.2.2 — live-tested on both sites:** exported files no longer contain whitespace-only lines inside list items.

- **v3.2.1:** on Rezolv, lines separated by a single line break (common in Ringg prompts) now arrive as separate paragraphs instead of running together (that editor has no line breaks), and re-importing the same file there reports "Nothing to change". The last import can be undone from the Import tab even after you leave its results screen.

- **v3.0.0 — UI 2.0:** greyscale, Verdana, hand-drawn panel with no product name or logo, equal side-by-side download buttons, sticky actions, site-neutral wording everywhere in the UI, and author links (LinkedIn · GitHub · Figma) that appear after a download, import, undo, backup or Replace all finishes and hide when the next one starts.

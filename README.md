# ClientPDF

Merge PDF files entirely in the browser — no upload, no server, no account.

## Why

Every mainstream PDF merge tool (Smallpdf, iLovePDF, etc.) uploads your file to
their servers to process it. ClientPDF doesn't have a server: merging happens
client-side via [pdf-lib](https://github.com/Hopding/pdf-lib) compiled to
WebAssembly/JS, vendored locally in the app. Open the browser network tab
while using it — nothing goes out.

## Stack

Static HTML/CSS/JS, zero build step, zero backend. `pdf-lib` vendored locally
at `vendor/pdf-lib.esm.min.js` and imported as an ES module — not loaded from
a CDN. Deployed on GitHub Pages.

## Local dev

```
npx serve .
```

or any static file server — there's no build step.

## Status

Twenty-three tools live: Merge, Split (extract/split-to-zip), Delete Pages (remove
specific pages by range and keep the rest as one file — unlike Split, which
only pulls a range out or explodes every page, this one lets you drop pages
2 and 4 while keeping 1, 3, 5 together; blocks client-side if the delete
list would empty the whole document), Rotate, Reorder
(drag pages into a new order or drop the ones you don't need), Compress
(re-encodes embedded JPEG images to shrink file size), Page Numbers
(stamps a running page number in any corner, with a configurable start
number and an option to skip the cover page), Images to PDF (turns a
batch of JPG/PNG images into a single PDF, one page per image, reorderable
before conversion), Add Watermark (stamps custom text across every
page, with configurable opacity and angle, via pdf-lib's native
`drawText`), and Edit Metadata (reads and edits Title, Author, Subject,
Keywords, Creation Date, and Modification Date via pdf-lib's
`getTitle`/`setTitle`-style accessors; the Producer field is intentionally
not editable in the UI since pdf-lib always overwrites it to its own
signature on save regardless of what's set), and Crop Pages (trims the
visible margins on every page by setting a custom CropBox — unlike Delete
Pages, which removes whole pages, or Split, which pulls pages out into
separate files, Crop keeps every page but shrinks the visible area; the
trimmed-away content still exists in the underlying content stream, it's
just outside the CropBox that compliant viewers render), and Flatten Form
Fields (bakes a filled-out AcroForm's text fields, checkboxes, radio
buttons, and dropdowns into permanent static page content via pdf-lib's
`form.flatten()` — unlike every other tool here, which edits page/document
structure, this one removes interactivity itself; a PDF with zero form
fields is detected client-side and reported as a no-op instead of silently
producing a byte-identical download), and Pages per Sheet (lays 2 or 4
original pages onto each printed sheet via pdf-lib's `embedPages`/`drawPage`
— genuinely new operation category, not a variant of Split/Reorder/Crop,
since it composites multiple source pages into a new page rather than
moving or trimming existing ones; landscape or portrait sheet, scaled and
centered per cell), and Duplicate Pages (copies specific pages via
`copyPages`, inserting each duplicate immediately after its original —
unlike Delete Pages, which removes pages, or Reorder, which rearranges
them, this one adds content by growing the page count; range/list input
identical to Delete Pages' page picker for consistency), and Insert Blank
Pages (adds blank pages at any position — before the first page, between
any two pages, or at the end — via pdf-lib's `insertPage`, sized to match
the neighboring page; positions are applied in descending order so each
insert doesn't shift the indices of positions still queued), and Fill Form
Fields (types values into an existing AcroForm's text fields, checkboxes,
radio buttons, dropdowns, and multi-select option lists via pdf-lib's
`setText`/`check`/`select` accessors, then downloads the filled file with
fields still interactive — unlike Flatten Form Fields, which bakes in
whatever values a field already holds and removes interactivity, this one
is the step that puts values into an empty or partially filled form in the
first place; button and signature fields are detected and shown as
unsupported rather than silently ignored), and Add Bookmarks (adds named
outline entries that jump straight to a page in any PDF reader's sidebar,
built via pdf-lib's low-level `context.nextRef`/`context.assign` API since
pdf-lib has no high-level outline helper — the `/Outlines` dict and each
item dict are linked by hand per the PDF spec with `Parent`/`First`/`Last`/
`Next`/`Prev`/`Count`; entries are sorted by page number before linking so
the resulting sidebar reads top-to-bottom regardless of add order), and
Split by Bookmarks (reads a PDF's *existing* outline instead of writing
one — walks the `/Outlines` linked list, resolving each item's target page
via either a direct `/Dest` array or an `/A` GoTo action's `/D` array to
cover PDFs from Word/LibreOffice as well as pdf-lib, then extracts each
bookmarked section as its own PDF via `copyPages`; sections are computed
from bookmark page order, each running until the next bookmark or the end
of the document), and Extract Images (pulls the JPEG images embedded in a
PDF's pages back out as standalone `.jpg` files, one at a time or all
zipped together — walks each page's `/Resources`/`XObject` dict for
`/Image`-subtype entries filtered with `/DCTDecode`, whose raw stream
bytes are already a byte-identical JPEG file, no re-encoding needed;
images using other filters — raw `FlateDecode` pixel data, `JPXDecode`,
`CCITTFax` — are reported as skipped rather than silently dropped or
falsely claimed as extracted; zipping uses a hand-rolled store-mode
`.zip` writer with zero dependencies rather than N sequential downloads),
and Resize Pages (rescales every page to a standard paper size or a
percentage via pdf-lib's `page.scale()`, which resizes the page's
MediaBox/CropBox and its content transformation matrix together —
distinct from Crop, which only changes the visible clip area without
touching dimensions or content scale; "fit to size" mode scales
uniformly, using the smaller of the two axis ratios, so content never
distorts even when the source and target aspect ratios differ), and
Grayscale PDF (rewrites the RGB/CMYK color-setting operators — `rg`/`RG`/
`k`/`K` — inside each page's content stream to their grayscale equivalents
via the standard luminosity formula (`0.3R + 0.59G + 0.11B`, with CMYK
converted to RGB first); a new operation category, since every other tool
here edits page/document structure or embedded assets rather than the
color values inside a page's own drawing instructions — decodes each
content stream with pdf-lib's own `decodePDFRawStream` (handling
FlateDecode transparently), regex-rewrites color operators on token
boundaries, then writes the modified stream back *uncompressed* rather
than re-deflating it, trading a slightly larger file for zero new
dependencies; intentionally leaves `sc`/`SC`/`scn`/`SCN` (pattern/
Separation/ICC colorspaces) and embedded raster images untouched rather
than guessing at colorspaces it can't safely interpret — the UI says so
directly rather than overselling itself as a universal grayscale
converter), and Add Page Borders (draws an unfilled rectangular outline on
every page via pdf-lib's `drawRectangle` with `borderColor`/`borderWidth`
set and `color` left `undefined` — the same primitive Resize Pages'
`page.scale()` and Watermark's `drawText`/`drawImage` build on, but used
here for a stroke-only shape instead of a fill or overlay; margin, color,
and stroke width are all user-configurable, and the margin is validated
client-side against half of each page's own smallest dimension so an
oversized value fails cleanly instead of drawing a nonsensical or inverted
rectangle — distinct from Resize Pages, which rescales the page itself, and
from Watermark, which overlays text/image content, since this only adds an
outline and leaves page dimensions and existing content untouched), and Image
Watermark (stamps a user-supplied PNG or JPG logo onto every page via
`embedPng`/`embedJpg` and `drawImage`, with configurable opacity, scale as a
percentage of page width, and one of nine anchor positions — the image kind
is detected from its file signature, not just its extension or MIME type, so
a mislabeled file fails cleanly instead of throwing a raw pdf-lib exception;
distinct from the original Watermark tool, which only stamps text with an
angle control — this one needs a real embedded image asset instead of a
font glyph run, aspect ratio is preserved automatically so a logo never
looks stretched). No
paywall, no artificial limits. Distribution plan is
directory/community launches (Product Hunt, tool directories), not organic
search — a brand-new domain has no chance of ranking for "merge pdf"
against incumbent DR90+ sites in the near term, so SEO is not the growth
bet here.

Compress only re-encodes JPEG-filtered images (`/DCTDecode`) — the common
case for scanned documents and photos — via `<canvas>`, capping the longest
side at 1600px and re-encoding at quality 0.65. It skips images with
transparency (SMask) or a CMYK color space (unreliable to decode via
`<img>`/`<canvas>`), and skips a re-encode if it wouldn't actually be smaller.
PDFs with no compressible JPEGs still get re-serialized (object streams on),
which sometimes shaves a little size on its own — the before/after size shown
is always the real result, never a faked number.

## Analytics

No-signup visit counter via [counterapi.dev](https://counterapi.dev) — counts
page loads and a coarse referrer bucket (github / direct / other), no cookies,
no personal data. Check current counts:

```
curl -s https://api.counterapi.dev/v1/clientpdf-abyworkings/visits-total
curl -s https://api.counterapi.dev/v1/clientpdf-abyworkings/visits-github
curl -s https://api.counterapi.dev/v1/clientpdf-abyworkings/visits-direct
curl -s https://api.counterapi.dev/v1/clientpdf-abyworkings/visits-other
```

`visits-github` rising means a directory listing (awesome-list, etc.) is
sending clicks — that's the signal to watch for.

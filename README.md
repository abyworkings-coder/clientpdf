# ClientPDF

Merge PDF files entirely in the browser — no upload, no server, no account.

## Why

Every mainstream PDF merge tool (Smallpdf, iLovePDF, etc.) uploads your file to
their servers to process it. ClientPDF doesn't have a server: merging happens
client-side via [pdf-lib](https://github.com/Hopding/pdf-lib) compiled to
WebAssembly/JS, loaded from a CDN. Open the browser network tab while using it —
nothing goes out.

## Stack

Static HTML/CSS/JS, zero build step, zero backend. `pdf-lib` loaded from
`cdn.jsdelivr.net` as an ES module. Deployed on GitHub Pages.

## Local dev

```
npx serve .
```

or any static file server — there's no build step.

## Status

Fourteen tools live: Merge, Split (extract/split-to-zip), Delete Pages (remove
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
identical to Delete Pages' page picker for consistency). No paywall, no artificial
limits. Distribution plan is
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

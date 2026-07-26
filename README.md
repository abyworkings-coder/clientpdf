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

v1: single-tool PDF merge with drag-to-reorder. No paywall, no artificial
limits. Distribution plan is directory/community launches (Product Hunt, tool
directories), not organic search — a brand-new domain has no chance of
ranking for "merge pdf" against incumbent DR90+ sites in the near term, so SEO
is not the growth bet here.

Planned next: split, compress, reorder-pages tools under the same shell once
usage data justifies further investment.

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

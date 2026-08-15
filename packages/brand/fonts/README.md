# Vendored face

`InstrumentSans-SemiBold.ttf` — the weight the wordmark is set in.

Vendored rather than fetched at build time so `build-assets.py` is
reproducible. The first version of that script read the font out of `/tmp`,
which meant it worked exactly once, on one machine, and would have failed on
anyone else's — while still producing *some* output if a fallback face were
allowed to stand in. A logo that is quietly the wrong shape is worse than a
build that stops, so the script now refuses to run without this file, and this
file is here.

**Licence.** SIL Open Font License 1.1, which permits bundling and
redistribution. From the font's own metadata:

> Copyright 2022 The Instrument Sans Project Authors
> (https://github.com/Instrument/instrument-sans)
> Licence: https://scripts.sil.org/OFL

Only this weight is vendored, because only this weight is used. The apps load
the full family from Google Fonts at runtime — see the `<link>` in each
`index.html`.

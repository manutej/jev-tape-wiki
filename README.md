# jev-tape wiki

Static reader for the jev-tape wiki. The source of truth is [`manutej/jev-tape/wiki`](https://github.com/manutej/jev-tape/tree/main/wiki); this repo only publishes it.

Not a live TypeSafe qualifier. No API keys.

```bash
node scripts/build.mjs ../jev-tape   # regenerates index.html; the header records the jev-tape commit it was built from
node .jev/check.mjs                  # CI: fails on a placeholder or near-empty page
```

The page count and any broken `[[links]]` are printed in the page footer; nothing is dropped silently.
The cross-repo contract is in [`.jev/README.md`](.jev/README.md).

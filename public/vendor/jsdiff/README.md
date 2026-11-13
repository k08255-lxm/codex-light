# jsdiff 9.0.0

Unmodified ESM files from the official `diff` package, matching the dependency bundled with the installed DSH runtime. Only the `diffLines` dependency closure is included: `diff/base.js`, `diff/line.js`, and `util/params.js`.

Source: https://github.com/kpdecker/jsdiff/tree/v9.0.0

`src/dsh-changes.mjs` uses this library to count additions and removals in DSH's applied edit fragments. These counts describe cumulative edits, not a workspace net diff. The upstream BSD license is included in `LICENSE`.

## [1.7.0](https://github.com/GMOD/shared-read-cache/compare/v1.6.0...v1.7.0) (2026-08-21)

### Bug Fixes

- Release a caller when its own signal aborts, not when the shared read lands ([3db7f9d](https://github.com/GMOD/shared-read-cache/commit/3db7f9d8df2ea7f567b532257aede3995de92b53))
- A value sizeOf cannot weigh fails its read rather than the process ([750e79f](https://github.com/GMOD/shared-read-cache/commit/750e79f067f6192f6dd9872e3223b7a4e85b87fd))
- A batch ends when its last read settles, and abandoned reads do not defer it ([2a7ea52](https://github.com/GMOD/shared-read-cache/commit/2a7ea522258634bb30d6ade203e5ca0d4faabf75))
- One recency counter per budget, not one per copy of the module ([e327d10](https://github.com/GMOD/shared-read-cache/commit/e327d10b75e6f75decac0822f64a750b293c99c3))
- A size that is not a weight fails its read ([1ff41e8](https://github.com/GMOD/shared-read-cache/commit/1ff41e82f2bcd1f8b876e080d52b764fb18dd547))
- Has() agrees with the other lookups about an abandoned read ([8f2ab66](https://github.com/GMOD/shared-read-cache/commit/8f2ab6693b55b75454fefe42deca0b7abcab5680))

### Chores

- Keep agent worktrees out of the toolchain's way ([dd7ec1f](https://github.com/GMOD/shared-read-cache/commit/dd7ec1f4dcd54ec86afbb5b165797754c1b8e073))

### Documentation

- Put the README in the active voice ([befc19e](https://github.com/GMOD/shared-read-cache/commit/befc19ef440571d1dafed4dbfa60a10c8e9473b7))
- Correct the release command in CONTRIBUTING, and its voice ([323aac9](https://github.com/GMOD/shared-read-cache/commit/323aac9af1c80bfbcea4b13ae8b1e813cb983930))
- A docs/ folder — the get() path, memory, and an API reference ([74018c6](https://github.com/GMOD/shared-read-cache/commit/74018c671b0ef4c4f8ba8825880e66e0e79a80e7))
- Link the consumers, and each measurement to where it was taken ([e60720a](https://github.com/GMOD/shared-read-cache/commit/e60720a16d5c80c777e57cfddc534fdd4c8785a7))

### Other Changes

- Misc ([63eac3c](https://github.com/GMOD/shared-read-cache/commit/63eac3c92b2ae5952289ad26eac680e1c38b4ab2))

### Tests

- Random operation sequences over the accounting invariants ([06512e8](https://github.com/GMOD/shared-read-cache/commit/06512e8fcdc16ab52bed96fdcc5401ee29287370))

## [1.6.0](https://github.com/GMOD/shared-read-cache/compare/v1.5.1...v1.6.0) (2026-08-14)

### Bug Fixes

- The budget compared seqs describing entries it was not offered ([7d8d6da](https://github.com/GMOD/shared-read-cache/commit/7d8d6da383bad0b651476896b60205579336fc31))
- An unlimited budget never pruned its collected members ([b6bad58](https://github.com/GMOD/shared-read-cache/commit/b6bad584f3d02d52e0c2a6ec75872bbcbd8f60d5))

### Chores

- Render only the commit subject, and link the commit ([f00b82f](https://github.com/GMOD/shared-read-cache/commit/f00b82f3a7545044848d6b912766916e4c2cdc1e))
- Create a GitHub release for each published tag ([0a260a5](https://github.com/GMOD/shared-read-cache/commit/0a260a50ce3c5ba4635ed7862a182a03a26788e8))
- Enforce type strippability in tsconfig ([7358ecb](https://github.com/GMOD/shared-read-cache/commit/7358ecb801d99590c9f8d3615e3585811b38abb8))

### Features

- The constructor takes no options at all ([317ca60](https://github.com/GMOD/shared-read-cache/commit/317ca60375a826697732178fff1279f827560f40))

### Refactoring

- Drop an entry before touching it, not after ([c14fa68](https://github.com/GMOD/shared-read-cache/commit/c14fa68e44a5b39ef8724068e25c91289c5f93c2))

## [1.5.1](https://github.com/GMOD/shared-read-cache/compare/v1.5.0...v1.5.1) (2026-08-10)

### Chores

- Gate preversion on format:check, as CI does
- Gate preversion on typecheck too, as CI does
- Converge package.json on the shape its siblings use

### Other Changes

- Revert "chore: converge package.json" — the CHANGELOG prettier step ([b862fe8](https://github.com/GMOD/shared-read-cache/commit/b862fe8a8a0df2c6af4c94222fca0f56201096ed))

## [1.5.0](https://github.com/GMOD/shared-read-cache/compare/v1.4.4...v1.5.0) (2026-08-10)

### Bug Fixes

- The sweep timer runs when there is something to reclaim, not while entries exist

### Documentation

- A budget's members must all weigh in the same unit

### Features

- A budget several caches share, evicted globally least-recently-used

## [1.4.4](https://github.com/GMOD/shared-read-cache/compare/v1.4.3...v1.4.4) (2026-08-09)

## [1.4.3](https://github.com/GMOD/shared-read-cache/compare/v1.4.2...v1.4.3) (2026-08-06)

### Bug Fixes

- A live duck-typed signal is no longer a TypeError

## [1.4.2](https://github.com/GMOD/shared-read-cache/compare/v1.4.1...v1.4.2) (2026-08-06)

### Documentation

- Stop citing @gmod/cram as the case FOR the batch policy

## [1.4.1](https://github.com/GMOD/shared-read-cache/compare/v1.4.0...v1.4.1) (2026-08-06)

### Refactoring

- Pull the unref duck-type out of startSweep

## [1.4.0](https://github.com/GMOD/shared-read-cache/compare/v1.3.0...v1.4.0) (2026-08-06)

### Features

- IdleTimeoutMs, to reclaim what a parked consumer is sitting on

## [1.3.0](https://github.com/GMOD/shared-read-cache/compare/v1.2.0...v1.3.0) (2026-08-06)

## [1.2.0](https://github.com/GMOD/shared-read-cache/compare/...v1.2.0) (2026-08-06)

### Chores

- Let npm publish stop auto-correcting repository.url
- Exempt our own packages from the release quarantine
- Bump pnpm/action-setup to v6.0.10
- Run the test suite as `pnpm test --run`

### Features

- A promise cache whose shared reads honour every caller's signal
- A batch eviction policy, a per-call fill, and getIfCached
- **BREAKING** No budget unless you ask for one


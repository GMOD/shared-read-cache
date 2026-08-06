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


# Contributing

## Development

```sh
pnpm install
pnpm test
pnpm build
```

```sh
pnpm version patch  # or minor/major
```

`pnpm version patch` runs lint, format, types, tests and build, regenerates
CHANGELOG.md with git-cliff, then pushes the tag, which triggers the publish
workflow.

[docs/api.md](docs/api.md) is written by hand, and `test/apiDocs.test.ts` fails
when a public member of `SharedReadCache`, `SharedBudget`, their options and
budget interfaces, or an export, is missing from it. Document the new member, or
add it to the test's `undocumented` list with the reason it is internal.

## Diagrams

`docs/img/*.svg` is generated from the `.dot` beside it and committed, since
GitHub does not render DOT. If you edit a `.dot`, re-render it:

```sh
dot -Tsvg docs/img/dataflow.dot -o docs/img/dataflow.svg
dot -Tsvg docs/img/eviction.dot -o docs/img/eviction.svg
```

CI does not check the SVGs, because graphviz is not a dependency and different
versions emit cosmetically different SVG. A CI check would fail on the graphviz
version rather than on the content.

## Publishing

Releases publish automatically via GitHub Actions using npm trusted publishing
(OIDC, no stored token). The publish job needs `id-token: write`; trusted
publishing attaches provenance without a `--provenance` flag.

Trusted publishing is already configured for this repo. To set up a new package:
`npm trust github <pkg> --file publish.yml --repo GMOD/<repo>` (requires
npm >=11.10.0 and 2FA).

Once npm publish succeeds, the `release` job creates the GitHub release for the
tag. `scripts/release-notes.sh` extracts the notes from that version's
CHANGELOG.md section; run it with a version to preview a release's notes.

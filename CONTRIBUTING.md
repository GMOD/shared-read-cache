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

That runs lint, format, types, tests and build, regenerates CHANGELOG.md with
git-cliff, then pushes the tag, which triggers the publish workflow.

## Diagrams

`docs/img/*.svg` is generated from the `.dot` beside it and committed, since
GitHub does not render DOT. If you edit a `.dot`, re-render it:

```sh
dot -Tsvg docs/img/dataflow.dot -o docs/img/dataflow.svg
dot -Tsvg docs/img/eviction.dot -o docs/img/eviction.svg
```

Nothing checks this — graphviz is not a dependency, and different versions emit
cosmetically different SVG, so a CI check would fail on the version rather than
on the content.

## Publishing

Releases publish automatically via GitHub Actions using npm trusted publishing
(OIDC, no stored token). The workflow requires `--provenance` and
`id-token: write` permissions.

This repo is already configured. To set up a new package:
`npm trust github <pkg> --file publish.yml --repo GMOD/<repo>` (requires
npm >=11.10.0 and 2FA).

Once npm publish succeeds, the `release` job creates the GitHub release for the
tag, taking its notes from that version's CHANGELOG.md section — which
`scripts/release-notes.sh` extracts, so run that with a version to preview what
a release will say.

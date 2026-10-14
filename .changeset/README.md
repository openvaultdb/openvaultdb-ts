# Changesets

Every pull request that should release a package must include a changeset:

```sh
pnpm changeset
```

Choose `patch`, `minor`, or `major` for each changed package and describe the
user-visible change. Merging ordinary changesets updates the automated version
pull request; merging that pull request publishes.

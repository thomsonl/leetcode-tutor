# Release notes

The Changelog tab in the extension's options page shows these notes.
Write one file per version, named after it, for example `1.4.0.md`.

The file starts with a date line, then a blank line, then one bullet per line:

```
date: 2026-11-18

- Added something you can see.
- Fixed something that was wrong.
```

Write for the person using the extension, in the past tense, with no dashes.
Then regenerate the data file the tab reads:

```sh
node extension/scripts/changelog.mjs
```

`extension/changelog.json` is generated.
Never edit it by hand: a test fails when it does not match these notes.
The tab only lists versions up to the one that is running, so notes for the next version can be written ahead of the release.
Before a release, make sure `<version>.md` exists for the version in `extension/manifest.json`; a test checks that too.

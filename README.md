# 3lib-orchestrator

3lib-orchestrator is library that allows for downloading and copying files from github artifacts or from local folders.

if your project relies on using 3suite utilities, 3lib-orchestrator can help managing that. the best ways to use this library are through either [3suite-maestro](https://github.com/3sig/3suite-maestro) or [3suite-orchestrator-project-template](https://github.com/3sig/3suite-orchestrator-project-template).

See either of those projects for examples on how to use this library.

See `orchestrator.json5` for configuration examples, and read through the architecture section.

## Source actions

Processes can declare a `sourceActions` array, which runs a series of actions on a source file after it is fetched (downloaded from a github release, or copied from a local folder). Actions run in the order they appear.

- `unzip` — unzips the fetched file into `devDependenciesLocation`.
- `chmod` — makes a file executable. Uses the fetched file by default, or the file named in `file`.
- `move` — moves the fetched file into a subfolder of `devDependenciesLocation`. Requires `location`; `filename` optionally renames the file.
- `command` — runs an arbitrary shell command (via the system shell, with live output). Requires `command`. Runs in the process's `localPath` if set, otherwise in `devDependenciesLocation`.

For `local` sources, actions run on every `setupDev()` call. For `github` sources, actions run only when a new release is downloaded — they are skipped when the source is already up to date, just like the download itself. A non-zero command exit aborts `setupDev()` before `deps.json` and `config.json5` are written.

example:

```json5
{
  name: "my-tool",
  source: "org/my-tool",
  sourceActions: [
    { type: "unzip" },
    { type: "chmod", file: "my-tool" },
    { type: "command", command: "bun install" },
  ],
}
```

## Architecture

`3lib-orchestrator` works by taking in a configuration file modeled after the configuration for [3suite-orchestrator](https://github.com/3sig/3suite-orchestrator). it uses special configuration keys to specify which process entries need to be downloaded. it then replaces those configuration keys with the proper exec commands for the downloaded files.

once 3lib-orchestrator has downloaded the files, the downloaded 3suite-orchestrator can be run. if 3lib-orchestrator is run again, it will check for updates to the downloaded files and replace them if necessary. update checks are done by looking for newer releases on the linked github repositories.

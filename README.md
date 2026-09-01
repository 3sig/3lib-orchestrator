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

### sourceSetupActions (pre-match setup)

Processes can also declare a `sourceSetupActions` array, which runs **before** the source file is matched by the platform binary / `sourceFilePattern` logic. This is for preparing the source, e.g. building a binary into `localPath` so the match step can find it.

- Only `command` actions are supported — the source file has not been matched yet, so `unzip`/`chmod`/`move` have no file to act on. Any other type throws.
- `command` runs in the process's `localPath` if set, otherwise in `devDependenciesLocation` — same as `command` in `sourceActions`.
- Timing follows the fetch step: `local` sources run it on every `setupDev()` call; `github` sources only when a new release is downloaded (skipped when up to date, like everything else in that step).
- `%processName%` references are **not** resolved in `sourceSetupActions` — filenames are only known after matching. Strings pass through raw.

## Cross-process references

To refer to another process's filename, surround its `name` with percents: `%processName%`.

- Resolves to the bare filename in `devDependenciesLocation` as downloaded/copied, before that process's own source actions run (e.g. `%httpServer%` → `3suite-http-server_v1.0.1_osx-arm`). Add any prefix you need at the reference site.
- References are resolved in every string of a process's `sourceActions`, its `config`, its `sourceExecOverride`, and the top-level `configs` map.
- Unknown names are left as-is, so shell env vars like `%USERPROFILE%` inside `command` actions keep working.

## Dev overrides

If a dev override file exists next to your orchestrator config, orchestrator merges it on top of the base config before resolving dependencies and generating `config.json5`. The name is derived from the base config filename by inserting `.dev` before the extension: the default `orchestrator.json5` picks up **`orchestrator.dev.json5`**, and any custom filename passed to orchestrator gets the same treatment (e.g. `my-config.json5` → `my-config.dev.json5`).


- **Objects** (top-level keys, nested objects like `configs`) merge by key: values in the dev file overwrite the base, and keys missing from the dev file keep the base value.
- **`processes`** merge per element, matched by `name`:
  - Base order is preserved. A matched entry is merged field-by-field, so only the fields you list in the dev entry change.
  - A dev entry whose `name` matches no base process is **appended** to the end of `processes` as a new process, with a console warning naming it. This lets dev files add local-only processes.
  - A dev entry without a `name` throws, since there's no way to identify which process it targets. Base entries without a `name` are left untouched (unmatchable).
- **Arrays** are replaced when present in the dev file.

## Architecture

`3lib-orchestrator` works by taking in a configuration file modeled after the configuration for [3suite-orchestrator](https://github.com/3sig/3suite-orchestrator). it uses special configuration keys to specify which process entries need to be downloaded. it then replaces those configuration keys with the proper exec commands for the downloaded files.

once 3lib-orchestrator has downloaded the files, the downloaded 3suite-orchestrator can be run. if 3lib-orchestrator is run again, it will check for updates to the downloaded files and replace them if necessary. update checks are done by looking for newer releases on the linked github repositories.

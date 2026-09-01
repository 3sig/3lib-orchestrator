// Tests for cross-process %processName% references.
//
// The integration part uses only local sources (no GitHub downloads); the
// only network call is the 3suite-orchestrator release check that every
// setupDev run performs, and even that is satisfied from a pre-seeded
// deps.json so the large orchestrator binary is never downloaded.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as fleece from "golden-fleece";
import * as Octokit from "octokit";
import orchestrator from "./main.js";

const { setupDev, substituteProcessReferences } = orchestrator;

let failures = 0;

function assertEqual(actual, expected, label) {
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText === expectedText) {
    console.log("PASS:", label);
  } else {
    failures++;
    console.error("FAIL:", label);
    console.error("  expected:", expectedText);
    console.error("  actual:  ", actualText);
  }
}

function assert(condition, label) {
  if (condition) {
    console.log("PASS:", label);
  } else {
    failures++;
    console.error("FAIL:", label);
  }
}

// --- unit: string substitution ---
const filenameMap = {
  httpServer: "3suite-http-server_v1.0.1_osx-arm",
  "a-tool": "a-tool-bin",
};

assertEqual(
  substituteProcessReferences("%httpServer%", filenameMap),
  "3suite-http-server_v1.0.1_osx-arm",
  "exact reference"
);
assertEqual(
  substituteProcessReferences("./%httpServer%", filenameMap),
  "./3suite-http-server_v1.0.1_osx-arm",
  "reference embedded in a path"
);
assertEqual(
  substituteProcessReferences("%httpServer% and %a-tool%", filenameMap),
  "3suite-http-server_v1.0.1_osx-arm and a-tool-bin",
  "multiple references in one string"
);
assertEqual(
  substituteProcessReferences("%unknown%", filenameMap),
  "%unknown%",
  "unknown reference left as-is"
);
assertEqual(
  substituteProcessReferences("%USERPROFILE%\\foo", filenameMap),
  "%USERPROFILE%\\foo",
  "windows env var left as-is"
);
assertEqual(
  substituteProcessReferences("100% and %% and a lone %", filenameMap),
  "100% and %% and a lone %",
  "lone/empty percents untouched"
);
assertEqual(substituteProcessReferences(42, filenameMap), 42, "non-string passthrough (number)");
assertEqual(substituteProcessReferences(null, filenameMap), null, "non-string passthrough (null)");

// --- unit: recursive substitution ---
assertEqual(
  substituteProcessReferences(
    {
      config: { ref: "%httpServer%", nested: { list: ["%a-tool%", "plain"] } },
      actions: [{ type: "chmod", file: "./%httpServer%" }],
    },
    filenameMap
  ),
  {
    config: { ref: "3suite-http-server_v1.0.1_osx-arm", nested: { list: ["a-tool-bin", "plain"] } },
    actions: [{ type: "chmod", file: "./3suite-http-server_v1.0.1_osx-arm" }],
  },
  "recursive object/array substitution"
);

// --- integration: cross-process references through setupDev ---
async function integrationTest() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "3lib-orchestrator-refs-"));
  const sourcesADir = path.join(tmpRoot, "sources-a");
  const sourcesBDir = path.join(tmpRoot, "sources-b");
  const depsDir = path.join(tmpRoot, "deps");

  fs.mkdirSync(sourcesADir);
  fs.mkdirSync(sourcesBDir);
  fs.writeFileSync(path.join(sourcesADir, "a-tool-bin"), "#!/bin/sh\necho a\n");
  fs.writeFileSync(path.join(sourcesBDir, "b-tool-bin"), "#!/bin/sh\necho b\n");

  // Seed the 3suite-orchestrator bootstrap entry so setupDev skips the
  // large orchestrator binary download.
  const octokit = new Octokit.Octokit();
  const { data: releases } = await octokit.request("GET /repos/3sig/3suite-orchestrator/releases");
  const latestRelease = releases.sort((a, b) => b.published_at - a.published_at)[0];

  fs.mkdirSync(depsDir);
  fs.writeFileSync(
    path.join(depsDir, "deps.json"),
    JSON.stringify({
      "3sig/3suite-orchestrator": { url: latestRelease.url, filename: "orchestrator-stub" },
    })
  );

  const configPath = path.join(tmpRoot, "orchestrator.json5");
  fs.writeFileSync(
    configPath,
    `{
      devDependenciesLocation: ${JSON.stringify(depsDir)},
      processes: [
        {
          name: "a-tool",
          sourceType: "local",
          localPath: ${JSON.stringify(sourcesADir)},
          sourceFileType: "pattern-match",
          sourceFilePattern: "a-tool-*",
        },
        {
          name: "b-tool",
          sourceType: "local",
          localPath: ${JSON.stringify(sourcesBDir)},
          sourceFileType: "pattern-match",
          sourceFilePattern: "b-tool-*",
          sourceActions: [
            { type: "command", command: "echo %a-tool% > ../deps/ref-check.txt" },
          ],
          config: { ref: "%a-tool%" },
        },
      ],
      configs: {
        other: { binary: "./%a-tool%" },
      },
    }`
  );

  await setupDev(configPath);

  // The command action ran with the cross-process reference resolved.
  const refCheck = fs.readFileSync(path.join(depsDir, "ref-check.txt"), "utf8").trim();
  assertEqual(refCheck, "a-tool-bin", "command action resolved cross-process reference");

  // The generated config.json5 has references resolved in the process
  // config, the sourceActions, and the top-level configs map.
  const generatedText = fs.readFileSync(path.join(depsDir, "config.json5"), "utf8");
  const generated = await fleece.evaluate(generatedText);
  const aTool = generated.processes.find(p => p.name === "a-tool");
  const bTool = generated.processes.find(p => p.name === "b-tool");
  assertEqual(aTool.exec, "./a-tool-bin", "a-tool exec unaffected");
  assertEqual(bTool.exec, "./b-tool-bin", "b-tool exec unaffected");
  assertEqual(bTool.config.ref, "a-tool-bin", "process config reference resolved");
  assertEqual(
    bTool.sourceActions[0].command,
    "echo a-tool-bin > ../deps/ref-check.txt",
    "sourceActions reference resolved in generated config"
  );
  assertEqual(generated.configs.other.binary, "./a-tool-bin", "top-level configs reference resolved");
  assert(!generatedText.includes("%a-tool%"), "no raw references left in generated config");
  assert(
    fs.readFileSync(configPath, "utf8").includes("%a-tool%"),
    "input config keeps raw references"
  );

  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

async function main() {
  await integrationTest();

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll tests passed");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

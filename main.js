import * as fleece from "golden-fleece";
import * as Octokit from "octokit";
import * as fs from "fs";
import { spawn } from 'child_process';
import { Readable } from "stream";

let configFile = fs.readFileSync('orchestrator.json5', 'utf8');
let config = fleece.evaluate(configFile);
console.log(config);

// Using spawn (better for large files, real-time output)
function unzipWithSpawn(zipPath, outputDir) {
  return new Promise((resolve, reject) => {
    const process = spawn('unzip', ['-o', zipPath, '-d', outputDir]);

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data) => {
      stdout += data.toString();
      console.log(`stdout: ${data}`);
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
      console.log(`stderr: ${data}`);
    });

    process.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Unzip process exited with code ${code}: ${stderr}`));
      }
    });

    process.on('error', (err) => {
      reject(new Error(`Failed to start unzip process: ${err.message}`));
    });
  });
}

function getExistingDependencies() {
  let devDependenciesLocation = (config["devDependenciesLocation"] || ".");
  let existingDependencies = {};
  if (!fs.existsSync(devDependenciesLocation + "/deps.json")) {
    fs.writeFileSync(devDependenciesLocation + "/deps.json", JSON.stringify(existingDependencies));
  }
  let existingDependenciesFile = fs.readFileSync(devDependenciesLocation + "/deps.json", 'utf8');

  existingDependencies = JSON.parse(existingDependenciesFile);

  return existingDependencies;
}

async function getDependency(process, existingDependencies) {
  let currentPlatform = getCurrentPlatform();
  let latestRelease = await getLatestRelease(process.source);
  let devDependenciesLocation =   (config["devDependenciesLocation"] ||  ".");

  if (existingDependencies[process.source]?.url == latestRelease.url) {
    console.log("Already up to date:", process.source);
  }
  else {
    let filename = await getPlatformBinary(latestRelease, currentPlatform);
    let downloadFileName = devDependenciesLocation + "/" + filename;
    for (let sourceAction of process.sourceActions) {
      if (sourceAction.type == "unzip") {
        console.log("Unzipping", downloadFileName);
        await unzipWithSpawn(downloadFileName, devDependenciesLocation);
        console.log("Unzipped", downloadFileName);
      } else if (sourceAction.type == "chmod") {
        let chmodFile =
          devDependenciesLocation + "/" + (sourceAction.file || filename);
        fs.chmodSync(chmodFile, 0o755);
      }
    }
    existingDependencies[process.source] = {
      url: latestRelease.url,
      filename: filename,
    };
  }

  process.exec = process.sourceExecOverride || "./" + existingDependencies[process.source].filename;

  delete process.source;
  delete process.sourceAction;
  delete process.sourceExecOverride;
}

async function getDependencies() {
  let devDependenciesLocation =   (config["devDependenciesLocation"] ||  ".");

  if (!fs.existsSync(devDependenciesLocation)) {
    fs.mkdirSync(devDependenciesLocation);
  }
  let existingDependencies = await getExistingDependencies();

  let currentPlatform = getCurrentPlatform();

  await getDependency({source: "3sig/3suite-orchestrator", sourceActions: [{type: "chmod"}]}, existingDependencies)

  // let latestOrchestratorRelease = await getLatestRelease(
  //   "3sig/3suite-orchestrator",
  // );
  // let orchestratorFilename = await getPlatformBinary(
  //   latestOrchestratorRelease,
  //   getCurrentPlatform(),
  // );

  // fs.chmodSync(devDependenciesLocation + "/" + orchestratorFilename, 0o755);

  let processes = structuredClone(config["processes"] || []);
  let dependencies = [];

  let getBinaryPromises = [];
  for (let process of processes) {
    if (process.source) {
      dependencies.push(process);
    }
    console.log("a", process);

    getBinaryPromises.push(getDependency(process, existingDependencies));

    console.log("b", process);
  }

  await Promise.all(getBinaryPromises);

  fs.writeFileSync(
    devDependenciesLocation + "/deps.json",
    JSON.stringify(existingDependencies, null, 2)
  );

  return processes;
}

async function getLatestRelease(repo) {
  const octokit = new Octokit.Octokit();

  let releaseResponse = await octokit.request(`GET /repos/${repo}/releases`);

  let releases = releaseResponse.data;
  let latestRelease = releases.sort(
    (a, b) => b.published_at - a.published_at,
  )[0];

  console.log(repo, latestRelease.name);
  return latestRelease;
}

async function getPlatformBinary(release, platform) {
  for (let asset of release.assets) {
    if (asset.name.includes(platform)) {
      const url = asset.browser_download_url;
      let fileName = url.split("/").pop();
      let downloadFileName =
          (config["devDependenciesLocation"] ||  ".") + "/" + fileName;
      const resp = await fetch(url);

      if (resp.ok && resp.body) {
        console.log("Writing to file:", downloadFileName);
        let writer = fs.createWriteStream(downloadFileName);
        let readable = Readable.fromWeb(resp.body).pipe(writer);

        await new Promise((resolve, reject) => {
          readable.on("finish", resolve);
          readable.on("error", reject);
        });

        console.log(downloadFileName, "written successfully");
        return fileName;
      }
    }
  }
}

function getCurrentPlatform() {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") {
      return "osx-arm";
    } else {
      return "osx-x64";
    }
  } else if (process.platform === "win32") {
    return "win";
  } else if (process.platform === "linux") {
    if (process.arch === "arm64") {
      return "linux-arm";
    } else {
      return "linux";
    }
  }
}

async function setupDev() {
  let processes = await getDependencies();

  //read config.json5
  let orchestratorConfigText = fs.readFileSync("orchestrator.json5", "utf8");
  let orchestratorConfig = await fleece.evaluate(orchestratorConfigText);

  let patchedConfig = fleece.patch(orchestratorConfigText, {
    ...orchestratorConfig,
    processes,
  });
  fs.writeFileSync(
    (config["devDependenciesLocation"] ||  ".") + "/config.json5",
    patchedConfig,
  );
}

export default {
  setupDev,
};

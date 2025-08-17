import * as fleece from "golden-fleece";
import * as Octokit from "octokit";
import * as fs from "fs";
import { spawn } from 'child_process';
import { Readable } from "stream";

let configFile = fs.readFileSync('orchestrator.json5', 'utf8');
let config = fleece.evaluate(configFile);

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
  let devDependenciesLocation = (config["devDependenciesLocation"] || ".");

  const sourceType = process.sourceType || "github";

  if (sourceType === "local") {
    await getDependencyFromLocal(process, existingDependencies, currentPlatform, devDependenciesLocation);
  } else {
    await getDependencyFromGitHub(process, existingDependencies, currentPlatform, devDependenciesLocation);
  }
}

async function processSourceActions(sourceActions, filename, devDependenciesLocation) {
  if (!sourceActions || sourceActions.length === 0) {
    return;
  }

  for (let sourceAction of sourceActions) {
    if (sourceAction.type == "unzip") {
      const targetFileName = devDependenciesLocation + "/" + filename;
      console.log("Unzipping", targetFileName);
      await unzipWithSpawn(targetFileName, devDependenciesLocation);
      console.log("Unzipped", targetFileName);
    } else if (sourceAction.type == "chmod") {
      let chmodFile = devDependenciesLocation + "/" + (sourceAction.file || filename);
      fs.chmodSync(chmodFile, 0o755);
    } else if (sourceAction.type == "move") {
      if (!sourceAction.location) {
        throw new Error("location is required for move action");
      }

      const sourceFile = devDependenciesLocation + "/" + filename;
      const targetFilename = sourceAction.filename || filename;
      const targetLocation = devDependenciesLocation + "/" + sourceAction.location;
      const targetFile = targetLocation + "/" + targetFilename;

      // Create target directory if it doesn't exist
      if (!fs.existsSync(targetLocation)) {
        fs.mkdirSync(targetLocation, { recursive: true });
        console.log("Created directory:", targetLocation);
      }

      console.log("Moving", sourceFile, "to", targetFile);
      fs.renameSync(sourceFile, targetFile);
      console.log("Moved to:", targetFile);
    }
  }
}

function setProcessExec(process, dependencyKey, existingDependencies) {
  process.exec = process.sourceExecOverride || "./" + existingDependencies[dependencyKey].filename;
}

function cleanupProcessObject(process) {
  delete process.localPath;
  delete process.sourceType;
  delete process.source;
  delete process.sourceAction;
  delete process.sourceExecOverride;
}

async function getDependencyFromGitHub(process, existingDependencies, currentPlatform, devDependenciesLocation) {
  let latestRelease = await getLatestRelease(process.source);

  if (existingDependencies[process.source]?.url == latestRelease.url) {
    console.log("Already up to date:", process.source);
  }
  else {
    let filename = await getPlatformBinary(latestRelease, currentPlatform, process);
    await processSourceActions(process.sourceActions, filename, devDependenciesLocation);
    existingDependencies[process.source] = {
      url: latestRelease.url,
      filename: filename,
    };
  }

  setProcessExec(process, process.source, existingDependencies);
  cleanupProcessObject(process);
}

async function getDependencyFromLocal(process, existingDependencies, currentPlatform, devDependenciesLocation) {
  const localPath = process.localPath;
  if (!localPath) {
    throw new Error("localPath is required when sourceType is 'local'");
  }

  if (!fs.existsSync(localPath)) {
    throw new Error(`Local path does not exist: ${localPath}`);
  }

  let filename = await getLocalPlatformBinary(localPath, currentPlatform, process, devDependenciesLocation);
  await processSourceActions(process.sourceActions, filename, devDependenciesLocation);

  existingDependencies[localPath] = {
    path: localPath,
    filename: filename,
  };

  setProcessExec(process, localPath, existingDependencies);
  cleanupProcessObject(process);
}

async function getDependencies() {
  let devDependenciesLocation =   (config["devDependenciesLocation"] ||  ".");

  if (!fs.existsSync(devDependenciesLocation)) {
    fs.mkdirSync(devDependenciesLocation);
  }
  let existingDependencies = await getExistingDependencies();

  await getDependency({source: "3sig/3suite-orchestrator", sourceActions: [{type: "chmod"}]}, existingDependencies)

  let processes = structuredClone(config["processes"] || []);
  let currentPlatform = getCurrentPlatform();
  
  // Apply platform-specific configuration to each process
  processes = processes.map(process => applyPlatformConfigToProcess(process, currentPlatform));
  
  let dependencies = [];

  let getBinaryPromises = [];
  for (let process of processes) {
    if (process.source || process.localPath) {
      dependencies.push(process);
    }

    getBinaryPromises.push(getDependency(process, existingDependencies));
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

  return latestRelease;
}

function wildcardToRegex(pattern) {
  return new RegExp(
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\*?]/g, '\\$&')
      .replace(/\\\*/g, '.*')
      .replace(/\\\?/g, '.') +
    '$'
  );
}

async function getLocalPlatformBinary(localPath, platform, process = {}, devDependenciesLocation) {
  const sourceFileType = process.sourceFileType || "platform-binary";

  const files = fs.readdirSync(localPath);

  for (let fileName of files) {
    let matches = false;

    if (sourceFileType === "pattern-match") {
      if (!process.sourceFilePattern) {
        throw new Error(`sourceFilePattern is required when sourceFileType is "pattern-match"`);
      }
      const regex = wildcardToRegex(process.sourceFilePattern);
      matches = regex.test(fileName);
    } else {
      matches = fileName.includes(platform);
    }

    if (matches) {
      const sourcePath = localPath + "/" + fileName;
      const targetPath = devDependenciesLocation + "/" + fileName;

      console.log("Copying from local:", sourcePath, "to", targetPath);
      fs.copyFileSync(sourcePath, targetPath);
      console.log("Copy completed:", fileName);

      return fileName;
    }
  }

  throw new Error(`No matching file found in ${localPath} for platform ${platform} with sourceFileType ${sourceFileType}`);
}

async function getPlatformBinary(release, platform, process = {}) {
  const sourceFileType = process.sourceFileType || "platform-binary";

  for (let asset of release.assets) {
    let matches = false;

    if (sourceFileType === "pattern-match") {
      if (!process.sourceFilePattern) {
        throw new Error(`sourceFilePattern is required when sourceFileType is "pattern-match"`);
      }
      const regex = wildcardToRegex(process.sourceFilePattern);
      matches = regex.test(asset.name);
    } else {
      matches = asset.name.includes(platform);
    }

    if (matches) {
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

function deepMerge(target, source) {
  const result = { ...target };
  
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  
  return result;
}

function applyPlatformConfigToProcess(process, currentPlatform) {
  if (!process.sourcePlatformConfig || !process.sourcePlatformConfig[currentPlatform]) {
    return process;
  }
  
  const platformConfig = process.sourcePlatformConfig[currentPlatform];
  const mergedProcess = deepMerge(process, platformConfig);
  
  delete mergedProcess.sourcePlatformConfig;
  
  return mergedProcess;
}

async function setupDev() {
  let processes = await getDependencies();

  // Filter out processes that shouldn't be included in the final config
  let finalProcesses = processes.filter(process => !process.sourceExclude);

  //read config.json5
  let orchestratorConfigText = fs.readFileSync("orchestrator.json5", "utf8");
  let orchestratorConfig = await fleece.evaluate(orchestratorConfigText);

  let patchedConfig = fleece.patch(orchestratorConfigText, {
    ...orchestratorConfig,
    processes: finalProcesses,
  });
  fs.writeFileSync(
    (config["devDependenciesLocation"] ||  ".") + "/config.json5",
    patchedConfig,
  );
}

export default {
  setupDev,
};

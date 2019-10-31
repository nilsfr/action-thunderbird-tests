/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2019 */

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";
import * as github from "@actions/github";

// The tool cache tries to remove the env variables on import, so we have to do our command line
// setup first. This would normally just be: import * as tc from "@actions/tool-cache";
var tc;

import path from "path";
import fs from "fs-extra";
import request from "request-promise-native";
import readline from "readline";
import { URL } from "url";
import yargs from "yargs";

import CheckRun from "./checkrun";
import { findApp, execOut } from "./utils";

const PIP_PACKAGES = [
	"six==1.10.0",
	"vcversioner==2.16.0.0",
	"mozsystemmonitor==0.4",
	"jsonschema==2.5.1",
	"functools32==3.2.3-2",
	"psutil==5.4.3",
	"mock",
	"simplejson"
];

const DOWNLOAD_BASE_MAP = {
 nightly: "https://ftp.mozilla.org/pub/thunderbird/nightly/latest-comm-central",
 beta: "", // TODO
 release: ""
};

async function getBuildId(base, version, platform) {
  let info = await request({
    url: `${base}/thunderbird-${version}.en-US.${platform}.json`,
    json: true
  });

  return info.buildid;
}

async function getThunderbirdVersion(channel) {
  let versions = await request({
    uri: "https://product-details.mozilla.org/1.0/thunderbird_versions.json",
    json: true
  });

  switch (channel) {
    case "nightly": return versions.LATEST_THUNDERBIRD_NIGHTLY_VERSION;
    case "beta": return versions.LATEST_THUNDERBIRD_DEVEL_VERSION;
    case "release": return versions.LATEST_THUNDERBIRD_VERSION;
    default: return 0;
  }
}

function getPlatform() {
  let platform = {
    "darwin": "mac",
    "win32": "win32",
    "linux": "linux"
  }[process.platform];

  if (platform == "linux") {
    platform += "-" + {
      "x32": "i686",
      "x64": "x86_64"
    }[process.arch];
  }

  let suffix = {
    "mac": "dmg",
    "win32": "zip",
    "linux-i686": "tar.bz2",
    "linux-x86_64": "tar.bz2"
  }[platform];

  return { platform, suffix };
}

async function downloadAndExtract(url, destination) {
  let downloadPath = await tc.downloadTool(url);
  await fs.mkdirp(destination);
  core.debug(`Extracting ${url} to ${destination}`);

  if (url.endsWith(".dmg")) {
    let mountpoint = await fs.mkdtemp("undmg-");
    let hdiutil = await io.which("hdiutil", true);
    await exec.exec(hdiutil, ["attach", "-quiet", "-mountpoint", mountpoint, downloadPath]);
    let files = await fs.readdir(mountpoint);
    let app = files.find(file => file.endsWith(".app"));
    await fs.copy(path.join(mountpoint, app), path.join(destination, app));
    await exec.exec(hdiutil, ["detach", "-quiet", mountpoint]);
    await fs.remove(mountpoint);
  } else if (url.endsWith(".zip")) {
    await tc.extractZip(downloadPath, destination);
  } else if (url.endsWith(".tar.bz2")) {
    await tc.extractTar(downloadPath, destination, "xj");
  } else if (url.endsWith(".tar.gz")) {
    await tc.extractTar(downloadPath, destination, "xz");
  } else {
    throw new Error("Don't know how to handle " + url);
  }
}

async function download(channel, testTypes, destination) {
  let version = await getThunderbirdVersion(channel);
  let { platform, suffix } = getPlatform();
  let base = DOWNLOAD_BASE_MAP[channel];
  let buildId = await getBuildId(base, version, platform);
  let versionId = "0.0." + buildId;
  let testPackageName = "thunderbird-tests-" + testTypes.join("-");

  let testPath = tc.find(testPackageName, versionId, platform);
  let appPath = tc.find("thunderbird", versionId, platform);
  let binPath = appPath ? await findApp(appPath) : null;

  if (!testPath || !appPath) {
    testPath = path.join(destination, "tests");
    appPath = path.join(destination, "application");

    let promises = testTypes.map((testType) => {
      let testUrl = `${base}/thunderbird-${version}.en-US.${platform}.${testType}.tests.tar.gz`;
      return downloadAndExtract(testUrl, testPath);
    });

    promises.push(
      downloadAndExtract(`${base}/thunderbird-${version}.en-US.${platform}.${suffix}`, appPath)
    );

    await Promise.all(promises);

    // Copy xpcshell and components over to the binary path
    binPath = await findApp(appPath);
    await fs.copy(path.join(testPath, "bin", "xpcshell"), path.join(binPath, "xpcshell"));
    await fs.copy(path.join(testPath, "bin", "components"), path.join(binPath, "components"));

    // Cache directories
    testPath = await tc.cacheDir(testPath, testPackageName, versionId, platform);
    appPath = await tc.cacheDir(appPath, "thunderbird", versionId, platform);
  }

  return { testPath, appPath, binPath };
}

async function createXpcshellManifest(buildPath, testPath, targetManifest) {
  let lightning = path.join(testPath, "xpcshell/tests/comm/calendar/test/unit");

  let content = "[DEFAULT]\n" +
    `head = ${path.join(lightning, "head_libical.js")} ${path.join(lightning, "head_consts.js")}\n` +
    `[include:${path.relative(buildPath, targetManifest)}]`;

  let filename = path.join(buildPath, "xpcshell.ini");

  await fs.writeFile(filename, content);

  return filename;
}

async function parseLog(logFile, baseDir) {
  let rli = readline.createInterface({
    input: fs.createReadStream(logFile),
    terminal: false
  });
  let annotations = [];
  let pass = 0;
  let fail = 0;

  for await (let line of rli) {
    let data;
    try {
      data = JSON.parse(line);
    } catch (e) {
      continue;
    }

    if (data.action == "test_status" && data.status == "FAIL" && data.stack) {
      fail++;
      let stack = data.stack.split("\n");
      let [file, , lineNr] = stack[0].split(":");
      lineNr = parseInt(lineNr, 10);
      annotations.push({
        path: path.relative(baseDir, file),
        start_line: lineNr,
        end_line: lineNr,
        annotation_level: "failure",
        message: data.message,
        title: "Test failure: " + data.subtest
      });
    } else if (data.action == "test_status" && data.status == "PASS") {
      pass++;
    }
  }

  rli.close();

  return { pass, fail, annotations };
}

async function setupPython(venv, testPath) {
  let venvBin;
  try {
    venvBin = await io.which("virtualenv", true);
  } catch (e) {
    let userbase = await execOut(await io.which("python", true), ["-m", "site", "--user-base"]);
    venvBin = path.join(userbase, "bin", "virtualenv");
  }

  await exec.exec(await io.which("pip", true), ["install", "virtualenv"]);
  await exec.exec(venvBin, [venv]);

  let pip = path.join(venv, "bin", "pip");

  // install pip packages
  await exec.exec(pip, ["install", ...PIP_PACKAGES]);
  await exec.exec(
    pip,
    ["install", "-r", "mozbase_requirements.txt"],
    { cwd: path.join(testPath, "config") }
  );
  await exec.exec(pip, ["freeze"]);
}

async function main() {
  await setupEnv();
  tc = await import("@actions/tool-cache");

  let channel = core.getInput("channel", { required: true });
  let xpcshell = core.getInput("xpcshell");
  let buildout = path.join(process.env.GITHUB_WORKSPACE, "build");
  let repoBase = process.env.GITHUB_WORKSPACE; // TODO Docs say GITHUB_WORKSPACE is the parent to the repo, but in practice it is not.

  let testTypes = ["common"];
  if (xpcshell) {
    testTypes.push("xpcshell");
  }

  core.startGroup("Test harness setup");

  let { testPath, appPath, binPath } = await download(channel, testTypes, buildout);

  let venv = path.join(buildout, "venv");
  let python = path.join(venv, "bin", "python");

  if (await fs.pathExists(venv)) {
    core.warning(`${venv} already exists, skipping package setup`);
  } else {
    await setupPython(venv, testPath);
  }
  core.endGroup();

  // Run xpcshell tests
  if (xpcshell) {
    core.startGroup("xpcshell tests");
    core.debug("Running xpcshell tests");
    let pluginpath = path.join(await findApp(appPath, "Resources"), "plugins");
    let manifest = path.join(repoBase, xpcshell);
    let xpcshellLog = path.join(buildout, "xpcshell-log.txt");
    if (core.getInput("lightning") == "true") {
      manifest = await createXpcshellManifest(buildout, testPath, manifest);
    }

    let check = new CheckRun("xpcshell", github.context, core.getInput("token"));
    await check.create();

    try {
      await exec.exec(python, [
        path.join(testPath, "xpcshell", "runxpcshelltests.py"),
        "--log-raw", xpcshellLog,
        "--keep-going",
        "--setpref", "media.peerconnection.mtransport_process=false",
        "--setpref", "network.process.enabled=false",
        "--test-plugin-path", pluginpath,
        "--utility-path", path.join(testPath, "bin"),
        "--testing-modules-dir", path.join(testPath, "modules"),
        "--xpcshell", path.join(binPath, "xpcshell"),
        "--manifest", manifest,
        "--verbose",
      ]);
    } catch (e) {
      core.setFailed("xpcshell tests failed: " + e);
    }

    let { pass, fail, annotations } = await parseLog(xpcshellLog, repoBase);
    await check.complete(pass, fail, annotations);

    core.endGroup();
  }
}

async function setupEnv() {
  if (!process.env.GITHUB_ACTION) {
    // We are not running as a github action, so we'll assume we are running from the command line
    // and will fill nr environment to accommodate.

    let packageData = JSON.parse(await fs.readFile("package.json"));
    let repo = new URL(packageData.repository.url);

    if (repo.hostname != "github.com") {
      throw new Error("Repository details in package.json don't point to a github repo");
    }

    let argv = yargs
      .option("c", {
        alias: "channel",
        default: "nightly",
        describe: "The channel to run on",
        choices: Object.keys(DOWNLOAD_BASE_MAP)
      })
      .option("t", {
        alias: "token",
        default: "",
        describe: "The GitHub access token",
      })
      .option("lightning", {
        boolean: true,
        default: true,
        describe: "Enable Lightning when running tests (use --no-lightning to disable)"
      })
      .option("tempdir", {
        default: "build/tmp",
        describe: "The temporary directory for the runner"
      })
      .option("cachedir", {
        default: "build/cache",
        describe: "The tool cache directory for the runner"
      })
      .command("$0 <xpcshell>", "Run tests in the testing framework used by Thunderbird", (subyargs) => {
        subyargs.positional("xpcshell", {
          describe: "The path to the xpcshell.ini"
        });
      })
      .wrap(120)
      .argv;

    await Promise.all([fs.mkdirp(argv.cachedir), fs.mkdirp(argv.tempdir)]);

    let env = {
      GITHUB_WORKSPACE: process.cwd(),
      GITHUB_WORKFLOW: "action-thunderbird-tests",
      GITHUB_REPOSITORY: repo.pathname.substr(1).replace(/\.git$/i, ""),
      GITHUB_SHA: await execOut("git", ["rev-parse", "HEAD"]),

      INPUT_TOKEN: argv.token,
      INPUT_LIGHTNING: argv.lightning.toString(),
      INPUT_CHANNEL: argv.channel,
      INPUT_XPCSHELL: argv.xpcshell,
      RUNNER_TMP: path.resolve(argv.tempdir),
      RUNNER_TOOL_CACHE: path.resolve(argv.cachedir),
    };

    console.log("Using the following configuration:");
    console.log(env);

    process.env = Object.assign(process.env, env);
    console.log(process.env);
  }
}

main().catch((err) => {
  console.error(err);
  core.setFailed(err);
});

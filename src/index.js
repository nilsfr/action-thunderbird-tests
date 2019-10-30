/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2019 */

import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as tc from "@actions/tool-cache";
import * as io from "@actions/io";
import * as github from "@actions/github";

import path from "path";
import fs from "fs-extra";
import request from "request-promise-native";
import readline from "readline";

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

async function execOut(argv0, args, options={}) {
  let output = "";
  await exec.exec(await io.which("python", true), ["-m", "site", "--user-base"], {
    ...options,
    listeners: {
      stdout: (data) => {
        output += data.toString();
      }
    }
  });

  return output.trim();
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

  let testout = path.join(destination, "tests");
  let appout = path.join(destination, "application");

  let promises = testTypes.map((testType) => {
    let testUrl = `${base}/thunderbird-${version}.en-US.${platform}.${testType}.tests.tar.gz`;
    return downloadAndExtract(testUrl, testout);
  });

  promises.push(downloadAndExtract(
    `${base}/thunderbird-${version}.en-US.${platform}.${suffix}`,
    appout
 ));

  await Promise.all(promises);

  return { testPath: testout, appPath: appout };
}

async function findApp(base, container="MacOS") {
  if (process.platform == "darwin") {
    let files = await fs.readdir(base);
    let app = files.find(file => file.endsWith(".app"));

    return path.join(base, app, "Contents", container);
  } else {
    return path.join(base, "thunderbird");
  }
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

class CheckRun {
  constructor(name, context, token) {
    this.id = null;
    this.name = name;
    this.context = context;
    this.octokit = new github.GitHub(token);

    this.ready = !!token;
  }

  async create() {
    if (!this.ready) {
      return;
    }

    let res = await this.octokit.checks.create({
      ...this.context.repo,
      head_sha: this.context.sha,
      name: "Test: " + this.name,
      status: "in_progress",
      started_at: new Date().toISOString()
    });

    this.id = res.data.id;
  }

  async complete(pass, fail, annotations) {
    if (!this.ready) {
      return;
    }

    await this.octokit.checks.update({
      ...this.context.repo,
      head_sha: this.context.sha,
      check_run_id: this.id,
      status: "completed",
      completed_at: new Date().toISOString(),
      conclusion: annotations.length ? "failure" : "success",
      output: {
        title: this.name,
        summary: `${pass} checks passed, ${fail} checks failed`,
        annotations: annotations
      }
    });
  }
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

async function main() {
  let channel = core.getInput("channel", { required: true });
  let xpcshell = core.getInput("xpcshell");
  let buildout = path.join(process.env.GITHUB_WORKSPACE, "build");
  let repoBase = process.env.GITHUB_WORKSPACE; // TODO Docs say GITHUB_WORKSPACE is the parent to the repo, but in practice it is not.
  let venv = path.join(buildout, "venv");

  let testTypes = ["common"];
  if (xpcshell) {
    testTypes.push("xpcshell");
  }

  core.startGroup("Test harness setup");

  let { testPath, appPath } = await download(channel, testTypes, buildout);

  // Copy xpcshell and components over to the binary path
  core.debug("Copying xpcshell to application path " + appPath);
  let binPath = await findApp(appPath);
  await fs.copy(path.join(testPath, "bin", "xpcshell"), path.join(binPath, "xpcshell"));
  await fs.copy(path.join(testPath, "bin", "components"), path.join(binPath, "components"));

  // set up virtualenv
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
  let python = path.join(venv, "bin", "python");

  // install pip packages
  await exec.exec(pip, ["install", ...PIP_PACKAGES]);
  await exec.exec(
    pip,
    ["install", "-r", "mozbase_requirements.txt"],
    { cwd: path.join(testPath, "config") }
  );
  await exec.exec(pip, ["freeze"]);
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

main().catch((err) => {
  console.error(err);
  core.setFailed(err);
});

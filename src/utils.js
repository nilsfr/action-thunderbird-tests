/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2019 */

import * as exec from "@actions/exec";

import fs from "fs-extra";
import path from "path";

export async function findApp(base, container="MacOS") {
  if (process.platform == "darwin") {
    let files = await fs.readdir(base);
    let app = files.find(file => file.endsWith(".app"));

    return path.join(base, app, "Contents", container);
  } else {
    return path.join(base, "thunderbird");
  }
}

export async function execOut(argv0, args, options={}) {
  let output = "";
  await exec.exec(argv0, args, {
    ...options,
    listeners: {
      stdout: (data) => {
        output += data.toString();
      }
    }
  });

  return output.trim();
}

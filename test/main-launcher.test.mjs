import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { isBackgroundHelperInvocation } from "../workflows/github-repositories/src/avatar.mjs";
import { requestedAuthenticationAction } from "../workflows/github-repositories/src/main.mjs";
import bootstrap from "../workflows/github-repositories/src/bootstrap.cjs";

const execFileAsync = promisify(execFile);

test("bootstrap accepts Node.js 22 or later in the current process", () => {
  assert.equal(bootstrap.supportedNodeVersion("21.99.0"), false);
  assert.equal(bootstrap.supportedNodeVersion("22.0.0"), true);
  assert.equal(bootstrap.supportedNodeVersion("24.19.0"), true);
  assert.equal(bootstrap.supportedNodeVersion("22x.0.0"), false);
});

test("authentication helper accepts only fixed two-argument actions", () => {
  assert.equal(
    requestedAuthenticationAction(["--authentication-helper", "login"]),
    "login",
  );
  assert.equal(
    requestedAuthenticationAction([
      "--authentication-helper",
      "authorize-projects",
    ]),
    "authorize-projects",
  );
  assert.equal(
    requestedAuthenticationAction(["--authentication-helper", "login", "extra"]),
    null,
  );
  assert.equal(
    requestedAuthenticationAction(["--authentication-helper", "arbitrary"]),
    null,
  );
});

test("Node launcher returns fixed links without GitHub CLI or API access", async () => {
  const launcherPath = path.resolve(
    "workflows/github-repositories/github-repositories",
  );

  const result = await execFileAsync("/bin/sh", [launcherPath, "issue"], {
    env: {
      HOME: process.env.HOME,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      alfred_workflow_cache: "",
    },
  });
  const output = JSON.parse(result.stdout);

  assert.equal(output.items[0].arg, "https://github.com/issues");
  assert.equal("avatarRefreshNeeded" in output, false);
});

test("Node launcher clears inherited Node execution options", async () => {
  const launcherPath = path.resolve(
    "workflows/github-repositories/github-repositories",
  );

  const result = await execFileAsync("/bin/sh", [launcherPath, "issue"], {
    env: {
      HOME: process.env.HOME,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      NODE_OPTIONS: "--require=/definitely/missing/module.cjs",
      alfred_workflow_cache: "",
    },
  });

  assert.equal(JSON.parse(result.stdout).items[0].title, "GitHub Issues");
});

test("background and authentication markers cannot be confused", () => {
  assert.equal(
    isBackgroundHelperInvocation(["--authentication-helper", "login"]),
    false,
  );
  assert.equal(
    requestedAuthenticationAction(["--background-helper", "refresh-avatars"]),
    null,
  );
});

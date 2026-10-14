import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { isBackgroundHelperInvocation } from "../workflows/github-repositories/src/avatar.mjs";
import { requestedAuthenticationAction, runSearch } from "../workflows/github-repositories/src/main.mjs";
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

test("reload returns a non-selectable loading row before starting its request", async () => {
  const queries = [];
  const app = {
    run: async (query) => {
      queries.push(query);
      return { items: [] };
    },
  };

  const output = await runSearch(" ReLoAd ", false, app);

  assert.deepEqual(queries, []);
  assert.equal(output.items[0].title, "Reloading GitHub repositories…");
  assert.equal(output.items[0].valid, false);
  assert.equal("arg" in output.items[0], false);
  assert.equal(output.rerun, 0.1);
  assert.deepEqual(output.variables, { github_navigator_reload_pending: "1" });
});

for (const result of [
  { items: [{ title: "owner/fresh", valid: true }], avatarRefreshNeeded: true },
  { items: [{ title: "Unable to load repositories", valid: false }] },
]) {
  test(`reload replaces loading with ${result.items[0].title} and stops rerunning`, async () => {
    const queries = [];
    const app = {
      run: async (query) => {
        queries.push(query);
        return result;
      },
    };

    const output = await runSearch("reload", true, app);

    assert.deepEqual(queries, ["reload"]);
    assert.deepEqual(output.items, result.items);
    assert.equal(output.avatarRefreshNeeded, result.avatarRefreshNeeded);
    assert.equal("rerun" in output, false);
    assert.deepEqual(output.variables, { github_navigator_reload_pending: "" });
  });
}

test("changing the query cancels the pending reload stage", async () => {
  const queries = [];
  const app = {
    run: async (query) => {
      queries.push(query);
      return { items: [{ title: "owner/reload-example", valid: true }] };
    },
  };

  const output = await runSearch("reload example", true, app);

  assert.deepEqual(queries, ["reload example"]);
  assert.equal(output.items[0].title, "owner/reload-example");
  assert.equal("rerun" in output, false);
  assert.deepEqual(output.variables, { github_navigator_reload_pending: "" });
});

for (const pending of ["", "true", "1; unexpected"]) {
  test(`Node launcher returns loading without API access for pending flag ${JSON.stringify(pending)}`, async () => {
    const launcherPath = path.resolve("workflows/github-repositories/github-repositories");

    const result = await execFileAsync("/bin/sh", [launcherPath, "reload"], {
      env: {
        HOME: process.env.HOME,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        alfred_workflow_cache: "",
        github_navigator_reload_pending: pending,
      },
    });
    const output = JSON.parse(result.stdout);

    assert.equal(output.items[0].title, "Reloading GitHub repositories…");
    assert.equal(output.items[0].valid, false);
    assert.equal(output.rerun, 0.1);
    assert.deepEqual(output.variables, { github_navigator_reload_pending: "1" });
    assert.equal("avatarRefreshNeeded" in output, false);
  });
}

test("Node launcher returns fixed links without GitHub CLI or API access", async () => {
  const launcherPath = path.resolve(
    "workflows/github-repositories/github-repositories",
  );

  const result = await execFileAsync("/bin/sh", [launcherPath, "issue"], {
    env: {
      HOME: process.env.HOME,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      alfred_workflow_cache: "",
      github_navigator_reload_pending: "1",
    },
  });
  const output = JSON.parse(result.stdout);

  assert.equal(output.items[0].arg, "https://github.com/issues");
  assert.deepEqual(output.variables, { github_navigator_reload_pending: "" });
  assert.equal("rerun" in output, false);
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

import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  githubCLILoginArguments,
  githubCLIProjectAuthorizationArguments,
  githubCLIProjectLoginArguments,
  restrictedCommandEnvironment,
  runBoundedCommand,
  stageGitHubCLIInCache,
} from "../workflows/github-repositories/src/command.mjs";
import { managedTemporaryDirectory } from "./helpers.mjs";

test("authentication commands use only fixed least-privilege arguments", () => {
  assert.deepEqual(githubCLILoginArguments(), [
    "auth",
    "login",
    "--hostname",
    "github.com",
    "--web",
    "--skip-ssh-key",
  ]);
  assert.deepEqual(githubCLIProjectLoginArguments(), [
    ...githubCLILoginArguments(),
    "--scopes",
    "read:project",
  ]);
  assert.deepEqual(githubCLIProjectAuthorizationArguments(), [
    "auth",
    "refresh",
    "--hostname",
    "github.com",
    "--scopes",
    "read:project",
  ]);
});

test("restricted command environment drops parent secrets and proxy settings", () => {
  process.env.GH_TOKEN = "must-not-leak";
  process.env.HTTPS_PROXY = "https://proxy.invalid";
  const environment = restrictedCommandEnvironment(
    "/private/cache/executables/gh",
    false,
  );

  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.HTTPS_PROXY, undefined);
  assert.equal(environment.GH_PROMPT_DISABLED, "1");
  assert.equal(environment.PATH.startsWith("/private/cache/executables:"), true);

  delete process.env.GH_TOKEN;
  delete process.env.HTTPS_PROXY;
});

test("bounded command captures output without inheriting an implicit shell", async () => {
  const result = await runBoundedCommand(
    {
      path: "/bin/sh",
      args: ["-c", "/usr/bin/printf '%s' safe"],
      timeoutMilliseconds: 1_000,
      stdoutLimit: 16,
      stderrLimit: 16,
    },
    { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  );

  assert.equal(result.error, null);
  assert.equal(result.stdout.toString("utf8"), "safe");
  assert.equal(result.stdoutOverflow, false);
});

test("bounded command stops output beyond the configured limit", async () => {
  const result = await runBoundedCommand(
    {
      path: "/bin/sh",
      args: ["-c", "/usr/bin/printf '%s' 123456789"],
      timeoutMilliseconds: 1_000,
      stdoutLimit: 4,
      stderrLimit: 16,
    },
    { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  );

  assert.equal(result.stdout.toString("utf8"), "1234");
  assert.equal(result.stdoutOverflow, true);
  assert.ok(result.error);
});

test("bounded command terminates a timed-out process group", async () => {
  const result = await runBoundedCommand(
    {
      path: "/bin/sh",
      args: ["-c", "/bin/sleep 5"],
      timeoutMilliseconds: 20,
      stdoutLimit: 16,
      stderrLimit: 16,
    },
    { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  );

  assert.equal(result.timedOut, true);
  assert.ok(result.error);
});

test("GitHub CLI staging creates a private executable snapshot", (context) => {
  const sourceRoot = managedTemporaryDirectory(context);
  const cacheRoot = managedTemporaryDirectory(context);
  const sourcePath = path.join(sourceRoot, "gh");
  writeFileSync(sourcePath, "#!/bin/sh\nexit 0\n", { mode: 0o500 });

  const stagedPath = stageGitHubCLIInCache(sourcePath, cacheRoot);

  assert.equal(readFileSync(stagedPath, "utf8"), "#!/bin/sh\nexit 0\n");
  assert.equal(lstatSync(stagedPath).mode & 0o777, 0o500);
  assert.equal(path.dirname(stagedPath), path.join(cacheRoot, "executables"));
});

test("GitHub CLI staging refreshes a changed source identity", (context) => {
  const sourceRoot = managedTemporaryDirectory(context);
  const cacheRoot = managedTemporaryDirectory(context);
  const sourcePath = path.join(sourceRoot, "gh");
  writeFileSync(sourcePath, "first", { mode: 0o500 });
  stageGitHubCLIInCache(sourcePath, cacheRoot);
  chmodSync(sourcePath, 0o700);
  writeFileSync(sourcePath, "second-version", { mode: 0o500 });
  chmodSync(sourcePath, 0o500);

  const stagedPath = stageGitHubCLIInCache(sourcePath, cacheRoot);

  assert.equal(readFileSync(stagedPath, "utf8"), "second-version");
});

test("GitHub CLI staging refuses a symbolic-link source", (context) => {
  const sourceRoot = managedTemporaryDirectory(context);
  const cacheRoot = managedTemporaryDirectory(context);
  const sourcePath = path.join(sourceRoot, "real-gh");
  const linkPath = path.join(sourceRoot, "gh");
  writeFileSync(sourcePath, "safe", { mode: 0o500 });
  symlinkSync(sourcePath, linkPath);

  assert.throws(() => stageGitHubCLIInCache(linkPath, cacheRoot));
});

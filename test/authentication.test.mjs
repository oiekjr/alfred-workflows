import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  githubConfigIdentitiesEqual,
  githubConfigIdentityAt,
  isValidGitHubAccountIdentity,
  loginHelperToken,
  parseAuthenticationStatus,
} from "../workflows/github-repositories/src/authentication.mjs";
import { managedTemporaryDirectory, testConfigIdentity } from "./helpers.mjs";

test("authentication status extracts only active GitHub.com identity", () => {
  const output = [
    "github.com",
    "  ✓ Logged in to github.com account Owner-Name (/path/to/hosts.yml)",
    "  - Active account: true",
    "  - Token scopes: 'repo', 'read:project'",
  ].join("\n");

  assert.deepEqual(parseAuthenticationStatus(output), {
    hostname: "github.com",
    login: "owner-name",
    scopes: "'repo', 'read:project'",
  });
});

test("authentication status rejects duplicates and inactive accounts", () => {
  const inactive = [
    "Logged in to github.com account owner (/path)",
    "Active account: false",
  ].join("\n");
  const duplicate = [
    "Logged in to github.com account owner (/path)",
    "Logged in to github.com account other (/path)",
    "Active account: true",
  ].join("\n");

  assert.equal(parseAuthenticationStatus(inactive), null);
  assert.equal(parseAuthenticationStatus(duplicate), null);
});

test("GitHub config identity uses metadata without reading file contents", (context) => {
  const home = managedTemporaryDirectory(context);
  const configDirectory = path.join(home, ".config");
  const ghDirectory = path.join(configDirectory, "gh");
  mkdirSync(configDirectory, { mode: 0o700 });
  mkdirSync(ghDirectory, { mode: 0o700 });
  const hostsPath = path.join(ghDirectory, "hosts.yml");
  writeFileSync(hostsPath, "secret-token: must-not-be-returned", { mode: 0o600 });

  const identity = githubConfigIdentityAt(home);

  assert.ok(identity);
  assert.equal(identity.size, statSync(hostsPath).size);
  assert.equal(JSON.stringify(identity).includes("secret-token"), false);
  assert.equal(readFileSync(hostsPath, "utf8").includes("secret-token"), true);
});

test("GitHub config identity rejects broadly writable files", (context) => {
  const home = managedTemporaryDirectory(context);
  const ghDirectory = path.join(home, ".config", "gh");
  mkdirSync(ghDirectory, { recursive: true, mode: 0o700 });
  chmodSync(path.join(home, ".config"), 0o700);
  const hostsPath = path.join(ghDirectory, "hosts.yml");
  writeFileSync(hostsPath, "github.com: {}", { mode: 0o600 });
  chmodSync(hostsPath, 0o644);

  assert.equal(githubConfigIdentityAt(home), null);
});

test("account identity validates exact fields and compares config metadata", () => {
  const config = testConfigIdentity(3);
  const account = { hostname: "github.com", login: "Owner", config };

  assert.equal(isValidGitHubAccountIdentity(account), true);
  assert.equal(
    isValidGitHubAccountIdentity({ ...account, token: "secret" }),
    false,
  );
  assert.equal(githubConfigIdentitiesEqual(config, { ...config }), true);
  assert.equal(
    githubConfigIdentitiesEqual(config, { ...config, inode: "4" }),
    false,
  );
});

test("login helper token contains only a verified absolute launcher path", () => {
  const launcherPath = path.resolve(
    "workflows/github-repositories/github-repositories",
  );

  const token = loginHelperToken(launcherPath);

  assert.equal(Buffer.from(token, "base64").toString("utf8"), launcherPath);
});

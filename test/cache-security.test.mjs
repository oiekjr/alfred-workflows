import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { ListCache } from "../workflows/github-repositories/src/cache.mjs";
import {
  ensureSecureCacheSubdirectory,
  readPrivateFile,
  validatePrivateRegularFile,
  writePrivateDataAtomically,
} from "../workflows/github-repositories/src/security.mjs";
import {
  managedTemporaryDirectory,
  testAccountIdentity,
  testConfigIdentity,
  testProject,
  testRepository,
} from "./helpers.mjs";

test("repository cache is private and bound to GitHub config identity", (context) => {
  const root = managedTemporaryDirectory(context);
  const config = testConfigIdentity(1);
  const cache = new ListCache(root);
  cache.storeRepositories(testAccountIdentity(config), [testRepository()]);

  const loaded = cache.loadRepositories(config);
  const cachePath = path.join(root, "lists", "repositories.json");

  assert.equal(loaded?.[0].full_name, "owner/repository");
  assert.equal(statSync(path.dirname(cachePath)).mode & 0o777, 0o700);
  assert.equal(statSync(cachePath).mode & 0o777, 0o600);
  assert.equal(cache.loadRepositories(testConfigIdentity(2)), null);
  assert.equal(lstatSync(path.dirname(cachePath)).isDirectory(), true);
  assert.throws(() => lstatSync(cachePath), { code: "ENOENT" });
});

test("project cache stores only normalized open projects", (context) => {
  const root = managedTemporaryDirectory(context);
  const config = testConfigIdentity();
  const cache = new ListCache(root);

  cache.storeProjects(testAccountIdentity(config), [testProject()]);

  assert.equal(cache.loadProjects(config)?.[0].title, "Roadmap");
  assert.throws(
    () => cache.storeProjects(testAccountIdentity(config), [testProject({ closed: true })]),
    /invalid entries/u,
  );
});

test("cache remains valid for 30 minutes and is then invalidated", (context) => {
  const root = managedTemporaryDirectory(context);
  const config = testConfigIdentity();
  let now = Date.now();
  const cache = new ListCache(root, () => now);
  cache.storeRepositories(testAccountIdentity(config), [testRepository()]);
  now += 29 * 60 * 1000;

  assert.equal(cache.loadRepositories(config)?.length, 1);

  now += 2 * 60 * 1000;

  assert.equal(cache.loadRepositories(config), null);
  assert.throws(
    () => lstatSync(path.join(root, "lists", "repositories.json")),
    { code: "ENOENT" },
  );
});

test("cache rejects unknown document fields and malformed entries", (context) => {
  const root = managedTemporaryDirectory(context);
  const lists = ensureSecureCacheSubdirectory(root, "lists");
  const document = {
    schema: 3,
    account: testAccountIdentity(),
    repositories: [testRepository()],
    unexpected: true,
  };
  writePrivateDataAtomically(
    lists,
    "repositories.json",
    JSON.stringify(document),
  );
  const cache = new ListCache(root);

  assert.equal(cache.loadRepositories(testConfigIdentity()), null);
});

test("atomic private writes replace content without broad permissions", (context) => {
  const root = managedTemporaryDirectory(context);
  const directory = ensureSecureCacheSubdirectory(root, "data");

  const targetPath = writePrivateDataAtomically(directory, "value.txt", "first");
  writePrivateDataAtomically(directory, "value.txt", "second");

  assert.equal(readPrivateFile(targetPath, 20).toString("utf8"), "second");
  assert.equal(statSync(targetPath).mode & 0o777, 0o600);
});

test("private file validation rejects symlinks and shared permissions", (context) => {
  const root = managedTemporaryDirectory(context);
  const sourcePath = path.join(root, "source");
  writeFileSync(sourcePath, "value", { mode: 0o600 });
  const linkPath = path.join(root, "link");
  symlinkSync(sourcePath, linkPath);

  assert.throws(() => validatePrivateRegularFile(linkPath));
  chmodSync(sourcePath, 0o644);
  assert.throws(() => validatePrivateRegularFile(sourcePath));
});

test("private reads enforce a hard byte limit", (context) => {
  const root = managedTemporaryDirectory(context);
  const targetPath = path.join(root, "large");
  writeFileSync(targetPath, "123456", { mode: 0o600 });

  assert.throws(() => readPrivateFile(targetPath, 5), /size limit/u);
  assert.equal(readFileSync(targetPath, "utf8"), "123456");
});

test("cache invalidation ignores unavailable relative roots", () => {
  const cache = new ListCache("");

  assert.doesNotThrow(() => cache.invalidate());
});

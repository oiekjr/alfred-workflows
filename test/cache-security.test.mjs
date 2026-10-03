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
  validateSecureDirectory,
  validateSecurePathComponents,
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

test("path validation still rejects symbolic-link ancestors", (context) => {
  const root = managedTemporaryDirectory(context);
  const directory = path.join(root, "real");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(path.join(directory, "value"), "data", { mode: 0o600 });
  const link = path.join(root, "link");
  symlinkSync(directory, link);

  assert.throws(() => validatePrivateRegularFile(path.join(link, "value")), /symbolic links/u);
  assert.throws(() => validateSecureDirectory(link), /symbolic links/u);
});

test("path validation still rejects writable ancestors", (context) => {
  const root = managedTemporaryDirectory(context);
  const directory = path.join(root, "shared");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(path.join(directory, "value"), "data", { mode: 0o600 });
  chmodSync(directory, 0o770);

  assert.throws(() => validatePrivateRegularFile(path.join(directory, "value")), /write permission/u);
});

test("path validation preserves regular-file and directory distinctions", (context) => {
  const root = managedTemporaryDirectory(context);
  const target = path.join(root, "value");
  writeFileSync(target, "data", { mode: 0o600 });

  assert.equal(validateSecureDirectory(root).isDirectory(), true);
  assert.equal(validatePrivateRegularFile(target).isFile(), true);
  assert.throws(() => validateSecureDirectory(target), /not a directory/u);
  assert.throws(() => validatePrivateRegularFile(root), /not a regular file/u);
  assert.equal(validateSecurePathComponents(target), undefined);
});

test("private reads enforce a hard byte limit", (context) => {
  const root = managedTemporaryDirectory(context);
  const targetPath = path.join(root, "large");
  writeFileSync(targetPath, "123456", { mode: 0o600 });

  assert.throws(() => readPrivateFile(targetPath, 5), /size limit/u);
  assert.equal(readFileSync(targetPath, "utf8"), "123456");
});

for (const bytes of [65_535, 65_536, 65_537]) {
  test(`private reads retain exactly ${bytes} bytes across chunks`, (context) => {
    const root = managedTemporaryDirectory(context);
    const target = path.join(root, "value");
    const data = Buffer.alloc(bytes, 0x61);
    writeFileSync(target, data, { mode: 0o600 });

    const result = readPrivateFile(target, 128 * 1024);

    assert.deepEqual(result, data);
  });
}

for (const bytes of [4, 5, 6]) {
  test(`private reads enforce a five-byte limit for ${bytes} bytes`, (context) => {
    const root = managedTemporaryDirectory(context);
    const target = path.join(root, "value");
    const data = Buffer.alloc(bytes, 0x61);
    writeFileSync(target, data, { mode: 0o600 });

    if (bytes > 5) {
      assert.throws(() => readPrivateFile(target, 5), /size limit/u);
    } else {
      assert.deepEqual(readPrivateFile(target, 5), data);
    }
  });
}

test("private reads accept empty files with a zero-byte limit", (context) => {
  const root = managedTemporaryDirectory(context);
  const target = path.join(root, "empty");
  writeFileSync(target, Buffer.alloc(0), { mode: 0o600 });

  assert.deepEqual(readPrivateFile(target, 0), Buffer.alloc(0));
});

test("cache invalidation ignores unavailable relative roots", () => {
  const cache = new ListCache("");

  assert.doesNotThrow(() => cache.invalidate());
});

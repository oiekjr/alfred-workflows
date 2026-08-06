import assert from "node:assert/strict";
import { lstatSync, utimesSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  AvatarCache,
  acquireAvatarRefreshLock,
  inspectAvatarImage,
  isBackgroundHelperInvocation,
  releaseAvatarRefreshLock,
  restrictedBackgroundHelperEnvironment,
} from "../workflows/github-repositories/src/avatar.mjs";
import { managedTemporaryDirectory, testPNG } from "./helpers.mjs";

/**
 * 有効なGitHub所有者テスト値を生成する。
 *
 * @param {number} id 所有者ID
 * @returns {object} 所有者値
 */
function owner(id) {
  return {
    id,
    login: `owner-${id}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    type: "User",
  };
}

test("avatar image inspection accepts bounded PNG, GIF, and JPEG", () => {
  const gif = Buffer.alloc(11);
  gif.write("GIF89a", 0, "ascii");
  gif.writeUInt16LE(2, 6);
  gif.writeUInt16LE(3, 8);
  gif[10] = 0x3b;
  const jpeg = Buffer.alloc(23);
  jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  jpeg.writeUInt16BE(4, 7);
  jpeg.writeUInt16BE(5, 9);
  jpeg.set([0xff, 0xd9], 21);

  assert.deepEqual(inspectAvatarImage(testPNG()), {
    extension: "png",
    width: 1,
    height: 1,
  });
  assert.deepEqual(inspectAvatarImage(gif), {
    extension: "gif",
    width: 2,
    height: 3,
  });
  assert.deepEqual(inspectAvatarImage(jpeg), {
    extension: "jpg",
    width: 5,
    height: 4,
  });
});

test("avatar image inspection rejects unsupported dimensions and data", () => {
  const oversized = Buffer.from(testPNG());
  oversized.writeUInt32BE(1025, 16);

  assert.throws(() => inspectAvatarImage(oversized), /unsupported/u);
  assert.throws(() => inspectAvatarImage(Buffer.from("not-an-image")), /unsupported/u);
});

test("avatar cache marks missing images and saves verified private data", async (context) => {
  const root = managedTemporaryDirectory(context);
  let downloads = 0;
  const cache = new AvatarCache(root, async () => {
    downloads += 1;
    return { data: testPNG(), extension: "png" };
  });

  const before = cache.paths([owner(10)]);
  await cache.refresh([owner(10)]);
  const after = cache.paths([owner(10)]);
  const avatarPath = path.join(root, "avatars", "10.png");

  assert.equal(before.refreshNeeded, true);
  assert.equal(downloads, 1);
  assert.equal(after.refreshNeeded, false);
  assert.equal(after.paths.get(10), avatarPath);
  assert.equal(lstatSync(avatarPath).mode & 0o777, 0o600);
});

test("avatar cache keeps stale images visible while requesting refresh", async (context) => {
  const root = managedTemporaryDirectory(context);
  const cache = new AvatarCache(root, async () => ({
    data: testPNG(),
    extension: "png",
  }));
  await cache.refresh([owner(10)]);
  const avatarPath = path.join(root, "avatars", "10.png");
  const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(avatarPath, oldDate, oldDate);

  const result = cache.paths([owner(10)]);

  assert.equal(result.paths.get(10), avatarPath);
  assert.equal(result.refreshNeeded, true);
});

test("avatar cache rejects mismatched extensions before writing", async (context) => {
  const root = managedTemporaryDirectory(context);
  const cache = new AvatarCache(root, async () => ({
    data: testPNG(),
    extension: "gif",
  }));

  await assert.rejects(() => cache.refreshOwner(owner(10)), /does not match/u);
  assert.equal(cache.paths([owner(10)]).paths.size, 0);
});

test("avatar refresh bounds total downloads and concurrency", async (context) => {
  const root = managedTemporaryDirectory(context);
  let downloads = 0;
  let active = 0;
  let maximumActive = 0;
  const cache = new AvatarCache(root, async () => {
    downloads += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return { data: testPNG(), extension: "png" };
  });
  const owners = Array.from({ length: 30 }, (_, index) => owner(index + 1));

  await cache.refresh(owners);

  assert.equal(downloads, 24);
  assert.ok(maximumActive <= 4);
});

test("avatar refresh lock prevents concurrent helpers", (context) => {
  const root = managedTemporaryDirectory(context);
  const first = acquireAvatarRefreshLock(root);
  const second = acquireAvatarRefreshLock(root);

  assert.ok(first);
  assert.equal(second, null);
  releaseAvatarRefreshLock(first);
  const third = acquireAvatarRefreshLock(root);
  assert.ok(third);
  releaseAvatarRefreshLock(third);
});

test("background helper accepts only the exact fixed invocation", () => {
  assert.equal(
    isBackgroundHelperInvocation(["--background-helper", "refresh-avatars"]),
    true,
  );
  assert.equal(
    isBackgroundHelperInvocation(["--background-helper", "other"]),
    false,
  );
  assert.equal(
    isBackgroundHelperInvocation([
      "--background-helper",
      "refresh-avatars",
      "extra",
    ]),
    false,
  );
});

test("background helper environment excludes inherited secrets", () => {
  process.env.GH_TOKEN = "must-not-leak";

  const environment = restrictedBackgroundHelperEnvironment();

  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.match(environment.alfred_workflow_cache, /Workflow Data/u);
  delete process.env.GH_TOKEN;
});

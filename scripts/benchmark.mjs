import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { testAccountIdentity, testConfigIdentity, testProject, testRepository, testPNG } from "../test/helpers.mjs";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sampleCount = 9;
const entryCount = 5_000;
const ownerCount = 50;
const repositories = Array.from({ length: entryCount }, (_, index) => {
  const number = (index * 3571) % entryCount;
  const ownerID = number % ownerCount + 1;
  const fullName = `Owner-${ownerID}/Repository-${number}`;
  return testRepository({
    id: number + 1,
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    description: "A local benchmark fixture",
    owner: {
      id: ownerID,
      login: `Owner-${ownerID}`,
      avatar_url: `https://avatars.githubusercontent.com/u/${ownerID}?v=4`,
      type: "User",
    },
  });
});
const projects = repositories.map((repository) => testProject({
  id: `PVT_${repository.id}`,
  number: repository.id,
  title: repository.full_name,
  html_url: `https://github.com/orgs/${repository.owner.login}/projects/${repository.id}`,
  owner: { ...repository.owner, node_id: `O_${repository.owner.id}`, type: "Organization" },
}));
const distinctOwnerProjects = Array.from({ length: 1_000 }, (_, index) => {
  const id = (index * 3571) % 1_000 + 1;
  const login = `owner-${String(id).padStart(5, "0")}`;
  return testProject({
    id: `PVT_${id}`,
    title: "İ".repeat(480),
    html_url: `https://github.com/orgs/${login}/projects/1`,
    owner: { ...testProject().owner, id, node_id: `O_${id}`, login },
  });
});
const sortedDistinctOwnerProjects = [...distinctOwnerProjects].sort((left, right) =>
  left.owner.login < right.owner.login ? -1 : 1,
);
const repositoryOutput = Buffer.from(Array.from({ length: entryCount / 100 }, (_, page) =>
  JSON.stringify({
    login: "owner",
    repositories: repositories.slice(page * 100, (page + 1) * 100).map((repository) => ({
      ...repository,
      owner: { ...repository.owner, id: undefined },
    })),
  }),
).join("\n"));
const projectOutput = Buffer.from(projects.map((project) => JSON.stringify({
  ...project,
  owner: { ...project.owner, id: undefined },
})).join("\n"));

const sourceRoots = process.argv[2] === "--compare"
  ? [path.resolve(process.argv[3]), projectDirectory]
  : [path.resolve(process.argv[2] ?? projectDirectory)];
const sessions = [];
try {
  for (const sourceRoot of sourceRoots) {
    sessions.push(await benchmarkOperations(sourceRoot));
  }
  const measurements = {};
  for (const name of Object.keys(sessions[0].operations)) {
    measurements[name] = await measure(sessions.map((session) => session.operations[name]));
  }
  process.stdout.write(`${JSON.stringify({ node: process.versions.node, sampleCount, entryCount, ownerCount, sourceRoots, medianMilliseconds: measurements }, null, 2)}\n`);
} finally {
  for (const session of sessions) {
    session.cleanup();
  }
}

/**
 * 指定したソースに対して通信を行わない計測処理を組み立てる。
 *
 * @param {string} sourceRoot 計測対象のリポジトリルート
 * @returns {Promise<{operations: Record<string, () => unknown>, cleanup: () => void}>} 計測処理と後処理
 */
async function benchmarkOperations(sourceRoot) {
  const sourceDirectory = path.join(
    path.resolve(sourceRoot),
    "workflows/github-repositories/src",
  );
  const domain = await import(pathToFileURL(path.join(sourceDirectory, "domain.mjs")));
  const { App } = await import(pathToFileURL(path.join(sourceDirectory, "app.mjs")));
  const { AvatarCache } = await import(pathToFileURL(path.join(sourceDirectory, "avatar.mjs")));
  const { ListCache } = await import(pathToFileURL(path.join(sourceDirectory, "cache.mjs")));
  const { ensureSecureCacheSubdirectory, readPrivateFile } = await import(pathToFileURL(path.join(sourceDirectory, "security.mjs")));

  /**
   * 通信と書込を除外して更新対象の選択処理を計測する。
   */
  class SelectionBenchmarkCache extends AvatarCache {
    selected = 0;

    /**
     * 選択された所有者数だけを記録する。
     *
     * @returns {Promise<string>} 未保存を示す空文字列
     */
    async refreshOwner() {
      this.selected += 1;
      return "";
    }
  }

  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "github-navigator-benchmark-")));
  chmodSync(root, 0o700);
  try {
    const config = testConfigIdentity();
    const lists = new ListCache(root);
    lists.storeRepositories(testAccountIdentity(config), repositories);
    lists.storeProjects(testAccountIdentity(config), projects);
    const directory = ensureSecureCacheSubdirectory(root, "avatars");
    for (let ownerID = 1; ownerID <= ownerCount; ownerID += 1) {
      writeFileSync(path.join(directory, `${ownerID}.png`), testPNG(), { mode: 0o600 });
    }
    const avatars = new AvatarCache(root);
    const app = new App({
      runner: {
        /**
         * 実アカウントへの接続を防止する。
         *
         * @returns {never}
         * @throws {Error} キャッシュを利用できない場合
         */
        findExecutable() {
          throw new Error("benchmark must remain offline");
        },
        /**
         * 実アカウントへの接続を防止する。
         *
         * @returns {Promise<never>}
         * @throws {Error} 外部コマンドが要求された場合
         */
        async run() {
          throw new Error("benchmark must remain offline");
        },
      },
      avatars,
      lists,
      githubConfig: { currentIdentity: () => config },
      helperTokenProvider: () => "",
    });
    const missingOwners = Array.from({ length: 500 }, (_, index) => ({
      id: index + 1_000,
      avatar_url: `https://avatars.githubusercontent.com/u/${index + 1_000}`,
    }));
    const refreshCache = new SelectionBenchmarkCache(root);
    const readPath = path.join(root, "read-fixture");
    writeFileSync(readPath, Buffer.alloc(4 * 1024 * 1024, 0x61), { mode: 0o600 });

    return {
      operations: {
        repositoryNormalize: () => domain.normalizeRepositories(repositories),
        projectNormalize: () => domain.normalizeProjects(projects),
        projectDistinctOwnersLongTitles: () => domain.normalizeProjects(distinctOwnerProjects),
        projectSortedDistinctOwnersLongTitles: () => domain.normalizeProjects(sortedDistinctOwnerProjects),
        repositoryParse: () => domain.parseRepositoryPages(repositoryOutput),
        projectParse: () => domain.parseProjects(projectOutput),
        repositoryCachedFeed: async () => {
          const feed = await app.run("");
          assert.equal(feed.items.length, entryCount);
        },
        projectCachedFeed: async () => {
          const feed = await app.run("projects");
          assert.equal(feed.items.length, entryCount);
        },
        avatarMissingPaths: () => avatars.paths(missingOwners),
        avatarRefreshSelection: async () => {
          refreshCache.selected = 0;
          await refreshCache.refresh(missingOwners);
          assert.equal(refreshCache.selected, 24);
        },
        privateRead4MiB: () => readPrivateFile(readPath, 16 * 1024 * 1024),
      },
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * ソースごとの処理を交互に実行し、固定回数の計測から中央値を取得する。
 *
 * @param {(() => unknown | Promise<unknown>)[]} operations 計測処理
 * @returns {Promise<number | {baseline: number, current: number}>} ミリ秒単位の中央値
 */
async function measure(operations) {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    for (const operation of operations) {
      await operation();
    }
  }
  const samples = operations.map(() => []);
  for (let iteration = 0; iteration < sampleCount; iteration += 1) {
    const order = iteration % 2 === 0 ? operations.keys() : [...operations.keys()].reverse();
    for (const index of order) {
      const start = performance.now();
      await operations[index]();
      samples[index].push(performance.now() - start);
    }
  }
  const medians = samples.map((values) => {
    values.sort((left, right) => left - right);
    return Number(values[Math.floor(values.length / 2)].toFixed(3));
  });
  return medians.length === 1 ? medians[0] : { baseline: medians[0], current: medians[1] };
}

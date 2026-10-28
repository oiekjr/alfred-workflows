import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { App } from "../workflows/github-repositories/src/app.mjs";
import { ListCache } from "../workflows/github-repositories/src/cache.mjs";
import { runSearch } from "../workflows/github-repositories/src/main.mjs";
import {
  managedTemporaryDirectory,
  successfulCommandResult,
  testAccountIdentity,
  testConfigIdentity,
  testProject,
  testRepository,
} from "./helpers.mjs";

const AUTHENTICATION_OUTPUT = [
  "github.com",
  "  ✓ Logged in to github.com account owner (/Users/test/.config/gh/hosts.yml)",
  "  - Active account: true",
  "  - Token scopes: 'repo', 'read:project'",
].join("\n");

/**
 * GraphQLのリポジトリページ出力をテスト用に生成する。
 *
 * @param {object[]} repositories リポジトリ一覧
 * @param {string} [login="owner"] 閲覧アカウント
 * @returns {string} GitHub CLIのJSON行出力
 */
function repositoryPageOutput(repositories, login = "owner") {
  return JSON.stringify({
    login,
    repositories: repositories.map((repository) => ({
      ...repository,
      owner: {
        login: repository.owner.login,
        avatar_url: repository.owner.avatar_url,
        type: repository.owner.type,
      },
    })),
  });
}

class FakeRunner {
  /**
   * 偽の実行結果列を初期化する。
   *
   * @param {object[]} results 実行結果列
   * @param {Error | null} [findError=null] 検索エラー
   */
  constructor(results, findError = null) {
    this.results = [...results];
    this.findError = findError;
    this.commands = [];
    this.findCalls = 0;
  }

  /**
   * 固定GitHub CLIパスまたは設定済みエラーを返す。
   *
   * @returns {string} 偽の実行ファイルパス
   */
  findExecutable() {
    this.findCalls += 1;
    if (this.findError) {
      throw this.findError;
    }
    return "/private/cache/gh";
  }

  /**
   * 次の偽結果を返してコマンド条件を記録する。
   *
   * @param {object} command コマンド条件
   * @returns {Promise<object>} 次の偽結果
   */
  async run(command) {
    this.commands.push(command);
    const result = this.results.shift();
    if (!result) {
      throw new Error("unexpected command");
    }
    return result;
  }
}

class FakeLists {
  /**
   * 空の一覧キャッシュを初期化する。
   */
  constructor() {
    this.repositories = null;
    this.projects = null;
    this.invalidations = 0;
  }

  /**
   * 保存済みリポジトリを返す。
   *
   * @returns {object[] | null} 保存値
   */
  loadRepositories() {
    return this.repositories;
  }

  /**
   * リポジトリを保存する。
   *
   * @param {object} _account アカウント
   * @param {object[]} repositories 保存値
   * @returns {void}
   */
  storeRepositories(_account, repositories) {
    this.repositories = repositories;
  }

  /**
   * 保存済みProjectを返す。
   *
   * @returns {object[] | null} 保存値
   */
  loadProjects() {
    return this.projects;
  }

  /**
   * Projectを保存する。
   *
   * @param {object} _account アカウント
   * @param {object[]} projects 保存値
   * @returns {void}
   */
  storeProjects(_account, projects) {
    this.projects = projects;
  }

  /**
   * 保存値を無効化する。
   *
   * @returns {void}
   */
  invalidate() {
    this.invalidations += 1;
    this.repositories = null;
    this.projects = null;
  }
}

/**
 * テスト用Appを依存注入して生成する。
 *
 * @param {FakeRunner} runner コマンド実行境界
 * @param {FakeLists | ListCache | null} [lists=null] 一覧キャッシュ
 * @param {object | null} [config=testConfigIdentity()] 設定同一性
 * @returns {App} テスト対象
 */
function createApp(runner, lists = null, config = testConfigIdentity()) {
  return new App({
    runner,
    avatars: null,
    lists,
    githubConfig: { currentIdentity: () => config },
    helperTokenProvider: () => "safe-token",
  });
}

test("fixed links bypass GitHub CLI and config lookup", async () => {
  let configCalls = 0;
  const runner = new FakeRunner([], new Error("must not resolve"));
  const app = new App({
    runner,
    avatars: null,
    lists: null,
    githubConfig: { currentIdentity: () => { configCalls += 1; return null; } },
    helperTokenProvider: () => "",
  });

  const issues = await app.run(" issue ");
  const pullRequests = await app.run("PRS");

  assert.equal(issues.items[0].arg, "https://github.com/issues");
  assert.equal(pullRequests.items[0].arg, "https://github.com/pulls");
  assert.equal(runner.findCalls, 0);
  assert.equal(configCalls, 0);
});

test("stars opens the active account profile without list or Projects access", async () => {
  const runner = new FakeRunner([
    successfulCommandResult("gh version 2.60.0"),
    successfulCommandResult(AUTHENTICATION_OUTPUT.replace(
      "  - Token scopes: 'repo', 'read:project'",
      "  - Token scopes: 'repo'",
    )),
  ]);
  const lists = new FakeLists();
  lists.repositories = [testRepository()];
  const app = createApp(runner, lists);

  const result = await app.run("stars");

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, "GitHub Stars");
  assert.equal(result.items[0].arg, "https://github.com/owner?tab=stars");
  assert.equal(result.items[0].quicklookurl, "https://github.com/owner?tab=stars");
  assert.equal(result.items[0].valid, true);
  assert.deepEqual(result.items[0].variables, { action: "open" });
  assert.deepEqual(runner.commands.map((command) => command.args), [
    ["--version"],
    ["auth", "status", "--active", "--hostname", "github.com"],
  ]);
  assert.equal(lists.invalidations, 0);
});

test("stars follows an account switch instead of reusing a previous login", async () => {
  const runner = new FakeRunner([
    successfulCommandResult("gh version 2.60.0"),
    successfulCommandResult(AUTHENTICATION_OUTPUT),
    successfulCommandResult("gh version 2.60.0"),
    successfulCommandResult(AUTHENTICATION_OUTPUT.replace("account owner ", "account next-owner ")),
  ]);
  const app = createApp(runner);

  await app.run("stars");
  const result = await app.run("star");

  assert.equal(result.items[0].arg, "https://github.com/next-owner?tab=stars");
});

test("signed-out stars offers standard login without Projects authorization", async () => {
  const signedOut = successfulCommandResult();
  signedOut.error = new Error("not logged in");
  const runner = new FakeRunner([
    successfulCommandResult("gh version 2.60.0"),
    signedOut,
  ]);

  const result = await createApp(runner).run("stars");

  assert.equal(result.items[0].title, "Sign in to GitHub");
  assert.deepEqual(result.items[0].variables, {
    action: "login",
    login_helper: "safe-token",
  });
});

for (const output of ["unexpected", AUTHENTICATION_OUTPUT.replace("account owner ", "account evil/path ")]) {
  test(`stars rejects invalid authentication output ${JSON.stringify(output)}`, async () => {
    const runner = new FakeRunner([
      successfulCommandResult("gh version 2.60.0"),
      successfulCommandResult(output),
    ]);

    const result = await createApp(runner).run("stars");

    assert.equal(result.items[0].title, "Unable to check GitHub authentication");
    assert.equal(result.items[0].valid, false);
    assert.equal(result.items[0].arg, undefined);
  });
}

test("stars reports authentication timeout without opening a profile", async () => {
  const timedOut = successfulCommandResult();
  timedOut.timedOut = true;
  const runner = new FakeRunner([
    successfulCommandResult("gh version 2.60.0"),
    timedOut,
  ]);

  const result = await createApp(runner).run("stars");

  assert.equal(result.items[0].title, "Unable to check GitHub authentication");
  assert.equal(result.items[0].valid, false);
});

test("missing and outdated GitHub CLI return install actions", async () => {
  const missing = await createApp(
    new FakeRunner([], new Error("not found")),
  ).run("");
  const outdated = await createApp(
    new FakeRunner([successfulCommandResult("gh version 2.59.9")]),
  ).run("");

  assert.equal(missing.items[0].title, "Install GitHub CLI");
  assert.equal(outdated.items[0].title, "Update GitHub CLI");
});

test("unauthenticated repository flow exposes only the fixed login action", async () => {
  const apiFailure = successfulCommandResult();
  apiFailure.error = new Error("API authentication failed");
  const authenticationFailure = successfulCommandResult();
  authenticationFailure.error = new Error("not logged in");
  const runner = new FakeRunner([
    successfulCommandResult("gh version 2.60.0"),
    apiFailure,
    authenticationFailure,
  ]);

  const result = await createApp(runner).run("");

  assert.equal(result.items[0].title, "Sign in to GitHub");
  assert.deepEqual(result.items[0].variables, {
    action: "login",
    login_helper: "safe-token",
  });
  assert.equal(runner.commands.length, 3);
  assert.equal(runner.commands[1].args.includes("graphql"), true);
  assert.equal(runner.commands[2].args[0], "auth");
});

test("repository fetch is cached and subsequent typing filters locally", async () => {
  const lists = new FakeLists();
  const repositories = [
    testRepository({
      id: 1,
      full_name: "owner/alpha",
      html_url: "https://github.com/owner/alpha",
    }),
    testRepository({
      id: 2,
      full_name: "owner/other",
      html_url: "https://github.com/owner/other",
    }),
  ];
  const runner = new FakeRunner([
    successfulCommandResult("gh version 2.60.0"),
    successfulCommandResult(repositoryPageOutput(repositories)),
  ]);
  const app = createApp(runner, lists);

  const initial = await app.run("");
  const filtered = await app.run("OT");

  assert.equal(initial.items.length, 2);
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].title, "owner/other");
  assert.equal(runner.findCalls, 1);
  assert.equal(runner.commands.length, 2);
  assert.equal(runner.commands[1].args.includes("graphql"), true);
  assert.equal(runner.commands[1].args.includes("/user/repos"), false);
  assert.equal(
    runner.commands.some((command) => command.args[0] === "auth"),
    false,
  );
});

test("the next invocation filters the persisted fetch with the latest input without another API call", async (context) => {
  const root = managedTemporaryDirectory(context);
  const config = testConfigIdentity();
  const repositories = [
    testRepository({
      full_name: "owner/alpha",
      html_url: "https://github.com/owner/alpha",
    }),
    testRepository({
      id: 2,
      full_name: "owner/other",
      html_url: "https://github.com/owner/other",
    }),
  ];
  const response = Promise.withResolvers();
  const runner = new FakeRunner([
    successfulCommandResult("gh version 2.60.0"),
    response.promise,
  ]);
  const initialApp = createApp(runner, new ListCache(root), config);
  let latestInput = "al";
  const initialRequest = initialApp.run(latestInput);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runner.commands.filter((command) => command.args[0] === "api").length, 1);
  latestInput = "OT";

  response.resolve(successfulCommandResult(repositoryPageOutput(repositories)));
  await initialRequest;
  const nextApp = createApp(runner, new ListCache(root), config);
  const result = await nextApp.run(latestInput);

  assert.deepEqual(result.items.map((item) => item.title), ["owner/other"]);
  assert.equal(runner.findCalls, 1);
  assert.equal(runner.commands.filter((command) => command.args[0] === "api").length, 1);
});

test("reload clears both persisted lists, fetches repositories and preserves avatars", async (context) => {
  const root = managedTemporaryDirectory(context);
  const config = testConfigIdentity();
  const lists = new ListCache(root);
  lists.storeRepositories(testAccountIdentity(config), [testRepository()]);
  lists.storeProjects(testAccountIdentity(config), [testProject()]);
  const avatarDirectory = path.join(root, "avatars");
  mkdirSync(avatarDirectory, { mode: 0o700 });
  const avatarPath = path.join(avatarDirectory, "10.png");
  writeFileSync(avatarPath, "cached avatar", { mode: 0o600 });
  const fresh = testRepository({
    full_name: "owner/fresh",
    html_url: "https://github.com/owner/fresh",
  });
  const runner = new FakeRunner([
    successfulCommandResult("gh version 2.60.0"),
    successfulCommandResult(repositoryPageOutput([fresh])),
  ]);
  const app = createApp(runner, lists, config);

  const loading = await runSearch("reload", false, app);

  assert.equal(loading.items[0].valid, false);
  assert.equal(runner.findCalls, 0);
  assert.equal(lists.loadRepositories(config)?.[0].full_name, "owner/repository");
  assert.equal(lists.loadProjects(config)?.[0].title, "Roadmap");

  const result = await runSearch("reload", true, app);
  const subsequent = await app.run("fresh");

  assert.equal(result.items[0].title, "owner/fresh");
  assert.equal(subsequent.items[0].title, "owner/fresh");
  assert.equal(lists.loadRepositories(config)?.[0].full_name, "owner/fresh");
  assert.equal(lists.loadProjects(config), null);
  assert.equal(readFileSync(avatarPath, "utf8"), "cached avatar");
  assert.equal(runner.commands.length, 2);
  assert.equal(runner.commands[1].args.includes("graphql"), true);
});

test("Project search after reload fetches its list on demand", async () => {
  const lists = new FakeLists();
  lists.repositories = [testRepository()];
  lists.projects = [testProject({ title: "Old project" })];
  const runner = new FakeRunner([
    successfulCommandResult("gh version 2.60.0"),
    successfulCommandResult(repositoryPageOutput([testRepository()])),
    successfulCommandResult("gh version 2.60.0"),
    successfulCommandResult(AUTHENTICATION_OUTPUT),
    successfulCommandResult(JSON.stringify(testProject())),
  ]);
  const app = createApp(runner, lists);
  await app.run("reload");

  const result = await app.run("project");

  assert.equal(result.items[0].title, "example-org / Roadmap");
  assert.equal(lists.projects?.[0].title, "Roadmap");
  assert.equal(runner.commands.length, 5);
  assert.equal(runner.commands[4].args.includes("graphql"), true);
});

test("reload reports cache deletion failure without reusing old lists", async () => {
  const lists = new FakeLists();
  lists.repositories = [testRepository()];
  lists.invalidate = () => { throw new Error("permission denied"); };
  const runner = new FakeRunner([]);

  const result = await createApp(runner, lists).run("reload");

  assert.equal(result.items[0].title, "Unable to clear GitHub list cache");
  assert.equal(result.items[0].valid, false);
  assert.equal(runner.findCalls, 0);
});

test("reload does not restore cleared lists when repository retrieval fails", async () => {
  const lists = new FakeLists();
  lists.repositories = [testRepository()];
  lists.projects = [testProject()];
  const failure = successfulCommandResult();
  failure.timedOut = true;
  const runner = new FakeRunner([
    successfulCommandResult("gh version 2.60.0"),
    failure,
  ]);

  const result = await createApp(runner, lists).run("reload");

  assert.equal(result.items[0].title, "Unable to load repositories");
  assert.equal(result.items[0].valid, false);
  assert.equal(lists.repositories, null);
  assert.equal(lists.projects, null);
});

test("invalid repository API output is never cached or selectable", async () => {
  const lists = new FakeLists();
  const unsafe = testRepository({
    html_url: "https://evil.example/owner/repository",
  });
  const runner = new FakeRunner([
    successfulCommandResult("gh version 2.60.0"),
    successfulCommandResult(repositoryPageOutput([unsafe])),
  ]);

  const result = await createApp(runner, lists).run("");

  assert.equal(result.items[0].title, "Unable to load repositories");
  assert.equal(lists.repositories, null);
});

test("project search requires read scope before API access", async () => {
  const noProjectScope = AUTHENTICATION_OUTPUT.replace(
    "'repo', 'read:project'",
    "'repo'",
  );
  const runner = new FakeRunner([
    successfulCommandResult("gh version 2.60.0"),
    successfulCommandResult(noProjectScope),
  ]);

  const result = await createApp(runner).run("project roadmap");

  assert.equal(result.items[0].title, "Authorize GitHub Projects");
  assert.equal(result.items[0].variables.action, "authorize-projects");
  assert.equal(runner.commands.length, 2);
});

test("project fetch caches only open normalized projects", async () => {
  const lists = new FakeLists();
  const runner = new FakeRunner([
    successfulCommandResult("gh version 2.60.0"),
    successfulCommandResult(AUTHENTICATION_OUTPUT),
    successfulCommandResult(JSON.stringify(testProject())),
  ]);
  const app = createApp(runner, lists);

  const result = await app.run("projects road");

  assert.equal(result.items[0].title, "example-org / Roadmap");
  assert.equal(lists.projects?.length, 1);
  assert.equal(
    runner.commands[2].args.includes("graphql"),
    true,
  );
});

test("configuration changes during an API request prevent cache writes", async () => {
  const first = testConfigIdentity(1);
  const second = testConfigIdentity(2);
  let calls = 0;
  const lists = new FakeLists();
  const runner = new FakeRunner([
    successfulCommandResult("gh version 2.60.0"),
    successfulCommandResult(repositoryPageOutput([testRepository()])),
  ]);
  const app = new App({
    runner,
    avatars: null,
    lists,
    githubConfig: {
      currentIdentity: () => {
        calls += 1;
        return calls === 1 ? first : second;
      },
    },
    helperTokenProvider: () => "safe-token",
  });

  const result = await app.run("");

  assert.equal(result.items[0].title, "owner/repository");
  assert.equal(lists.repositories, null);
});

test("repository API failure bounds the authentication fallback", async () => {
  const apiFailure = successfulCommandResult();
  apiFailure.error = new Error("API authentication failed");
  const timedOut = successfulCommandResult();
  timedOut.error = new Error("timeout");
  timedOut.timedOut = true;
  const runner = new FakeRunner([
    successfulCommandResult("gh version 2.60.0"),
    apiFailure,
    timedOut,
  ]);

  const result = await createApp(runner).run("");

  assert.equal(result.items[0].title, "Unable to check GitHub authentication");
  assert.equal(runner.commands.length, 3);
});

test("repository API timeout skips the authentication fallback", async () => {
  const timedOut = successfulCommandResult();
  timedOut.error = new Error("timeout");
  timedOut.timedOut = true;
  const runner = new FakeRunner([
    successfulCommandResult("gh version 2.60.0"),
    timedOut,
  ]);

  const result = await createApp(runner).run("");

  assert.equal(result.items[0].title, "Unable to load repositories");
  assert.equal(runner.commands.length, 2);
});

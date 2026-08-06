import {
  EnvironmentGitHubConfigProvider,
  githubConfigIdentitiesEqual,
  isValidGitHubAccountIdentity,
  loginHelperToken,
  parseAuthenticationStatus,
} from "./authentication.mjs";
import { newEnvironmentListCache } from "./cache.mjs";
import { ExecRunner } from "./command.mjs";
import {
  API_OUTPUT_LIMIT,
  API_TIMEOUT_MILLISECONDS,
  AUTHENTICATION_TIMEOUT_MILLISECONDS,
  GITHUB_HOSTNAME,
  GITHUB_ISSUES_URL,
  GITHUB_PULL_REQUESTS_URL,
  MINIMUM_GITHUB_CLI,
  PROJECT_GRAPHQL_QUERY,
  PROJECT_JQ_EXPRESSION,
  REPOSITORY_GRAPHQL_QUERY,
  REPOSITORY_JQ_EXPRESSION,
  SHORT_OUTPUT_LIMIT,
  STDERR_LIMIT,
  VERSION_TIMEOUT_MILLISECONDS,
  commandFailed,
  emptyProjectFeed,
  emptyRepositoryFeed,
  failureFeed,
  filterProjects,
  filterRepositories,
  fixedLinkFeed,
  hasProjectReadScope,
  installFeed,
  loginFeed,
  noMatchingProjectFeed,
  noMatchingRepositoryFeed,
  normalizeProjects,
  normalizeRepositories,
  parseGitHubCLIVersion,
  parseProjects,
  parseRepositoryPages,
  projectAuthorizationFeed,
  projectFailureFeed,
  projectItems,
  projectLoginFeed,
  projectOwners,
  repositoryFailureFeed,
  repositoryItems,
  repositoryOwners,
  routeInput,
  supportedGitHubCLIVersion,
} from "./domain.mjs";

/**
 * GitHub CLIとローカルキャッシュをAlfred候補生成へ統合する。
 */
export class App {
  /**
   * 外部依存を差し替え可能な形で初期化する。
   *
   * @param {AppDependencies} dependencies 外部依存
   */
  constructor(dependencies) {
    this.runner = dependencies.runner;
    this.avatars = dependencies.avatars;
    this.lists = dependencies.lists;
    this.githubConfig = dependencies.githubConfig;
    this.helperTokenProvider = dependencies.helperTokenProvider;
  }

  /**
   * 入力と現在のGitHub CLI状態に対応するAlfred応答を生成する。
   *
   * @param {string} query Alfred検索語
   * @returns {Promise<import("./domain.mjs").Feed | object>} Alfred応答
   */
  async run(query) {
    const input = routeInput(query);
    if (input.mode === "issues") {
      return fixedLinkFeed(
        "GitHub Issues",
        "Open your GitHub issues in the default browser.",
        GITHUB_ISSUES_URL,
      );
    }
    if (input.mode === "pull_requests") {
      return fixedLinkFeed(
        "GitHub Pull requests",
        "Open your GitHub pull requests in the default browser.",
        GITHUB_PULL_REQUESTS_URL,
      );
    }

    let configIdentity = this.currentGitHubConfigIdentity();
    if (this.lists && configIdentity === null) {
      safelyInvalidate(this.lists);
    }

    if (this.lists && configIdentity !== null) {
      const cachedValues =
        input.mode === "projects"
          ? this.lists.loadProjects(configIdentity)
          : this.lists.loadRepositories(configIdentity);
      if (cachedValues !== null) {
        if (this.githubConfigStillCurrent(configIdentity)) {
          return input.mode === "projects"
            ? this.projectFeed(cachedValues, input.query, true)
            : this.repositoryFeed(cachedValues, input.query, true);
        }

        safelyInvalidate(this.lists);
        configIdentity = this.currentGitHubConfigIdentity();
      }
    }

    let githubCLIPath;
    try {
      githubCLIPath = this.runner.findExecutable("gh");
    } catch {
      return installFeed("Install GitHub CLI");
    }

    const versionResult = await this.runner.run({
      path: githubCLIPath,
      args: ["--version"],
      timeoutMilliseconds: VERSION_TIMEOUT_MILLISECONDS,
      stdoutLimit: SHORT_OUTPUT_LIMIT,
      stderrLimit: STDERR_LIMIT,
    });
    if (commandFailed(versionResult)) {
      return failureFeed(
        "Unable to run GitHub CLI",
        "Check your GitHub CLI installation, then try again.",
      );
    }

    const currentVersion = parseGitHubCLIVersion(versionResult.stdout);
    if (currentVersion === null) {
      return failureFeed(
        "Unable to check GitHub CLI",
        `Install GitHub CLI ${MINIMUM_GITHUB_CLI} or later, then try again.`,
      );
    }
    if (!supportedGitHubCLIVersion(currentVersion)) {
      return installFeed("Update GitHub CLI");
    }

    if (input.mode === "repositories") {
      return this.runRepositories(
        githubCLIPath,
        input.query,
        configIdentity,
      );
    }

    const authenticationCheck = await this.authenticationStatus(
      githubCLIPath,
    );
    if (authenticationCheck.status === "failure") {
      return authenticationCheck.feed;
    }
    if (authenticationCheck.status === "signed_out") {
      return projectLoginFeed(this.helperToken());
    }

    const cacheAccount = this.stableCacheAccount(
      authenticationCheck.authentication,
      configIdentity,
    );
    if (!hasProjectReadScope(authenticationCheck.authentication.scopes)) {
      return projectAuthorizationFeed(this.helperToken());
    }
    return this.runProjects(githubCLIPath, input.query, cacheAccount);
  }

  /**
   * GitHub CLIの認証状態を固定引数・制限付きで取得する。
   *
   * @param {string} githubCLIPath 検証済みGitHub CLIパス
   * @returns {Promise<AuthenticationCheck>} 認証確認結果
   */
  async authenticationStatus(githubCLIPath) {
    const result = await this.runner.run({
      path: githubCLIPath,
      args: [
        "auth",
        "status",
        "--active",
        "--hostname",
        GITHUB_HOSTNAME,
      ],
      timeoutMilliseconds: AUTHENTICATION_TIMEOUT_MILLISECONDS,
      stdoutLimit: SHORT_OUTPUT_LIMIT,
      stderrLimit: STDERR_LIMIT,
    });
    if (result.timedOut) {
      return {
        status: "failure",
        feed: failureFeed(
          "Unable to check GitHub authentication",
          "GitHub CLI did not respond in time. Try again.",
        ),
      };
    }
    if (result.stdoutOverflow || result.stderrOverflow) {
      return {
        status: "failure",
        feed: failureFeed(
          "Unable to check GitHub authentication",
          "GitHub CLI returned an unexpectedly large response.",
        ),
      };
    }
    if (result.error !== null) {
      return { status: "signed_out" };
    }

    const authentication = parseAuthenticationStatus(result.stdout);
    if (authentication === null) {
      return {
        status: "failure",
        feed: failureFeed(
          "Unable to check GitHub authentication",
          "GitHub CLI returned an invalid authentication response.",
        ),
      };
    }
    return { status: "authenticated", authentication };
  }

  /**
   * 現在のGitHub CLI設定ファイル同一性を取得する。
   *
   * @returns {object | null} 比較可能な同一性情報
   */
  currentGitHubConfigIdentity() {
    if (!this.githubConfig) {
      return null;
    }
    return this.githubConfig.currentIdentity();
  }

  /**
   * 取得済みGitHub CLI設定が現在も一致するか判定する。
   *
   * @param {object} config 取得済み設定同一性
   * @returns {boolean} 一致する場合はtrue
   */
  githubConfigStillCurrent(config) {
    const currentConfig = this.currentGitHubConfigIdentity();
    return (
      currentConfig !== null &&
      githubConfigIdentitiesEqual(config, currentConfig)
    );
  }

  /**
   * アカウント確定中に設定が変化していないキャッシュ所有者を生成する。
   *
   * @param {object} authentication 認証状態
   * @param {object | null} initialConfig APIまたは認証確認前の設定同一性
   * @returns {object | null} 安定したキャッシュ所有者
   */
  stableCacheAccount(authentication, initialConfig) {
    if (
      initialConfig === null ||
      !this.githubConfigStillCurrent(initialConfig)
    ) {
      return null;
    }

    const account = {
      hostname: authentication.hostname,
      login: authentication.login,
      config: initialConfig,
    };
    return isValidGitHubAccountIdentity(account) ? account : null;
  }

  /**
   * API取得中もキャッシュ所有者の設定が変化していないか判定する。
   *
   * @param {object | null} account キャッシュ所有者
   * @returns {boolean} 現在も一致する場合はtrue
   */
  cacheAccountStillCurrent(account) {
    return (
      account !== null &&
      isValidGitHubAccountIdentity(account) &&
      this.githubConfigStillCurrent(account.config)
    );
  }

  /**
   * 認証導線用のランチャートークンを安全に取得する。
   *
   * @returns {string} Base64ランチャーパス。取得不能時は空文字列
   */
  helperToken() {
    try {
      return this.helperTokenProvider();
    } catch {
      return "";
    }
  }

  /**
   * 閲覧可能なリポジトリを取得してAlfred応答を生成する。
   *
   * @param {string} githubCLIPath 検証済みGitHub CLIパス
   * @param {string} query ローカル検索語
   * @param {object | null} initialConfig API取得前の設定同一性
   * @returns {Promise<object>} Alfred応答
   */
  async runRepositories(githubCLIPath, query, initialConfig) {
    const result = await this.runner.run({
      path: githubCLIPath,
      args: [
        "api",
        "graphql",
        "--hostname",
        GITHUB_HOSTNAME,
        "--method",
        "POST",
        "--paginate",
        "-f",
        `query=${REPOSITORY_GRAPHQL_QUERY}`,
        "--jq",
        REPOSITORY_JQ_EXPRESSION,
      ],
      timeoutMilliseconds: API_TIMEOUT_MILLISECONDS,
      stdoutLimit: API_OUTPUT_LIMIT,
      stderrLimit: STDERR_LIMIT,
    });
    if (commandFailed(result)) {
      if (
        result.timedOut ||
        result.stdoutOverflow ||
        result.stderrOverflow
      ) {
        return repositoryFailureFeed(result.timedOut);
      }

      const authenticationCheck = await this.authenticationStatus(
        githubCLIPath,
      );
      if (authenticationCheck.status === "failure") {
        return authenticationCheck.feed;
      }
      if (authenticationCheck.status === "signed_out") {
        return loginFeed(this.helperToken());
      }
      return repositoryFailureFeed(result.timedOut);
    }

    let response;
    try {
      response = parseRepositoryPages(result.stdout);
    } catch {
      return repositoryFailureFeed(false);
    }
    const normalized = normalizeRepositories(response.repositories);
    if (
      response.repositories.length > 0 &&
      normalized.validCount === 0
    ) {
      return repositoryFailureFeed(false);
    }

    const cacheAccount = this.stableCacheAccount(
      { hostname: GITHUB_HOSTNAME, login: response.login },
      initialConfig,
    );
    let cacheAvailable = false;
    if (this.lists && this.cacheAccountStillCurrent(cacheAccount)) {
      try {
        this.lists.storeRepositories(cacheAccount, normalized.values);
        cacheAvailable = true;
      } catch {
        cacheAvailable = false;
      }
    }

    return this.repositoryFeed(normalized.values, query, cacheAvailable);
  }

  /**
   * 検証済みリポジトリを検索してAlfred応答へ変換する。
   *
   * @param {import("./domain.mjs").Repository[]} repositories リポジトリ一覧
   * @param {string} query ローカル検索語
   * @param {boolean} cacheAvailable 一覧キャッシュ保存済みの場合はtrue
   * @returns {object} Alfred応答
   */
  repositoryFeed(repositories, query, cacheAvailable) {
    if (repositories.length === 0) {
      return emptyRepositoryFeed();
    }
    const matchingRepositories = filterRepositories(repositories, query);
    if (matchingRepositories.length === 0) {
      return noMatchingRepositoryFeed();
    }

    const avatarResult = this.avatarPaths(
      repositoryOwners(matchingRepositories),
    );
    return {
      items: repositoryItems(matchingRepositories, avatarResult.paths),
      avatarRefreshNeeded:
        cacheAvailable && avatarResult.refreshNeeded,
    };
  }

  /**
   * 閲覧可能なOpen Projectを取得してAlfred応答を生成する。
   *
   * @param {string} githubCLIPath 検証済みGitHub CLIパス
   * @param {string} query ローカル検索語
   * @param {object | null} cacheAccount キャッシュ所有者
   * @returns {Promise<object>} Alfred応答
   */
  async runProjects(githubCLIPath, query, cacheAccount) {
    const result = await this.runner.run({
      path: githubCLIPath,
      args: [
        "api",
        "graphql",
        "--hostname",
        GITHUB_HOSTNAME,
        "--method",
        "POST",
        "--paginate",
        "-f",
        `query=${PROJECT_GRAPHQL_QUERY}`,
        "--jq",
        PROJECT_JQ_EXPRESSION,
      ],
      timeoutMilliseconds: API_TIMEOUT_MILLISECONDS,
      stdoutLimit: API_OUTPUT_LIMIT,
      stderrLimit: STDERR_LIMIT,
    });
    if (commandFailed(result)) {
      return projectFailureFeed(result.timedOut);
    }

    let projects;
    try {
      projects = parseProjects(result.stdout);
    } catch {
      return projectFailureFeed(false);
    }
    const normalized = normalizeProjects(projects);
    if (projects.length > 0 && normalized.validCount === 0) {
      return projectFailureFeed(false);
    }

    let cacheAvailable = false;
    if (this.lists && this.cacheAccountStillCurrent(cacheAccount)) {
      try {
        this.lists.storeProjects(cacheAccount, normalized.values);
        cacheAvailable = true;
      } catch {
        cacheAvailable = false;
      }
    }

    return this.projectFeed(normalized.values, query, cacheAvailable);
  }

  /**
   * 検証済みOpen Projectを検索してAlfred応答へ変換する。
   *
   * @param {import("./domain.mjs").Project[]} projects Project一覧
   * @param {string} query ローカル検索語
   * @param {boolean} cacheAvailable 一覧キャッシュ保存済みの場合はtrue
   * @returns {object} Alfred応答
   */
  projectFeed(projects, query, cacheAvailable) {
    if (projects.length === 0) {
      return emptyProjectFeed();
    }
    const matchingProjects = filterProjects(projects, query);
    if (matchingProjects.length === 0) {
      return noMatchingProjectFeed();
    }

    const avatarResult = this.avatarPaths(projectOwners(matchingProjects));
    return {
      items: projectItems(matchingProjects, avatarResult.paths),
      avatarRefreshNeeded:
        cacheAvailable && avatarResult.refreshNeeded,
    };
  }

  /**
   * 通信せず所有者ごとのローカルアバターパスを取得する。
   *
   * @param {object[]} owners GitHub所有者一覧
   * @returns {{paths: Map<number, string>, refreshNeeded: boolean}} 取得結果
   */
  avatarPaths(owners) {
    if (!this.avatars) {
      return { paths: new Map(), refreshNeeded: false };
    }
    return this.avatars.paths(owners);
  }
}

/**
 * Alfred実行環境用のアプリケーション依存を組み立てる。
 *
 * @param {string} launcherPath 認証処理にも使用するランチャーパス
 * @param {object | null} avatars アバターキャッシュ
 * @returns {App} 実環境用アプリケーション
 */
export function createEnvironmentApp(launcherPath, avatars) {
  return new App({
    runner: new ExecRunner(),
    avatars,
    lists: newEnvironmentListCache(),
    githubConfig: new EnvironmentGitHubConfigProvider(),
    helperTokenProvider: () => loginHelperToken(launcherPath),
  });
}

/**
 * 一覧キャッシュ無効化失敗を候補表示から分離する。
 *
 * @param {{invalidate: () => void}} lists 一覧キャッシュ
 * @returns {void}
 */
function safelyInvalidate(lists) {
  try {
    lists.invalidate();
  } catch {
    // キャッシュ異常時もGitHub CLIからの再取得を継続する
  }
}

/**
 * @typedef {object} AppDependencies
 * @property {{findExecutable: (name: string) => string, run: (command: object) => Promise<object>}} runner コマンド実行境界
 * @property {{paths: (owners: object[]) => {paths: Map<number, string>, refreshNeeded: boolean}} | null} avatars アバター境界
 * @property {{loadRepositories: Function, storeRepositories: Function, loadProjects: Function, storeProjects: Function, invalidate: Function} | null} lists 一覧キャッシュ境界
 * @property {{currentIdentity: () => object | null} | null} githubConfig 設定同一性境界
 * @property {() => string} helperTokenProvider 認証ヘルパートークン境界
 */

/**
 * @typedef {{status: "authenticated", authentication: object} | {status: "signed_out"} | {status: "failure", feed: object}} AuthenticationCheck
 */

export const GITHUB_HOSTNAME = "github.com";
export const GITHUB_CLI_WEBSITE = "https://cli.github.com/";
export const GITHUB_ISSUES_URL = "https://github.com/issues";
export const GITHUB_PULL_REQUESTS_URL = "https://github.com/pulls";
export const MINIMUM_GITHUB_CLI = "2.60.0";
export const API_OUTPUT_LIMIT = 16 * 1024 * 1024;
export const SHORT_OUTPUT_LIMIT = 4 * 1024;
export const STDERR_LIMIT = 8 * 1024;
export const VERSION_TIMEOUT_MILLISECONDS = 5_000;
export const AUTHENTICATION_TIMEOUT_MILLISECONDS = 5_000;
export const API_TIMEOUT_MILLISECONDS = 30_000;
export const PROJECT_READ_SCOPE = "read:project";
export const PROJECT_WRITE_SCOPE = "project";

const REPOSITORY_DESCRIPTION_LIMIT = 4 * 1024;
const PROJECT_DESCRIPTION_LIMIT = 4 * 1024;
const MINIMUM_VERSION = { major: 2, minor: 60, patch: 0 };

export const REPOSITORY_GRAPHQL_QUERY = `query($endCursor: String) {
  viewer {
    login
    repositories(
      first: 100
      after: $endCursor
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
    ) {
      nodes {
        databaseId
        nameWithOwner
        url
        isPrivate
        description
        isArchived
        isFork
        owner {
          avatarUrl
          login
          __typename
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

export const REPOSITORY_JQ_EXPRESSION = `.data.viewer as $viewer |
{
  login: $viewer.login,
  repositories: [
    $viewer.repositories.nodes[] |
    {
      id: .databaseId,
      full_name: .nameWithOwner,
      html_url: .url,
      private: .isPrivate,
      description,
      archived: .isArchived,
      fork: .isFork,
      owner: {
        login: .owner.login,
        avatar_url: .owner.avatarUrl,
        type: .owner.__typename
      }
    }
  ]
}`;

export const PROJECT_GRAPHQL_QUERY = `query($endCursor: String) {
  viewer {
    id
    login
    avatarUrl
    projectsV2(
      first: 100
      minPermissionLevel: READ
      orderBy: {field: TITLE, direction: ASC}
    ) {
      nodes {
        id
        number
        title
        url
        shortDescription
        public
        closed
      }
    }
    organizations(first: 100, after: $endCursor) {
      nodes {
        id
        login
        avatarUrl
        projectsV2(
          first: 100
          minPermissionLevel: READ
          orderBy: {field: TITLE, direction: ASC}
        ) {
          nodes {
            id
            number
            title
            url
            shortDescription
            public
            closed
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

export const PROJECT_JQ_EXPRESSION = `.data.viewer as $viewer |
(
  {
    owner: {
      node_id: $viewer.id,
      login: $viewer.login,
      avatar_url: $viewer.avatarUrl,
      type: "User"
    },
    projects: $viewer.projectsV2.nodes
  },
  (
    $viewer.organizations.nodes[] |
    {
      owner: {
        node_id: .id,
        login: .login,
        avatar_url: .avatarUrl,
        type: "Organization"
      },
      projects: .projectsV2.nodes
    }
  )
) |
.owner as $owner |
.projects[] |
{
  id,
  number,
  title,
  html_url: .url,
  short_description: .shortDescription,
  public,
  closed,
  owner: $owner
}`;

/**
 * 利用者入力を固定リンク、Project検索、リポジトリ検索へ分類する。
 *
 * @param {string} query Alfred検索語
 * @returns {RoutedInput} 分類結果
 */
export function routeInput(query) {
  const normalizedQuery = query.trim();
  if (/^issues?$/iu.test(normalizedQuery)) {
    return { mode: "issues", query: "" };
  }
  if (/^prs?$/iu.test(normalizedQuery)) {
    return { mode: "pull_requests", query: "" };
  }

  const match = normalizedQuery.match(/^(\S+)(?:\s+(.*))?$/u);
  const command = match?.[1] ?? "";
  if (/^projects?$/iu.test(command)) {
    return { mode: "projects", query: (match?.[2] ?? "").trim() };
  }

  return { mode: "repositories", query };
}

/**
 * GitHub CLIのバージョン出力を解析する。
 *
 * @param {Buffer | string} output GitHub CLI標準出力
 * @returns {SemanticVersion | null} 解析済みバージョン
 */
export function parseGitHubCLIVersion(output) {
  const fields = output.toString().trim().split(/\s+/u);
  for (let index = 0; index < fields.length - 1; index += 1) {
    if (fields[index] === "version") {
      return parseVersion(fields[index + 1]);
    }
  }

  return null;
}

/**
 * ドット区切りのセマンティックバージョンを解析する。
 *
 * @param {string} value バージョン文字列
 * @returns {SemanticVersion | null} 解析済みバージョン
 */
export function parseVersion(value) {
  const normalizedValue = value.replace(/^v/u, "").split("-", 1)[0];
  const match = normalizedValue.match(/^(\d+)\.(\d+)\.(\d+)$/u);
  if (!match) {
    return null;
  }

  const numbers = match.slice(1).map(Number);
  if (numbers.some((number) => !Number.isSafeInteger(number))) {
    return null;
  }

  return { major: numbers[0], minor: numbers[1], patch: numbers[2] };
}

/**
 * GitHub CLIが必要な最小バージョン以上か判定する。
 *
 * @param {SemanticVersion} current 現在バージョン
 * @returns {boolean} 最小バージョン以上の場合はtrue
 */
export function supportedGitHubCLIVersion(current) {
  return !versionLessThan(current, MINIMUM_VERSION);
}

/**
 * ページ単位のリポジトリGraphQL応答を解析してログイン名と一覧を取得する。
 *
 * @param {Buffer | string} output GitHub CLI標準出力
 * @returns {{login: string, repositories: unknown[]}} 解析済みアカウントと一覧
 * @throws {Error} ページ構造、ログイン名、JSONが不正な場合
 */
export function parseRepositoryPages(output) {
  const pages = parseJSONLines(output);
  if (pages.length === 0) {
    throw new Error("repository response contains no pages");
  }

  let login = "";
  /** @type {unknown[]} */
  const repositories = [];
  for (const page of pages) {
    if (
      !isRecord(page) ||
      typeof page.login !== "string" ||
      !isGitHubLogin(page.login) ||
      !Array.isArray(page.repositories)
    ) {
      throw new Error("repository response page is invalid");
    }

    const pageLogin = page.login.toLowerCase();
    if (login !== "" && login !== pageLogin) {
      throw new Error("repository response account changed between pages");
    }
    login = pageLogin;
    repositories.push(...page.repositories.map(withDerivedOwnerID));
  }

  return { login, repositories };
}

/**
 * リポジトリを検証・正規化して安定順へ並べる。
 *
 * @param {unknown[]} repositories APIまたはキャッシュ由来の値
 * @returns {{values: Repository[], validCount: number}} 正規化結果
 */
export function normalizeRepositories(repositories) {
  /** @type {Repository[]} */
  const normalizedRepositories = [];

  for (const candidate of repositories) {
    if (!isRecord(candidate)) {
      continue;
    }
    const owner = normalizedRepositoryOwner(candidate.owner);
    if (
      !Number.isSafeInteger(candidate.id) ||
      candidate.id <= 0 ||
      typeof candidate.full_name !== "string" ||
      candidate.full_name === "" ||
      typeof candidate.html_url !== "string" ||
      !isGitHubRepositoryURL(candidate.html_url, candidate.full_name) ||
      typeof candidate.private !== "boolean" ||
      (candidate.description !== null &&
        typeof candidate.description !== "string") ||
      typeof candidate.archived !== "boolean" ||
      typeof candidate.fork !== "boolean" ||
      owner === null
    ) {
      continue;
    }

    normalizedRepositories.push({
      id: candidate.id,
      full_name: candidate.full_name,
      html_url: candidate.html_url,
      private: candidate.private,
      description:
        candidate.description === null
          ? null
          : boundedDisplayText(
            candidate.description,
            REPOSITORY_DESCRIPTION_LIMIT,
          ),
      archived: candidate.archived,
      fork: candidate.fork,
      owner,
    });
  }

  normalizedRepositories.sort((left, right) => {
    const leftFolded = left.full_name.toLowerCase();
    const rightFolded = right.full_name.toLowerCase();
    if (leftFolded !== rightFolded) {
      return leftFolded < rightFolded ? -1 : 1;
    }
    return left.full_name < right.full_name
      ? -1
      : left.full_name === right.full_name
        ? 0
        : 1;
  });

  return {
    values: normalizedRepositories,
    validCount: normalizedRepositories.length,
  };
}

/**
 * 検証済みリポジトリから検索語を含む項目を抽出する。
 *
 * @param {Repository[]} repositories 検証済みリポジトリ
 * @param {string} query 検索語
 * @returns {Repository[]} 一致したリポジトリ
 */
export function filterRepositories(repositories, query) {
  const normalizedQuery = normalizedFilterQuery(query);
  return repositories.filter(
    (repository) =>
      normalizedQuery === "" ||
      repository.full_name.toLowerCase().includes(normalizedQuery),
  );
}

/**
 * リポジトリをAlfred候補へ変換する。
 *
 * @param {Repository[]} repositories 検証済みリポジトリ
 * @param {Map<number, string>} avatarPaths 所有者別アバターパス
 * @returns {AlfredItem[]} Alfred候補
 */
export function repositoryItems(repositories, avatarPaths) {
  return repositories.map((repository) => {
    /** @type {AlfredItem} */
    const item = {
      uid: String(repository.id),
      title: repository.full_name,
      subtitle: repositorySubtitle(repository),
      arg: repository.html_url,
      match: repository.full_name,
      quicklookurl: repository.html_url,
      valid: true,
      variables: { action: "open" },
    };
    const avatarPath = avatarPaths.get(repository.owner.id);
    if (avatarPath) {
      item.icon = { path: avatarPath };
    }
    return item;
  });
}

/**
 * リポジトリから所有者情報を抽出する。
 *
 * @param {Repository[]} repositories 検証済みリポジトリ
 * @returns {GitHubOwner[]} 所有者一覧
 */
export function repositoryOwners(repositories) {
  return repositories.map((repository) => repository.owner);
}

/**
 * 改行区切りのProject API応答を解析して所有者IDを補完する。
 *
 * @param {Buffer | string} output GitHub CLI標準出力
 * @returns {unknown[]} 解析済み値
 * @throws {Error} JSONが不正な場合
 */
export function parseProjects(output) {
  return parseJSONLines(output).map(withDerivedOwnerID);
}

/**
 * Projectを検証・重複排除し、Open Projectを安定順へ並べる。
 *
 * @param {unknown[]} projects APIまたはキャッシュ由来の値
 * @returns {{values: Project[], validCount: number, openCount: number}} 正規化結果
 */
export function normalizeProjects(projects) {
  /** @type {Project[]} */
  const normalizedProjects = [];
  const seenProjectIDs = new Set();
  let validCount = 0;
  let openCount = 0;

  for (const candidate of projects) {
    if (!isRecord(candidate)) {
      continue;
    }
    const owner = normalizedProjectOwner(candidate.owner);
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.number !== "number" ||
      typeof candidate.title !== "string" ||
      typeof candidate.html_url !== "string" ||
      typeof candidate.short_description !== "string" ||
      typeof candidate.public !== "boolean" ||
      typeof candidate.closed !== "boolean" ||
      owner === null
    ) {
      continue;
    }

    const value = {
      id: candidate.id,
      number: candidate.number,
      title: normalizedDisplayText(candidate.title),
      html_url: candidate.html_url,
      short_description: boundedDisplayText(
        candidate.short_description,
        PROJECT_DESCRIPTION_LIMIT,
      ),
      public: candidate.public,
      closed: candidate.closed,
      owner,
    };
    if (!isValidProject(value) || seenProjectIDs.has(value.id)) {
      continue;
    }

    seenProjectIDs.add(value.id);
    validCount += 1;
    if (value.closed) {
      continue;
    }
    openCount += 1;
    normalizedProjects.push(value);
  }

  normalizedProjects.sort((left, right) => {
    const leftOwner = left.owner.login.toLowerCase();
    const rightOwner = right.owner.login.toLowerCase();
    if (leftOwner !== rightOwner) {
      return leftOwner < rightOwner ? -1 : 1;
    }

    const leftTitle = left.title.toLowerCase();
    const rightTitle = right.title.toLowerCase();
    if (leftTitle !== rightTitle) {
      return leftTitle < rightTitle ? -1 : 1;
    }
    return left.number - right.number;
  });

  return { values: normalizedProjects, validCount, openCount };
}

/**
 * 検証済みOpen Projectから所有者またはタイトルに一致する項目を抽出する。
 *
 * @param {Project[]} projects 検証済みProject
 * @param {string} query 検索語
 * @returns {Project[]} 一致したProject
 */
export function filterProjects(projects, query) {
  const normalizedQuery = normalizedFilterQuery(query);
  return projects.filter(
    (project) =>
      normalizedQuery === "" ||
      project.owner.login.toLowerCase().includes(normalizedQuery) ||
      project.title.toLowerCase().includes(normalizedQuery),
  );
}

/**
 * ProjectをAlfred候補へ変換する。
 *
 * @param {Project[]} projects 検証済みProject
 * @param {Map<number, string>} avatarPaths 所有者別アバターパス
 * @returns {AlfredItem[]} Alfred候補
 */
export function projectItems(projects, avatarPaths) {
  return projects.map((project) => {
    /** @type {AlfredItem} */
    const item = {
      uid: `project:${project.id}`,
      title: `${project.owner.login} / ${project.title}`,
      subtitle: projectSubtitle(project),
      arg: project.html_url,
      match: `${project.owner.login} ${project.title}`,
      quicklookurl: project.html_url,
      valid: true,
      variables: { action: "open" },
    };
    const avatarPath = avatarPaths.get(project.owner.id);
    if (avatarPath) {
      item.icon = { path: avatarPath };
    }
    return item;
  });
}

/**
 * Projectから所有者情報を抽出する。
 *
 * @param {Project[]} projects 検証済みProject
 * @returns {GitHubOwner[]} 所有者一覧
 */
export function projectOwners(projects) {
  return projects.map((project) => project.owner);
}

/**
 * GitHub.comのユーザー名またはOrganization名を検証する。
 *
 * @param {string} login 検証対象ログイン名
 * @returns {boolean} GitHub命名条件を満たす場合はtrue
 */
export function isGitHubLogin(login) {
  return (
    typeof login === "string" &&
    login.length >= 1 &&
    login.length <= 39 &&
    !login.startsWith("-") &&
    !login.endsWith("-") &&
    /^[A-Za-z0-9-]+$/u.test(login)
  );
}

/**
 * GitHub.com上の対象リポジトリURLだけを許可する。
 *
 * @param {string} rawURL 検証対象URL
 * @param {string} fullName owner/repository形式の名前
 * @returns {boolean} 期待URLと完全一致する場合はtrue
 */
export function isGitHubRepositoryURL(rawURL, fullName) {
  const expectedURL = `https://${GITHUB_HOSTNAME}/${fullName}`;
  if (rawURL !== expectedURL) {
    return false;
  }

  try {
    const parsedURL = new URL(rawURL);
    return (
      parsedURL.protocol === "https:" &&
      parsedURL.hostname === GITHUB_HOSTNAME &&
      parsedURL.port === "" &&
      parsedURL.username === "" &&
      parsedURL.password === "" &&
      parsedURL.search === "" &&
      parsedURL.hash === "" &&
      parsedURL.pathname === `/${fullName}`
    );
  } catch {
    return false;
  }
}

/**
 * GitHub.com上の対象Project URLだけを許可する。
 *
 * @param {string} rawURL 検証対象URL
 * @param {GitHubOwner} owner Project所有者
 * @param {number} number Project番号
 * @returns {boolean} 期待URLと完全一致する場合はtrue
 */
export function isGitHubProjectURL(rawURL, owner, number) {
  const ownerPath =
    owner.type === "Organization"
      ? "/orgs/"
      : owner.type === "User"
        ? "/users/"
        : "";
  if (ownerPath === "") {
    return false;
  }

  const expectedPath = `${ownerPath}${owner.login}/projects/${number}`;
  const expectedURL = `https://${GITHUB_HOSTNAME}${expectedPath}`;
  if (rawURL !== expectedURL) {
    return false;
  }

  try {
    const parsedURL = new URL(rawURL);
    return (
      parsedURL.protocol === "https:" &&
      parsedURL.hostname === GITHUB_HOSTNAME &&
      parsedURL.port === "" &&
      parsedURL.username === "" &&
      parsedURL.password === "" &&
      parsedURL.search === "" &&
      parsedURL.hash === "" &&
      parsedURL.pathname === expectedPath
    );
  } catch {
    return false;
  }
}

/**
 * HTTPSのGitHubアバター配信先から数値所有者IDを取得する。
 *
 * @param {string} rawURL 検証対象URL
 * @returns {number | null} 検証済み所有者ID
 */
export function avatarOwnerIDFromURL(rawURL) {
  try {
    const parsedURL = new URL(rawURL);
    if (!isAllowedAvatarURL(parsedURL)) {
      return null;
    }
    const match = parsedURL.pathname.match(/^\/u\/([1-9][0-9]*)$/u);
    if (!match) {
      return null;
    }
    const ownerID = Number(match[1]);
    return Number.isSafeInteger(ownerID) && ownerID > 0 ? ownerID : null;
  } catch {
    return null;
  }
}

/**
 * GitHubアバターURLを検証して固定画像サイズを指定する。
 *
 * @param {string} rawURL 検証対象URL
 * @param {number} ownerID 期待所有者ID
 * @returns {string | null} 正規化済みURL
 */
export function normalizedAvatarURL(rawURL, ownerID) {
  if (avatarOwnerIDFromURL(rawURL) !== ownerID) {
    return null;
  }

  const parsedURL = new URL(rawURL);
  parsedURL.search = "";
  parsedURL.searchParams.set("s", "128");
  return parsedURL.toString();
}

/**
 * URLが許可したGitHubアバター配信先か判定する。
 *
 * @param {URL} parsedURL 解析済みURL
 * @returns {boolean} 許可条件を満たす場合はtrue
 */
export function isAllowedAvatarURL(parsedURL) {
  return (
    parsedURL.protocol === "https:" &&
    parsedURL.hostname === "avatars.githubusercontent.com" &&
    parsedURL.port === "" &&
    parsedURL.username === "" &&
    parsedURL.password === "" &&
    parsedURL.hash === "" &&
    /^\/u\/[1-9][0-9]*$/u.test(parsedURL.pathname)
  );
}

/**
 * GitHub CLI認証にProject読取権限があるか判定する。
 *
 * @param {string} scopes GitHub CLIのスコープ表示
 * @returns {boolean} 読取または書込スコープがある場合はtrue
 */
export function hasProjectReadScope(scopes) {
  return scopes.split(",").some((value) => {
    const scope = value.trim().replace(/^['"]|['"]$/gu, "");
    return scope === PROJECT_READ_SCOPE || scope === PROJECT_WRITE_SCOPE;
  });
}

/**
 * コマンド結果が利用不能か判定する。
 *
 * @param {import("./command.mjs").CommandResult | CommandResultLike} result コマンド結果
 * @returns {boolean} 失敗状態の場合はtrue
 */
export function commandFailed(result) {
  return (
    result.error !== null ||
    result.timedOut ||
    result.stdoutOverflow ||
    result.stderrOverflow
  );
}

/**
 * 固定GitHubページを開くAlfred候補を生成する。
 *
 * @param {string} title 表示タイトル
 * @param {string} subtitle 補足説明
 * @param {string} targetURL 固定URL
 * @returns {Feed} Alfred応答
 */
export function fixedLinkFeed(title, subtitle, targetURL) {
  return feed([
    {
      title,
      subtitle,
      arg: targetURL,
      quicklookurl: targetURL,
      valid: true,
      variables: { action: "open" },
    },
  ]);
}

/**
 * GitHub CLI導入ページを開くAlfred候補を生成する。
 *
 * @param {string} title 表示タイトル
 * @returns {Feed} Alfred応答
 */
export function installFeed(title) {
  return feed([
    {
      title,
      subtitle: `GitHub CLI ${MINIMUM_GITHUB_CLI} or later is required.`,
      arg: GITHUB_CLI_WEBSITE,
      quicklookurl: GITHUB_CLI_WEBSITE,
      valid: true,
      variables: { action: "open" },
    },
  ]);
}

/**
 * GitHub CLIのWeb認証を開始する候補を生成する。
 *
 * @param {string} helperToken 検証済みランチャーパストークン
 * @returns {Feed} Alfred応答
 */
export function loginFeed(helperToken) {
  if (helperToken === "") {
    return failureFeed(
      "Unable to start GitHub authentication",
      "Reinstall the workflow, then try again.",
    );
  }
  return feed([
    {
      title: "Sign in to GitHub",
      subtitle: "Press Return to authenticate with GitHub CLI.",
      valid: true,
      variables: { action: "login", login_helper: helperToken },
    },
  ]);
}

/**
 * Project読取権限を含むGitHub CLI認証候補を生成する。
 *
 * @param {string} helperToken 検証済みランチャーパストークン
 * @returns {Feed} Alfred応答
 */
export function projectLoginFeed(helperToken) {
  if (helperToken === "") {
    return failureFeed(
      "Unable to start GitHub authentication",
      "Reinstall the workflow, then try again.",
    );
  }
  return feed([
    {
      title: "Sign in to GitHub for Projects",
      subtitle:
        "Press Return to authenticate with read-only Projects access.",
      valid: true,
      variables: { action: "login-projects", login_helper: helperToken },
    },
  ]);
}

/**
 * 既存認証へProject読取権限を追加する候補を生成する。
 *
 * @param {string} helperToken 検証済みランチャーパストークン
 * @returns {Feed} Alfred応答
 */
export function projectAuthorizationFeed(helperToken) {
  if (helperToken === "") {
    return failureFeed(
      "Unable to authorize GitHub Projects",
      "Reinstall the workflow, then try again.",
    );
  }
  return feed([
    {
      title: "Authorize GitHub Projects",
      subtitle: "Press Return to add read-only Projects access to GitHub CLI.",
      valid: true,
      variables: {
        action: "authorize-projects",
        login_helper: helperToken,
      },
    },
  ]);
}

/**
 * 選択できない状態通知候補を生成する。
 *
 * @param {string} title 表示タイトル
 * @param {string} subtitle 補足説明
 * @returns {Feed} Alfred応答
 */
export function failureFeed(title, subtitle) {
  return feed([{ title, subtitle, valid: false }]);
}

/**
 * 閲覧可能なリポジトリがない状態を生成する。
 *
 * @returns {Feed} Alfred応答
 */
export function emptyRepositoryFeed() {
  return failureFeed(
    "No repositories found",
    "The active GitHub account has no accessible repositories.",
  );
}

/**
 * 検索語に一致するリポジトリがない状態を生成する。
 *
 * @returns {Feed} Alfred応答
 */
export function noMatchingRepositoryFeed() {
  return failureFeed(
    "No matching repositories",
    "No repository owner or name contains your query.",
  );
}

/**
 * リポジトリ取得失敗状態を生成する。
 *
 * @param {boolean} timedOut タイムアウトの場合はtrue
 * @returns {Feed} Alfred応答
 */
export function repositoryFailureFeed(timedOut) {
  return timedOut
    ? failureFeed(
      "Unable to load repositories",
      "GitHub did not respond in time. Try again.",
    )
    : failureFeed(
      "Unable to load repositories",
      "Check your connection and GitHub CLI authentication, then try again.",
    );
}

/**
 * 閲覧可能なOpen Projectがない状態を生成する。
 *
 * @returns {Feed} Alfred応答
 */
export function emptyProjectFeed() {
  return failureFeed(
    "No open projects found",
    "The active GitHub account has no accessible open projects.",
  );
}

/**
 * 検索語に一致するProjectがない状態を生成する。
 *
 * @returns {Feed} Alfred応答
 */
export function noMatchingProjectFeed() {
  return failureFeed(
    "No matching projects",
    "No project owner or title contains your query.",
  );
}

/**
 * Project取得失敗状態を生成する。
 *
 * @param {boolean} timedOut タイムアウトの場合はtrue
 * @returns {Feed} Alfred応答
 */
export function projectFailureFeed(timedOut) {
  return timedOut
    ? failureFeed(
      "Unable to load projects",
      "GitHub did not respond in time. Try again.",
    )
    : failureFeed(
      "Unable to load projects",
      "Check your connection, GitHub CLI authentication, and Organization access.",
    );
}

/**
 * Alfred応答を生成する。
 *
 * @param {AlfredItem[]} items Alfred候補
 * @param {boolean} [avatarRefreshNeeded=false] アバター更新要否
 * @returns {Feed} Alfred応答
 */
export function feed(items, avatarRefreshNeeded = false) {
  return { items, avatarRefreshNeeded };
}

/**
 * 表示文字列の改行と連続空白を正規化する。
 *
 * @param {string} value 外部入力
 * @returns {string} 表示用文字列
 */
export function normalizedDisplayText(value) {
  return value.trim().replace(/\s+/gu, " ");
}

/**
 * 表示文字列をUTF-8境界を保って指定バイト数へ制限する。
 *
 * @param {string} value 外部入力
 * @param {number} limit 最大バイト数
 * @returns {string} 制限済み表示文字列
 */
export function boundedDisplayText(value, limit) {
  const normalizedValue = normalizedDisplayText(value);
  if (limit <= 0 || Buffer.byteLength(normalizedValue, "utf8") <= limit) {
    return normalizedValue;
  }

  let result = "";
  let bytes = 0;
  for (const character of normalizedValue) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > limit) {
      break;
    }
    result += character;
    bytes += characterBytes;
  }
  return `${result.trim()}…`;
}

/**
 * リポジトリ所有者を検証して必要フィールドだけ複製する。
 *
 * @param {unknown} candidate 検証対象
 * @returns {GitHubOwner | null} 検証済み所有者
 */
function normalizedRepositoryOwner(candidate) {
  if (
    !isRecord(candidate) ||
    !Number.isSafeInteger(candidate.id) ||
    candidate.id <= 0 ||
    typeof candidate.login !== "string" ||
    typeof candidate.avatar_url !== "string" ||
    typeof candidate.type !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    login: candidate.login,
    avatar_url: candidate.avatar_url,
    type: candidate.type,
  };
}

/**
 * Project所有者を検証して必要フィールドだけ複製する。
 *
 * @param {unknown} candidate 検証対象
 * @returns {GitHubOwner | null} 検証済み所有者
 */
function normalizedProjectOwner(candidate) {
  if (
    !isRecord(candidate) ||
    !Number.isSafeInteger(candidate.id) ||
    candidate.id <= 0 ||
    typeof candidate.node_id !== "string" ||
    typeof candidate.login !== "string" ||
    typeof candidate.avatar_url !== "string" ||
    typeof candidate.type !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    node_id: candidate.node_id,
    login: candidate.login,
    avatar_url: candidate.avatar_url,
    type: candidate.type,
  };
}

/**
 * Projectの識別情報と遷移先を検証する。
 *
 * @param {Project} project 検証対象Project
 * @returns {boolean} 有効な場合はtrue
 */
function isValidProject(project) {
  return (
    project.id !== "" &&
    Buffer.byteLength(project.id, "utf8") <= 256 &&
    Number.isSafeInteger(project.number) &&
    project.number > 0 &&
    project.title !== "" &&
    Buffer.byteLength(project.title, "utf8") <= 1024 &&
    isValidProjectOwner(project.owner) &&
    isGitHubProjectURL(project.html_url, project.owner, project.number)
  );
}

/**
 * Project所有者の識別情報を検証する。
 *
 * @param {GitHubOwner} owner 検証対象所有者
 * @returns {boolean} 有効な場合はtrue
 */
function isValidProjectOwner(owner) {
  return (
    typeof owner.node_id === "string" &&
    owner.node_id !== "" &&
    Buffer.byteLength(owner.node_id, "utf8") <= 256 &&
    isGitHubLogin(owner.login) &&
    (owner.type === "Organization" || owner.type === "User")
  );
}

/**
 * 公開状態と説明からリポジトリ補足文を生成する。
 *
 * @param {Repository} repository 検証済みリポジトリ
 * @returns {string} 補足文
 */
function repositorySubtitle(repository) {
  const labels = [repository.private ? "Private" : "Public"];
  if (repository.archived) {
    labels.push("Archived");
  }
  if (repository.fork) {
    labels.push("Fork");
  }

  const subtitle = labels.join(" · ");
  if (repository.description === null) {
    return subtitle;
  }
  const description = normalizedDisplayText(repository.description);
  return description === "" ? subtitle : `${subtitle} — ${description}`;
}

/**
 * 公開状態、番号、説明からProject補足文を生成する。
 *
 * @param {Project} project 検証済みProject
 * @returns {string} 補足文
 */
function projectSubtitle(project) {
  const subtitle = `${project.public ? "Public" : "Private"} · Project #${project.number}`;
  return project.short_description === ""
    ? subtitle
    : `${subtitle} — ${project.short_description}`;
}

/**
 * 検索語の前後空白と大文字小文字を正規化する。
 *
 * @param {string} query 検索語
 * @returns {string} 正規化済み検索語
 */
function normalizedFilterQuery(query) {
  return query.trim().toLowerCase();
}

/**
 * 2つのセマンティックバージョンを比較する。
 *
 * @param {SemanticVersion} current 比較元
 * @param {SemanticVersion} other 比較先
 * @returns {boolean} 比較元が古い場合はtrue
 */
function versionLessThan(current, other) {
  if (current.major !== other.major) {
    return current.major < other.major;
  }
  if (current.minor !== other.minor) {
    return current.minor < other.minor;
  }
  return current.patch < other.patch;
}

/**
 * 改行区切りJSONを容量確定済み文字列から解析する。
 *
 * @param {Buffer | string} output JSON出力
 * @returns {unknown[]} 解析済み値
 * @throws {Error} JSONが不正な場合
 */
function parseJSONLines(output) {
  const text = output.toString().trim();
  if (text === "") {
    return [];
  }
  return text.split("\n").map((line) => JSON.parse(line));
}

/**
 * API項目の検証可能なアバターURLから数値所有者IDを補完する。
 *
 * @param {unknown} candidate リポジトリまたはProject候補
 * @returns {unknown} 所有者IDを補完した候補
 */
function withDerivedOwnerID(candidate) {
  if (!isRecord(candidate) || !isRecord(candidate.owner)) {
    return candidate;
  }

  const owner = { ...candidate.owner };
  if (!Number.isSafeInteger(owner.id) || owner.id <= 0) {
    const ownerID = avatarOwnerIDFromURL(
      typeof owner.avatar_url === "string" ? owner.avatar_url : "",
    );
    if (ownerID !== null) {
      owner.id = ownerID;
    }
  }
  return { ...candidate, owner };
}

/**
 * 値が非配列オブジェクトか判定する。
 *
 * @param {unknown} value 検証対象
 * @returns {value is Record<string, unknown>} オブジェクトの場合はtrue
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @typedef {object} SemanticVersion
 * @property {number} major メジャーバージョン
 * @property {number} minor マイナーバージョン
 * @property {number} patch パッチバージョン
 */

/**
 * @typedef {object} RoutedInput
 * @property {"repositories" | "issues" | "pull_requests" | "projects"} mode 入力種別
 * @property {string} query ローカル検索語
 */

/**
 * @typedef {object} GitHubOwner
 * @property {number} id 数値所有者ID
 * @property {string} [node_id] GraphQLノードID
 * @property {string} login GitHubログイン名
 * @property {string} avatar_url アバターURL
 * @property {string} type 所有者種別
 */

/**
 * @typedef {object} Repository
 * @property {number} id リポジトリID
 * @property {string} full_name owner/repository形式の名前
 * @property {string} html_url GitHub URL
 * @property {boolean} private 非公開状態
 * @property {string | null} description 説明
 * @property {boolean} archived アーカイブ状態
 * @property {boolean} fork Fork状態
 * @property {GitHubOwner} owner 所有者
 */

/**
 * @typedef {object} Project
 * @property {string} id GraphQLノードID
 * @property {number} number Project番号
 * @property {string} title タイトル
 * @property {string} html_url GitHub URL
 * @property {string} short_description 説明
 * @property {boolean} public 公開状態
 * @property {boolean} closed 終了状態
 * @property {GitHubOwner} owner 所有者
 */

/**
 * @typedef {object} AlfredItem
 * @property {string} [uid] 安定識別子
 * @property {string} title 表示タイトル
 * @property {string} [subtitle] 補足説明
 * @property {string} [arg] Alfred引数
 * @property {string} [match] 検索対象文字列
 * @property {string} [quicklookurl] Quick Look URL
 * @property {{path: string}} [icon] アイコン
 * @property {boolean} valid 選択可能状態
 * @property {Record<string, string>} [variables] 後続処理用変数
 */

/**
 * @typedef {object} Feed
 * @property {AlfredItem[]} items Alfred候補
 * @property {boolean} avatarRefreshNeeded アバター更新要否
 */

/**
 * @typedef {object} CommandResultLike
 * @property {Error | null} error 実行エラー
 * @property {boolean} timedOut タイムアウト有無
 * @property {boolean} stdoutOverflow 標準出力超過有無
 * @property {boolean} stderrOverflow 標準エラー出力超過有無
 */

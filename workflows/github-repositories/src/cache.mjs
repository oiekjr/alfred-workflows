import { rmSync } from "node:fs";
import path from "node:path";
import {
  githubConfigIdentitiesEqual,
  isValidGitHubAccountIdentity,
  isValidGitHubConfigIdentity,
} from "./authentication.mjs";
import {
  API_OUTPUT_LIMIT,
  normalizeProjects,
  normalizeRepositories,
} from "./domain.mjs";
import {
  ensureSecureCacheSubdirectory,
  expectedAlfredCacheRoot,
  isFileSystemError,
  readPrivateFile,
  trustedAlfredCacheRootFromEnvironment,
  validatePrivateRegularFile,
  writePrivateDataAtomically,
} from "./security.mjs";

const LIST_CACHE_LIFETIME_MILLISECONDS = 30 * 60 * 1000;
const LIST_CACHE_DIRECTORY = "lists";
const LIST_CACHE_SCHEMA_VERSION = 3;
const REPOSITORY_LIST_CACHE_NAME = "repositories.json";
const PROJECT_LIST_CACHE_NAME = "projects.json";

/**
 * 検証済みGitHub一覧をアカウント単位で短期保存する。
 */
export class ListCache {
  /**
   * キャッシュ保存先と時刻関数を初期化する。
   *
   * @param {string} rootDirectory 非公開キャッシュルート
   * @param {() => number} [now=Date.now] 現在時刻を返す関数
   */
  constructor(rootDirectory, now = Date.now) {
    this.rootDirectory = rootDirectory;
    this.now = now;
  }

  /**
   * 現在のGitHub CLI設定に対応するリポジトリ一覧を読み込む。
   *
   * @param {import("./authentication.mjs").GitHubConfigIdentity | object} config 設定同一性
   * @returns {import("./domain.mjs").Repository[] | null} 有効な一覧
   */
  loadRepositories(config) {
    if (!isValidGitHubConfigIdentity(config)) {
      return null;
    }

    const document = this.load(REPOSITORY_LIST_CACHE_NAME);
    if (
      !isRepositoryCacheDocument(document) ||
      !githubConfigIdentitiesEqual(document.account.config, config)
    ) {
      this.invalidateFile(REPOSITORY_LIST_CACHE_NAME);
      return null;
    }

    const normalized = normalizeRepositories(document.repositories);
    if (normalized.validCount !== document.repositories.length) {
      this.invalidateFile(REPOSITORY_LIST_CACHE_NAME);
      return null;
    }

    return normalized.values;
  }

  /**
   * 検証済みリポジトリ一覧を現在アカウント用に保存する。
   *
   * @param {object} account GitHubアカウント同一性
   * @param {unknown[]} repositories リポジトリ一覧
   * @returns {void}
   * @throws {Error} 入力または保存先が不正な場合
   */
  storeRepositories(account, repositories) {
    if (!isValidGitHubAccountIdentity(account)) {
      throw new Error("repository cache account is invalid");
    }
    const normalized = normalizeRepositories(repositories);
    if (normalized.validCount !== repositories.length) {
      throw new Error("repository cache contains invalid entries");
    }

    this.store(REPOSITORY_LIST_CACHE_NAME, {
      schema: LIST_CACHE_SCHEMA_VERSION,
      account,
      repositories: normalized.values,
    });
  }

  /**
   * 現在のGitHub CLI設定に対応するOpen Project一覧を読み込む。
   *
   * @param {object} config 設定同一性
   * @returns {import("./domain.mjs").Project[] | null} 有効な一覧
   */
  loadProjects(config) {
    if (!isValidGitHubConfigIdentity(config)) {
      return null;
    }

    const document = this.load(PROJECT_LIST_CACHE_NAME);
    if (
      !isProjectCacheDocument(document) ||
      !githubConfigIdentitiesEqual(document.account.config, config)
    ) {
      this.invalidateFile(PROJECT_LIST_CACHE_NAME);
      return null;
    }

    const normalized = normalizeProjects(document.projects);
    if (
      normalized.validCount !== document.projects.length ||
      normalized.openCount !== document.projects.length
    ) {
      this.invalidateFile(PROJECT_LIST_CACHE_NAME);
      return null;
    }

    return normalized.values;
  }

  /**
   * 検証済みOpen Project一覧を現在アカウント用に保存する。
   *
   * @param {object} account GitHubアカウント同一性
   * @param {unknown[]} projects Open Project一覧
   * @returns {void}
   * @throws {Error} 入力または保存先が不正な場合
   */
  storeProjects(account, projects) {
    if (!isValidGitHubAccountIdentity(account)) {
      throw new Error("project cache account is invalid");
    }
    const normalized = normalizeProjects(projects);
    if (
      normalized.validCount !== projects.length ||
      normalized.openCount !== projects.length
    ) {
      throw new Error("project cache contains invalid entries");
    }

    this.store(PROJECT_LIST_CACHE_NAME, {
      schema: LIST_CACHE_SCHEMA_VERSION,
      account,
      projects: normalized.values,
    });
  }

  /**
   * GitHub一覧の短期キャッシュだけを削除する。
   *
   * @returns {void}
   * @throws {Error} 検証済みファイルを削除できない場合
   */
  invalidate() {
    if (!this.rootDirectory || !path.isAbsolute(this.rootDirectory)) {
      return;
    }

    for (const name of [
      REPOSITORY_LIST_CACHE_NAME,
      PROJECT_LIST_CACHE_NAME,
    ]) {
      this.removeFile(name);
    }
  }

  /**
   * 固定名のキャッシュ文書を容量・権限・期限付きで読み込む。
   *
   * @param {string} name 固定ファイル名
   * @returns {unknown | null} 解析済み文書
   */
  load(name) {
    if (
      typeof this.now !== "function" ||
      !this.rootDirectory ||
      !path.isAbsolute(this.rootDirectory)
    ) {
      return null;
    }

    const targetPath = this.path(name);
    try {
      const information = validatePrivateRegularFile(targetPath);
      const ageMilliseconds =
        this.now() - Number(information.mtimeNs / 1_000_000n);
      if (
        ageMilliseconds < 0 ||
        ageMilliseconds > LIST_CACHE_LIFETIME_MILLISECONDS
      ) {
        this.invalidateFile(name);
        return null;
      }

      const data = readPrivateFile(targetPath, API_OUTPUT_LIMIT);
      return JSON.parse(data.toString("utf8"));
    } catch {
      this.invalidateFile(name);
      return null;
    }
  }

  /**
   * 固定名のキャッシュ文書を容量制限付きでアトミックに保存する。
   *
   * @param {string} name 固定ファイル名
   * @param {object} document 保存文書
   * @returns {void}
   * @throws {Error} 容量または保存条件を満たさない場合
   */
  store(name, document) {
    if (!this.rootDirectory || !path.isAbsolute(this.rootDirectory)) {
      throw new Error("list cache is unavailable");
    }

    const data = Buffer.from(JSON.stringify(document), "utf8");
    if (data.length > API_OUTPUT_LIMIT) {
      throw new Error("list cache exceeds size limit");
    }

    const directory = ensureSecureCacheSubdirectory(
      this.rootDirectory,
      LIST_CACHE_DIRECTORY,
    );
    writePrivateDataAtomically(directory, name, data);
  }

  /**
   * 固定したキャッシュファイル名の絶対パスを生成する。
   *
   * @param {string} name 固定ファイル名
   * @returns {string} キャッシュファイルパス
   */
  path(name) {
    return path.join(this.rootDirectory, LIST_CACHE_DIRECTORY, name);
  }

  /**
   * 無効な固定名キャッシュを削除する。
   *
   * @param {string} name 固定ファイル名
   * @returns {void}
   */
  invalidateFile(name) {
    try {
      this.removeFile(name);
    } catch {
      // 読込失敗時は候補表示を優先し、次回保存で置換する
    }
  }

  /**
   * 検証済み通常ファイルだけを削除する。
   *
   * @param {string} name 固定ファイル名
   * @returns {void}
   * @throws {Error} 不正な既存パスまたは削除失敗を検出した場合
   */
  removeFile(name) {
    if (!this.rootDirectory || !path.isAbsolute(this.rootDirectory)) {
      return;
    }

    const targetPath = this.path(name);
    try {
      validatePrivateRegularFile(targetPath);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        return;
      }
      throw error;
    }

    try {
      rmSync(targetPath);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) {
        throw error;
      }
    }
  }
}

/**
 * Alfred実行環境用の短期一覧キャッシュを初期化する。
 *
 * @returns {ListCache} 環境対応キャッシュ
 */
export function newEnvironmentListCache() {
  return new ListCache(trustedAlfredCacheRootFromEnvironment());
}

/**
 * 現在ワークフローのGitHub一覧キャッシュを無効化する。
 *
 * @returns {void}
 */
export function invalidateListCache() {
  new ListCache(expectedAlfredCacheRoot()).invalidate();
}

/**
 * リポジトリキャッシュ文書が厳密な構造か検証する。
 *
 * @param {unknown} value 検証対象
 * @returns {value is RepositoryCacheDocument} 有効な場合はtrue
 */
function isRepositoryCacheDocument(value) {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["schema", "account", "repositories"]) &&
    value.schema === LIST_CACHE_SCHEMA_VERSION &&
    isValidGitHubAccountIdentity(value.account) &&
    Array.isArray(value.repositories)
  );
}

/**
 * Projectキャッシュ文書が厳密な構造か検証する。
 *
 * @param {unknown} value 検証対象
 * @returns {value is ProjectCacheDocument} 有効な場合はtrue
 */
function isProjectCacheDocument(value) {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["schema", "account", "projects"]) &&
    value.schema === LIST_CACHE_SCHEMA_VERSION &&
    isValidGitHubAccountIdentity(value.account) &&
    Array.isArray(value.projects)
  );
}

/**
 * オブジェクトが指定キーだけを持つか判定する。
 *
 * @param {Record<string, unknown>} value 検証対象
 * @param {string[]} keys 許可キー
 * @returns {boolean} キー集合が一致する場合はtrue
 */
function hasExactKeys(value, keys) {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
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
 * @typedef {object} RepositoryCacheDocument
 * @property {number} schema スキーマ番号
 * @property {object} account アカウント同一性
 * @property {unknown[]} repositories リポジトリ一覧
 */

/**
 * @typedef {object} ProjectCacheDocument
 * @property {number} schema スキーマ番号
 * @property {object} account アカウント同一性
 * @property {unknown[]} projects Project一覧
 */

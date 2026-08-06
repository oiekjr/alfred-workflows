import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  currentUserHomeDirectory,
  trustedAlfredCacheRootFromEnvironment,
  validatePrivateRegularFile,
  validateSecurePathComponents,
} from "./security.mjs";
import { GITHUB_HOSTNAME, isGitHubLogin } from "./domain.mjs";

const GITHUB_CONFIG_DIRECTORY = ".config/gh";
const GITHUB_HOSTS_FILE_NAME = "hosts.yml";

/**
 * Alfred実行環境に対応するGitHub CLI設定ファイルの同一性を提供する。
 */
export class EnvironmentGitHubConfigProvider {
  /**
   * 標準GitHub CLI設定ファイルの内容を読まずに同一性を取得する。
   *
   * @returns {GitHubConfigIdentity | null} 比較可能な同一性情報
   */
  currentIdentity() {
    if (trustedAlfredCacheRootFromEnvironment() === "") {
      return null;
    }

    try {
      return githubConfigIdentityAt(currentUserHomeDirectory());
    } catch {
      return null;
    }
  }
}

/**
 * 指定ホーム内の標準hosts.ymlから非秘密のファイル同一性を取得する。
 *
 * @param {string} homeDirectory 検証済みホームディレクトリ
 * @returns {GitHubConfigIdentity | null} 比較可能な同一性情報
 */
export function githubConfigIdentityAt(homeDirectory) {
  if (!path.isAbsolute(homeDirectory)) {
    return null;
  }

  try {
    const information = validatePrivateRegularFile(
      path.join(
        homeDirectory,
        GITHUB_CONFIG_DIRECTORY,
        GITHUB_HOSTS_FILE_NAME,
      ),
    );
    const identity = {
      device: information.dev.toString(),
      inode: information.ino.toString(),
      size: Number(information.size),
      modification_unix_nano: information.mtimeNs.toString(),
    };

    return isValidGitHubConfigIdentity(identity) ? identity : null;
  } catch {
    return null;
  }
}

/**
 * GitHub CLI認証状態から利用中アカウントと権限だけを抽出する。
 *
 * @param {Buffer | string} output GitHub CLI標準出力
 * @returns {AuthenticationStatus | null} 検証済み認証状態
 */
export function parseAuthenticationStatus(output) {
  const loginMarker = `Logged in to ${GITHUB_HOSTNAME} account `;
  const tokenSourceMarker = " (";
  const activeMarker = "Active account:";
  const scopesMarker = "Token scopes:";

  let login = "";
  let scopes = "";
  let activeFound = false;
  let scopesFound = false;

  for (const line of output.toString().split("\n")) {
    const loginStart = line.indexOf(loginMarker);
    if (loginStart >= 0) {
      const value = line.slice(loginStart + loginMarker.length);
      const sourceStart = value.indexOf(tokenSourceMarker);
      if (sourceStart <= 0 || login !== "") {
        return null;
      }
      const candidate = value.slice(0, sourceStart);
      if (!isGitHubLogin(candidate)) {
        return null;
      }
      login = candidate.toLowerCase();
    }

    const activeStart = line.indexOf(activeMarker);
    if (activeStart >= 0) {
      if (
        activeFound ||
        line.slice(activeStart + activeMarker.length).trim() !== "true"
      ) {
        return null;
      }
      activeFound = true;
    }

    const scopesStart = line.indexOf(scopesMarker);
    if (scopesStart >= 0) {
      if (scopesFound) {
        return null;
      }
      scopes = line.slice(scopesStart + scopesMarker.length).trim();
      scopesFound = true;
    }
  }

  if (login === "" || !activeFound) {
    return null;
  }

  return { hostname: GITHUB_HOSTNAME, login, scopes };
}

/**
 * GitHub CLI設定ファイルの同一性が比較可能か検証する。
 *
 * @param {unknown} value 検証対象
 * @returns {value is GitHubConfigIdentity} 比較可能な場合はtrue
 */
export function isValidGitHubConfigIdentity(value) {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasExactKeys(value, [
      "device",
      "inode",
      "size",
      "modification_unix_nano",
    ]) &&
    isPositiveIntegerString(value.device, false) &&
    isPositiveIntegerString(value.inode, true) &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    isPositiveIntegerString(value.modification_unix_nano, true)
  );
}

/**
 * キャッシュ所有者がGitHub.comの有効なアカウントか検証する。
 *
 * @param {unknown} value 検証対象
 * @returns {value is GitHubAccountIdentity} 有効な場合はtrue
 */
export function isValidGitHubAccountIdentity(value) {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasExactKeys(value, ["hostname", "login", "config"]) &&
    value.hostname === GITHUB_HOSTNAME &&
    typeof value.login === "string" &&
    isGitHubLogin(value.login) &&
    isValidGitHubConfigIdentity(value.config)
  );
}

/**
 * 2つのGitHub CLI設定同一性が一致するか判定する。
 *
 * @param {GitHubConfigIdentity} left 比較元
 * @param {GitHubConfigIdentity} right 比較先
 * @returns {boolean} 全属性が一致する場合はtrue
 */
export function githubConfigIdentitiesEqual(left, right) {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modification_unix_nano === right.modification_unix_nano
  );
}

/**
 * Terminal認証用ランチャーの絶対パスを安全な転送形式へ変換する。
 *
 * @param {string} launcherPath Node.jsランチャーパス
 * @returns {string} Base64形式の検証済み絶対パス
 * @throws {Error} パスまたは権限が信頼条件を満たさない場合
 */
export function loginHelperToken(launcherPath) {
  const resolvedPath = path.normalize(realpathSync(launcherPath));
  if (!path.isAbsolute(resolvedPath)) {
    throw new Error("workflow launcher path is not absolute");
  }
  validateSecurePathComponents(resolvedPath);

  const information = lstatSync(resolvedPath, { bigint: true });
  const userID = currentUserID();
  if (
    !information.isFile() ||
    information.uid !== BigInt(userID) ||
    (information.mode & 0o022n) !== 0n
  ) {
    throw new Error("workflow launcher permissions are unsafe");
  }

  return Buffer.from(resolvedPath, "utf8").toString("base64");
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
 * 10進整数文字列が非負または正か判定する。
 *
 * @param {unknown} value 検証対象
 * @param {boolean} positive 正数だけ許可する場合はtrue
 * @returns {boolean} 条件を満たす場合はtrue
 */
function isPositiveIntegerString(value, positive) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    return false;
  }
  return !positive || value !== "0";
}

/**
 * 現在プロセスの実UIDを取得する。
 *
 * @returns {number} 実UID
 * @throws {Error} UIDを取得できない場合
 */
function currentUserID() {
  if (typeof process.getuid !== "function") {
    throw new Error("current user ID is unavailable");
  }

  return process.getuid();
}

/**
 * @typedef {object} AuthenticationStatus
 * @property {string} hostname GitHubホスト名
 * @property {string} login GitHubログイン名
 * @property {string} scopes OAuthスコープ表示
 */

/**
 * @typedef {object} GitHubConfigIdentity
 * @property {string} device デバイス番号
 * @property {string} inode inode番号
 * @property {number} size ファイルサイズ
 * @property {string} modification_unix_nano 更新時刻
 */

/**
 * @typedef {object} GitHubAccountIdentity
 * @property {string} hostname GitHubホスト名
 * @property {string} login GitHubログイン名
 * @property {GitHubConfigIdentity} config GitHub CLI設定同一性
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  constants as fileConstants,
  fstatSync,
  lstatSync,
  openSync,
  rmSync,
} from "node:fs";
import https from "node:https";
import path from "node:path";
import {
  EnvironmentGitHubConfigProvider,
  loginHelperToken,
} from "./authentication.mjs";
import { ListCache } from "./cache.mjs";
import {
  normalizedAvatarURL,
  projectOwners,
  repositoryOwners,
} from "./domain.mjs";
import {
  RESTRICTED_SYSTEM_PATH,
} from "./command.mjs";
import {
  currentUserHomeDirectory,
  ensureSecureCacheSubdirectory,
  expectedAlfredCacheRoot,
  isFileSystemError,
  trustedAlfredCacheRootFromEnvironment,
  validatePrivateRegularFile,
  writePrivateDataAtomically,
} from "./security.mjs";

const AVATAR_CACHE_LIFETIME_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
const AVATAR_DOWNLOAD_TIMEOUT_MILLISECONDS = 2_000;
const MAXIMUM_CONCURRENT_AVATAR_DOWNLOADS = 4;
const MAXIMUM_AVATAR_DOWNLOADS_PER_RUN = 24;
const MAXIMUM_AVATAR_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_AVATAR_DIMENSION = 1024;
const AVATAR_CACHE_DIRECTORY = "avatars";
const AVATAR_EXTENSIONS = ["png", "jpg", "gif"];
const BACKGROUND_HELPER_MARKER = "--background-helper";
const AVATAR_REFRESH_HELPER_ACTION = "refresh-avatars";
const BACKGROUND_CACHE_DIRECTORY = "background";
const AVATAR_REFRESH_LOCK_NAME = "avatar-refresh.lock";
const AVATAR_REFRESH_LOCK_STALE_MILLISECONDS = 5 * 60 * 1000;

/**
 * GitHub所有者のアバターを非公開キャッシュで管理する。
 */
export class AvatarCache {
  /**
   * 保存先、ダウンロード境界、時刻関数を初期化する。
   *
   * @param {string} rootDirectory 非公開キャッシュルート
   * @param {(url: string, ownerID: number) => Promise<AvatarDownload>} [downloader=downloadAvatar] 画像取得関数
   * @param {() => number} [now=Date.now] 現在時刻を返す関数
   */
  constructor(rootDirectory, downloader = downloadAvatar, now = Date.now) {
    this.rootDirectory = rootDirectory;
    this.downloader = downloader;
    this.now = now;
  }

  /**
   * 通信せずキャッシュ済み画像と更新要否を返す。
   *
   * @param {object[]} owners GitHub所有者一覧
   * @returns {{paths: Map<number, string>, refreshNeeded: boolean}} 取得結果
   */
  paths(owners) {
    const result = { paths: new Map(), refreshNeeded: false };
    if (!this.available()) {
      return result;
    }

    try {
      ensureSecureCacheSubdirectory(
        this.rootDirectory,
        AVATAR_CACHE_DIRECTORY,
      );
    } catch {
      return result;
    }

    const seenOwnerIDs = new Set();
    for (const owner of owners) {
      if (!validOwnerID(owner?.id) || seenOwnerIDs.has(owner.id)) {
        continue;
      }
      seenOwnerIDs.add(owner.id);

      const cached = this.cachedFile(owner.id);
      if (cached !== null) {
        result.paths.set(owner.id, cached.path);
        if (this.isFresh(cached.information.mtimeNs)) {
          continue;
        }
      }

      try {
        if (normalizedAvatarURL(owner.avatar_url, owner.id) === null) {
          throw new Error("avatar owner does not match GitHub owner");
        }
        result.refreshNeeded = true;
      } catch {
        // 不正な外部URLは更新対象へ含めない
      }
    }

    return result;
  }

  /**
   * 不足または期限切れの画像だけを制限付きで取得する。
   *
   * @param {object[]} owners GitHub所有者一覧
   * @returns {Promise<void>} 全ワーカー終了時に解決するPromise
   */
  async refresh(owners) {
    if (!this.available()) {
      return;
    }
    ensureSecureCacheSubdirectory(
      this.rootDirectory,
      AVATAR_CACHE_DIRECTORY,
    );

    const downloadOwners = [];
    const seenOwnerIDs = new Set();
    for (const owner of owners) {
      if (!validOwnerID(owner?.id) || seenOwnerIDs.has(owner.id)) {
        continue;
      }
      seenOwnerIDs.add(owner.id);

      const cached = this.cachedFile(owner.id);
      if (
        cached !== null &&
        this.isFresh(cached.information.mtimeNs)
      ) {
        continue;
      }

      try {
        if (normalizedAvatarURL(owner.avatar_url, owner.id) === null) {
          throw new Error("avatar owner does not match GitHub owner");
        }
        if (downloadOwners.length < MAXIMUM_AVATAR_DOWNLOADS_PER_RUN) {
          downloadOwners.push(owner);
        }
      } catch {
        // 不正な外部URLは通信対象へ含めない
      }
    }

    let nextIndex = 0;
    const workerCount = Math.min(
      MAXIMUM_CONCURRENT_AVATAR_DOWNLOADS,
      downloadOwners.length,
    );
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < downloadOwners.length) {
        const owner = downloadOwners[nextIndex];
        nextIndex += 1;
        try {
          await this.refreshOwner(owner);
        } catch {
          // 個別画像の失敗は他の所有者更新へ影響させない
        }
      }
    });
    await Promise.all(workers);
  }

  /**
   * 単一所有者の画像を検証してアトミックに保存する。
   *
   * @param {object} owner GitHub所有者
   * @returns {Promise<string>} 保存済み画像パス
   */
  async refreshOwner(owner) {
    const avatarURL = normalizedAvatarURL(owner.avatar_url, owner.id);
    if (avatarURL === null) {
      throw new Error("avatar owner does not match GitHub owner");
    }
    const avatar = await this.downloader(avatarURL, owner.id);
    validateAvatarDownload(avatar);

    const directory = ensureSecureCacheSubdirectory(
      this.rootDirectory,
      AVATAR_CACHE_DIRECTORY,
    );
    const name = `${owner.id}.${avatar.extension}`;
    const destinationPath = writePrivateDataAtomically(
      directory,
      name,
      avatar.data,
    );
    this.removeOtherExtensions(owner.id, avatar.extension);

    return destinationPath;
  }

  /**
   * キャッシュルートが安全に利用可能な形か判定する。
   *
   * @returns {boolean} 絶対パスと時刻関数が利用可能な場合はtrue
   */
  available() {
    return (
      this.rootDirectory !== "" &&
      path.isAbsolute(this.rootDirectory) &&
      typeof this.now === "function"
    );
  }

  /**
   * 所有者IDに対応する検証済みキャッシュ画像を検索する。
   *
   * @param {number} ownerID GitHub所有者ID
   * @returns {{path: string, information: import("node:fs").BigIntStats} | null} キャッシュ画像
   */
  cachedFile(ownerID) {
    for (const extension of AVATAR_EXTENSIONS) {
      const targetPath = this.path(ownerID, extension);
      try {
        return {
          path: targetPath,
          information: validatePrivateRegularFile(targetPath),
        };
      } catch {
        // 次の固定拡張子を確認する
      }
    }
    return null;
  }

  /**
   * 所有者IDと固定拡張子から安全な保存パスを生成する。
   *
   * @param {number} ownerID GitHub所有者ID
   * @param {string} extension 固定画像拡張子
   * @returns {string} キャッシュ画像パス
   */
  path(ownerID, extension) {
    if (!validOwnerID(ownerID) || !AVATAR_EXTENSIONS.includes(extension)) {
      throw new Error("avatar cache identity is invalid");
    }
    return path.join(
      this.rootDirectory,
      AVATAR_CACHE_DIRECTORY,
      `${ownerID}.${extension}`,
    );
  }

  /**
   * キャッシュ画像が有効期間内か判定する。
   *
   * @param {bigint} modificationTimeNanoseconds 更新時刻
   * @returns {boolean} 有効期間内の場合はtrue
   */
  isFresh(modificationTimeNanoseconds) {
    const ageMilliseconds =
      this.now() - Number(modificationTimeNanoseconds / 1_000_000n);
    return (
      ageMilliseconds >= 0 &&
      ageMilliseconds <= AVATAR_CACHE_LIFETIME_MILLISECONDS
    );
  }

  /**
   * 新しい画像と異なる固定拡張子の古い画像だけを削除する。
   *
   * @param {number} ownerID GitHub所有者ID
   * @param {string} keptExtension 保持する画像拡張子
   * @returns {void}
   */
  removeOtherExtensions(ownerID, keptExtension) {
    for (const extension of AVATAR_EXTENSIONS) {
      if (extension === keptExtension) {
        continue;
      }
      const targetPath = this.path(ownerID, extension);
      try {
        validatePrivateRegularFile(targetPath);
        rmSync(targetPath);
      } catch (error) {
        if (!isFileSystemError(error, "ENOENT")) {
          // 新しい検証済み画像を優先し、古い異常パスへ触れない
        }
      }
    }
  }
}

/**
 * Alfred環境のアバターキャッシュを初期化する。
 *
 * @returns {AvatarCache} 環境対応キャッシュ
 */
export function newEnvironmentAvatarCache() {
  return new AvatarCache(trustedAlfredCacheRootFromEnvironment());
}

/**
 * GitHubの許可済み配信先から画像を容量・時間制限付きで取得する。
 *
 * @param {string} avatarURL 正規化済みアバターURL
 * @param {number} ownerID GitHub所有者ID
 * @returns {Promise<AvatarDownload>} 検証済み画像
 */
export async function downloadAvatar(avatarURL, ownerID) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    AVATAR_DOWNLOAD_TIMEOUT_MILLISECONDS,
  );
  timer.unref();

  try {
    const data = await requestAvatar(
      new URL(avatarURL),
      ownerID,
      0,
      controller.signal,
    );
    const image = inspectAvatarImage(data);
    return { data, extension: image.extension };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 許可済みURLへ直接HTTPS接続し、制限内の応答本文を読み込む。
 *
 * @param {URL} avatarURL 接続先URL
 * @param {number} ownerID GitHub所有者ID
 * @param {number} redirectCount リダイレクト回数
 * @param {AbortSignal} signal 中止シグナル
 * @returns {Promise<Buffer>} 応答本文
 */
function requestAvatar(avatarURL, ownerID, redirectCount, signal) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      avatarURL,
      {
        headers: {
          Accept: "image/png,image/jpeg,image/gif",
          "User-Agent": "alfred-github-repositories",
        },
        minVersion: "TLSv1.2",
        signal,
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode >= 300 && statusCode < 400) {
          response.resume();
          if (redirectCount >= 3 || typeof response.headers.location !== "string") {
            reject(new Error("avatar redirect is unsupported"));
            return;
          }

          let redirectedURL;
          try {
            redirectedURL = new URL(response.headers.location, avatarURL);
            const normalizedRedirect = normalizedAvatarURL(
              redirectedURL.toString(),
              ownerID,
            );
            if (normalizedRedirect === null) {
              throw new Error("avatar redirect changed identity");
            }
            if (redirectedURL.pathname !== avatarURL.pathname) {
              throw new Error("avatar redirect changed identity");
            }
            redirectedURL = new URL(normalizedRedirect);
          } catch (error) {
            reject(error);
            return;
          }

          requestAvatar(
            redirectedURL,
            ownerID,
            redirectCount + 1,
            signal,
          ).then(resolve, reject);
          return;
        }

        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`unexpected avatar status: ${statusCode}`));
          return;
        }

        const contentLength = parseContentLength(
          response.headers["content-length"],
        );
        if (contentLength > MAXIMUM_AVATAR_RESPONSE_BYTES) {
          response.destroy();
          reject(new Error("avatar exceeds size limit"));
          return;
        }

        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAXIMUM_AVATAR_RESPONSE_BYTES) {
            response.destroy(new Error("avatar exceeds size limit"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once("error", reject);
        response.once("end", () => resolve(Buffer.concat(chunks, bytes)));
      },
    );
    request.once("error", reject);
  });
}

/**
 * HTTP Content-Lengthを安全な非負整数へ変換する。
 *
 * @param {string | undefined} value ヘッダー値
 * @returns {number} 不明な場合は0
 */
function parseContentLength(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

/**
 * PNG、JPEG、GIFの形式と展開寸法をヘッダーから検証する。
 *
 * @param {Buffer} data 画像データ
 * @returns {{extension: "png" | "jpg" | "gif", width: number, height: number}} 画像情報
 * @throws {Error} 形式または寸法が不正な場合
 */
export function inspectAvatarImage(data) {
  let image;
  if (
    data.length >= 24 &&
    data.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ) &&
    data.readUInt32BE(8) === 13 &&
    data.subarray(12, 16).toString("ascii") === "IHDR" &&
    data.length >= 33 &&
    data.subarray(data.length - 8, data.length - 4).toString("ascii") ===
      "IEND"
  ) {
    image = {
      extension: "png",
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    };
  } else if (
    data.length >= 10 &&
    (data.subarray(0, 6).toString("ascii") === "GIF87a" ||
      data.subarray(0, 6).toString("ascii") === "GIF89a") &&
    data[data.length - 1] === 0x3b
  ) {
    image = {
      extension: "gif",
      width: data.readUInt16LE(6),
      height: data.readUInt16LE(8),
    };
  } else {
    const dimensions = jpegDimensions(data);
    if (dimensions !== null) {
      image = { extension: "jpg", ...dimensions };
    }
  }

  if (
    image === undefined ||
    image.width <= 0 ||
    image.height <= 0 ||
    image.width > MAXIMUM_AVATAR_DIMENSION ||
    image.height > MAXIMUM_AVATAR_DIMENSION
  ) {
    throw new Error("avatar image format or dimensions are unsupported");
  }
  return image;
}

/**
 * JPEGセグメントからSOF寸法を抽出する。
 *
 * @param {Buffer} data JPEGデータ
 * @returns {{width: number, height: number} | null} 画像寸法
 */
function jpegDimensions(data) {
  if (
    data.length < 4 ||
    data[0] !== 0xff ||
    data[1] !== 0xd8 ||
    data[data.length - 2] !== 0xff ||
    data[data.length - 1] !== 0xd9
  ) {
    return null;
  }

  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < data.length) {
    while (offset < data.length && data[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= data.length) {
      return null;
    }
    const marker = data[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 1 >= data.length) {
      return null;
    }

    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) {
      return null;
    }
    if (startOfFrameMarkers.has(marker)) {
      if (length < 7) {
        return null;
      }
      return {
        height: data.readUInt16BE(offset + 3),
        width: data.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }

  return null;
}

/**
 * 取得境界から返された画像データと拡張子の整合性を検証する。
 *
 * @param {AvatarDownload} avatar 取得結果
 * @returns {void}
 * @throws {Error} 容量、形式、拡張子が不正な場合
 */
function validateAvatarDownload(avatar) {
  if (
    !Buffer.isBuffer(avatar?.data) ||
    avatar.data.length === 0 ||
    avatar.data.length > MAXIMUM_AVATAR_RESPONSE_BYTES
  ) {
    throw new Error("avatar data is invalid");
  }
  const image = inspectAvatarImage(avatar.data);
  if (image.extension !== avatar.extension) {
    throw new Error("avatar extension does not match image data");
  }
}

/**
 * 固定引数のアバター更新処理を独立プロセスで開始する。
 *
 * @param {string} launcherPath 検証済みNode.jsランチャーパス
 * @returns {void}
 */
export function startAvatarRefreshHelper(launcherPath) {
  if (!path.isAbsolute(launcherPath)) {
    throw new Error("workflow launcher path is not absolute");
  }
  loginHelperToken(launcherPath);
  const environment = restrictedBackgroundHelperEnvironment();
  const child = spawn(
    "/bin/sh",
    [launcherPath, BACKGROUND_HELPER_MARKER, AVATAR_REFRESH_HELPER_ACTION],
    {
      detached: true,
      env: environment,
      stdio: "ignore",
    },
  );
  child.unref();
}

/**
 * 短期一覧キャッシュ内の所有者画像を排他制御して更新する。
 *
 * @returns {Promise<void>} 更新完了時に解決するPromise
 */
export async function refreshCachedAvatars() {
  const rootDirectory = trustedAlfredCacheRootFromEnvironment();
  if (rootDirectory === "") {
    return;
  }

  const lock = acquireAvatarRefreshLock(rootDirectory);
  if (lock === null) {
    return;
  }
  try {
    const configIdentity = new EnvironmentGitHubConfigProvider().currentIdentity();
    if (configIdentity === null) {
      return;
    }

    const lists = new ListCache(rootDirectory);
    const owners = [];
    const repositories = lists.loadRepositories(configIdentity);
    if (repositories !== null) {
      owners.push(...repositoryOwners(repositories));
    }
    const projects = lists.loadProjects(configIdentity);
    if (projects !== null) {
      owners.push(...projectOwners(projects));
    }
    if (owners.length === 0) {
      return;
    }

    await new AvatarCache(rootDirectory).refresh(owners);
  } finally {
    releaseAvatarRefreshLock(lock);
  }
}

/**
 * 引数が固定された内部アバター更新呼出しか判定する。
 *
 * @param {string[]} arguments_ Node.jsへ渡された利用者引数
 * @returns {boolean} 内部呼出形式と一致する場合はtrue
 */
export function isBackgroundHelperInvocation(arguments_) {
  return (
    arguments_.length === 2 &&
    arguments_[0] === BACKGROUND_HELPER_MARKER &&
    arguments_[1] === AVATAR_REFRESH_HELPER_ACTION
  );
}

/**
 * 親の秘密情報を継承しないバックグラウンド実行環境を生成する。
 *
 * @returns {NodeJS.ProcessEnv} 固定環境変数
 */
export function restrictedBackgroundHelperEnvironment() {
  return {
    HOME: currentUserHomeDirectory(),
    PATH: RESTRICTED_SYSTEM_PATH,
    LC_ALL: "C",
    alfred_workflow_cache: expectedAlfredCacheRoot(),
  };
}

/**
 * 多重アバター更新を防ぐ非公開排他ファイルを取得する。
 *
 * @param {string} rootDirectory 非公開キャッシュルート
 * @returns {AvatarRefreshLock | null} 取得済みロック
 */
export function acquireAvatarRefreshLock(rootDirectory) {
  const directory = ensureSecureCacheSubdirectory(
    rootDirectory,
    BACKGROUND_CACHE_DIRECTORY,
  );
  const lockPath = path.join(directory, AVATAR_REFRESH_LOCK_NAME);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor = null;
    try {
      descriptor = openSync(
        lockPath,
        fileConstants.O_CREAT |
          fileConstants.O_EXCL |
          fileConstants.O_RDWR |
          fileConstants.O_NOFOLLOW,
        0o600,
      );
      const information = fstatSync(descriptor, { bigint: true });
      validatePrivateRegularFile(lockPath);
      return {
        descriptor,
        path: lockPath,
        device: information.dev,
        inode: information.ino,
      };
    } catch (error) {
      if (descriptor !== null) {
        closeSync(descriptor);
      }
      if (!isFileSystemError(error, "EEXIST")) {
        throw error;
      }
      if (attempt > 0 || !removeStaleLock(lockPath)) {
        return null;
      }
    }
  }

  return null;
}

/**
 * 自身が取得した排他ファイルだけを閉じて削除する。
 *
 * @param {AvatarRefreshLock | null} lock 取得済みロック
 * @returns {void}
 */
export function releaseAvatarRefreshLock(lock) {
  if (lock === null) {
    return;
  }
  closeSync(lock.descriptor);

  try {
    const information = lstatSync(lock.path, { bigint: true });
    if (
      information.dev === lock.device &&
      information.ino === lock.inode &&
      information.isFile()
    ) {
      rmSync(lock.path);
    }
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) {
      throw error;
    }
  }
}

/**
 * 放置された検証済みロックだけを削除する。
 *
 * @param {string} lockPath ロックファイルパス
 * @returns {boolean} 削除して再試行可能な場合はtrue
 */
function removeStaleLock(lockPath) {
  try {
    const information = validatePrivateRegularFile(lockPath);
    const ageMilliseconds =
      Date.now() - Number(information.mtimeNs / 1_000_000n);
    if (
      ageMilliseconds < 0 ||
      ageMilliseconds <= AVATAR_REFRESH_LOCK_STALE_MILLISECONDS
    ) {
      return false;
    }

    rmSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * GitHub所有者IDが安全な整数か判定する。
 *
 * @param {unknown} value 検証対象
 * @returns {value is number} 正の安全な整数の場合はtrue
 */
function validOwnerID(value) {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/**
 * @typedef {object} AvatarDownload
 * @property {Buffer} data 画像データ
 * @property {"png" | "jpg" | "gif"} extension 検証済み拡張子
 */

/**
 * @typedef {object} AvatarRefreshLock
 * @property {number} descriptor ロックファイル記述子
 * @property {string} path ロックファイルパス
 * @property {bigint} device デバイス番号
 * @property {bigint} inode inode番号
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fileConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const WORKFLOW_BUNDLE_IDENTIFIER =
  "com.oiekjr.alfred.github-repositories";

/**
 * macOS上の現在ユーザーのホームディレクトリを検証する。
 *
 * @returns {string} 検証済みホームディレクトリ
 * @throws {Error} パス、所有者、権限が信頼条件を満たさない場合
 */
export function currentUserHomeDirectory() {
  const homeDirectory = path.normalize(homedir());
  if (!path.isAbsolute(homeDirectory)) {
    throw new Error("home directory is not absolute");
  }

  const userID = currentUserID();
  if (userID === 0) {
    if (
      homeDirectory !== "/var/root" &&
      homeDirectory !== "/private/var/root"
    ) {
      throw new Error("root home directory is outside the expected location");
    }
  } else if (
    path.dirname(homeDirectory) !== "/Users" ||
    path.basename(homeDirectory) === "." ||
    path.basename(homeDirectory) === "Shared"
  ) {
    throw new Error("home directory is outside /Users");
  }

  validateSecureDirectory(homeDirectory);
  const information = lstatBigInt(homeDirectory);
  if (information.uid !== BigInt(userID)) {
    throw new Error("home directory owner does not match process owner");
  }

  return homeDirectory;
}

/**
 * Alfredが提供する専用キャッシュパスだけを受理する。
 *
 * @param {NodeJS.ProcessEnv} [environment=process.env] 実行環境
 * @returns {string} 検証済みキャッシュパス。利用できない場合は空文字列
 */
export function trustedAlfredCacheRootFromEnvironment(
  environment = process.env,
) {
  let expectedPath;
  try {
    expectedPath = expectedAlfredCacheRoot();
  } catch {
    return "";
  }

  const configuredPath = path.normalize(
    environment.alfred_workflow_cache ?? "",
  );
  return configuredPath === expectedPath ? expectedPath : "";
}

/**
 * 現在ユーザー用のAlfred専用キャッシュパスを生成する。
 *
 * @returns {string} Alfred専用キャッシュパス
 */
export function expectedAlfredCacheRoot() {
  return path.join(
    currentUserHomeDirectory(),
    "Library",
    "Caches",
    "com.runningwithcrayons.Alfred",
    "Workflow Data",
    WORKFLOW_BUNDLE_IDENTIFIER,
  );
}

/**
 * パス全体と末尾ディレクトリの所有者・権限を検証する。
 *
 * @param {string} targetPath 検証対象パス
 * @returns {import("node:fs").BigIntStats} 検証済みファイル情報
 * @throws {Error} 信頼条件を満たさない場合
 */
export function validateSecureDirectory(targetPath) {
  validateSecurePathComponents(targetPath);
  const information = lstatBigInt(targetPath);
  if (!information.isDirectory()) {
    throw new Error("path is not a directory");
  }

  return information;
}

/**
 * 現在ユーザーだけが利用できる非公開ディレクトリか検証する。
 *
 * @param {string} targetPath 検証対象パス
 * @returns {import("node:fs").BigIntStats} 検証済みファイル情報
 * @throws {Error} 信頼条件を満たさない場合
 */
export function validatePrivateDirectory(targetPath) {
  const information = validateSecureDirectory(targetPath);
  if (information.uid !== BigInt(currentUserID())) {
    throw new Error("private directory owner is not trusted");
  }
  if ((information.mode & 0o077n) !== 0n) {
    throw new Error("private directory permissions are too broad");
  }

  return information;
}

/**
 * 現在ユーザーだけが利用できる通常ファイルか検証する。
 *
 * @param {string} targetPath 検証対象パス
 * @returns {import("node:fs").BigIntStats} 検証済みファイル情報
 * @throws {Error} 信頼条件を満たさない場合
 */
export function validatePrivateRegularFile(targetPath) {
  validateSecurePathComponents(targetPath);
  const information = lstatBigInt(targetPath);
  if (!information.isFile()) {
    throw new Error("path is not a regular file");
  }
  if (information.uid !== BigInt(currentUserID())) {
    throw new Error("private file owner is not trusted");
  }
  if ((information.mode & 0o077n) !== 0n) {
    throw new Error("private file permissions are too broad");
  }

  return information;
}

/**
 * パスを構成する全要素が信頼できるか検証する。
 *
 * @param {string} targetPath 検証対象パス
 * @returns {void}
 * @throws {Error} symlink、所有者、権限が信頼条件を満たさない場合
 */
export function validateSecurePathComponents(targetPath) {
  const cleanPath = path.normalize(targetPath);
  if (!path.isAbsolute(cleanPath)) {
    throw new Error("path is not absolute");
  }

  validateTrustedPathInformation(lstatBigInt(path.parse(cleanPath).root));
  let currentPath = path.parse(cleanPath).root;
  const components = cleanPath
    .slice(currentPath.length)
    .split(path.sep)
    .filter(Boolean);

  for (let index = 0; index < components.length; index += 1) {
    currentPath = path.join(currentPath, components[index]);
    const information = lstatBigInt(currentPath);
    validateTrustedPathInformation(information);
    if (index < components.length - 1 && !information.isDirectory()) {
      throw new Error(`path component is not a directory: ${currentPath}`);
    }
  }
}

/**
 * 信頼済み親ディレクトリ内へ非公開キャッシュルートを用意する。
 *
 * @param {string} rootDirectory キャッシュルート
 * @returns {void}
 * @throws {Error} パスや権限が信頼条件を満たさない場合
 */
export function ensureSecureCacheRoot(rootDirectory) {
  if (!rootDirectory || !path.isAbsolute(rootDirectory)) {
    throw new Error("cache root is unavailable");
  }

  try {
    validatePrivateDirectory(rootDirectory);
    return;
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) {
      throw error;
    }
  }

  validateSecureDirectory(path.dirname(rootDirectory));
  try {
    mkdirSync(rootDirectory, { mode: 0o700 });
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) {
      throw error;
    }
  }
  validatePrivateDirectory(rootDirectory);
}

/**
 * 固定名の非公開キャッシュサブディレクトリを用意する。
 *
 * @param {string} rootDirectory キャッシュルート
 * @param {string} name 固定サブディレクトリ名
 * @returns {string} 検証済みサブディレクトリ
 * @throws {Error} 名前、パス、権限が信頼条件を満たさない場合
 */
export function ensureSecureCacheSubdirectory(rootDirectory, name) {
  if (!isSafeBaseName(name)) {
    throw new Error("cache directory name is invalid");
  }
  ensureSecureCacheRoot(rootDirectory);

  const directory = path.join(rootDirectory, name);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) {
      throw error;
    }
  }
  validatePrivateDirectory(directory);

  return directory;
}

/**
 * 非公開通常ファイルを容量制限付きで読み込む。
 *
 * @param {string} targetPath 読込対象パス
 * @param {number} maximumBytes 最大バイト数
 * @returns {Buffer} 読み込んだデータ
 * @throws {Error} ファイルが変化した場合、または上限を超えた場合
 */
export function readPrivateFile(targetPath, maximumBytes) {
  const expectedInformation = validatePrivateRegularFile(targetPath);
  if (
    expectedInformation.size < 0n ||
    expectedInformation.size > BigInt(maximumBytes)
  ) {
    throw new Error("private file exceeds size limit");
  }

  const descriptor = openSync(
    targetPath,
    fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
  );
  try {
    const openedInformation = fstatSync(descriptor, { bigint: true });
    if (!sameFile(expectedInformation, openedInformation)) {
      throw new Error("private file changed during validation");
    }

    return readBoundedDescriptor(descriptor, maximumBytes);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * 非公開ディレクトリ内の固定名ファイルをアトミックに置換する。
 *
 * @param {string} directory 保存先ディレクトリ
 * @param {string} name 固定ファイル名
 * @param {(descriptor: number) => void} writeContent 内容を書き込む処理
 * @param {number} [mode=0o600] 完成ファイルの権限
 * @returns {string} 保存先パス
 * @throws {Error} パス、権限、書込処理が失敗した場合
 */
export function writePrivateFileAtomically(
  directory,
  name,
  writeContent,
  mode = 0o600,
) {
  if (!isSafeBaseName(name)) {
    throw new Error("private file name is invalid");
  }
  validatePrivateDirectory(directory);

  const temporaryPath = path.join(
    directory,
    `.private-${randomBytes(16).toString("hex")}.tmp`,
  );
  const descriptor = openSync(
    temporaryPath,
    fileConstants.O_CREAT |
      fileConstants.O_EXCL |
      fileConstants.O_WRONLY |
      fileConstants.O_NOFOLLOW,
    0o600,
  );

  let descriptorOpen = true;
  try {
    fchmodSync(descriptor, mode);
    writeContent(descriptor);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptorOpen = false;

    const destinationPath = path.join(directory, name);
    try {
      validatePrivateRegularFile(destinationPath);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) {
        throw error;
      }
    }

    renameSync(temporaryPath, destinationPath);
    const destinationInformation = validatePrivateRegularFile(destinationPath);
    if (Number(destinationInformation.mode & 0o777n) !== mode) {
      throw new Error("private file permissions are invalid");
    }

    return destinationPath;
  } finally {
    if (descriptorOpen) {
      closeSync(descriptor);
    }
    rmSync(temporaryPath, { force: true });
  }
}

/**
 * 非公開ファイルへデータをアトミックに保存する。
 *
 * @param {string} directory 保存先ディレクトリ
 * @param {string} name 固定ファイル名
 * @param {string | Uint8Array} data 保存データ
 * @param {number} [mode=0o600] 完成ファイルの権限
 * @returns {string} 保存先パス
 */
export function writePrivateDataAtomically(
  directory,
  name,
  data,
  mode = 0o600,
) {
  return writePrivateFileAtomically(
    directory,
    name,
    (descriptor) => {
      writeFileSync(descriptor, data);
    },
    mode,
  );
}

/**
 * 対象パスが指定ルート自身または配下か判定する。
 *
 * @param {string} root 許可ルート
 * @param {string} targetPath 対象パス
 * @returns {boolean} ルート配下の場合はtrue
 */
export function isPathInside(root, targetPath) {
  const relativePath = path.relative(
    path.normalize(root),
    path.normalize(targetPath),
  );
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`))
  );
}

/**
 * ファイルシステム例外が指定コードか判定する。
 *
 * @param {unknown} error 判定対象
 * @param {string} code エラーコード
 * @returns {boolean} 指定コードの場合はtrue
 */
export function isFileSystemError(error, code) {
  return (
    error instanceof Error &&
    "code" in error &&
    /** @type {{code?: unknown}} */ (error).code === code
  );
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
 * symlink、所有者、共有書込権限を検証する。
 *
 * @param {import("node:fs").BigIntStats} information ファイル情報
 * @returns {void}
 * @throws {Error} 信頼条件を満たさない場合
 */
function validateTrustedPathInformation(information) {
  if (information.isSymbolicLink()) {
    throw new Error("symbolic links are not allowed");
  }

  const userID = BigInt(currentUserID());
  if (information.uid !== 0n && information.uid !== userID) {
    throw new Error("file owner is not trusted");
  }
  if ((information.mode & 0o022n) !== 0n) {
    throw new Error("group or other write permission is not allowed");
  }
}

/**
 * BigInt形式でsymlinkを追跡せずファイル情報を取得する。
 *
 * @param {string} targetPath 対象パス
 * @returns {import("node:fs").BigIntStats} ファイル情報
 */
function lstatBigInt(targetPath) {
  return lstatSync(targetPath, { bigint: true });
}

/**
 * 2つのファイル情報が同じ実体を示すか判定する。
 *
 * @param {import("node:fs").BigIntStats} left 比較元
 * @param {import("node:fs").BigIntStats} right 比較先
 * @returns {boolean} 同じ実体の場合はtrue
 */
function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * ファイル記述子から上限を超えない範囲だけ読み込む。
 *
 * @param {number} descriptor ファイル記述子
 * @param {number} maximumBytes 最大バイト数
 * @returns {Buffer} 読み込んだデータ
 * @throws {Error} 上限を超えた場合
 */
function readBoundedDescriptor(descriptor, maximumBytes) {
  const chunks = [];
  let totalBytes = 0;
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1));

  while (true) {
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
    if (bytesRead === 0) {
      break;
    }
    totalBytes += bytesRead;
    if (totalBytes > maximumBytes) {
      throw new Error("private file exceeds size limit");
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }

  return Buffer.concat(chunks, totalBytes);
}

/**
 * パス要素を含まない固定ファイル名か判定する。
 *
 * @param {string} name 判定対象
 * @returns {boolean} 固定名として安全な場合はtrue
 */
function isSafeBaseName(name) {
  return Boolean(name) && name !== "." && path.basename(name) === name;
}

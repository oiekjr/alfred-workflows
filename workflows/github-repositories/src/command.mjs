import {
  closeSync,
  constants as fileConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  currentUserHomeDirectory,
  ensureSecureCacheSubdirectory,
  expectedAlfredCacheRoot,
  isFileSystemError,
  isPathInside,
  readPrivateFile,
  validatePrivateRegularFile,
  writePrivateDataAtomically,
  writePrivateFileAtomically,
} from "./security.mjs";

export const RESTRICTED_SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const EXECUTABLE_CACHE_DIRECTORY = "executables";
const MAXIMUM_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const EXECUTABLE_SNAPSHOT_NAME = "gh";
const EXECUTABLE_IDENTITY_NAME = "gh.source";
const MAXIMUM_IDENTITY_BYTES = 256;

const GITHUB_CLI_EXECUTABLE_CANDIDATES = [
  { candidatePath: "/opt/homebrew/bin/gh", root: "/opt/homebrew" },
  { candidatePath: "/usr/local/bin/gh", root: "/usr/local" },
  { candidatePath: "/opt/local/bin/gh", root: "/opt/local" },
];

/**
 * GitHub CLIを固定配置から検証して制限付きで実行する。
 */
export class ExecRunner {
  /**
   * 許可した標準配置からGitHub CLIを検索して非公開キャッシュへ固定する。
   *
   * @param {string} name 実行ファイル名
   * @returns {string} キャッシュ済み実行ファイルパス
   * @throws {Error} 許可したGitHub CLIが見つからない場合
   */
  findExecutable(name) {
    if (name !== "gh") {
      throw new Error("executable is not allowed");
    }

    for (const candidate of GITHUB_CLI_EXECUTABLE_CANDIDATES) {
      try {
        return stageGitHubCLI(resolveTrustedExecutable(candidate));
      } catch {
        // 次の固定候補を検証する
      }
    }

    throw new Error("GitHub CLI is not installed in a supported location");
  }

  /**
   * 検証済みGitHub CLIを時間・出力量・環境変数の制限付きで実行する。
   *
   * @param {Command} command 実行条件
   * @returns {Promise<CommandResult>} 実行結果
   */
  async run(command) {
    validatePrivateExecutable(command.path);
    const environment = restrictedCommandEnvironment(command.path, false);
    return runBoundedCommand(command, environment);
  }

  /**
   * GitHub CLIのWeb認証をTerminal上で実行する。
   *
   * @returns {Promise<void>} 正常終了時に解決するPromise
   */
  async login() {
    await this.runInteractiveAuthentication(githubCLILoginArguments());
  }

  /**
   * Project読取権限を含むGitHub CLIのWeb認証を実行する。
   *
   * @returns {Promise<void>} 正常終了時に解決するPromise
   */
  async loginProjects() {
    await this.runInteractiveAuthentication(githubCLIProjectLoginArguments());
  }

  /**
   * 既存認証へProject読取権限だけを追加する。
   *
   * @returns {Promise<void>} 正常終了時に解決するPromise
   */
  async authorizeProjects() {
    await this.runInteractiveAuthentication(
      githubCLIProjectAuthorizationArguments(),
    );
  }

  /**
   * 固定引数のGitHub CLI認証処理を対話環境で実行する。
   *
   * @param {string[]} arguments_ GitHub CLI引数
   * @returns {Promise<void>} 正常終了時に解決するPromise
   * @throws {Error} 起動または認証に失敗した場合
   */
  async runInteractiveAuthentication(arguments_) {
    const githubCLIPath = this.findExecutable("gh");
    const environment = restrictedCommandEnvironment(githubCLIPath, true);

    await new Promise((resolve, reject) => {
      const child = spawn(githubCLIPath, arguments_, {
        env: environment,
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `GitHub CLI authentication failed: ${signal ?? code ?? "unknown"}`,
          ),
        );
      });
    });
  }
}

/**
 * 外部コマンドを時間・出力量・プロセスグループ制限付きで実行する。
 *
 * @param {Command} command 実行条件
 * @param {NodeJS.ProcessEnv} environment 制限済み環境変数
 * @returns {Promise<CommandResult>} 実行結果
 */
export async function runBoundedCommand(command, environment) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let timedOut = false;
    /** @type {Error | null} */
    let spawnError = null;

    const child = spawn(command.path, command.args, {
      detached: true,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      stopProcessGroup(child.pid);
    }, command.timeoutMilliseconds);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      const result = appendBoundedChunk(
        stdoutChunks,
        stdoutBytes,
        Buffer.from(chunk),
        command.stdoutLimit,
      );
      stdoutBytes = result.bytes;
      if (result.overflow) {
        stdoutOverflow = true;
        stopProcessGroup(child.pid);
      }
    });
    child.stderr.on("data", (chunk) => {
      const result = appendBoundedChunk(
        stderrChunks,
        stderrBytes,
        Buffer.from(chunk),
        command.stderrLimit,
      );
      stderrBytes = result.bytes;
      if (result.overflow) {
        stderrOverflow = true;
        stopProcessGroup(child.pid);
      }
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const failed =
        spawnError !== null ||
        code !== 0 ||
        timedOut ||
        stdoutOverflow ||
        stderrOverflow;
      resolve({
        stdout: Buffer.concat(stdoutChunks, stdoutBytes),
        stderr: Buffer.concat(stderrChunks, stderrBytes),
        error: failed
          ? (spawnError ??
            new Error(`command failed: ${signal ?? code ?? "unknown"}`))
          : null,
        timedOut,
        stdoutOverflow,
        stderrOverflow,
      });
    });
  });
}

/**
 * GitHub CLIのログイン引数を副作用を限定して生成する。
 *
 * @returns {string[]} 固定ログイン引数
 */
export function githubCLILoginArguments() {
  return [
    "auth",
    "login",
    "--hostname",
    "github.com",
    "--web",
    "--skip-ssh-key",
  ];
}

/**
 * Project読取権限だけを追加したログイン引数を生成する。
 *
 * @returns {string[]} 固定ログイン引数
 */
export function githubCLIProjectLoginArguments() {
  return [...githubCLILoginArguments(), "--scopes", "read:project"];
}

/**
 * 既存認証へProject読取権限だけを追加する引数を生成する。
 *
 * @returns {string[]} 固定認証更新引数
 */
export function githubCLIProjectAuthorizationArguments() {
  return [
    "auth",
    "refresh",
    "--hostname",
    "github.com",
    "--scopes",
    "read:project",
  ];
}

/**
 * 固定候補のリンク先と配置条件を検証する。
 *
 * @param {ExecutableCandidate} candidate 実行ファイル候補
 * @returns {string} 検証済み実体パス
 * @throws {Error} 配置条件を満たさない場合
 */
export function resolveTrustedExecutable(candidate) {
  if (
    !path.isAbsolute(candidate.candidatePath) ||
    !path.isAbsolute(candidate.root)
  ) {
    throw new Error("executable candidate is not absolute");
  }
  validateExecutablePathComponents(candidate.candidatePath, true);

  const resolvedPath = path.normalize(realpathSync(candidate.candidatePath));
  if (!isPathInside(candidate.root, resolvedPath)) {
    throw new Error("executable resolves outside trusted root");
  }
  validateExecutableInRoot(candidate.root, resolvedPath);

  return resolvedPath;
}

/**
 * 実行ファイル実体が許可ルート配下のGitHub CLIか検証する。
 *
 * @param {string} executablePath 実体パス
 * @returns {void}
 * @throws {Error} 許可条件を満たさない場合
 */
export function validateResolvedExecutable(executablePath) {
  const cleanPath = path.normalize(executablePath);
  if (path.basename(cleanPath) !== "gh") {
    throw new Error("executable path is not allowed");
  }

  for (const candidate of GITHUB_CLI_EXECUTABLE_CANDIDATES) {
    if (isPathInside(candidate.root, cleanPath)) {
      validateExecutableInRoot(candidate.root, cleanPath);
      return;
    }
  }

  throw new Error("executable path is not allowed");
}

/**
 * 検証済みGitHub CLIをAlfredの非公開キャッシュへ複製する。
 *
 * @param {string} sourcePath 検証済み実体パス
 * @returns {string} キャッシュ済み実行ファイルパス
 */
export function stageGitHubCLI(sourcePath) {
  return stageGitHubCLIInCache(sourcePath, expectedAlfredCacheRoot());
}

/**
 * GitHub CLIを指定した非公開キャッシュへ容量制限付きで複製する。
 *
 * @param {string} sourcePath 検証済み実体パス
 * @param {string} cacheRoot キャッシュルート
 * @returns {string} キャッシュ済み実行ファイルパス
 * @throws {Error} 検証または複製に失敗した場合
 */
export function stageGitHubCLIInCache(sourcePath, cacheRoot) {
  const sourceDescriptor = openSync(
    sourcePath,
    fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
  );
  try {
    const sourceInformation = fstatSync(sourceDescriptor, { bigint: true });
    validateSourceExecutableInformation(sourceInformation);

    const cacheDirectory = ensureSecureCacheSubdirectory(
      cacheRoot,
      EXECUTABLE_CACHE_DIRECTORY,
    );
    const sourceIdentity = executableSourceIdentity(sourceInformation);
    const snapshotPath = path.join(
      cacheDirectory,
      EXECUTABLE_SNAPSHOT_NAME,
    );
    const identityPath = path.join(
      cacheDirectory,
      EXECUTABLE_IDENTITY_NAME,
    );

    try {
      validatePrivateExecutableInCache(snapshotPath, cacheRoot);
      const cachedIdentity = readPrivateFile(
        identityPath,
        MAXIMUM_IDENTITY_BYTES,
      ).toString("utf8");
      if (cachedIdentity === sourceIdentity) {
        return snapshotPath;
      }
    } catch {
      // キャッシュ不一致時は検証済み実体から置換する
    }

    writePrivateFileAtomically(
      cacheDirectory,
      EXECUTABLE_SNAPSHOT_NAME,
      (destinationDescriptor) => {
        copyDescriptorBounded(
          sourceDescriptor,
          destinationDescriptor,
          sourceInformation.size,
          MAXIMUM_EXECUTABLE_BYTES,
        );
      },
      0o500,
    );
    validatePrivateExecutableInCache(snapshotPath, cacheRoot);
    writePrivateDataAtomically(
      cacheDirectory,
      EXECUTABLE_IDENTITY_NAME,
      sourceIdentity,
    );

    return snapshotPath;
  } finally {
    closeSync(sourceDescriptor);
  }
}

/**
 * 親の秘密情報を含まないGitHub CLI実行環境を生成する。
 *
 * @param {string} executablePath GitHub CLI実体パス
 * @param {boolean} interactive 対話認証の場合はtrue
 * @returns {NodeJS.ProcessEnv} 制限済み環境変数
 */
export function restrictedCommandEnvironment(executablePath, interactive) {
  const pathValue = `${path.dirname(executablePath)}:${RESTRICTED_SYSTEM_PATH}`;
  const environment = {
    HOME: currentUserHomeDirectory(),
    PATH: pathValue,
    LC_ALL: "C",
    GH_PAGER: "cat",
    PAGER: "cat",
    NO_COLOR: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
  };

  if (interactive) {
    return {
      ...environment,
      GH_BROWSER: "/usr/bin/open",
      BROWSER: "/usr/bin/open",
      TERM: "xterm-256color",
    };
  }

  return { ...environment, GH_PROMPT_DISABLED: "1" };
}

/**
 * 実体が許可ルート配下の実行可能なGitHub CLIか検証する。
 *
 * @param {string} root 許可ルート
 * @param {string} executablePath 実体パス
 * @returns {void}
 * @throws {Error} 所有者、権限、配置条件を満たさない場合
 */
function validateExecutableInRoot(root, executablePath) {
  if (
    path.basename(executablePath) !== "gh" ||
    !isPathInside(root, executablePath)
  ) {
    throw new Error("executable path is not allowed");
  }
  validateExecutablePathComponents(executablePath, false);

  const information = lstatSync(executablePath, { bigint: true });
  if (!information.isFile() || (information.mode & 0o111n) === 0n) {
    throw new Error("path is not an executable regular file");
  }
  const userID = BigInt(currentUserID());
  if (information.uid !== 0n && information.uid !== userID) {
    throw new Error("executable owner is not trusted");
  }
  if ((information.mode & 0o022n) !== 0n) {
    throw new Error("executable is writable by another account");
  }
}

/**
 * 実行ファイルまでの所有者・書込権限・symlink条件を検証する。
 *
 * @param {string} executablePath 検証対象パス
 * @param {boolean} allowFinalSymlink 末尾symlinkを許可する場合はtrue
 * @returns {void}
 * @throws {Error} 信頼条件を満たさない場合
 */
function validateExecutablePathComponents(
  executablePath,
  allowFinalSymlink,
) {
  const cleanPath = path.normalize(executablePath);
  if (!path.isAbsolute(cleanPath)) {
    throw new Error("executable path is not absolute");
  }

  const rootPath = path.parse(cleanPath).root;
  let currentPath = rootPath;
  const components = cleanPath
    .slice(rootPath.length)
    .split(path.sep)
    .filter(Boolean);

  for (let index = 0; index < components.length; index += 1) {
    currentPath = path.join(currentPath, components[index]);
    const information = lstatSync(currentPath, { bigint: true });
    const finalComponent = index === components.length - 1;
    const userID = BigInt(currentUserID());
    if (information.uid !== 0n && information.uid !== userID) {
      throw new Error("executable path owner is not trusted");
    }
    if (information.isSymbolicLink()) {
      if (allowFinalSymlink && finalComponent) {
        continue;
      }
      throw new Error("unexpected symbolic link in executable path");
    }
    if ((information.mode & 0o002n) !== 0n) {
      throw new Error("executable path is writable by any account");
    }
    if (
      (information.mode & 0o020n) !== 0n &&
      information.uid !== userID
    ) {
      throw new Error("system-owned executable path is group-writable");
    }
    if (!finalComponent && !information.isDirectory()) {
      throw new Error("executable path component is not a directory");
    }
  }
}

/**
 * GitHub CLI導入元の種類・容量・所有者・権限を検証する。
 *
 * @param {import("node:fs").BigIntStats} information ファイル情報
 * @returns {void}
 * @throws {Error} 信頼条件を満たさない場合
 */
function validateSourceExecutableInformation(information) {
  if (!information.isFile() || (information.mode & 0o111n) === 0n) {
    throw new Error("GitHub CLI source is not an executable regular file");
  }
  if (
    information.size <= 0n ||
    information.size > BigInt(MAXIMUM_EXECUTABLE_BYTES)
  ) {
    throw new Error("GitHub CLI source size is unsupported");
  }

  const userID = BigInt(currentUserID());
  if (information.uid !== 0n && information.uid !== userID) {
    throw new Error("GitHub CLI source owner is not trusted");
  }
  if ((information.mode & 0o022n) !== 0n) {
    throw new Error("GitHub CLI source is writable by another account");
  }
}

/**
 * 差替えを識別する非秘密のファイル属性を生成する。
 *
 * @param {import("node:fs").BigIntStats} information ファイル情報
 * @returns {string} 実体識別文字列
 */
function executableSourceIdentity(information) {
  return [
    information.dev.toString(16),
    information.ino.toString(16),
    information.size.toString(16),
    information.mtimeNs.toString(16),
  ].join(":");
}

/**
 * キャッシュ内の固定GitHub CLIが読取・実行専用か検証する。
 *
 * @param {string} executablePath キャッシュ済み実行ファイル
 * @param {string} cacheRoot キャッシュルート
 * @returns {void}
 * @throws {Error} 配置または権限が不正な場合
 */
function validatePrivateExecutableInCache(executablePath, cacheRoot) {
  const expectedDirectory = path.join(cacheRoot, EXECUTABLE_CACHE_DIRECTORY);
  if (
    path.dirname(path.normalize(executablePath)) !== expectedDirectory ||
    path.basename(executablePath) !== EXECUTABLE_SNAPSHOT_NAME
  ) {
    throw new Error("executable snapshot is outside the private cache");
  }

  const information = validatePrivateRegularFile(executablePath);
  if (Number(information.mode & 0o777n) !== 0o500) {
    throw new Error("executable snapshot permissions are invalid");
  }
}

/**
 * 現在のAlfred専用キャッシュ内にあるGitHub CLIか検証する。
 *
 * @param {string} executablePath 検証対象パス
 * @returns {void}
 */
function validatePrivateExecutable(executablePath) {
  validatePrivateExecutableInCache(executablePath, expectedAlfredCacheRoot());
}

/**
 * ファイル記述子間で実行ファイルを容量制限付きコピーする。
 *
 * @param {number} sourceDescriptor コピー元
 * @param {number} destinationDescriptor コピー先
 * @param {bigint} expectedBytes 期待バイト数
 * @param {number} maximumBytes 最大バイト数
 * @returns {void}
 * @throws {Error} 容量超過または途中変更を検出した場合
 */
function copyDescriptorBounded(
  sourceDescriptor,
  destinationDescriptor,
  expectedBytes,
  maximumBytes,
) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let copiedBytes = 0n;

  while (true) {
    const bytesRead = readSync(
      sourceDescriptor,
      buffer,
      0,
      buffer.length,
      null,
    );
    if (bytesRead === 0) {
      break;
    }
    copiedBytes += BigInt(bytesRead);
    if (copiedBytes > BigInt(maximumBytes)) {
      throw new Error("GitHub CLI exceeded the size limit");
    }

    let writtenBytes = 0;
    while (writtenBytes < bytesRead) {
      writtenBytes += writeSync(
        destinationDescriptor,
        buffer,
        writtenBytes,
        bytesRead - writtenBytes,
      );
    }
  }

  if (copiedBytes !== expectedBytes) {
    throw new Error("GitHub CLI changed during copy");
  }
}

/**
 * 出力チャンクを保持上限まで追加する。
 *
 * @param {Buffer[]} chunks 保持済みチャンク
 * @param {number} currentBytes 保持済みバイト数
 * @param {Buffer} chunk 追加チャンク
 * @param {number} limit 最大保持バイト数
 * @returns {{bytes: number, overflow: boolean}} 追加後の状態
 */
function appendBoundedChunk(chunks, currentBytes, chunk, limit) {
  const remainingBytes = Math.max(limit - currentBytes, 0);
  const writeBytes = Math.min(remainingBytes, chunk.length);
  if (writeBytes > 0) {
    chunks.push(Buffer.from(chunk.subarray(0, writeBytes)));
  }

  return {
    bytes: currentBytes + writeBytes,
    overflow: chunk.length > remainingBytes,
  };
}

/**
 * 子孫を含む独立プロセスグループを停止する。
 *
 * @param {number | undefined} processID 子プロセスID
 * @returns {void}
 */
function stopProcessGroup(processID) {
  if (!processID) {
    return;
  }
  try {
    process.kill(-processID, "SIGKILL");
  } catch (error) {
    if (!isFileSystemError(error, "ESRCH")) {
      // 終了競合以外も呼出側のcloseイベントで失敗として扱う
    }
  }
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
 * @typedef {object} Command
 * @property {string} path 実行ファイルパス
 * @property {string[]} args 固定引数
 * @property {number} timeoutMilliseconds タイムアウト
 * @property {number} stdoutLimit 標準出力上限
 * @property {number} stderrLimit 標準エラー出力上限
 */

/**
 * @typedef {object} CommandResult
 * @property {Buffer} stdout 標準出力
 * @property {Buffer} stderr 標準エラー出力
 * @property {Error | null} error 実行エラー
 * @property {boolean} timedOut タイムアウト有無
 * @property {boolean} stdoutOverflow 標準出力超過有無
 * @property {boolean} stderrOverflow 標準エラー出力超過有無
 */

/**
 * @typedef {object} ExecutableCandidate
 * @property {string} candidatePath 固定候補パス
 * @property {string} root 許可ルート
 */

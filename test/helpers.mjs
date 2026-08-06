import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * パス祖先を解決した非公開テストディレクトリを生成する。
 *
 * @returns {string} テスト専用ディレクトリ
 */
export function secureTemporaryDirectory() {
  const directory = realpathSync(
    mkdtempSync(path.join(tmpdir(), "github-navigator-test-")),
  );
  chmodSync(directory, 0o700);
  return directory;
}

/**
 * テストディレクトリを後処理へ登録する。
 *
 * @param {import("node:test").TestContext} context テストコンテキスト
 * @returns {string} テスト専用ディレクトリ
 */
export function managedTemporaryDirectory(context) {
  const directory = secureTemporaryDirectory();
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * GitHub CLI設定ファイルの同一性テスト値を生成する。
 *
 * @param {number} seed 識別用数値
 * @returns {object} 有効な設定同一性
 */
export function testConfigIdentity(seed = 1) {
  return {
    device: String(seed),
    inode: String(seed),
    size: seed,
    modification_unix_nano: String(seed),
  };
}

/**
 * GitHubアカウントキャッシュの同一性テスト値を生成する。
 *
 * @param {object} config 設定同一性
 * @returns {object} 有効なアカウント同一性
 */
export function testAccountIdentity(config = testConfigIdentity()) {
  return { hostname: "github.com", login: "owner", config };
}

/**
 * 有効なリポジトリテスト値を生成する。
 *
 * @param {Partial<object>} [overrides={}] 上書き属性
 * @returns {object} リポジトリ値
 */
export function testRepository(overrides = {}) {
  return {
    id: 1,
    full_name: "owner/repository",
    html_url: "https://github.com/owner/repository",
    private: false,
    description: null,
    archived: false,
    fork: false,
    owner: {
      id: 10,
      login: "owner",
      avatar_url: "https://avatars.githubusercontent.com/u/10?v=4",
      type: "User",
    },
    ...overrides,
  };
}

/**
 * 有効なProjectテスト値を生成する。
 *
 * @param {Partial<object>} [overrides={}] 上書き属性
 * @returns {object} Project値
 */
export function testProject(overrides = {}) {
  return {
    id: "PVT_1",
    number: 1,
    title: "Roadmap",
    html_url: "https://github.com/orgs/example-org/projects/1",
    short_description: "Delivery plan",
    public: true,
    closed: false,
    owner: {
      id: 20,
      node_id: "O_1",
      login: "example-org",
      avatar_url: "https://avatars.githubusercontent.com/u/20?v=4",
      type: "Organization",
    },
    ...overrides,
  };
}

/**
 * 成功した外部コマンド結果を生成する。
 *
 * @param {string | Buffer} [stdout=""] 標準出力
 * @returns {object} コマンド結果
 */
export function successfulCommandResult(stdout = "") {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    error: null,
    timedOut: false,
    stdoutOverflow: false,
    stderrOverflow: false,
  };
}

/**
 * 1ピクセルPNG画像を返す。
 *
 * @returns {Buffer} PNGデータ
 */
export function testPNG() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
}

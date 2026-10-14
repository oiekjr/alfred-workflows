import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createEnvironmentApp } from "./app.mjs";
import {
  isBackgroundHelperInvocation,
  newEnvironmentAvatarCache,
  refreshCachedAvatars,
  startAvatarRefreshHelper,
} from "./avatar.mjs";
import { invalidateListCache } from "./cache.mjs";
import { ExecRunner } from "./command.mjs";
import { routeInput } from "./domain.mjs";

const AUTHENTICATION_HELPER_MARKER = "--authentication-helper";
const AUTHENTICATION_ACTIONS = new Set([
  "login",
  "login-projects",
  "authorize-projects",
]);
const FALLBACK_OUTPUT = JSON.stringify({
  variables: { github_navigator_reload_pending: "" },
  items: [
    {
      title: "Unable to load GitHub results",
      subtitle: "The workflow could not create a response.",
      valid: false,
    },
  ],
});

/**
 * 通常検索、認証ヘルパー、バックグラウンド更新を固定引数で振り分ける。
 *
 * @param {string[]} arguments_ Node.jsへ渡された利用者引数
 * @returns {Promise<number>} プロセス終了コード
 */
export async function runMain(arguments_) {
  if (isBackgroundHelperInvocation(arguments_)) {
    try {
      await refreshCachedAvatars();
      return 0;
    } catch {
      process.stderr.write("Unable to refresh GitHub avatars.\n");
      return 1;
    }
  }
  if (arguments_[0] === "--background-helper") {
    process.stderr.write("Unsupported background action.\n");
    return 2;
  }

  if (arguments_[0] === AUTHENTICATION_HELPER_MARKER) {
    const authenticationAction = requestedAuthenticationAction(arguments_);
    if (authenticationAction === null) {
      process.stderr.write("Unsupported authentication action.\n");
      return 2;
    }

    try {
      invalidateListCache();
      const runner = new ExecRunner();
      if (authenticationAction === "login") {
        await runner.login();
      } else if (authenticationAction === "login-projects") {
        await runner.loginProjects();
      } else {
        await runner.authorizeProjects();
      }
      return 0;
    } catch {
      process.stderr.write("Unable to start GitHub CLI authentication.\n");
      return 1;
    }
  }

  const launcherPath = currentLauncherPath();
  try {
    const app = createEnvironmentApp(
      launcherPath,
      newEnvironmentAvatarCache(),
    );
    const feed = await runSearch(
      arguments_[0] ?? "",
      process.env.github_navigator_reload_pending === "1",
      app,
    );
    writeFeed(feed);

    if (feed.avatarRefreshNeeded === true) {
      try {
        startAvatarRefreshHelper(launcherPath);
      } catch {
        // 候補表示を優先し、次回実行時に更新を再試行する
      }
    }
    return 0;
  } catch {
    process.stdout.write(FALLBACK_OUTPUT);
    return 1;
  }
}

/**
 * 再読み込みの待機表示を先に返し、次のAlfred実行で一覧を取得する。
 *
 * @param {string} query Alfred検索語
 * @param {boolean} reloadPending 同一セッションで待機表示を返した場合はtrue
 * @param {{run: (query: string) => Promise<object>}} app 検索処理
 * @returns {Promise<object>} 表示または検索結果
 */
export async function runSearch(query, reloadPending, app) {
  if (routeInput(query).mode === "reload" && !reloadPending) {
    return {
      items: [{
        title: "Reloading GitHub repositories…",
        subtitle: "Please wait. The results will appear when reloading finishes.",
        valid: false,
      }],
      rerun: 0.1,
      variables: { github_navigator_reload_pending: "1" },
    };
  }

  const feed = await app.run(query);
  return {
    ...feed,
    variables: { github_navigator_reload_pending: "" },
  };
}

/**
 * Terminal専用の固定2引数形式から認証操作を取得する。
 *
 * @param {string[]} arguments_ Node.jsへ渡された利用者引数
 * @returns {"login" | "login-projects" | "authorize-projects" | null} 認証操作
 */
export function requestedAuthenticationAction(arguments_) {
  if (
    arguments_.length !== 2 ||
    arguments_[0] !== AUTHENTICATION_HELPER_MARKER ||
    !AUTHENTICATION_ACTIONS.has(arguments_[1])
  ) {
    return null;
  }
  return /** @type {"login" | "login-projects" | "authorize-projects"} */ (
    arguments_[1]
  );
}

/**
 * 実行中ソースに対応する検証対象ランチャーの実体パスを取得する。
 *
 * @returns {string} ランチャー絶対パス
 */
function currentLauncherPath() {
  return realpathSync(
    fileURLToPath(new URL("../github-repositories", import.meta.url)),
  );
}

/**
 * 内部制御属性を除外してAlfred Script Filter形式を出力する。
 *
 * @param {{items: object[], rerun?: number, variables?: Record<string, string>}} feed 内部応答
 * @returns {void}
 */
function writeFeed(feed) {
  process.stdout.write(JSON.stringify({
    items: feed.items,
    rerun: feed.rerun,
    variables: feed.variables,
  }));
}

const directInvocation =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (directInvocation) {
  process.exitCode = await runMain(process.argv.slice(2));
}

#!/usr/bin/env bash

set -euo pipefail
umask 077

readonly_system_path="/usr/bin:/bin:/usr/sbin:/sbin"
node_version="24.19.0"
export PATH="$readonly_system_path"

script_directory="$(cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
project_directory="$(cd -- "$script_directory/.." && /bin/pwd -P)"
workflow_directory="$project_directory/workflows/github-repositories"
build_directory="$project_directory/build"
output_directory="$build_directory/github-repositories"
runtime_sources=(
	app.mjs
	authentication.mjs
	avatar.mjs
	bootstrap.cjs
	cache.mjs
	command.mjs
	domain.mjs
	main.mjs
	security.mjs
)

# run_system は親環境を継承せずmacOS標準ツールを実行する。
run_system() {
	/usr/bin/env -i PATH="$readonly_system_path" "$@"
}

# ensure_owned_directory はsymlinkや共有書込を拒否して作業先を用意する。
ensure_owned_directory() {
	local directory_path="$1"

	if [[ -L "$directory_path" ]]; then
		echo "Refusing symbolic-link directory: $directory_path" >&2
		exit 1
	fi
	if [[ ! -e "$directory_path" ]]; then
		/bin/mkdir -m 0755 "$directory_path"
	fi
	if [[ ! -d "$directory_path" || ! -O "$directory_path" ]]; then
		echo "Build directory must be owned by the current user: $directory_path" >&2
		exit 1
	fi

	local mode
	mode="$(run_system /usr/bin/stat -f '%Lp' "$directory_path")"
	if (( (8#$mode & 0022) != 0 )); then
		echo "Build directory must not be group- or other-writable: $directory_path" >&2
		exit 1
	fi
}

# ensure_regular_source は入力ファイルの所有者、種類、共有書込権限を検証する。
ensure_regular_source() {
	local source_path="$1"

	if [[ -L "$source_path" || ! -f "$source_path" || ! -O "$source_path" ]]; then
		echo "Build source must be a current-user-owned regular file: $source_path" >&2
		exit 1
	fi

	local mode
	mode="$(run_system /usr/bin/stat -f '%Lp' "$source_path")"
	if (( (8#$mode & 0022) != 0 )); then
		echo "Build source must not be group- or other-writable: $source_path" >&2
		exit 1
	fi
}

# ensure_owned_path はmise導入先の祖先をユーザー所有ホームまで検証する。
ensure_owned_path() {
	local directory_path="$1"
	local boundary="$2"
	local expected_user_id="$3"
	local current_path="$directory_path"

	while true; do
		if [[ -L "$current_path" || ! -d "$current_path" ]]; then
			echo "Refusing unsafe mise path: $current_path" >&2
			exit 1
		fi
		if [[ "$(run_system /usr/bin/stat -f '%u' "$current_path")" != "$expected_user_id" ]]; then
			echo "Mise path must be owned by the current user: $current_path" >&2
			exit 1
		fi

		local mode
		mode="$(run_system /usr/bin/stat -f '%Lp' "$current_path")"
		if (( (8#$mode & 0022) != 0 )); then
			echo "Mise path must not be group- or other-writable: $current_path" >&2
			exit 1
		fi
		if [[ "$current_path" == "$boundary" ]]; then
			break
		fi
		if [[ "$current_path" != "$boundary"/* ]]; then
			echo "Mise path is outside the current user home." >&2
			exit 1
		fi

		current_path="$(/usr/bin/dirname -- "$current_path")"
	done
}

ensure_owned_directory "$build_directory"
ensure_owned_directory "$workflow_directory"
ensure_regular_source "$project_directory/mise.toml"
ensure_regular_source "$project_directory/package.json"
ensure_regular_source "$project_directory/scripts/check-syntax.mjs"
ensure_regular_source "$workflow_directory/info.plist"
ensure_regular_source "$workflow_directory/github-repositories"
for source_name in "${runtime_sources[@]}"; do
	ensure_regular_source "$workflow_directory/src/$source_name"
done

if ! run_system /usr/bin/grep -Fqx "node = \"$node_version\"" "$project_directory/mise.toml"; then
	echo "Node.js version pin is inconsistent." >&2
	exit 1
fi

user_record="$(run_system /usr/bin/id -P)"
IFS=: read -r _ _ record_user_id _ _ _ _ _ user_home_directory _ <<< "$user_record"
current_user_id="$(run_system /usr/bin/id -u)"
if [[ "$record_user_id" != "$current_user_id" ||
	"$user_home_directory" != /Users/* ||
	"$(cd -- "$user_home_directory" && /bin/pwd -P)" != "$user_home_directory" ]]; then
	echo "Unable to resolve a trusted macOS user home." >&2
	exit 1
fi

node_root="$user_home_directory/.local/share/mise/installs/node/$node_version"
node_path="$node_root/bin/node"
ensure_owned_path "$(/usr/bin/dirname -- "$node_path")" "$user_home_directory" "$current_user_id"
ensure_regular_source "$node_path"
if [[ ! -x "$node_path" || "$(run_system "$node_path" --version)" != "v$node_version" ]]; then
	echo "Node.js $node_version managed by mise is required." >&2
	exit 1
fi

run_system "$node_path" "$project_directory/scripts/check-syntax.mjs"

temporary_directory="$(run_system /usr/bin/mktemp -d "$build_directory/.build.XXXXXX")"
case "$temporary_directory" in
	"$build_directory"/.build.*) ;;
	*)
		echo "Unexpected temporary build path." >&2
		exit 1
		;;
esac
staging_directory="$temporary_directory/github-repositories"

# cleanup は検証済み作業用ディレクトリだけを終了時に削除する。
cleanup() {
	/bin/rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

/bin/mkdir -m 0755 "$staging_directory"
/bin/mkdir -m 0755 "$staging_directory/src"
/bin/cp "$workflow_directory/info.plist" "$staging_directory/info.plist"
/bin/cp "$workflow_directory/github-repositories" "$staging_directory/github-repositories"
for source_name in "${runtime_sources[@]}"; do
	/bin/cp "$workflow_directory/src/$source_name" "$staging_directory/src/$source_name"
done
/bin/chmod 0644 "$staging_directory/info.plist"
/bin/chmod 0644 "$staging_directory/github-repositories"
for source_name in "${runtime_sources[@]}"; do
	/bin/chmod 0644 "$staging_directory/src/$source_name"
done

run_system /usr/bin/plutil -lint "$staging_directory/info.plist"
run_system /bin/sh -n "$staging_directory/github-repositories"
for source_name in "${runtime_sources[@]}"; do
	run_system "$node_path" --check "$staging_directory/src/$source_name"
done

if [[ -L "$output_directory" ]]; then
	echo "Refusing symbolic-link build output: $output_directory" >&2
	exit 1
fi
if [[ -e "$output_directory" ]]; then
	if [[ ! -O "$output_directory" ]]; then
		echo "Build output must be owned by the current user: $output_directory" >&2
		exit 1
	fi
	/bin/rm -rf -- "$output_directory"
fi
/bin/mv "$staging_directory" "$output_directory"

echo "$output_directory"

#!/usr/bin/env bash

set -euo pipefail
umask 077

readonly_system_path="/usr/bin:/bin:/usr/sbin:/sbin"
go_version="1.26.5"
export PATH="$readonly_system_path"

script_directory="$(cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
project_directory="$(cd -- "$script_directory/.." && /bin/pwd -P)"
build_directory="$project_directory/build"
binary_path="$build_directory/github-repositories"

# run_system は親環境を継承せずmacOS標準ツールを実行する。
run_system() {
	/usr/bin/env -i PATH="$readonly_system_path" "$@"
}

# ensure_owned_directory はsymlinkや他アカウントが書き込める作業先を拒否する。
ensure_owned_directory() {
	local path="$1"

	if [[ -L "$path" ]]; then
		echo "Refusing symbolic-link directory: $path" >&2
		exit 1
	fi
	if [[ ! -e "$path" ]]; then
		/bin/mkdir -m 0755 "$path"
	fi
	if [[ ! -d "$path" || ! -O "$path" ]]; then
		echo "Build directory must be owned by the current user: $path" >&2
		exit 1
	fi

	local mode
	mode="$(run_system /usr/bin/stat -f '%Lp' "$path")"
	if (( (8#$mode & 0022) != 0 )); then
		echo "Build directory must not be group- or other-writable: $path" >&2
		exit 1
	fi
}

# ensure_regular_source はビルド入力のsymlinkと共有書込権限を拒否する。
ensure_regular_source() {
	local path="$1"

	if [[ -L "$path" || ! -f "$path" || ! -O "$path" ]]; then
		echo "Build source must be a current-user-owned regular file: $path" >&2
		exit 1
	fi

	local mode
	mode="$(run_system /usr/bin/stat -f '%Lp' "$path")"
	if (( (8#$mode & 0022) != 0 )); then
		echo "Build source must not be group- or other-writable: $path" >&2
		exit 1
	fi
}

# ensure_owned_path はmise導入先の全要素を現在ユーザーだけが変更できるか検証する。
ensure_owned_path() {
	local path="$1"
	local boundary="$2"
	local expected_user_id="$3"
	local current_path="$path"

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
ensure_regular_source "$project_directory/go.mod"
ensure_regular_source "$project_directory/mise.toml"
if ! run_system /usr/bin/grep -Fqx "go $go_version" "$project_directory/go.mod" ||
	! run_system /usr/bin/grep -Fqx "go = \"$go_version\"" "$project_directory/mise.toml"; then
	echo "Go version pins are inconsistent." >&2
	exit 1
fi

current_user_id="$(run_system /usr/bin/id -u)"
unsafe_source="$(
	run_system /usr/bin/find \
		"$project_directory/cmd" \
		"$project_directory/internal" \
		\( \
			-type l \
			-o \
			-type f \
			\( \
				! -user "$current_user_id" \
				-o -perm -002 \
				-o -perm -020 \
			\) \
		\) \
		-print \
		-quit
)"
if [[ -n "$unsafe_source" ]]; then
	echo "Refusing unsafe build source: $unsafe_source" >&2
	exit 1
fi

if [[ -L "$binary_path" || ( -e "$binary_path" && ! -f "$binary_path" ) ]]; then
	echo "Refusing unsafe build output: $binary_path" >&2
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

go_root="$user_home_directory/.local/share/mise/installs/go/$go_version"
go_path="$go_root/bin/go"
ensure_owned_path "$(/usr/bin/dirname -- "$go_path")" "$user_home_directory" "$current_user_id"
if [[ -L "$go_path" || ! -f "$go_path" || ! -x "$go_path" || ! -O "$go_path" ]]; then
	echo "Run this task through mise with its pinned Go installation." >&2
	exit 1
fi
ensure_regular_source "$go_path"
if [[ "$(run_system "$go_path" version)" != "go version go$go_version "* ]]; then
	echo "Go $go_version managed by mise is required." >&2
	exit 1
fi

temporary_directory="$(run_system /usr/bin/mktemp -d "$build_directory/.build.XXXXXX")"
case "$temporary_directory" in
	"$build_directory"/.build.*) ;;
	*)
		echo "Unexpected temporary build path." >&2
		exit 1
		;;
esac

# 作業用ディレクトリだけを終了時に削除する。
cleanup() {
	/bin/rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

go_cache="$temporary_directory/go-cache"
module_cache="$temporary_directory/module-cache"
arm64_binary="$temporary_directory/github-repositories-arm64"
x86_64_binary="$temporary_directory/github-repositories-x86_64"
universal_binary="$temporary_directory/github-repositories"

cd "$project_directory"

/usr/bin/env -i \
	PATH="$readonly_system_path" \
	GOCACHE="$go_cache" \
	GOMODCACHE="$module_cache" \
	GOENV=off \
	GOTOOLCHAIN=local \
	GOPROXY=off \
	GOSUMDB=off \
	GOWORK=off \
	GOFLAGS="-mod=readonly -buildvcs=false" \
	CGO_ENABLED=0 \
	GOOS=darwin \
	GOARCH=arm64 \
	"$go_path" build \
	-trimpath \
	-ldflags="-s -w" \
	-o "$arm64_binary" \
	./cmd/github-repositories

/usr/bin/env -i \
	PATH="$readonly_system_path" \
	GOCACHE="$go_cache" \
	GOMODCACHE="$module_cache" \
	GOENV=off \
	GOTOOLCHAIN=local \
	GOPROXY=off \
	GOSUMDB=off \
	GOWORK=off \
	GOFLAGS="-mod=readonly -buildvcs=false" \
	CGO_ENABLED=0 \
	GOOS=darwin \
	GOARCH=amd64 \
	"$go_path" build \
	-trimpath \
	-ldflags="-s -w" \
	-o "$x86_64_binary" \
	./cmd/github-repositories

run_system /usr/bin/lipo -create \
	"$arm64_binary" \
	"$x86_64_binary" \
	-output "$universal_binary"
/bin/chmod 0755 "$universal_binary"
run_system /usr/bin/lipo "$universal_binary" -verify_arch arm64 x86_64
run_system /usr/bin/codesign --force --sign - --timestamp=none "$universal_binary"
run_system /usr/bin/codesign --verify --strict --verbose=2 "$universal_binary"

/bin/mv -f "$universal_binary" "$binary_path"

echo "$binary_path"

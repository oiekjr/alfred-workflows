#!/usr/bin/env bash

set -euo pipefail
umask 077

readonly_system_path="/usr/bin:/bin:/usr/sbin:/sbin"
export PATH="$readonly_system_path"

script_directory="$(cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
project_directory="$(cd -- "$script_directory/.." && /bin/pwd -P)"
build_directory="$project_directory/build/github-repositories"
dist_directory="$project_directory/dist"
runtime_entries=(
	info.plist
	github-repositories
	src/app.mjs
	src/authentication.mjs
	src/avatar.mjs
	src/bootstrap.cjs
	src/cache.mjs
	src/command.mjs
	src/domain.mjs
	src/main.mjs
	src/security.mjs
)

# run_system は親環境を継承せずmacOS標準ツールを実行する。
run_system() {
	/usr/bin/env -i PATH="$readonly_system_path" "$@"
}

# validate_owned_directory は出力先の所有者、種類、共有書込権限を検証する。
validate_owned_directory() {
	local directory_path="$1"

	if [[ -L "$directory_path" || ! -d "$directory_path" || ! -O "$directory_path" ]]; then
		echo "Package directory must be a current-user-owned directory: $directory_path" >&2
		exit 1
	fi
	local mode
	mode="$(run_system /usr/bin/stat -f '%Lp' "$directory_path")"
	if (( (8#$mode & 0022) != 0 )); then
		echo "Package directory must not be group- or other-writable: $directory_path" >&2
		exit 1
	fi
}

# ensure_owned_directory は検証可能な出力先を用意する。
ensure_owned_directory() {
	local directory_path="$1"

	if [[ ! -e "$directory_path" && ! -L "$directory_path" ]]; then
		/bin/mkdir -m 0755 "$directory_path"
	fi
	validate_owned_directory "$directory_path"
}

# validate_runtime_file は配布入力が固定ツリー内の通常ファイルか検証する。
validate_runtime_file() {
	local relative_path="$1"
	local input_path="$build_directory/$relative_path"

	if [[ -L "$input_path" || ! -f "$input_path" || ! -O "$input_path" ]]; then
		echo "Package input must be a current-user-owned regular file: $input_path" >&2
		exit 1
	fi
	local mode
	mode="$(run_system /usr/bin/stat -f '%Lp' "$input_path")"
	if [[ "$mode" != "644" ]]; then
		echo "Package runtime file must use mode 0644: $input_path" >&2
		exit 1
	fi
	if [[ "$(run_system /usr/bin/file -b "$input_path")" == Mach-O* ]]; then
		echo "Native Mach-O files are not allowed in the workflow package: $input_path" >&2
		exit 1
	fi
}

validate_owned_directory "$build_directory"
validate_owned_directory "$build_directory/src"
ensure_owned_directory "$dist_directory"
for relative_path in "${runtime_entries[@]}"; do
	validate_runtime_file "$relative_path"
done

run_system /usr/bin/plutil -lint "$build_directory/info.plist"
run_system /bin/sh -n "$build_directory/github-repositories"
bundle_identifier="$(run_system /usr/bin/plutil -extract bundleid raw -o - "$build_directory/info.plist")"
if [[ "$bundle_identifier" != "com.oiekjr.alfred.github-repositories" ]]; then
	echo "Unexpected workflow bundle identifier." >&2
	exit 1
fi

version="$(run_system /usr/bin/plutil -extract version raw -o - "$build_directory/info.plist")"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
	echo "Workflow version must use MAJOR.MINOR.PATCH." >&2
	exit 1
fi

artifact_name="github-repositories-$version.alfredworkflow"
checksum_name="$artifact_name.sha256"
artifact_path="$dist_directory/$artifact_name"
checksum_path="$dist_directory/$checksum_name"
for output_path in "$artifact_path" "$checksum_path"; do
	if [[ -L "$output_path" || ( -e "$output_path" && ! -f "$output_path" ) ]]; then
		echo "Refusing unsafe package output: $output_path" >&2
		exit 1
	fi
done

temporary_directory="$(run_system /usr/bin/mktemp -d "$dist_directory/.package.XXXXXX")"
case "$temporary_directory" in
	"$dist_directory"/.package.*) ;;
	*)
		echo "Unexpected temporary package path." >&2
		exit 1
		;;
esac
temporary_artifact="$temporary_directory/$artifact_name"
temporary_checksum="$temporary_directory/$checksum_name"

# cleanup は検証済み作業用ディレクトリだけを終了時に削除する。
cleanup() {
	/bin/rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

(
	cd "$build_directory"
	run_system /usr/bin/zip -X -q "$temporary_artifact" "${runtime_entries[@]}"
)
run_system /usr/bin/unzip -tq "$temporary_artifact"

archive_entries="$(run_system /usr/bin/unzip -Z1 "$temporary_artifact")"
expected_entries="$(/usr/bin/printf '%s\n' "${runtime_entries[@]}")"
if [[ "$archive_entries" != "$expected_entries" ]]; then
	echo "Package contains unexpected entries." >&2
	exit 1
fi

(
	cd "$temporary_directory"
	run_system /usr/bin/shasum -a 256 "$artifact_name" > "$checksum_name"
	run_system /usr/bin/shasum -a 256 -c "$checksum_name"
)

/bin/mv -f "$temporary_artifact" "$artifact_path"
/bin/mv -f "$temporary_checksum" "$checksum_path"
(
	cd "$dist_directory"
	run_system /usr/bin/shasum -a 256 -c "$checksum_name"
)

echo "$artifact_path"
echo "$checksum_path"

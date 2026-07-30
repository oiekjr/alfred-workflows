#!/usr/bin/env bash

set -euo pipefail
umask 077

readonly_system_path="/usr/bin:/bin:/usr/sbin:/sbin"
export PATH="$readonly_system_path"

script_directory="$(cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
project_directory="$(cd -- "$script_directory/.." && /bin/pwd -P)"
workflow_directory="$project_directory/workflows/github-repositories"
plist_path="$workflow_directory/info.plist"
binary_path="$project_directory/build/github-repositories"
dist_directory="$project_directory/dist"

# run_system は親環境を継承せずmacOS標準ツールを実行する。
run_system() {
	/usr/bin/env -i PATH="$readonly_system_path" "$@"
}

# validate_owned_directory はsymlinkや他アカウントが書き込めるディレクトリを拒否する。
validate_owned_directory() {
	local path="$1"

	if [[ -L "$path" ]]; then
		echo "Refusing symbolic-link directory: $path" >&2
		exit 1
	fi
	if [[ ! -d "$path" || ! -O "$path" ]]; then
		echo "Package directory must be owned by the current user: $path" >&2
		exit 1
	fi

	local mode
	mode="$(run_system /usr/bin/stat -f '%Lp' "$path")"
	if (( (8#$mode & 0022) != 0 )); then
		echo "Package directory must not be group- or other-writable: $path" >&2
		exit 1
	fi
}

# ensure_owned_directory は検証可能な出力先を用意する。
ensure_owned_directory() {
	local path="$1"

	if [[ ! -e "$path" && ! -L "$path" ]]; then
		/bin/mkdir -m 0755 "$path"
	fi
	validate_owned_directory "$path"
}

# ensure_regular_input はパッケージ入力のsymlinkと共有書込権限を拒否する。
ensure_regular_input() {
	local path="$1"
	local expected_parent="$2"

	if [[ -L "$path" || ! -f "$path" || ! -O "$path" ]]; then
		echo "Package input must be a current-user-owned regular file: $path" >&2
		exit 1
	fi
	local physical_parent
	physical_parent="$(
		cd -- "$(/usr/bin/dirname -- "$path")"
		/bin/pwd -P
	)"
	if [[ "$physical_parent" != "$expected_parent" ]]; then
		echo "Package input resolves through an unexpected directory: $path" >&2
		exit 1
	fi

	local mode
	mode="$(run_system /usr/bin/stat -f '%Lp' "$path")"
	if (( (8#$mode & 0022) != 0 )); then
		echo "Package input must not be group- or other-writable: $path" >&2
		exit 1
	fi
}

validate_owned_directory "$workflow_directory"
validate_owned_directory "$project_directory/build"
ensure_owned_directory "$dist_directory"
ensure_regular_input "$plist_path" "$project_directory/workflows/github-repositories"
ensure_regular_input "$binary_path" "$project_directory/build"

if [[ ! -x "$binary_path" ]]; then
	echo "Run the build task before packaging." >&2
	exit 1
fi

run_system /usr/bin/plutil -lint "$plist_path"
run_system /usr/bin/lipo "$binary_path" -verify_arch arm64 x86_64
run_system /usr/bin/codesign --verify --strict --verbose=2 "$binary_path"

bundle_identifier="$(run_system /usr/bin/plutil -extract bundleid raw -o - "$plist_path")"
if [[ "$bundle_identifier" != "com.oiekjr.alfred.github-repositories" ]]; then
	echo "Unexpected workflow bundle identifier." >&2
	exit 1
fi

version="$(run_system /usr/bin/plutil -extract version raw -o - "$plist_path")"
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
staging_directory="$temporary_directory/workflow"
temporary_artifact="$temporary_directory/$artifact_name"
temporary_checksum="$temporary_directory/$checksum_name"

# 作業用ディレクトリだけを終了時に削除する。
cleanup() {
	/bin/rm -rf -- "$temporary_directory"
}
trap cleanup EXIT

/bin/mkdir -m 0700 "$staging_directory"
/bin/cp "$plist_path" "$staging_directory/info.plist"
/bin/cp "$binary_path" "$staging_directory/github-repositories"
/bin/chmod 0644 "$staging_directory/info.plist"
/bin/chmod 0755 "$staging_directory/github-repositories"

run_system /usr/bin/plutil -lint "$staging_directory/info.plist"
run_system /usr/bin/codesign --verify --strict --verbose=2 "$staging_directory/github-repositories"

(
	cd "$staging_directory"
	run_system /usr/bin/zip -X -q "$temporary_artifact" info.plist github-repositories
)

run_system /usr/bin/unzip -tq "$temporary_artifact"
archive_entries="$(run_system /usr/bin/unzip -Z1 "$temporary_artifact")"
if [[ "$archive_entries" != $'info.plist\ngithub-repositories' ]]; then
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

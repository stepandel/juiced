#!/bin/sh
# Install a published Juiced release without Node.js, npm, or elevated privileges.
set -eu

fail() { printf 'juiced: %s\n' "$*" >&2; exit 1; }

main() {
  [ "$#" -le 1 ] || fail 'Usage: sh install.sh [version]'
  for command in curl tar mktemp uname awk grep; do
    command -v "$command" >/dev/null 2>&1 || fail "Required command is missing: $command"
  done
  if command -v sha256sum >/dev/null 2>&1; then
    checksum=sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    checksum=shasum
  else
    fail 'SHA-256 verification requires sha256sum or shasum.'
  fi
  case $(uname -s) in
    Darwin) platform=darwin ;;
    Linux) platform=linux ;;
    *) fail 'Supported systems are macOS and Linux.' ;;
  esac
  case $(uname -m) in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=x64 ;;
    *) fail 'Supported architectures are arm64 and x64.' ;;
  esac

  releases=https://github.com/stepandel/juiced/releases
  version=${1:-${JUICED_VERSION:-latest}}
  if [ "$version" = latest ]; then
    latest=$(curl --fail --silent --show-error --location --retry 3 \
      --connect-timeout 15 --proto '=https' --proto-redir '=https' \
      --output /dev/null --write-out '%{url_effective}' "$releases/latest") ||
      fail 'Could not find a public Juiced release. See https://github.com/stepandel/juiced/releases.'
    version=${latest##*/}
  fi
  version=${version#v}
  case "$version" in *[!0-9A-Za-z.-]*|'') fail 'Expected a release version such as 0.2.0 or v0.2.0.' ;; esac
  printf '%s\n' "$version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$' ||
    fail 'Expected a release version such as 0.2.0 or v0.2.0.'

  install_dir=${JUICED_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/juiced}
  bin_dir=${JUICED_BIN_DIR:-$HOME/.local/bin}
  install_kind=fresh
  case "$install_dir" in /*) ;; *) fail 'JUICED_INSTALL_DIR must be an absolute path.' ;; esac
  case "$bin_dir" in /*) ;; *) fail 'JUICED_BIN_DIR must be an absolute path.' ;; esac
  if [ -e "$bin_dir/juiced" ] || [ -L "$bin_dir/juiced" ]; then
    install_kind=update
    [ -L "$bin_dir/juiced" ] || fail "An existing command occupies $bin_dir/juiced. Move it before installing."
    case $(readlink "$bin_dir/juiced") in
      "$install_dir/releases/"*/bin/juiced) ;;
      *) fail "An existing command occupies $bin_dir/juiced. Move it before installing." ;;
    esac
  fi

  mkdir -p "$install_dir/releases" "$bin_dir"
  staging=$(mktemp -d "$install_dir/releases/.install.XXXXXXXX")
  link_staging=
  trap 'rm -rf "$staging"; if [ -n "$link_staging" ]; then rm -rf "$link_staging"; fi' 0
  trap 'exit 1' HUP INT TERM
  asset=juiced-$platform-$arch.tar.gz
  base=$releases/download/v$version
  printf 'Downloading Juiced %s for %s/%s...\n' "$version" "$platform" "$arch"
  for file in SHA256SUMS "$asset"; do
    curl --fail --silent --show-error --location --retry 3 \
      --connect-timeout 15 --proto '=https' --proto-redir '=https' \
      --output "$staging/$file" "$base/$file" || fail "Could not download $file for v$version."
  done
  expected=$(awk -v file="$asset" '$2 == file { print $1 }' "$staging/SHA256SUMS")
  printf '%s\n' "$expected" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$' || fail 'Missing or invalid release checksum.'
  if [ "$checksum" = shasum ]; then
    actual=$(shasum -a 256 "$staging/$asset" | awk '{ print $1 }')
  else
    actual=$(sha256sum "$staging/$asset" | awk '{ print $1 }')
  fi
  [ "$actual" = "$expected" ] || fail 'Release checksum did not match; installation stopped.'
  tar -xzf "$staging/$asset" -C "$staging"
  installed_version=$(JUICED_CONFIG_HOME="$staging/config" JUICED_MODE=managed \
    "$staging/juiced/bin/juiced" --version) ||
    fail 'This release cannot run on this system. Linux requires glibc 2.28+; macOS requires 13.5+.'
  [ "$installed_version" = "juiced $version" ] || fail 'The downloaded CLI version does not match the requested release.'

  # Keep the previous release intact until the new command has passed its check.
  destination=$install_dir/releases/$version-${staging##*/}
  mv "$staging/juiced" "$destination"
  # Persist custom paths so future automatic updates use this installation.
  printf '%s\000%s\000' "$install_dir" "$bin_dir" > "$destination/install-paths"
  link_staging=$(mktemp -d "$bin_dir/.juiced.XXXXXXXX")
  ln -s "$destination/bin/juiced" "$link_staging/juiced"
  mv -f "$link_staging/juiced" "$bin_dir/juiced"
  printf 'Installed Juiced %s to %s/juiced.\n' "$version" "$bin_dir"
  # The installed CLI owns the random ID and opt-out setting. Its version check
  # above never counts as a first run. Reporting failure cannot fail installation.
  # Releases that predate install reporting do not recognize the flag.
  if grep -q -e '--internal-install-completed' "$destination/bin/juiced.mjs" 2>/dev/null; then
    "$bin_dir/juiced" --internal-install-completed "$install_kind" || :
  fi
  case :$PATH: in
    *:"$bin_dir":*) printf 'Run juiced login to get started.\n' ;;
    *) printf 'Add %s to your PATH, then run juiced login.\n' "$bin_dir" ;;
  esac
}

# Running only after the function is fully read also supports piping into sh.
main "$@"

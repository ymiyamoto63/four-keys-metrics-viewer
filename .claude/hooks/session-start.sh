#!/bin/bash
# SessionStart hook: set up tooling that is not baked into the container image.
#
# Currently installs the GitHub CLI (gh). The container is ephemeral, so
# without this every new Claude Code on the web session starts without gh.
set -euo pipefail

# Only run in the remote (Claude Code on the web) container. Local machines are
# expected to manage their own tooling.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

GH_VERSION="${GH_VERSION:-2.101.0}"
GH_INSTALL_DIR="${GH_INSTALL_DIR:-/usr/local/bin}"

# Idempotent: the container image is cached after this hook completes, so on a
# warm start gh is already there and we have nothing to do.
if command -v gh >/dev/null 2>&1 \
  && gh --version 2>/dev/null | head -1 | grep -qF "gh version ${GH_VERSION}"; then
  echo "gh ${GH_VERSION} already installed at $(command -v gh)"
  exit 0
fi

case "$(uname -m)" in
  x86_64)  GH_ARCH=amd64 ;;
  aarch64|arm64) GH_ARCH=arm64 ;;
  *) echo "session-start: unsupported architecture $(uname -m), skipping gh install" >&2; exit 0 ;;
esac

GH_TARBALL="gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz"
GH_BASE_URL="https://github.com/cli/cli/releases/download/v${GH_VERSION}"

# Note: the apt repository at cli.github.com is blocked by the environment's
# egress policy, so we install the release tarball from github.com directly.
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# Retry with exponential backoff -- the proxied network occasionally drops.
fetch() {
  local url="$1" dest="$2" delay=2
  for attempt in 1 2 3 4; do
    if curl -fsSL --max-time 180 -o "$dest" "$url"; then
      return 0
    fi
    echo "session-start: fetch failed for $url (attempt $attempt), retrying in ${delay}s" >&2
    sleep "$delay"
    delay=$((delay * 2))
  done
  return 1
}

if ! fetch "${GH_BASE_URL}/${GH_TARBALL}" "${workdir}/${GH_TARBALL}"; then
  echo "session-start: could not download ${GH_TARBALL}, skipping gh install" >&2
  exit 0
fi

if ! fetch "${GH_BASE_URL}/gh_${GH_VERSION}_checksums.txt" "${workdir}/checksums.txt"; then
  echo "session-start: could not download checksums, skipping gh install" >&2
  exit 0
fi

# Verify the tarball against the release's published SHA256 before unpacking it.
(
  cd "$workdir"
  grep -F "  ${GH_TARBALL}" checksums.txt > expected.txt
  sha256sum -c expected.txt
)

tar -xzf "${workdir}/${GH_TARBALL}" -C "$workdir"
install -m 0755 "${workdir}/gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh" "${GH_INSTALL_DIR}/gh"

mkdir -p /usr/local/share/man/man1
cp -r "${workdir}/gh_${GH_VERSION}_linux_${GH_ARCH}/share/man/man1/." /usr/local/share/man/man1/ 2>/dev/null || true

echo "session-start: installed $("${GH_INSTALL_DIR}/gh" --version | head -1)"

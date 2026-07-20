#!/usr/bin/env bash
set -euo pipefail

# generate-distribution.sh
# Builds and packages a11y-scout monorepo for distribution

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Constants
DIST_DIR="distribution"
PACKAGES=("packages/a11y-scout" "packages/a11y-scout-playwright" "packages/a11y-scout-webdriverio")
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}a11y-scout Distribution Generator${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Step 1: Clean old distribution artifacts
echo -e "${YELLOW}[1/7]${NC} Cleaning old distribution artifacts..."
rm -rf "${ROOT_DIR}/${DIST_DIR}"
for pkg in "${PACKAGES[@]}"; do
  rm -f "${ROOT_DIR}/${pkg}"/*.tgz
done
echo -e "${GREEN}✓${NC} Cleaned distribution artifacts"
echo ""

# Step 2: Build all packages
echo -e "${YELLOW}[2/7]${NC} Building packages..."
cd "${ROOT_DIR}"
npm run build
echo -e "${GREEN}✓${NC} Build completed"
echo ""

# Step 3: Generate .tgz files
echo -e "${YELLOW}[3/7]${NC} Generating .tgz files..."
TARBALLS=()
for pkg in "${PACKAGES[@]}"; do
  echo "  → Packing ${pkg}..."
  cd "${ROOT_DIR}/${pkg}"
  tarball=$(npm pack 2>&1 | tail -n 1)
  TARBALLS+=("${ROOT_DIR}/${pkg}/${tarball}")
  echo -e "    ${GREEN}✓${NC} Created ${tarball}"
done
echo ""

# Step 4: Create distribution directory
echo -e "${YELLOW}[4/7]${NC} Creating distribution directory..."
mkdir -p "${ROOT_DIR}/${DIST_DIR}"
echo -e "${GREEN}✓${NC} Created ${DIST_DIR}/"
echo ""

# Step 5: Copy .tgz files to distribution/
echo -e "${YELLOW}[5/7]${NC} Copying .tgz files to distribution..."
for tarball in "${TARBALLS[@]}"; do
  filename=$(basename "${tarball}")
  cp "${tarball}" "${ROOT_DIR}/${DIST_DIR}/${filename}"
  echo "  → ${filename}"
done
echo -e "${GREEN}✓${NC} Copied all .tgz files"
echo ""

# Step 6: Generate manifest.txt with versions and checksums
echo -e "${YELLOW}[6/7]${NC} Generating manifest..."
MANIFEST="${ROOT_DIR}/${DIST_DIR}/manifest.txt"
{
  echo "Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  echo "Build: a11y-scout monorepo"
  echo ""
  echo "Packages:"
} > "${MANIFEST}"

cd "${ROOT_DIR}/${DIST_DIR}"
for tarball in *.tgz; do
  # Get file size in human-readable format
  if [[ "$OSTYPE" == "darwin"* ]]; then
    size=$(stat -f%z "${tarball}" | awk '{
      if ($1 < 1024) printf "%.0f B", $1
      else if ($1 < 1048576) printf "%.1f KB", $1/1024
      else printf "%.1f MB", $1/1048576
    }')
  else
    size=$(stat -c%s "${tarball}" | awk '{
      if ($1 < 1024) printf "%.0f B", $1
      else if ($1 < 1048576) printf "%.1f KB", $1/1024
      else printf "%.1f MB", $1/1048576
    }')
  fi

  # Extract package name and version from tarball filename
  # Handles both scoped (@org/pkg-1.0.0.tgz) and unscoped (pkg-1.0.0.tgz)
  if [[ "${tarball}" =~ ^a11y-scout-playwright-([0-9]+\.[0-9]+\.[0-9]+)\.tgz$ ]]; then
    pkg_name="@a11y-scout/playwright"
    version="${BASH_REMATCH[1]}"
  elif [[ "${tarball}" =~ ^a11y-scout-webdriverio-([0-9]+\.[0-9]+\.[0-9]+)\.tgz$ ]]; then
    pkg_name="@a11y-scout/webdriverio"
    version="${BASH_REMATCH[1]}"
  elif [[ "${tarball}" =~ ^a11y-scout-([0-9]+\.[0-9]+\.[0-9]+)\.tgz$ ]]; then
    pkg_name="a11y-scout"
    version="${BASH_REMATCH[1]}"
  else
    pkg_name="unknown"
    version="unknown"
  fi

  # Generate SHA256 checksum
  if command -v shasum &> /dev/null; then
    checksum=$(shasum -a 256 "${tarball}" | awk '{print $1}')
  else
    checksum=$(sha256sum "${tarball}" | awk '{print $1}')
  fi

  {
    echo "- ${pkg_name}@${version} (${tarball}, ${size})"
    echo "  SHA256: ${checksum}"
  } >> "${MANIFEST}"
done

# Copy installation guide and .env.example for consumers
if [[ -f "${ROOT_DIR}/docs/installation-guide.md" ]]; then
  cp "${ROOT_DIR}/docs/installation-guide.md" "${ROOT_DIR}/${DIST_DIR}/INSTALLATION_GUIDE.md"
  echo "" >> "${MANIFEST}"
  echo "Documentation: INSTALLATION_GUIDE.md" >> "${MANIFEST}"
fi

# Copy .env.example to distribution root for easy access
if [[ -f "${ROOT_DIR}/.env.example" ]]; then
  cp "${ROOT_DIR}/.env.example" "${ROOT_DIR}/${DIST_DIR}/.env.example"
  echo "Configuration: .env.example" >> "${MANIFEST}"
fi

cd "${ROOT_DIR}"
echo -e "${GREEN}✓${NC} Generated manifest.txt"
echo ""

# Step 7: Print summary
echo -e "${YELLOW}[7/7]${NC} Summary"
echo -e "${BLUE}========================================${NC}"
echo -e "Distribution packages created in: ${GREEN}${DIST_DIR}/${NC}"
echo ""
echo "Contents:"
for file in "${DIST_DIR}"/*; do
  if [[ -f "${file}" ]]; then
    filename=$(basename "${file}")
    if [[ "$OSTYPE" == "darwin"* ]]; then
      size=$(stat -f "%z" "${file}" | awk '{
        if ($1 < 1024) printf "%.0f B", $1
        else if ($1 < 1048576) printf "%.1f KB", $1/1024
        else printf "%.1f MB", $1/1048576
      }')
    else
      size=$(stat -c "%s" "${file}" | awk '{
        if ($1 < 1024) printf "%.0f B", $1
        else if ($1 < 1048576) printf "%.1f KB", $1/1024
        else printf "%.1f MB", $1/1048576
      }')
    fi
    echo "  • ${filename} (${size})"
  fi
done
echo ""
echo -e "${GREEN}✓ Distribution ready!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Next steps:"
echo "  1. Review: ls -lh ${DIST_DIR}/"
echo "  2. Verify: cat ${DIST_DIR}/manifest.txt"
echo "  3. Share: Upload ${DIST_DIR}/ to SharePoint"

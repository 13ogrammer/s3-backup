# SAM Makefile build for ApiFn.
#
# SAM sets ARTIFACTS_DIR to the directory it expects the deployable artifact
# in. We:
#   1. Bundle all TypeScript with esbuild (via the repo's local node_modules),
#      keeping @aws-sdk/* and sharp external so they're not inlined.
#   2. Install sharp with the linux/arm64 platform flags so the correct
#      native binary lands alongside the bundle in the artifact dir.
#
# @aws-sdk/* is excluded because the Lambda ARM64 runtime ships its own
# SDK — bundling it would add ~20 MB for no benefit.
#
# esbuild is resolved via the backend package's node_modules/.bin so the
# Makefile works regardless of whether it's on the system PATH.

# SAM runs make with CWD = CodeUri directory (src/), so ../node_modules/.bin
# resolves to backend/node_modules/.bin where esbuild lives.
ESBUILD := ../node_modules/.bin/esbuild

build-ApiFn:
	# Bundle TypeScript → JS, externals kept out of the bundle
	$(ESBUILD) index.ts \
		--bundle \
		--platform=node \
		--target=node20 \
		--format=esm \
		--minify \
		--external:@aws-sdk/* \
		--external:sharp \
		--outfile=$(ARTIFACTS_DIR)/index.mjs

	# Install sharp's linux/arm64 native binary into the artifact dir.
	# npm 11+ selects optional deps via --cpu/--os/--libc (the older
	# --platform/--arch flags don't drive optional-dep selection, which
	# is how sharp ships per-arch binaries — it picks the host's arch).
	# --include=optional is required so the matching
	# @img/sharp-linux-arm64 isn't pruned. --foreground-scripts ensures
	# its postinstall actually runs.
	npm install --prefix $(ARTIFACTS_DIR) \
		--cpu=arm64 \
		--os=linux \
		--libc=glibc \
		--include=optional \
		--omit=dev \
		--foreground-scripts \
		sharp

# MoveWorker bundles worker.ts as the entrypoint. Sharp is not used by the
# worker (no image resizing), but is installed to keep the artifact consistent
# and avoid missing-module errors if any transitive import reaches it.
build-MoveWorker:
	$(ESBUILD) worker.ts \
		--bundle \
		--platform=node \
		--target=node20 \
		--format=esm \
		--minify \
		--external:@aws-sdk/* \
		--external:sharp \
		--outfile=$(ARTIFACTS_DIR)/worker.mjs

	npm install --prefix $(ARTIFACTS_DIR) \
		--cpu=arm64 \
		--os=linux \
		--libc=glibc \
		--include=optional \
		--omit=dev \
		--foreground-scripts \
		sharp

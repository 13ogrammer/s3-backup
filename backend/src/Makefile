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
	# --foreground-scripts ensures the @img/sharp-linux-arm64 postinstall
	# actually runs inside the build container.
	npm install --prefix $(ARTIFACTS_DIR) \
		--platform=linux \
		--arch=arm64 \
		--os=linux \
		--libc=glibc \
		--omit=dev \
		--foreground-scripts \
		sharp

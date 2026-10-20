FROM node:22-bookworm-slim

# Keep Claude's model aliases current independently of the Cantelop SDK release.
ARG CLAUDE_CODE_VERSION=2.1.305
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git gh ripgrep python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

# Use the SDK's own login helper so authentication retains its PTY contract.
COPY node_modules/@cantelop/sdk/dist/harnesses/claude/login-pty.py /opt/app/login-pty.py

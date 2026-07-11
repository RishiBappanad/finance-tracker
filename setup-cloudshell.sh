#!/bin/bash
# TrackStack — Google Cloud Shell setup script
# Run once: bash setup-cloudshell.sh
# Then: cd finance-tracker && aider

set -e

echo "=== Installing Node 22 ==="
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"
nvm install 22
nvm use 22
nvm alias default 22

echo ""
echo "=== Installing pnpm ==="
corepack enable
corepack prepare pnpm@latest --activate

echo ""
echo "=== Cloning repo ==="
if [ ! -d "$HOME/finance-tracker" ]; then
  git clone https://github.com/RishiBappanad/finance-tracker.git "$HOME/finance-tracker"
fi
cd "$HOME/finance-tracker"

echo ""
echo "=== Installing dependencies ==="
pnpm install

echo ""
echo "=== Installing Aider (AI coding assistant) ==="
pip install aider-chat --quiet

echo ""
echo "=== Setting up Gemini for Aider ==="
# Uses your Gemini API key for free AI coding
echo ""
echo "⚠️  Add your Gemini API key:"
echo "  export GEMINI_API_KEY=your_key_here"
echo ""
echo "Then run:"
echo "  cd ~/finance-tracker"
echo "  aider --model gemini/gemini-2.0-flash"
echo ""
echo "=== Setup complete! ==="
echo ""
echo "Quick commands:"
echo "  aider --model gemini/gemini-2.0-flash    # AI makes changes"
echo "  pnpm test                                 # Run tests"
echo "  pnpm run build                            # Build everything"
echo "  git push origin main                      # Deploy to Railway"

# Keeps Python, the package cache and model downloads inside this folder (all gitignored).
# Point CC_VOICE_MODELS at an existing Hugging Face cache to reuse models you already downloaded.
V="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$V/.python}" UV_CACHE_DIR="${UV_CACHE_DIR:-$V/.uv-cache}" UV_PROJECT_ENVIRONMENT="$V/.venv"
export HF_HOME="${CC_VOICE_MODELS:-$V/models}"

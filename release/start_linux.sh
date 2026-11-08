#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"

if [ "$(uname -s)" != Linux ]; then
  echo "Use start_linux.sh on Linux only." >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "Unsupported Linux architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [ ! -f .env ]; then
  cp .env.example .env
fi
# Read literal values, including empty values and files with Windows line endings.
cr=$(printf '\r')
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%"$cr"}
  case "$line" in ''|\#*) continue ;; esac
  key=${line%%=*}
  case "$line" in *=*) ;; *) echo "Invalid .env line: expected KEY=value" >&2; exit 1 ;; esac
  case "$key" in
    ''|[0-9]*|*[!a-zA-Z0-9_]*) echo "Invalid .env variable name" >&2; exit 1 ;;
  esac
  export "$key=${line#*=}"
done < .env

: "${STATIC_DIR:=./dist}"
export STATIC_DIR
server="./bin/server_linux_$arch"
if [ ! -f "$server" ] || [ ! -f "$STATIC_DIR/index.html" ]; then
  echo "Missing server binary or frontend assets. Extract the complete release archive." >&2
  exit 1
fi
chmod +x "$server"
exec "$server"

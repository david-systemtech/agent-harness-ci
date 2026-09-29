#!/bin/sh
# The agent-harness launcher entry. Written by "agent-harness service install";
# "agent-harness service uninstall" removes it. The service definition runs it,
# and it starts the launcher of the version the launcher version file names.
# With no such version it exits 0, which the service manager leaves stopped,
# rather than failing again every few seconds.
data_dir='/home/david/.local/state/agent-harness'
version=
[ -r "$data_dir/launcher-version" ] && IFS= read -r version < "$data_dir/launcher-version"
case $version in
  '' | .* | *[!0-9A-Za-z.+-]*)
    echo "launcher entry: $data_dir/launcher-version names no version, so no launcher starts; \`agent-harness service install\` writes it." >&2
    exit 0
    ;;
esac
dir="$data_dir/versions/$version"
if [ ! -f "$dir/.complete" ]; then
  echo "launcher entry: $version is not complete in $data_dir/versions, so no launcher starts; \`agent-harness service install\` puts a version there." >&2
  exit 0
fi
exec "$dir/node/bin/node" "$dir/packages/cli/dist/main.js" launch --data-dir "$data_dir" --port 7433 --name 'David'\''s desk'

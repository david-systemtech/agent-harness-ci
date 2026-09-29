#!/bin/sh
# The agent-harness launcher entry. Written by "agent-harness service install";
# "agent-harness service uninstall" removes it. The service definition runs it,
# and it starts the launcher of the version the launcher version file names.
# With no such version it exits 0, which the service manager leaves stopped,
# rather than failing again every few seconds. It counts the starts of a
# launcher handed over to until that launcher confirms, and after
# 3 unconfirmed starts names the launcher that handed over again.
data_dir='/home/david/.local/state/agent-harness'
version=
[ -r "$data_dir/launcher-version" ] && IFS= read -r version < "$data_dir/launcher-version"
case $version in
  '' | .* | *[!0-9A-Za-z.+-]*)
    echo "launcher entry: $data_dir/launcher-version names no version, so no launcher starts; \`agent-harness service install\` writes it." >&2
    exit 0
    ;;
esac
from=
to=
[ -r "$data_dir/launcher-handover" ] && { IFS= read -r from; IFS= read -r to; } < "$data_dir/launcher-handover"
case $from in
  '' | .* | *[!0-9A-Za-z.+-]*) from= ;;
esac
if [ -n "$from" ] && [ "$to" = "$version" ]; then
  starts=
  [ -r "$data_dir/launcher-handover-starts" ] && IFS= read -r starts < "$data_dir/launcher-handover-starts"
  case $starts in
    '' | *[!0-9]*) starts=0 ;;
  esac
  if [ "$starts" -ge 3 ]; then
    echo "launcher entry: the launcher of $to was started $starts times without confirming that its child passed the gate, so the launcher of $from starts again." >&2
    printf '%s\n' "$from" > "$data_dir/.launcher-version.tmp" && mv -f "$data_dir/.launcher-version.tmp" "$data_dir/launcher-version"
    version=$from
  else
    printf '%s\n' "$((starts + 1))" > "$data_dir/.launcher-handover-starts.tmp" && mv -f "$data_dir/.launcher-handover-starts.tmp" "$data_dir/launcher-handover-starts"
  fi
fi
dir="$data_dir/versions/$version"
if [ ! -f "$dir/.complete" ]; then
  echo "launcher entry: $version is not complete in $data_dir/versions, so no launcher starts; \`agent-harness service install\` puts a version there." >&2
  exit 0
fi
exec "$dir/node/bin/node" "$dir/packages/cli/dist/main.js" launch --data-dir "$data_dir" --port 7433 --name 'David'\''s desk'

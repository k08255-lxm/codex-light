import { isIP } from 'node:net';

const ed25519Header = Buffer.from('0000000b7373682d6564323535313900000020', 'hex');
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function buildRelaySetupScript({ hostname, publicKey, hostId, sshPort }) {
  const labels = typeof hostname === 'string' ? hostname.split('.') : [];
  if (labels.length < 2 || hostname.length > 253 || labels.some(label => !dnsLabel.test(label))
    || isIP(hostname) || !/[a-z]/.test(labels.at(-1))
    || /(?:^|\.)(?:localhost|local|internal|home\.arpa|trycloudflare\.com)$/.test(hostname)
    || new URL('https://' + hostname).hostname !== hostname) {
    throw new TypeError('请输入固定的公网 HTTPS 域名');
  }
  if (sshPort !== 49323 || typeof hostId !== 'string' || !/^[0-9a-f]{32}$/.test(hostId) || hostId.length !== 32) {
    throw new RangeError('主机标识或 SSH 端口无效');
  }
  const encoded = typeof publicKey === 'string' && publicKey.startsWith('ssh-ed25519 ') ? publicKey.slice(12) : '';
  const blob = Buffer.from(encoded, 'base64');
  if (blob.length !== 51 || blob.toString('base64') !== encoded || !blob.subarray(0, 19).equals(ed25519Header)) {
    throw new TypeError('需要无注释的 OpenSSH Ed25519 公钥');
  }
  return "bash -s -- '" + hostname + "' '" + publicKey + "' '" + hostId + "' <<'CODECANG_RELAY_SETUP'\n"
    + setupBody + '\nCODECANG_RELAY_SETUP\n';
}

// The here-document makes a single paste work even from a non-Bash login shell.
// Only the generated public key and validated DNS name cross into the shell.
const setupBody = String.raw`set -euo pipefail
export LC_ALL=C
umask 022
fail() { echo "CodeCang: $*" >&2; exit 1; }
host=$1
device_key=$2
id=$3
domain_re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
key_re='^ssh-ed25519 [A-Za-z0-9+/]{68}$'
[[ "$host" =~ $domain_re && $(expr length "$host") -le 253 ]] || fail '域名格式无效'
case "$host" in *.localhost|*.local|*.internal|home.arpa|*.home.arpa|trycloudflare.com|*.trycloudflare.com) fail '需要固定公网域名';; esac
[[ "$host" =~ \.[a-z0-9-]*[a-z][a-z0-9-]*$ && "$device_key" =~ $key_re && "$id" =~ ^[0-9a-f]{32}$ ]] || fail '域名、公钥或主机标识无效'
[[ $EUID == 0 && -d /run/systemd/system ]] || fail '请在运行 systemd 的 Debian/Ubuntu VPS 上以 root 执行'
. /etc/os-release
[[ "$ID" == debian || "$ID" == ubuntu ]] || fail '支持 Debian/Ubuntu'
base=/etc/codecang-relay
sshd=codecang-relay-sshd
web=codecang-relay-https
units=/etc/systemd/system
lock=/run/codecang-relay-setup.lock
if [[ -e "$lock" || -L "$lock" ]]; then
  [[ -f "$lock" && ! -L "$lock" && $(stat -c %u "$lock") == 0 ]] || fail '安装锁路径冲突'
fi
exec 9<>"$lock"
flock -x 9
manifest='CodeCang managed multi-host relay v1'
if [[ -e "$base" || -L "$base" ]]; then
  [[ -d "$base" && ! -L "$base" && $(stat -c '%u:%a' "$base") == 0:755 && -f "$base/owner" && ! -L "$base/owner" && "$(<"$base/owner")" == "$manifest" ]] ||
    fail '目录已占用，请先由管理员核对原部署'
fi
for service in "$sshd" "$web"; do
  unit="$units/$service.service"
  if [[ -e "$unit" || -L "$unit" || $(systemctl show -p LoadState --value "$service.service") != not-found ]]; then
    [[ -f "$base/owner" && -L "$unit" && $(readlink "$unit") == "$base/$service.service" ]] ||
      fail "已有同名 systemd 服务: $service"
  fi
  [[ -z $(systemctl show -p DropInPaths --value "$service.service") ]] || fail "已有同名服务覆盖配置: $service"
done
if getent passwd codecang-tunnel >/dev/null || getent group codecang-tunnel >/dev/null; then
  fail '宿主已有同名账号或组 codecang-tunnel，请核实后再部署'
fi
export DEBIAN_FRONTEND=noninteractive
if ! command -v ss >/dev/null; then
  apt-get update
  apt-get install -y --no-install-recommends iproute2
fi
check_port() {
  local number=$1 option=$2 output
  output=$(ss "$option" "sport = :$number") || fail '无法检查监听端口'
  [[ -z "$output" ]] || fail "端口 $number 已占用，请使用空闲 VPS 或原有隧道"
}
if ! systemctl is-active --quiet "$sshd"; then check_port 49323 -Hlnt; fi
if ! systemctl is-active --quiet "$web"; then check_port 80 -Hlnt; check_port 443 -Hlnt; check_port 443 -Hlnu; fi
if [[ ! -x /usr/bin/podman ]]; then
  apt-get update
  apt-get install -y --no-install-recommends podman
fi
if [[ ! -e "$base" ]]; then
  mkdir -m 0755 "$base"
  printf '%s\n' "$manifest" > "$base/owner"
fi
install -d -m 0755 "$base/build" "$base/ssh"
install -d -m 0755 "$base/devices" "$base/retired" "$base/http"
install -d -m 0700 "$base/caddy-data"
if [[ ! -f "$base/image" ]] || ! podman image exists "$(<"$base/image")"; then
  cat > "$base/build/Containerfile" <<'IMAGE'
FROM docker.io/library/debian:trixie-slim
RUN set -eu; printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d; chmod 755 /usr/sbin/policy-rc.d; apt-get update; apt-get install -y --no-install-recommends openssh-server caddy iproute2 ca-certificates; rm -f /etc/ssh/ssh_host_*; rm -rf /var/lib/apt/lists/*; useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin codecang-tunnel
IMAGE
  podman build --network=host --iidfile "$base/image.new" "$base/build"
  mv "$base/image.new" "$base/image"
fi
image=$(<"$base/image")
[[ "$image" =~ ^(sha256:)?[0-9a-f]{64}$ ]] || fail '容器镜像 ID 无效'
if [[ ! -f "$base/ssh/host_key" ]]; then
  [[ ! -f "$base/ssh/authorized_keys" ]] || fail '已有部署缺少 SSH 主机密钥，请恢复备份'
  podman run --rm --network=none -v "$base/ssh:/relay" "$image" ssh-keygen -q -t ed25519 -N '' -C '' -f /relay/host_key
fi
host_key=$(podman run --rm --network=none -v "$base/ssh:/relay:ro" "$image" ssh-keygen -y -f /relay/host_key)
[[ "$host_key" =~ $key_re ]] || fail 'VPS 主机公钥无效'
printf '%s\n' "$device_key" | podman run --rm -i --network=none "$image" ssh-keygen -lf - >/dev/null
printf '%s\n' "$host_key" > "$base/host.pub"
cat > "$base/ssh/sshd_config" <<'SSHD'
Port 49323
AddressFamily any
HostKey /relay/host_key
PidFile none
AllowUsers codecang-tunnel
UsePAM yes
AuthenticationMethods publickey
PubkeyAuthentication yes
AuthorizedKeysFile /relay/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
MaxSessions 0
PermitTTY no
PermitUserRC no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
AllowStreamLocalForwarding no
AllowTcpForwarding remote
PermitOpen none
PermitListen 127.0.0.1:*
GatewayPorts no
ClientAliveInterval 30
ClientAliveCountMax 3
SSHD
podman run --rm --network=none -v "$base/ssh:/relay:ro" "$image" sh -ec 'mkdir -p /run/sshd; exec /usr/sbin/sshd -t -f /relay/sshd_config'
cat > "$base/routes.sh" <<'ROUTES'
# Call under the deployment lock. Retired ports stay reserved, including for
# authenticated SSH connections which had not requested their first forward.
register_device() {
  local record number domain key listening
  local -A used=()
  for record in "$base/devices"/* "$base/retired"/*; do
    [[ -f "$record" ]] || continue
    { read -r domain; read -r key; read -r number; } < "$record"
    used[$number]=1
    if [[ "$record" == "$base/devices/$id" && "$domain" == "$host" && "$key" == "$device_key" ]]; then
      assigned=$number
      return
    fi
    if [[ $(basename "$record") == "$id" || "$domain" == "$host" || "$key" == "$device_key" ]]; then
      fail '主机标识、域名或公钥与已有或已撤销的注册冲突。请核对原部署。'
    fi
  done
  for ((number=49322; number<=49999; number++)); do
    [[ $number != 49323 && ! -v "used[$number]" ]] || continue
    listening=$(ss -Hlnt "sport = :$number") || fail '无法检查回源端口'
    [[ -z "$listening" ]] || continue
    assigned=$number
    printf '%s\n%s\n%s\n' "$host" "$device_key" "$number" > "$base/registration.new"
    mv "$base/registration.new" "$base/devices/$id"
    return
  done
  fail '没有可用的专属回源端口'
}
render_routes() {
  local stage=$1 generation record machine domain key port
  generation=$(basename "$stage")
  mkdir -p "$stage/sites" "$stage/metadata"
  printf '{\n    admin unix//run/codecang-caddy.sock\n}\nimport /relay/%s/sites/*.caddy\n' "$generation" > "$stage/Caddyfile"
  : > "$base/ssh/authorized_keys.new"
  for record in "$base/devices"/*; do
    [[ -f "$record" ]] || continue
    machine=$(basename "$record")
    { read -r domain; read -r key; read -r port; } < "$record"
    printf 'restrict,port-forwarding,permitlisten="127.0.0.1:%s" %s\n' "$port" "$key" >> "$base/ssh/authorized_keys.new"
    printf '{"hostId":"%s","relayPort":%s,"hostKey":"%s"}\n' "$machine" "$port" "$(<"$base/host.pub")" > "$stage/metadata/$machine.json"
    cat > "$stage/sites/$machine.caddy" <<SITE
$domain {
    handle /.well-known/codecang-relay {
        header Content-Type application/json
        header Cache-Control no-store
        rewrite * /$machine.json
        root * /relay/$generation/metadata
        file_server
    }
    handle {
        reverse_proxy 127.0.0.1:$port
    }
}
SITE
  done
}
publish_routes() {
  local stage generation old fingerprint record
  fingerprint=$({
    sha256sum "$base/host.pub" "$base/routes.sh"
    for record in "$base/devices"/*; do if [[ -f "$record" ]]; then sha256sum "$record"; fi; done
  } | sha256sum)
  if [[ -f "$base/published" && "$(<"$base/published")" == "$fingerprint" && -f "$base/http/Caddyfile" && -f "$base/ssh/authorized_keys" ]]; then return; fi
  stage=$(mktemp -d "$base/http/gen.XXXXXXXX")
  generation=$(basename "$stage")
  chmod 0755 "$stage"
  render_routes "$stage"
  podman run --rm --network=none -v "$base/http:/relay:ro" "$(<"$base/image")" caddy validate --config "/relay/$generation/Caddyfile" --adapter caddyfile
  if systemctl is-active --quiet codecang-relay-https; then
    podman exec "$(< /run/codecang-relay-https/container.cid)" caddy reload --config "/relay/$generation/Caddyfile" --adapter caddyfile --address unix//run/codecang-caddy.sock
  fi
  mv "$base/ssh/authorized_keys.new" "$base/ssh/authorized_keys"
  mv "$stage/Caddyfile" "$base/http/Caddyfile"
  printf '%s\n' "$fingerprint" > "$base/published.new"
  mv "$base/published.new" "$base/published"
  for old in "$base/http"/gen.*; do
    [[ -d "$old" && "$old" != "$stage" ]] || continue
    rm -rf -- "$old"
  done
}
ROUTES
cat > "$base/revoke" <<'REVOKE'
#!/bin/bash
set -euo pipefail
base=/etc/codecang-relay
[[ $EUID == 0 && $# == 1 && $1 =~ ^[0-9a-f]{32}$ ]] || { echo '用法: sudo /etc/codecang-relay/revoke <主机标识>' >&2; exit 1; }
exec 9<>/run/codecang-relay-setup.lock
flock -x 9
. "$base/routes.sh"
record="$base/retired/$1"
if [[ -f "$base/devices/$1" ]]; then mv "$base/devices/$1" "$record"; fi
[[ -f "$record" ]] || { echo '未注册该设备' >&2; exit 1; }
publish_routes
if systemctl is-active --quiet codecang-relay-sshd; then
  port=$(tail -n1 "$record")
  podman exec "$(< /run/codecang-relay-sshd/container.cid)" sh -ec '
    sockets=$(ss -Htanp "sport = :$1") || exit 1
    for pid in $(printf "%s\n" "$sockets" | grep -oE "pid=[0-9]+" | cut -d= -f2 | sort -u); do
      [ "$pid" -gt 1 ] || continue
      case $(cat "/proc/$pid/comm" 2>/dev/null) in sshd|sshd-session) kill -TERM "$pid" || true;; esac
    done' sh "$port"
fi
echo '该主机的站点和授权已移除。该端口保留停用，其他设备继续使用各自的站点。'
REVOKE
chmod 0755 "$base/revoke"
write_unit() {
  local name=$1 arguments=$2
  cat > "$base/$name.service" <<UNIT
[Unit]
Description=CodeCang dedicated relay ($name)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
RuntimeDirectory=$name
ExecStartPre=-/usr/bin/rm -f /run/$name/container.cid
ExecStart=/usr/bin/podman run --cidfile /run/$name/container.cid --rm --network=host $arguments
Restart=on-failure
RestartSec=3
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT
  [[ -L "$units/$name.service" ]] || ln -s "$base/$name.service" "$units/$name.service"
}
write_unit "$sshd" "-v $base/ssh:/relay:ro $image sh -ec 'mkdir -p /run/sshd; exec /usr/sbin/sshd -D -e -f /relay/sshd_config'"
write_unit "$web" "--read-only --cap-drop=all --cap-add=NET_BIND_SERVICE --security-opt=no-new-privileges -e XDG_DATA_HOME=/data -e XDG_CONFIG_HOME=/data/config -v $base/caddy-data:/data -v $base/http:/relay:ro $image caddy run --config /relay/Caddyfile --adapter caddyfile"
systemctl daemon-reload
. "$base/routes.sh"
register_device
publish_routes
systemctl enable --now "$sshd.service" "$web.service"
ready=false
for ((attempt=0; attempt<40; attempt++)); do
  if [[ -s "/run/$web/container.cid" && -s "/run/$sshd/container.cid" ]] &&
      [[ -n $(ss -Hlnt 'sport = :49323') && -n $(ss -Hlnt 'sport = :443') ]] &&
      podman exec "$(<"/run/$web/container.cid")" test -S /run/codecang-caddy.sock; then
    ready=true
    break
  fi
  sleep .5
done
[[ "$ready" == true ]] || fail '服务尚未监听，请用 journalctl -u codecang-relay-sshd -u codecang-relay-https 检查'
echo "已配置独立服务。将 $host 的 A/AAAA 指向此 VPS，放行 TCP 80、443、49323。"
echo "本机 $id 的回源端口为 $assigned。撤销此设备：sudo /etc/codecang-relay/revoke $id"
echo "证书签发完成后，请在码舱连接。日志：journalctl -u codecang-relay-sshd -u codecang-relay-https"`;

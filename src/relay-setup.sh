#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
umask 022
fail() { echo "CodeCang: $*" >&2; exit 1; }
host=$1
device_key=$2
id=$3
port_request=${4:-443}
valid_port() { [[ "$1" =~ ^[1-9][0-9]{0,4}$ && "$1" -le 65535 ]]; }
[[ "$port_request" == auto ]] || valid_port "$port_request" || fail '公网端口必须为 auto 或 1 至 65535'
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
  [[ -z "$output" ]] || fail "中继需要的端口 $number 已由其他服务监听，请核对端口用途"
}
choose_entry() {
  local listeners result number
  entry=direct
  if [[ -f "$base/web-entry" ]]; then
    entry=$(<"$base/web-entry")
    [[ "$entry" == direct || ( "$entry" =~ ^[1-9][0-9]{4}$ && "$entry" -ge 49152 && "$entry" -le 49319 ) ]] || fail '已有入口配置无效，请核对 web-entry'
    return
  fi
  # Keep an assigned port or an already-running service, including older v1 installations.
  if [[ "$entry" != direct ]] || systemctl is-active --quiet "$web"; then return 0; fi
  listeners=$(ss -Hlnt '( sport = :80 or sport = :443 )') || fail '无法检查 HTTP/HTTPS 监听'
  result=$(ss -Hlnu 'sport = :443') || fail '无法检查 UDP 443 监听'
  if [[ -n "$listeners$result" ]] || command -v caddy >/dev/null || command -v nginx >/dev/null || systemctl is-active --quiet caddy || systemctl is-active --quiet nginx; then
    entry=''
    for ((number=49152;number<=49319;number++)); do
      result=$(ss -Hlnt "sport = :$number") || fail '无法检查本机代理端口'
      if [[ -z "$result" ]]; then entry=$number; break; fi
    done
    [[ -n "$entry" ]] || fail '没有空闲的本机代理端口'
  fi
}
choose_entry
unused_port() {
  local candidate attempt start sockets record
  local -A reserved=()
  for record in "$base/public-ports"/*; do
    [[ -f "$record" ]] || continue
    read -r candidate _ < "$record"
    reserved[$candidate]=1
  done
  start=$((RANDOM % 10000))
  for ((attempt=0;attempt<10000;attempt++)); do
    candidate=$((20000 + (start + attempt) % 10000))
    [[ "$candidate" != "${ssh_port:-}" && ! -v "reserved[$candidate]" ]] || continue
    sockets=$(ss -Hlnut "sport = :$candidate") || fail '无法检查空闲端口'
    if [[ -z "$sockets" ]]; then printf '%s\n' "$candidate"; return; fi
  done
  fail '没有可用的随机公网端口'
}
# Existing v1 servers already have clients using their SSH port.
ssh_port=49323
if [[ -f "$base/ssh-port" ]]; then
  ssh_port=$(<"$base/ssh-port")
  valid_port "$ssh_port" || fail '已保存的 SSH 端口无效'
elif [[ "$port_request" == auto && ! -f "$base/ssh/sshd_config" ]]; then
  ssh_port=$(unused_port)
fi
if ! systemctl is-active --quiet "$sshd"; then check_port "$ssh_port" -Hlnt; fi
public_port=$port_request
keep_standard=no
port_record="$base/public-ports/$id"
if [[ -f "$port_record" ]]; then
  read -r public_port keep_standard < "$port_record"
  valid_port "$public_port" && [[ "$keep_standard" == yes || "$keep_standard" == no ]] || fail '已有公网端口记录无效'
  [[ "$port_request" == auto || "$port_request" == 443 || "$port_request" == "$public_port" ]] || fail "该设备已分配 HTTPS 端口 $public_port"
else
  if [[ "$port_request" == auto ]]; then public_port=$(unused_port); fi
  if [[ -f "$base/devices/$id" ]]; then keep_standard=yes; fi
fi
[[ "$public_port" != "$ssh_port" ]] || fail '公网 HTTPS 和 SSH 需要两个不同的端口'
[[ "$entry" != direct || "$public_port" != 80 ]] || fail '独立入口需要 TCP 80 验证证书，请选择其他 HTTPS 端口'
if [[ "$public_port" != 443 ]]; then
  # The loopback proxy and per-device reverse forwards use these ranges.
  [[ "$public_port" -lt 49152 || "$public_port" -gt 49999 ]] || fail '该端口在中继内部端口范围内，请选用其他公网端口'
  for record in "$base/public-ports"/*; do
    [[ -f "$record" && "$record" != "$port_record" ]] || continue
    read -r other_port _ < "$record"
    [[ "$other_port" != "$public_port" ]] || fail '该端口已分配给另一台电脑'
  done
  listeners=$(ss -Hlnut "sport = :$public_port") || fail '无法检查公网端口'
  if [[ -n "$listeners" ]]; then
    [[ -f "$port_record" ]] || fail "公网端口 $public_port 已被占用"
    # A saved allocation can be live. Verify its identity before accepting it.
    generation=$(sed -n 's|^import /relay/\(gen\.[[:alnum:]]\+\)/sites/\*\.caddy$|\1|p' "$base/http/Caddyfile")
    expected="$base/http/$generation/metadata/$id.json"
    [[ -n "$generation" && -s "$expected" ]] || fail "无法核对端口 $public_port 原有注册，请检查部署"
    existing=$(curl --noproxy '*' --max-time 4 --max-filesize 1024 -fsS --resolve "$host:$public_port:127.0.0.1" "https://$host:$public_port/.well-known/codecang-relay") ||
      fail "已分配的端口 $public_port 正在使用，无法核实为本机的 HTTPS 中继"
    [[ "$existing" == "$(<"$expected")" ]] || fail "端口 $public_port 正由其他站点使用"
  fi
fi
if ! systemctl is-active --quiet "$web"; then
  if [[ "$entry" == direct ]]; then
    check_port 80 -Hlnt
    if [[ "$public_port" == 443 || "$keep_standard" == yes ]]; then check_port 443 -Hlnt; check_port 443 -Hlnu; fi
  else check_port "$entry" -Hlnt; fi
fi
if [[ ! -x /usr/bin/podman ]]; then
  apt-get update
  apt-get install -y --no-install-recommends podman
fi
if [[ ! -e "$base" ]]; then
  mkdir -m 0755 "$base"
  printf '%s\n' "$manifest" > "$base/owner"
fi
printf '%s\n' "$entry" > "$base/web-entry.new"
mv "$base/web-entry.new" "$base/web-entry"
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
printf '%s\n' "$ssh_port" > "$base/ssh-port.new"
mv "$base/ssh-port.new" "$base/ssh-port"
cat > "$base/ssh/sshd_config" <<SSHD
Port $ssh_port
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
  local stage=$1 generation record machine domain key port entry=direct site bind='' public keep extra ssh=49323
  if [[ -f "$base/ssh-port" ]]; then ssh=$(<"$base/ssh-port"); fi
  if [[ -f "$base/web-entry" ]]; then entry=$(<"$base/web-entry"); fi
  generation=$(basename "$stage")
  mkdir -p "$stage/sites" "$stage/metadata"
  {
    printf '{\n    admin unix//run/codecang-caddy.sock\n'
    if [[ "$entry" != direct ]]; then printf '    auto_https off\n'; fi
    printf '}\nimport /relay/%s/sites/*.caddy\n' "$generation"
    if [[ "$entry" != direct ]]; then
      printf 'http://:%s {\n    bind 127.0.0.1\n    respond 404\n}\n' "$entry"
    fi
  } > "$stage/Caddyfile"
  : > "$base/ssh/authorized_keys.new"
  for record in "$base/devices"/*; do
    [[ -f "$record" ]] || continue
    machine=$(basename "$record")
    { read -r domain; read -r key; read -r port; } < "$record"
    printf 'restrict,port-forwarding,permitlisten="127.0.0.1:%s" %s\n' "$port" "$key" >> "$base/ssh/authorized_keys.new"
    extra=''
    if [[ "$ssh" != 49323 ]]; then extra=",\"sshPort\":$ssh"; fi
    printf '{"hostId":"%s","relayPort":%s,"hostKey":"%s"%s}\n' "$machine" "$port" "$(<"$base/host.pub")" "$extra" > "$stage/metadata/$machine.json"
    site=$domain
    bind=''
    if [[ "$entry" != direct ]]; then
      site="http://$domain:$entry"; bind='    bind 127.0.0.1'
    elif [[ -f "$base/public-ports/$machine" ]]; then
      read -r public keep < "$base/public-ports/$machine"
      site="https://$domain:$public"
      if [[ "$keep" == yes ]]; then site="$domain, $site"; fi
      bind=$'    tls {\n        issuer acme {\n            disable_tlsalpn_challenge\n        }\n    }'
    fi
    cat > "$stage/sites/$machine.caddy" <<SITE
$site {
$bind
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
write_frontend_examples() {
  local examples="$base/frontends" port=$1 public=${2:-443} name=$host site=$host
  if [[ "$public" != 443 ]]; then name="$host-$public"; site="https://$host:$public"; fi
  install -d -m 0755 "$examples"
  cat > "$examples/$name.caddy.new" <<CADDY
$site {
    reverse_proxy 127.0.0.1:$port {
        flush_interval -1
    }
}
CADDY
  # The host administrator owns the TLS certificate and server block.
  cat > "$examples/$name.nginx.conf.new" <<NGINX
location / {
    proxy_pass http://127.0.0.1:$port;
    proxy_http_version 1.1;
    proxy_set_header Host \$http_host;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1h;
}
NGINX
  mv "$examples/$name.caddy.new" "$examples/$name.caddy"
  mv "$examples/$name.nginx.conf.new" "$examples/$name.nginx.conf"
}
publish_routes() {
  local stage generation old fingerprint record
  fingerprint=$({
    sha256sum "$base/host.pub" "$base/routes.sh" "$base/web-entry" "$base/ssh-port"
    for record in "$base/public-ports"/*; do if [[ -f "$record" ]]; then sha256sum "$record"; fi; done
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
if [[ "$public_port" != 443 && ! -f "$port_record" ]]; then
  install -d -m 0755 "$base/public-ports"
  printf '%s %s\n' "$public_port" "$keep_standard" > "$port_record.new"
  mv "$port_record.new" "$port_record"
fi
publish_routes
systemctl enable --now "$sshd.service" "$web.service"
ready=false
web_port=$entry
if [[ "$entry" == direct ]]; then web_port=$public_port; fi
for ((attempt=0; attempt<40; attempt++)); do
  if [[ -s "/run/$web/container.cid" && -s "/run/$sshd/container.cid" ]] &&
      [[ -n $(ss -Hlnt "sport = :$ssh_port") && -n $(ss -Hlnt "sport = :$web_port") ]] &&
      podman exec "$(<"/run/$web/container.cid")" test -S /run/codecang-caddy.sock; then
    ready=true
    break
  fi
  sleep .5
done
[[ "$ready" == true ]] || fail '服务尚未监听，请用 journalctl -u codecang-relay-sshd -u codecang-relay-https 检查'
if [[ "$entry" == direct ]]; then
  echo "已启动独立入口。将 $host 的 A/AAAA 指向此 VPS，放行 TCP 80（证书验证）、$public_port（HTTPS）、$ssh_port（SSH）。"
else
  write_frontend_examples "$entry" "$public_port"
  name=$host
  if [[ "$public_port" != 443 ]]; then name="$host-$public_port"; fi
  echo "VPS 本机中继已监听 127.0.0.1:$entry。请放行 TCP $public_port（HTTPS）、$ssh_port（SSH），再接入对外 HTTPS 服务。"
  echo "Caddy：在已有 Caddyfile 顶层添加 import $base/frontends/$name.caddy"
  echo "Nginx：在监听 $public_port 且配置了 $host 有效证书的 HTTPS server 块添加 include $base/frontends/$name.nginx.conf;"
  if [[ "$public_port" != 443 ]]; then echo "为端口 $public_port 单独配置 HTTPS 站点，原有 443 站点继续使用原配置。"; fi
  echo '核对配置后，只重载对外提供 HTTPS 的服务。'
fi
echo "本机 $id 的回源端口为 $assigned。撤销此设备：sudo /etc/codecang-relay/revoke $id"
origin="https://$host"
if [[ "$public_port" != 443 ]]; then origin="$origin:$public_port"; fi
echo "桌面公网地址：$origin"
echo "HTTPS 配置完成后，在码舱填写上述地址并连接。可核对 $origin/.well-known/codecang-relay 是否返回本机的 JSON 配置。"
echo "日志：journalctl --no-pager -l -n 50 -u codecang-relay-sshd -u codecang-relay-https"

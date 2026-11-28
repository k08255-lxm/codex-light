#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
umask 022
fail() { echo "CodeCang: $*" >&2; exit 1; }
base=/etc/codecang-relay
if [[ ${1:-} == --repair ]]; then
  if [[ $# == 1 ]]; then
    records=("$base"/devices/*)
    [[ ${#records[@]} == 1 && -f "${records[0]}" ]] || fail '请使用 --repair 电脑ID 指定一台已注册的电脑'
    id=${records[0]##*/}
  elif [[ $# == 2 ]]; then id=$2
  else fail '用法：--repair [电脑ID]'; fi
  [[ "$id" =~ ^[0-9a-f]{32}$ && -f "$base/devices/$id" ]] || fail '找不到该电脑的有效注册'
  { read -r host; read -r device_key; } < "$base/devices/$id"
  set -- "$host" "$device_key" "$id" prefer-443
fi
host=$1
device_key=$2
id=$3
port_request=${4:-443}
valid_port() { [[ "$1" =~ ^[1-9][0-9]{0,4}$ && "$1" -le 65535 ]]; }
[[ "$port_request" == auto || "$port_request" == prefer-443 ]] || valid_port "$port_request" || fail '无效的公网端口选项'
domain_re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
key_re='^ssh-ed25519 [A-Za-z0-9+/]{68}$'
[[ "$host" =~ $domain_re && $(expr length "$host") -le 253 ]] || fail '域名格式无效'
case "$host" in *.localhost|*.local|*.internal|home.arpa|*.home.arpa|trycloudflare.com|*.trycloudflare.com) fail '需要固定公网域名';; esac
[[ "$host" =~ \.[a-z0-9-]*[a-z][a-z0-9-]*$ && "$device_key" =~ $key_re && "$id" =~ ^[0-9a-f]{32}$ ]] || fail '域名、公钥或主机标识无效'
[[ $EUID == 0 && -d /run/systemd/system ]] || fail '请在运行 systemd 的 Debian/Ubuntu VPS 上以 root 执行'
. /etc/os-release
[[ "$ID" == debian || "$ID" == ubuntu ]] || fail '支持 Debian/Ubuntu'
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
if ! command -v curl >/dev/null; then
  apt-get update
  apt-get install -y --no-install-recommends curl ca-certificates
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
if [[ "$port_request" == prefer-443 ]]; then
  port_request=443
  if [[ "$entry" != direct && ! -f "$base/public-ports/$id" ]]; then
    listeners=$(ss -Hlnt 'sport = :443') || fail '无法检查现有 HTTPS 服务'
    if [[ -n "$listeners" ]]; then
      generation=''
      if [[ -f "$base/http/Caddyfile" ]]; then
        generation=$(sed -n 's|^import /relay/\(gen\.[[:alnum:]]\+\)/sites/\*\.caddy$|\1|p' "$base/http/Caddyfile")
      fi
      expected="$base/http/$generation/metadata/$id.json"
      matches=false
      if [[ -n "$generation" && -s "$expected" ]]; then
        for mode in loopback dns; do
          resolve=()
          if [[ "$mode" == loopback ]]; then resolve=(--resolve "$host:443:127.0.0.1"); fi
          if actual=$(curl --noproxy '*' --max-time 4 --max-filesize 1024 -fs "${resolve[@]}" "https://$host/.well-known/codecang-relay") &&
             [[ "$actual" == "$(<"$expected")" ]]; then matches=true; break; fi
        done
      fi
      if [[ "$matches" == false ]]; then
        echo '443 已有 HTTPS 服务，正在为码舱选择独立空闲端口。'
        port_request=auto
      fi
    fi
  fi
fi
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
if [[ "$entry" != direct ]]; then
  if ! command -v python3 >/dev/null || ! command -v openssl >/dev/null; then
    apt-get update
    apt-get install -y --no-install-recommends python3 openssl
  fi
  cat > "$base/frontend.py.new" <<'FRONTEND'
"""Connect one dedicated TLS port to the relay through the host's existing web server."""
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import shutil
import signal
import ssl
import subprocess
import sys
import tempfile
import time

base = Path(__file__).resolve().parent
frontends = base / "frontends"


def run(*args, capture=False):
    return subprocess.run(args, stdin=subprocess.DEVNULL, check=True, text=True,
                          stdout=subprocess.PIPE if capture else subprocess.DEVNULL)


def write_file(path, data, original=None):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
        staged = Path(tmp.name)
    try:
        if original:
            run("cp", "--preserve=all", "--", original, staged)
        staged.write_bytes(data)
        if not original:
            staged.chmod(0o644)
        os.replace(staged, path)
    finally:
        staged.unlink(missing_ok=True)


def probe(host, port, expected, attempts, loopback=True):
    resolve = ["--resolve", f"{host}:{port}:127.0.0.1"] if loopback else []
    for attempt in range(attempts):
        reply = subprocess.run(["curl", "--noproxy", "*", "--max-time", "3", "--max-filesize", "1024",
                                *resolve, "-fs", f"https://{host}:{port}/.well-known/codecang-relay"], stdout=subprocess.PIPE)
        if reply.returncode == 0 and reply.stdout.strip() == expected.strip():
            return True
        if attempt + 1 < attempts:
            time.sleep(0.5)
    return False


def certificate_pair(host, dump):
    lineage = Path("/etc/letsencrypt/live") / host
    pairs = [(str(lineage / "fullchain.pem"), str(lineage / "privkey.pem"))]
    # nginx -T lists files separately. Confirm the hostname, chain and matching
    # private key before referring to any configured pair in the new server.
    for section in re.split(r"(?m)^# configuration file .+:$", dump):
        def paths(directive):
            return re.findall(r'(?:^|[;{}])\s*' + directive + r'\s+"?(/[\w./@+ ~-]+?)"?\s*;', section, re.M)
        pairs.extend(zip(paths("ssl_certificate"), paths("ssl_certificate_key")))
    for cert, key in dict.fromkeys(pairs):
        if not Path(cert).is_file() or not Path(key).is_file():
            continue
        verified = subprocess.run(["openssl", "verify", "-purpose", "sslserver", "-verify_hostname", host,
                                   "-untrusted", cert, cert], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if verified.returncode:
            continue
        try:
            ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER).load_cert_chain(cert, key, password=lambda: b"")
            return cert, key
        except (ssl.SSLError, OSError):
            continue
    raise ValueError("Nginx 未找到覆盖该域名的有效证书和匹配的密钥")


def nginx_instance(owner):
    for value in set(re.findall(r'"nginx",pid=(\d+)', owner)):
        process = Path("/proc") / value
        try:
            title = (process / "cmdline").read_bytes().rstrip(b"\0").replace(b"\0", b" ").decode()
        except FileNotFoundError:
            continue
        if not title.startswith("nginx: master process ") or not (process / "root").samefile("/"):
            continue
        uid = re.search(r"(?m)^Uid:\s+\d+\s+(\d+)", (process / "status").read_text())
        if not uid or uid[1] != "0":
            continue
        command = [os.readlink(process / "exe")]
        args = shlex.split(title[len("nginx: master process "):])
        for flag in ("-p", "-c"):
            if flag in args:
                option = args[args.index(flag)+1]
                if not Path(option).is_absolute():
                    raise ValueError("Nginx 使用相对启动路径，无法安全确定当前配置")
                command.extend([flag, option])
        if "-g" in args and not re.fullmatch(r"(?:(?:daemon|master_process) (?:on|off);\s*)+",
                                              " ".join(args[args.index("-g")+1:])):
            raise ValueError("Nginx 使用自定义全局启动指令，请使用生成的接入文件")
        return command, int(value)
    raise ValueError("未找到宿主机上负责此入口的 Nginx 主进程")


def install_nginx(host, port, device, expected, owner):
    command, pid = nginx_instance(owner)
    dump = run(*command, "-T", capture=True).stdout
    cert, key = certificate_pair(host, dump)
    includes = re.findall(r'(?:^|[;{}])\s*include\s+"?(/[^"$;*]+/\*(?:\.conf)?)"?\s*;', dump, re.M)
    dirs = [Path(p).parent for p in includes if Path(p).parent.name in ("conf.d", "sites-enabled")]
    if not dirs:
        raise ValueError("Nginx 配置中未找到已加载的 conf.d 或 sites-enabled 站点目录")
    directory = next((d for d in dirs if d.name == "conf.d"), dirs[0])
    link = directory / f"codecang-relay-{device}.conf"
    source = frontends / f"{device}.nginx-site"
    record = frontends / f"{device}.nginx-link"
    if os.path.lexists(link) and not (link.is_symlink() and os.readlink(link) == str(source)):
        raise ValueError(f"已有其他配置占用 {link}")
    original = source.read_bytes() if source.exists() else None
    had_link = link.is_symlink()
    lines = [f"    listen {port} ssl;"]
    if Path("/proc/net/if_inet6").exists():
        lines.append(f"    listen [::]:{port} ssl;")
    name = host if port == "443" else f"{host}-{port}"
    lines.extend([f"    server_name {host};", f'    ssl_certificate "{cert}";',
                  f'    ssl_certificate_key "{key}";', f'    include "{frontends}/{name}.nginx.conf";'])
    reloading = False
    try:
        write_file(source, ("server {\n" + "\n".join(lines) + "\n}\n").encode())
        if not had_link:
            link.symlink_to(source)
        checked = run(*command, "-T", capture=True).stdout
        if f"# configuration file {link}:" not in checked.splitlines():
            raise ValueError("运行中的 Nginx 配置没有加载新增站点")
        write_file(record, str(link).encode())
        reloading = True
        os.kill(pid, signal.SIGHUP)
        if not probe(host, port, expected, 12):
            raise ValueError("重载后 HTTPS 没有返回这台电脑的中继配置")
    except BaseException:
        if not had_link and link.is_symlink() and os.readlink(link) == str(source):
            link.unlink()
        if original is not None:
            write_file(source, original)
        if not had_link:
            record.unlink(missing_ok=True)
        if reloading:
            run(*command, "-t")
            os.kill(pid, signal.SIGHUP)
        raise


def install_caddy(host, port, device, expected):
    pid = run("systemctl", "show", "--value", "-p", "MainPID", "caddy", capture=True).stdout.strip()
    proc = Path(f"/proc/{int(pid)}")
    args = (proc / "cmdline").read_bytes().decode().split("\0")
    if "--config" not in args or "--resume" in args:
        raise ValueError("Caddy 服务没有使用可识别的 Caddyfile")
    main = Path(args[args.index("--config")+1])
    if not main.is_absolute() or main.is_symlink() or not main.is_file() or not (proc / "root").samefile("/"):
        raise ValueError("请使用独立的常规 Caddyfile 接入该端口")
    for path in (main, *main.parents):
        info = path.stat()
        if info.st_uid != 0 or (info.st_mode & 0o022 and not info.st_mode & 0o1000):
            raise ValueError("Caddyfile 或其目录可由其他用户修改，请使用生成的接入配置")
    uid = int(re.search(r"(?m)^Uid:\s+\d+\s+(\d+)", (proc / "status").read_text())[1])
    caddy_cli = ["caddy"] if uid == 0 else ["runuser", "-u", pwd.getpwuid(uid).pw_name, "--", "caddy"]
    original = main.read_bytes()
    adapted = json.loads(run(*caddy_cli, "adapt", "--config", main, "--adapter", "caddyfile", capture=True).stdout)
    admin = adapted.get("admin", {}).get("listen", "localhost:2019")
    if not re.fullmatch(r"(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]+", admin):
        raise ValueError("Caddy 管理地址不支持自动核对当前配置")
    live = json.loads(run("curl", "--noproxy", "*", "-fsS", "--max-time", "3",
                          f"http://{admin}/config/", capture=True).stdout)
    if live != adapted:
        raise ValueError("Caddy 正在使用的配置与磁盘文件不同")
    enabled = frontends / "caddy-enabled"
    enabled.mkdir(exist_ok=True)
    link = enabled / f"{device}.caddy"
    name = host if port == "443" else f"{host}-{port}"
    source = frontends / f"{name}.caddy"
    if os.path.lexists(link) and not (link.is_symlink() and os.readlink(link) == str(source)):
        raise ValueError(f"已有其他配置占用 {link}")
    directive = f"import {enabled}/*.caddy".encode()
    updated = original if directive in original.splitlines() else original.rstrip(b"\n") + b"\n" + directive + b"\n"
    had_link = link.is_symlink()
    changed_main = False
    try:
        if not had_link:
            link.symlink_to(source)
        if main.read_bytes() != original:
            raise ValueError("Caddyfile 已被其他进程更改")
        if updated != original:
            write_file(main, updated, main)
            changed_main = True
        run(*caddy_cli, "validate", "--config", main, "--adapter", "caddyfile")
        run("systemctl", "reload", "caddy")
    except BaseException:
        if not had_link and link.is_symlink() and os.readlink(link) == str(source):
            link.unlink()
        if changed_main and main.read_bytes() == updated:
            write_file(main, original, main)
        raise
    if not probe(host, port, expected, 12):
        print("Caddy 已加载站点，HTTPS 尚未验证。请核对 DNS、证书签发和 journalctl -u caddy 的日志后重试。", file=sys.stderr)
        sys.exit(3)


def remove_frontend(host, port, device):
    record = frontends / f"{device}.nginx-link"
    if record.exists():
        link = Path(record.read_text())
        if link.is_symlink() and os.readlink(link) == str(frontends / f"{device}.nginx-site"):
            link.unlink()
        owner = run("ss", "-Hlnpt", f"sport = :{port}", capture=True).stdout
        if '"nginx"' in owner:
            command, pid = nginx_instance(owner)
            run(*command, "-t")
            os.kill(pid, signal.SIGHUP)
        record.unlink()
    link = frontends / "caddy-enabled" / f"{device}.caddy"
    name = host if port == "443" else f"{host}-{port}"
    if link.is_symlink() and os.readlink(link) == str(frontends / f"{name}.caddy"):
        link.unlink()
        try:
            run("systemctl", "reload", "caddy")
        except BaseException:
            link.symlink_to(frontends / f"{name}.caddy")
            raise


def main():
    action, host, port, device = sys.argv[1:]
    if action == "remove":
        remove_frontend(host, port, device)
        return
    root = (base / "http/Caddyfile").read_text()
    generation = re.search(r"(?m)^import /relay/(gen\.[A-Za-z0-9]+)/sites/\*\.caddy$", root)
    if not generation:
        raise ValueError("找不到已发布的中继配置")
    expected = (base / "http" / generation[1] / "metadata" / f"{device}.json").read_bytes()
    if probe(host, port, expected, 1) or probe(host, port, expected, 1, loopback=False):
        return
    owner = run("ss", "-Hlnpt", "sport = :443", capture=True).stdout
    if port == "443" and owner.strip():
        raise ValueError("此服务器由已有站点提供 HTTPS；选择分配空闲公网端口可单独配置入口")
    if not owner.strip():
        owner = run("ss", "-Hlnpt", "sport = :80", capture=True).stdout
    if '"nginx"' in owner:
        install_nginx(host, port, device, expected, owner)
    elif '"caddy"' in owner and shutil.which("caddy"):
        install_caddy(host, port, device, expected)
    else:
        raise ValueError("无法识别宿主机上负责 HTTPS 的 Nginx 或 Caddy")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        sys.exit(f"CodeCang HTTPS：{error}")
FRONTEND
  mv "$base/frontend.py.new" "$base/frontend.py"
fi
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
if [[ -f "$base/frontend.py" ]]; then
  read -r domain < "$record"
  public=443
  if [[ -f "$base/public-ports/$1" ]]; then read -r public _ < "$base/public-ports/$1"; fi
  python3 -I "$base/frontend.py" remove "$domain" "$public" "$1"
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
origin="https://$host"
if [[ "$public_port" != 443 ]]; then origin="$origin:$public_port"; fi
echo "请放行 TCP $public_port（HTTPS）、$ssh_port（SSH）。"
echo "桌面公网地址：$origin"
echo "本机 $id 的回源端口为 $assigned。撤销此设备：sudo /etc/codecang-relay/revoke $id"
if [[ "$entry" == direct ]]; then
  echo "已启动独立入口。将 $host 的 A/AAAA 指向此 VPS，并放行证书验证端口 TCP 80。"
  generation=$(sed -n 's|^import /relay/\(gen\.[[:alnum:]]\+\)/sites/\*\.caddy$|\1|p' "$base/http/Caddyfile")
  [[ -n "$generation" && -s "$base/http/$generation/metadata/$id.json" ]] || fail '找不到本机中继配置'
  expected=$(<"$base/http/$generation/metadata/$id.json")
  verified=false
  for ((attempt=0; attempt<10; attempt++)); do
    if actual=$(curl --noproxy '*' --max-time 3 --max-filesize 1024 -fs --resolve "$host:$public_port:127.0.0.1" "$origin/.well-known/codecang-relay") &&
       [[ "$actual" == "$expected" ]]; then verified=true; break; fi
    sleep 1
  done
  [[ "$verified" == true ]] || fail "HTTPS 尚未通过本机验证。请检查 DNS、TCP 80 和证书签发日志：journalctl -u $web --no-pager -n 50。修正后可重跑命令。"
else
  write_frontend_examples "$entry" "$public_port"
  frontend_status=0
  python3 -I "$base/frontend.py" install "$host" "$public_port" "$id" || frontend_status=$?
  if [[ "$frontend_status" == 3 ]]; then exit 3; fi
  if [[ "$frontend_status" != 0 ]]; then
    name=$host
    if [[ "$public_port" != 443 ]]; then name="$host-$public_port"; fi
    echo "内部中继已监听 127.0.0.1:$entry，HTTPS 入口尚未验证。手动接入文件如下："
    echo "Caddy：import $base/frontends/$name.caddy"
    echo "Nginx：在监听 $public_port 且配置了 $host 有效证书的 HTTPS server 块添加 include $base/frontends/$name.nginx.conf;"
    fail '请根据上面的接入结果处理后重新执行安装命令。'
  fi
fi
echo "已在 VPS 本机验证 $origin 的证书和本机中继配置。现在可以在码舱填写该地址并连接。"
echo "日志：journalctl --no-pager -l -n 50 -u codecang-relay-sshd -u codecang-relay-https"

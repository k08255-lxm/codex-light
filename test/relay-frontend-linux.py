"""Exercise generated frontend setup with real TLS listeners on isolated Linux ports."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import socket
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument("--nginx", required=True, type=Path)
parser.add_argument("--caddy", required=True, type=Path)
args = parser.parse_args()
nginx, caddy = args.nginx.resolve(), args.caddy.resolve()
script = (Path(__file__).resolve().parents[1] / "src/relay-setup.sh").read_text()
helper = script.split('<<\'FRONTEND\'\n', 1)[1].split('\nFRONTEND\n', 1)[0]
routes = script.split('<<\'ROUTES\'\n', 1)[1].split('\nROUTES\n', 1)[0]
host, device = "relay.example.test", "b" * 32


def exercise(provider):
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        for folder in ["frontends", "conf.d", "sites-enabled", "bin", "logs", "http/gen.test/metadata"]:
            (base / folder).mkdir(parents=True)
        (base / "frontend.py").write_text(helper)
        (base / "routes.sh").write_text(routes)
        metadata = json.dumps({"hostId": device, "relayPort": 49322, "hostKey": "fixture"})
        (base / "http/Caddyfile").write_text("import /relay/gen.test/sites/*.caddy\n")
        (base / f"http/gen.test/metadata/{device}.json").write_text(metadata)
        sockets = [socket.socket() for _ in range(4)]
        for sock in sockets:
            sock.bind(("127.0.0.1", 0))
        old, public, inner, admin = [s.getsockname()[1] for s in sockets]
        for sock in sockets:
            sock.close()
        cert, key = base / "cert.pem", base / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-subj", f"/CN={host}", "-addext", f"subjectAltName=DNS:{host}", "-keyout", key,
                        "-out", cert], check=True, stderr=subprocess.DEVNULL)
        env = {**os.environ, "PATH": str(base / "bin") + ":" + os.environ["PATH"], "SSL_CERT_FILE": str(cert),
               "CURL_CA_BUNDLE": str(cert), "XDG_DATA_HOME": td, "XDG_CONFIG_HOME": td}
        def wrapper(name, code):
            path = base / "bin" / name
            path.write_text("#!/bin/sh\n" + code + "\n")
            path.chmod(0o755)
        # The real listener/master is looked up at a free test port in place of 443.
        wrapper("ss", f'exec /usr/bin/ss -Hlnpt "sport = :{old}"')
        webroot = base / ".well-known"
        webroot.mkdir()
        (webroot / "codecang-relay").write_text(metadata)
        upstream = subprocess.Popen(["python3", "-m", "http.server", str(inner), "--bind", "127.0.0.1",
                                     "--directory", td], stderr=subprocess.DEVNULL)
        process = None
        try:
            subprocess.run(["bash", "-c", 'set -eu; base=$1; host=$2; . "$base/routes.sh"; write_frontend_examples "$3" "$4"',
                            "test", td, host, str(inner), str(public)], check=True)
            if provider == "nginx":
                main = base / "nginx.conf"
                site = base / "sites-enabled/sub2api"
                site.write_text(f'server {{\n listen 127.0.0.1:{old} ssl;\n server_name {host};\n'
                                f' ssl_certificate {cert};\n ssl_certificate_key {key};\n location / {{ return 200 existing; }}\n}}\n')
                temps = " ".join(f"{t}_temp_path {td}/logs/{t};" for t in
                                 ["client_body", "proxy", "fastcgi", "uwsgi", "scgi"])
                main.write_text(f"pid {td}/nginx.pid; error_log stderr; events {{}} http {{access_log off; {temps}\n"
                                f"include {td}/conf.d/*.conf;\ninclude {td}/sites-enabled/*;\n}}\n")
                cmd = [nginx, "-p", td + "/", "-c", main, "-g", "daemon off;"]
            else:
                main = base / "Caddyfile"
                site = base / "old.caddy"
                site.write_text(f"https://{host}:{old} {{\n bind 127.0.0.1\n tls {cert} {key}\n respond existing\n}}\n")
                main.write_text(f"{{\n admin 127.0.0.1:{admin}\n auto_https off\n}}\nimport {site}\n")
                cmd = [caddy, "run", "--config", main, "--adapter", "caddyfile"]
                (base / "bin/caddy").symlink_to(caddy)
            old_hash = hashlib.sha256(site.read_bytes()).digest()
            process = subprocess.Popen(cmd, cwd=td, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if provider == "caddy":
                wrapper("systemctl", f'if [ "$1" = show ]; then echo {process.pid}; else exec {shlex.quote(str(caddy))} reload --config {main} --adapter caddyfile; fi')
            def fetch(port, endpoint="/"):
                return subprocess.run(["curl", "--noproxy", "*", "-fs", "--max-time", "2", "--resolve",
                                       f"{host}:{port}:127.0.0.1", f"https://{host}:{port}{endpoint}"],
                                      env=env, capture_output=True, text=True).stdout
            for _ in range(50):
                if fetch(old) == "existing":
                    break
                time.sleep(0.1)
            assert fetch(old) == "existing"
            def manage(action, success=True):
                result = subprocess.run(["python3", "-I", base / "frontend.py", action, host, str(public), device],
                                        env=env, capture_output=True, text=True)
                assert (result.returncode == 0) == success, result.stderr
            if provider == "nginx":
                # Wrong identity after reload must roll back the new site, not touch 443.
                (webroot / "codecang-relay").write_text("wrong device")
                manage("install", False)
                assert not list((base / "conf.d").iterdir()) and fetch(old) == "existing"
                (webroot / "codecang-relay").write_text(metadata)
                time.sleep(0.3)
            manage("install")
            manage("install")
            assert fetch(public, "/.well-known/codecang-relay") == metadata
            assert fetch(old) == "existing" and hashlib.sha256(site.read_bytes()).digest() == old_hash
            manage("remove")
            for _ in range(20):
                if not fetch(public, "/.well-known/codecang-relay"):
                    break
                time.sleep(0.1)
            assert not fetch(public, "/.well-known/codecang-relay") and fetch(old) == "existing"
        finally:
            for service in [process, upstream]:
                if service is not None:
                    service.terminate()
                    service.wait(timeout=8)
        print(provider, "verified first install, redelivery, original site and revocation", flush=True)


for server in ("nginx", "caddy"):
    exercise(server)

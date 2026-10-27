import os
import re
import io
import uuid
import json
import time
import socket
import logging
import subprocess
import base64
import shlex
import threading
import paramiko
from flask import Flask, request, jsonify, render_template, redirect, session
from flask_sock import Sock

app = Flask(__name__)
app.secret_key = os.environ.get('FLASK_SECRET_KEY', 'dashboard-ssh-remote-secret-key-2026')

def get_git_version():
    """Retrieve Git commit timestamp in YYYY.MM.DD.HHMM format as application version."""
    try:
        base_dir = os.path.dirname(os.path.abspath(__file__))
        cmd = ['git', 'log', '-1', '--format=%cd', '--date=format:%Y.%m.%d.%H%M']
        out = subprocess.check_output(cmd, cwd=base_dir, stderr=subprocess.DEVNULL, timeout=2).decode().strip()
        if out:
            return f"v{out}"
    except Exception:
        pass
    return "v2026.10.27.0110"

APP_NAME = "Host Pilot"
APP_VERSION = get_git_version()

app.config['TEMPLATES_AUTO_RELOAD'] = os.environ.get('FLASK_DEBUG', 'False').lower() in ('true', '1', 't')
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024
sock = Sock(app)

# Quiet noisy polling requests in werkzeug logs
class WerkzeugFilter(logging.Filter):
    def filter(self, record):
        msg = record.getMessage()
        return not ("/api/logs" in msg or " 304 " in msg or msg.strip().endswith(" 304 -"))

werkzeug_logger = logging.getLogger('werkzeug')
werkzeug_logger.addFilter(WerkzeugFilter())

# In-memory store for session private keys (never saved to disk)
# Map: session_id -> { "key_content": str, "key_name": str, "updated_at": float }
_SESSION_KEYS = {}

# ==============================================================================
# Persistent SSH Client Connection Pool & Resource Eviction
# ==============================================================================
# Reuses existing open SSH sessions across requests instead of reconnecting on every call
_SSH_POOL = {}
_SSH_POOL_LOCK = threading.Lock()
_last_cleanup_ts = 0


def cleanup_stale_connections():
    """Periodically evicts idle SSH clients (idle > 30m) and expired session keys to free server memory."""
    global _last_cleanup_ts
    now = time.time()
    if now - _last_cleanup_ts < 300:  # Throttled to at most once per 5 minutes
        return
    _last_cleanup_ts = now

    with _SSH_POOL_LOCK:
        stale_sids = [
            sid for sid, entry in _SSH_POOL.items()
            if now - entry.get('last_used', 0) > 1800
        ]
        for sid in stale_sids:
            entry = _SSH_POOL.pop(sid, None)
            if entry and entry.get('client'):
                try:
                    entry['client'].close()
                except Exception:
                    pass

    stale_keys = [
        sid for sid, data in list(_SESSION_KEYS.items())
        if now - data.get('updated_at', 0) > 14400
    ]
    for sid in stale_keys:
        _SESSION_KEYS.pop(sid, None)


def close_pooled_client(session_id):
    """Safely close and evict an active SSH client from the persistent pool."""
    if not session_id:
        return
    with _SSH_POOL_LOCK:
        entry = _SSH_POOL.pop(session_id, None)
        if entry and entry.get('client'):
            try:
                entry['client'].close()
            except Exception:
                pass


def load_key_from_string(key_text, passphrase=None):
    """Parses a private key string (RSA, Ed25519, ECDSA) using Paramiko in memory without disk writes."""
    if not key_text or not key_text.strip():
        raise ValueError("Private key content is empty.")

    cleaned = key_text.strip()
    pwd = passphrase.strip() if (passphrase and str(passphrase).strip()) else None

    # Try all standard Paramiko key classes
    for key_cls in (paramiko.RSAKey, paramiko.Ed25519Key, paramiko.ECDSAKey):
        try:
            buf = io.StringIO(cleaned)
            return key_cls.from_private_key(buf, password=pwd)
        except paramiko.PasswordRequiredException:
            raise ValueError("Private key is encrypted with a passphrase. Please provide the key passphrase.")
        except Exception:
            continue

    raise ValueError("Invalid private key format. Ensure it is a valid PEM/OpenSSH private key format.")


def normalize_key_path(p):
    """Normalize and expand private key file path, stripping surrounding quotes."""
    if not p:
        return ""
    clean = str(p).strip().strip('"').strip("'")
    return os.path.normpath(os.path.expanduser(clean))


def get_active_conn():
    """Get active connection details from the current session."""
    if 'oci_conn' in session and session['oci_conn'].get('host'):
        return session['oci_conn']
    return None


@app.before_request
def require_connection():
    cleanup_stale_connections()
    allowed_paths = ('/login', '/api/login', '/static/', '/ws/')
    if any(request.path.startswith(p) for p in allowed_paths):
        return None
    if not get_active_conn():
        return redirect('/login')


def test_ssh_connection(host, username, port, key_path=None, key_content=None, passphrase=None):
    """Test SSH connection to remote host using either in-memory key or disk key file."""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        if key_content and key_content.strip():
            pkey = load_key_from_string(key_content, passphrase)
            client.connect(
                hostname=host.strip(),
                port=int(port),
                username=username.strip(),
                pkey=pkey,
                timeout=8,
                banner_timeout=8
            )
        elif key_path and key_path.strip():
            expanded_key = normalize_key_path(key_path)
            if not os.path.exists(expanded_key):
                return False, f"Key file not found at: {expanded_key}"
            client.connect(
                hostname=host.strip(),
                port=int(port),
                username=username.strip(),
                key_filename=expanded_key,
                password=passphrase.strip() if (passphrase and str(passphrase).strip()) else None,
                timeout=8,
                banner_timeout=8
            )
        else:
            return False, "No private key provided (neither in-memory content nor file path)."

        return True, "Success"
    except Exception as e:
        return False, str(e)
    finally:
        try:
            client.close()
        except Exception:
            pass


def get_ssh_client():
    """Establish or retrieve a persistent active SSH client from the connection pool."""
    conn = get_active_conn()
    if not conn or not conn.get('host'):
        return None, "No active remote host connection."

    session_id = session.get('session_id')
    if not session_id:
        return None, "No active session found."

    target_host = conn['host'].strip()
    target_port = int(conn.get('port', 22))
    target_user = conn.get('username', 'opc').strip()

    # 1. Check existing pooled connection
    with _SSH_POOL_LOCK:
        if session_id in _SSH_POOL:
            entry = _SSH_POOL[session_id]
            if (entry['host'] == target_host and 
                entry['port'] == target_port and 
                entry['username'] == target_user):
                client = entry['client']
                transport = client.get_transport()
                if transport and transport.is_active():
                    entry['last_used'] = time.time()
                    return client, None

            # Outdated or dead connection: clean up
            try:
                entry['client'].close()
            except Exception:
                pass
            _SSH_POOL.pop(session_id, None)

    # 2. Establish a new pooled connection
    key_info = _SESSION_KEYS.get(session_id) if session_id else None
    passphrase = conn.get('passphrase')

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        if key_info and key_info.get('key_content'):
            pkey = load_key_from_string(key_info['key_content'], passphrase)
            client.connect(
                hostname=target_host,
                port=target_port,
                username=target_user,
                pkey=pkey,
                timeout=8,
                banner_timeout=8
            )
        elif conn.get('key_path'):
            key_path = normalize_key_path(conn.get('key_path', ''))
            if not os.path.exists(key_path):
                return None, f"Private key file not found: {key_path}"
            client.connect(
                hostname=target_host,
                port=target_port,
                username=target_user,
                key_filename=key_path,
                password=passphrase.strip() if (passphrase and str(passphrase).strip()) else None,
                timeout=8,
                banner_timeout=8
            )
        else:
            return None, "No SSH key found for this active session."

        # Keep alive: send heartbeat packet every 30 seconds
        transport = client.get_transport()
        if transport:
            transport.set_keepalive(30)

        with _SSH_POOL_LOCK:
            _SSH_POOL[session_id] = {
                'client': client,
                'host': target_host,
                'port': target_port,
                'username': target_user,
                'last_used': time.time()
            }
        return client, None
    except Exception as e:
        return None, f"SSH connection to {target_host} failed: {str(e)}"


def run_remote_command(cmd, sudo=False, custom_sudo_password=None):
    """Execute command on the active remote host via persistent pooled SSH connection."""
    conn = get_active_conn()
    if not conn:
        return "", "No active remote connection.", 1

    session_id = session.get('session_id')

    full_cmd = cmd
    if sudo:
        pwd = custom_sudo_password or conn.get('sudo_password')
        if pwd:
            full_cmd = f"echo {shlex.quote(pwd)} | sudo -S {cmd}"
        else:
            full_cmd = f"sudo -n {cmd}"

    client, err = get_ssh_client()
    if err or not client:
        # Fallback to OpenSSH CLI only if key exists on disk
        raw_key_path = conn.get('key_path', '')
        if not raw_key_path:
            return "", err or "SSH client unavailable", 1
        key_path = normalize_key_path(raw_key_path)
        if not os.path.exists(key_path):
            return "", err or "Private key file not found", 1

        host = conn['host']
        user = conn.get('username', 'opc')
        port = str(conn.get('port', 22))
        try:
            ssh_args = [
                "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
                "-i", key_path, "-p", port, f"{user}@{host}", full_cmd
            ]
            res = subprocess.run(ssh_args, capture_output=True, text=True, timeout=12)
            return res.stdout, res.stderr, res.returncode
        except Exception:
            return "", err or "CLI fallback failed", 1

    stdout_ch = None
    try:
        stdin, stdout, stderr = client.exec_command(full_cmd, timeout=15)
        stdin.close()
        stdout_ch = getattr(stdout, 'channel', None)
        out = stdout.read().decode('utf-8', errors='replace')
        err_out = stderr.read().decode('utf-8', errors='replace')
        code = stdout.channel.recv_exit_status()
        return out, err_out, code
    except (paramiko.SSHException, socket.error) as e:
        # Remote connection dropped: evict from pool and retry once
        if session_id:
            close_pooled_client(session_id)

        client, retry_err = get_ssh_client()
        if retry_err or not client:
            return "", f"Connection dropped: {str(e)}", 1

        try:
            stdin, stdout, stderr = client.exec_command(full_cmd, timeout=15)
            stdin.close()
            stdout_ch = getattr(stdout, 'channel', None)
            out = stdout.read().decode('utf-8', errors='replace')
            err_out = stderr.read().decode('utf-8', errors='replace')
            code = stdout.channel.recv_exit_status()
            return out, err_out, code
        except Exception as retry_e:
            return "", str(retry_e), 1
    except Exception as e:
        return "", str(e), 1
    finally:
        if stdout_ch:
            try:
                stdout_ch.close()
            except Exception:
                pass


_hostname_cache = {"val": None, "host": None, "ts": 0}
_vm_info_cache = {"data": None, "host": None, "ts": 0}

def get_display_hostname():
    """Retrieve remote host's hostname via SSH."""
    conn = get_active_conn()
    if not conn:
        return "Not Connected"
    
    now = time.time()
    if _hostname_cache["val"] and _hostname_cache["host"] == conn['host'] and (now - _hostname_cache["ts"] < 120):
        return _hostname_cache["val"]
        
    out, err, code = run_remote_command("hostname")
    if code == 0 and out.strip():
        _hostname_cache["val"] = out.strip()
        _hostname_cache["host"] = conn['host']
        _hostname_cache["ts"] = now
        return out.strip()
    return f"Linux-VM ({conn['host']})"


def get_vm_details():
    """Query remote VM details (Private/Public IPs, Interfaces, OS, Kernel, CPU, Virt) with 120s caching."""
    conn = get_active_conn()
    if not conn:
        return {}

    now = time.time()
    if _vm_info_cache["data"] and _vm_info_cache["host"] == conn.get('host') and (now - _vm_info_cache["ts"] < 120):
        return _vm_info_cache["data"]

    py_script = """
import json, os, platform, socket, subprocess, re

info = {}
try:
    info['hostname'] = socket.gethostname()
except Exception:
    info['hostname'] = ''

# OS Release
os_name = 'Linux'
if os.path.exists('/etc/os-release'):
    try:
        with open('/etc/os-release') as f:
            for line in f:
                if line.startswith('PRETTY_NAME='):
                    os_name = line.strip().split('=', 1)[1].strip('\\"\\'')
                    break
    except Exception:
        pass
info['os_name'] = os_name
info['kernel'] = platform.release()
info['arch'] = platform.machine()

# CPU Model
cpu_model = ''
try:
    with open('/proc/cpuinfo') as f:
        for line in f:
            if 'model name' in line:
                cpu_model = line.split(':', 1)[1].strip()
                break
except Exception:
    pass
info['cpu_model'] = cpu_model or platform.processor()

# Network Interfaces & Private IPs
interfaces = []
private_ips = []
try:
    out = subprocess.check_output(['ip', '-j', 'addr'], stderr=subprocess.DEVNULL, text=True)
    for iface in json.loads(out):
        if_name = iface.get('ifname', '')
        if if_name == 'lo':
            continue
        addrs = []
        for addr_info in iface.get('addr_info', []):
            if addr_info.get('family') == 'inet':
                ip = addr_info.get('local')
                mask = addr_info.get('prefixlen')
                addrs.append(f'{ip}/{mask}')
                if ip and ip not in private_ips and not ip.startswith('127.'):
                    private_ips.append(ip)
        if addrs:
            interfaces.append({
                'name': if_name,
                'state': iface.get('operstate', 'UP'),
                'mac': iface.get('address', ''),
                'ips': addrs
            })
except Exception:
    try:
        out = subprocess.check_output(['hostname', '-I'], stderr=subprocess.DEVNULL, text=True)
        for ip in out.split():
            if ip not in private_ips and not ip.startswith('127.'):
                private_ips.append(ip)
    except Exception:
        pass

info['interfaces'] = interfaces
info['private_ips'] = private_ips
info['primary_private_ip'] = private_ips[0] if private_ips else ''

# Default Gateway
gateway = ''
try:
    out = subprocess.check_output(['ip', 'route', 'show', 'default'], stderr=subprocess.DEVNULL, text=True)
    parts = out.split()
    if 'via' in parts:
        gateway = parts[parts.index('via') + 1]
except Exception:
    pass
info['gateway'] = gateway

# DNS Servers
dns_servers = []
try:
    with open('/etc/resolv.conf') as f:
        for line in f:
            if line.startswith('nameserver'):
                dns = line.split()[1]
                if dns not in dns_servers:
                    dns_servers.append(dns)
except Exception:
    pass
info['dns_servers'] = dns_servers

# Virtualization
virt = ''
try:
    virt = subprocess.check_output(['systemd-detect-virt'], stderr=subprocess.DEVNULL, text=True).strip()
except Exception:
    pass
info['virtualization'] = virt or 'Cloud VM'

# Public IP detection (fast OCI metadata check or curl)
public_ip = ''
try:
    out = subprocess.check_output(['curl', '-s', '-m', '1', 'http://169.254.169.254/opc/v1/vnics/'], stderr=subprocess.DEVNULL, text=True)
    vnic_data = json.loads(out)
    if isinstance(vnic_data, list) and len(vnic_data) > 0:
        public_ip = vnic_data[0].get('publicIp', '')
except Exception:
    pass

if not public_ip:
    for service_url in ('https://api.ipify.org', 'https://icanhazip.com', 'https://ifconfig.me/ip'):
        try:
            out = subprocess.check_output(['curl', '-s', '-m', '1', service_url], stderr=subprocess.DEVNULL, text=True).strip()
            if re.match(r'^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$', out):
                public_ip = out
                break
        except Exception:
            pass

info['public_ip'] = public_ip

print(json.dumps(info))
"""
    cmd = f"python3 -c {shlex.quote(py_script)}"
    stdout, stderr, code = run_remote_command(cmd)

    if code != 0 or not stdout.strip():
        # Fallback to standard Linux bash commands
        fb_cmd = "hostname -I 2>/dev/null; echo '___VMDELIM___'; uname -r; echo '___VMDELIM___'; uname -m"
        fb_out, _, fb_code = run_remote_command(fb_cmd)
        if fb_code == 0 and fb_out:
            parts = fb_out.split('___VMDELIM___')
            priv_ips = parts[0].strip().split() if len(parts) > 0 else []
            kernel = parts[1].strip() if len(parts) > 1 else ''
            arch = parts[2].strip() if len(parts) > 2 else ''
            vm_data = {
                'hostname': get_display_hostname(),
                'os_name': 'Linux',
                'kernel': kernel,
                'arch': arch,
                'cpu_model': '',
                'interfaces': [],
                'private_ips': priv_ips,
                'primary_private_ip': priv_ips[0] if priv_ips else '',
                'gateway': '',
                'dns_servers': [],
                'virtualization': 'Cloud VM',
                'public_ip': conn.get('host', '')
            }
            _vm_info_cache["data"] = vm_data
            _vm_info_cache["host"] = conn.get('host')
            _vm_info_cache["ts"] = now
            return vm_data
        return {}

    try:
        vm_data = json.loads(stdout.strip())
        if not vm_data.get('public_ip'):
            vm_data['public_ip'] = conn.get('host', '')
        _vm_info_cache["data"] = vm_data
        _vm_info_cache["host"] = conn.get('host')
        _vm_info_cache["ts"] = now
        return vm_data
    except Exception:
        return {}


@app.context_processor
def inject_globals():
    conn = get_active_conn() or {}
    vm = _vm_info_cache.get("data") if (_vm_info_cache.get("host") == conn.get('host')) else {}
    pub_ip = (vm.get('public_ip') if vm else None) or conn.get('host', '127.0.0.1')
    priv_ip = (vm.get('primary_private_ip') if vm else None) or ''
    hname = (vm.get('hostname') if vm else None) or get_display_hostname()
    login_host = conn.get('host', '')
    return {
        'app_name': APP_NAME,
        'app_version': APP_VERSION,
        'login_host': login_host or pub_ip,
        'system_ip': pub_ip,
        'system_private_ip': priv_ip,
        'system_hostname': hname,
        'system_user': conn.get('username', 'opc'),
        'system_os': (vm.get('os_name') if vm else None) or 'Linux'
    }


def get_services_memory():
    """Retrieve memory consumption for active services on OCI VM."""
    service_mem = []
    try:
        cmd = "systemctl show '*.service' --property=Id,MemoryCurrent --no-pager"
        stdout, stderr, code = run_remote_command(cmd)
        if code == 0 and stdout:
            lines = stdout.strip().split('\n')
            current_mem = None
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                if line.startswith('MemoryCurrent='):
                    val = line.split('=', 1)[1]
                    if val != '[not set]':
                        try:
                            current_mem = int(val)
                        except ValueError:
                            current_mem = None
                    else:
                        current_mem = None
                elif line.startswith('Id='):
                    unit = line.split('=', 1)[1].replace('.service', '')
                    if current_mem is not None and current_mem > 0:
                        service_mem.append({
                            "name": unit,
                            "memory": current_mem
                        })
                        current_mem = None
            service_mem.sort(key=lambda x: x["memory"], reverse=True)
    except Exception:
        pass
    return service_mem


def get_top_processes():
    """Retrieve top memory consuming processes on OCI VM."""
    proc_list = []
    try:
        cmd = "ps -eo pid,comm,rss --no-headers --sort=-rss"
        stdout, stderr, code = run_remote_command(cmd)
        if code == 0 and stdout:
            lines = stdout.strip().split('\n')
            for line in lines[:20]:
                parts = line.strip().split()
                if len(parts) >= 3:
                    try:
                        pid = parts[0]
                        name = parts[1]
                        memory_bytes = int(parts[2]) * 1024
                        proc_list.append({
                            "pid": pid,
                            "name": name,
                            "memory": memory_bytes
                        })
                    except ValueError:
                        pass
    except Exception:
        pass
    return proc_list


# ==============================================================================
# Authentication & Connection Routes
# ==============================================================================
@app.route('/login', methods=['GET'])
def login_view():
    return render_template('login.html')


@app.route('/api/login', methods=['POST'])
def api_login():
    data = request.get_json() or {}
    host = str(data.get('host', '')).strip()
    username = str(data.get('username', 'opc')).strip()
    port = int(data.get('port', 22))
    key_path = str(data.get('key_path', '')).strip().strip('"').strip("'")
    key_content = str(data.get('key_content', '')).strip()
    key_name = str(data.get('key_name', '')).strip()
    passphrase = str(data.get('passphrase', '')).strip()
    sudo_password = str(data.get('sudo_password', ''))

    if not host or not username:
        return jsonify({"status": "error", "message": "Host and username are required."}), 400

    if not key_content and not key_path:
        return jsonify({"status": "error", "message": "Private SSH key is required (upload file, paste content, or enter file path)."}), 400

    # Test the SSH connection
    ok, err = test_ssh_connection(
        host=host,
        username=username,
        port=port,
        key_path=key_path if not key_content else None,
        key_content=key_content if key_content else None,
        passphrase=passphrase
    )
    if not ok:
        return jsonify({"status": "error", "message": f"Connection failed: {err}"}), 400

    # Ensure session has unique ID
    if 'session_id' not in session:
        session['session_id'] = str(uuid.uuid4())
    session_id = session['session_id']

    # Evict any existing pooled SSH connection for this session
    close_pooled_client(session_id)

    # Store key strictly in server RAM (never on disk, never in client cookie)
    if key_content:
        _SESSION_KEYS[session_id] = {
            'key_content': key_content,
            'key_name': key_name or "Uploaded In-Memory Key",
            'updated_at': time.time()
        }
    else:
        _SESSION_KEYS.pop(session_id, None)

    conn_data = {
        'host': host,
        'username': username,
        'port': port,
        'key_path': key_path if not key_content else '',
        'key_name': key_name or (os.path.basename(key_path) if key_path else "In-Memory Key"),
        'has_in_memory_key': bool(key_content),
        'sudo_password': sudo_password,
        'passphrase': passphrase
    }
    session['oci_conn'] = conn_data

    _hostname_cache["val"] = None
    return jsonify({"status": "success", "message": "Connected successfully."})


@app.route('/logout')
def logout():
    session_id = session.get('session_id')
    if session_id:
        _SESSION_KEYS.pop(session_id, None)
        close_pooled_client(session_id)
    session.clear()
    return redirect('/login')


# ==============================================================================
# Page Views
# ==============================================================================
@app.route('/')
def index():
    return redirect('/servers')

@app.route('/services')
def services_view():
    return render_template('services.html')

@app.route('/ports')
def ports_view():
    return render_template('ports.html')

@app.route('/memory')
def memory_view():
    return render_template('memory.html')

@app.route('/logs')
def logs_view():
    unit = request.args.get('unit', default='dashboard')
    if not re.match(r'^[a-zA-Z0-9_\-\.]+$', unit):
        unit = 'dashboard'
    return render_template('logs.html', selected_unit=unit)

@app.route('/terminal')
def terminal_view():
    conn = get_active_conn() or {}
    return render_template(
        'terminal.html',
        terminal_user=conn.get('username', 'opc'),
        terminal_host=conn.get('host', '127.0.0.1')
    )

@app.route('/servers')
def servers_view():
    return render_template('servers.html')

@app.route('/files')
def files_view():
    return render_template('files.html')

@app.route('/users')
def users_view():
    return render_template('users.html')


# ==============================================================================
# API Endpoints & WebSockets
# ==============================================================================
@sock.route('/ws/terminal')
def terminal_socket(ws):
    """Interactive full-duplex PTY terminal stream for xterm.js over WebSocket."""
    conn = get_active_conn()
    if not conn:
        try:
            ws.send("\r\n\x1b[1;31m[Authentication Required: Please log in to your server first.]\x1b[0m\r\n")
            ws.close()
        except Exception:
            pass
        return

    client, err = get_ssh_client()
    if err or not client:
        try:
            ws.send(f"\r\n\x1b[1;31m[SSH Connection Error: {err}]\x1b[0m\r\n")
            ws.close()
        except Exception:
            pass
        return

    channel = None
    stop_event = threading.Event()
    try:
        # Start interactive shell channel with PTY
        channel = client.invoke_shell(term='xterm-256color', width=90, height=30)
        channel.settimeout(0.05)

        # Background thread: read bytes from remote PTY and push to browser xterm
        def stream_remote_output():
            while not stop_event.is_set():
                try:
                    if channel.recv_ready():
                        data = channel.recv(4096)
                        if not data:
                            break
                        ws.send(data.decode('utf-8', errors='replace'))
                    elif channel.exit_status_ready():
                        break
                    else:
                        time.sleep(0.01)
                except Exception:
                    break
            stop_event.set()

        reader_thread = threading.Thread(target=stream_remote_output, daemon=True)
        reader_thread.start()

        # Foreground loop: receive keystrokes and resize signals from browser xterm
        while not stop_event.is_set():
            try:
                msg = ws.receive(timeout=0.08)
                if msg is None:
                    continue
                if isinstance(msg, str):
                    if msg.startswith('{"type":"resize"'):
                        try:
                            cfg = json.loads(msg)
                            cols = int(cfg.get('cols', 90))
                            rows = int(cfg.get('rows', 30))
                            channel.resize_pty(width=cols, height=rows)
                            continue
                        except Exception:
                            pass
                    channel.send(msg)
                elif isinstance(msg, bytes):
                    channel.send(msg)
            except Exception:
                break
    except Exception as e:
        try:
            ws.send(f"\r\n\x1b[1;31m[Terminal Session Failed: {str(e)}]\x1b[0m\r\n")
        except Exception:
            pass
    finally:
        stop_event.set()
        if channel:
            try:
                channel.close()
            except Exception:
                pass


@app.route('/api/terminal/exec', methods=['POST'])
def api_terminal_exec():
    data = request.get_json() or {}
    raw_cmd = str(data.get('command', '')).strip()
    cwd = str(data.get('cwd', '')).strip() or '~'
    use_sudo = bool(data.get('sudo', False))
    sudo_pwd = request.headers.get('X-Sudo-Password')

    if not raw_cmd:
        return jsonify({"stdout": "", "stderr": "", "code": 0, "cwd": cwd})

    if raw_cmd == 'clear':
        return jsonify({"stdout": "", "stderr": "", "code": 0, "cwd": cwd, "clear": True})

    marker = "___CWD_DELIM___"
    script = (
        f"cd {cwd} 2>/dev/null || cd ~; "
        f"{raw_cmd}; "
        f"__STATUS=$?; "
        f"echo -n '{marker}'; "
        f"pwd; "
        f"exit $__STATUS"
    )

    stdout, stderr, code = run_remote_command(script, sudo=use_sudo, custom_sudo_password=sudo_pwd)

    new_cwd = cwd
    actual_stdout = stdout
    if marker in stdout:
        parts = stdout.rsplit(marker, 1)
        actual_stdout = parts[0]
        extracted_cwd = parts[1].strip()
        if extracted_cwd:
            new_cwd = extracted_cwd

    return jsonify({
        "status": "success",
        "stdout": actual_stdout,
        "stderr": stderr,
        "code": code,
        "cwd": new_cwd
    })


_cpu_stat_cache = {"total": 0, "idle": 0, "ts": 0}


def get_system_vitals():
    """Query system vitals (CPU, RAM, Disk, Uptime, Load Avg, Public IP) in a single fast command."""
    conn = get_active_conn() or {}
    host_ip = conn.get('host', '127.0.0.1')
    hostname = get_display_hostname()

    # Query metrics in one fast SSH command
    cmd = (
        "cat /proc/loadavg; "
        "echo '___METRIC_DELIM___'; "
        "uptime -p 2>/dev/null || uptime; "
        "echo '___METRIC_DELIM___'; "
        "nproc 2>/dev/null || echo 1; "
        "echo '___METRIC_DELIM___'; "
        "df -B1 / | tail -1; "
        "echo '___METRIC_DELIM___'; "
        "head -n 1 /proc/stat; "
        "echo '___METRIC_DELIM___'; "
        "cat /proc/meminfo"
    )
    stdout, stderr, code = run_remote_command(cmd)

    loadavg = [0.0, 0.0, 0.0]
    uptime_str = "Unknown"
    cpu_cores = 1
    disk_info = {"filesystem": "/", "total": 0, "used": 0, "free": 0, "percent": 0, "mount": "/"}
    cpu_percent = 0.0
    ram_info = {"total": 0, "used": 0, "free": 0, "available": 0, "buffers_cached": 0, "used_percent": 0}
    swap_info = {"total": 0, "used": 0, "free": 0, "used_percent": 0}

    if code == 0 and stdout:
        sections = stdout.split('___METRIC_DELIM___')
        # 1. Load average
        if len(sections) > 0:
            parts = sections[0].strip().split()
            if len(parts) >= 3:
                try:
                    loadavg = [float(parts[0]), float(parts[1]), float(parts[2])]
                except ValueError:
                    pass

        # 2. Uptime
        if len(sections) > 1:
            raw_up = sections[1].strip()
            uptime_str = raw_up[3:] if raw_up.startswith('up ') else raw_up

        # 3. CPU Cores
        if len(sections) > 2:
            try:
                cpu_cores = int(sections[2].strip())
            except ValueError:
                pass

        # 4. Disk Usage (root mount)
        if len(sections) > 3:
            df_parts = sections[3].strip().split()
            if len(df_parts) >= 6:
                try:
                    t_b = int(df_parts[1])
                    u_b = int(df_parts[2])
                    a_b = int(df_parts[3])
                    pct = round((u_b / t_b) * 100, 1) if t_b > 0 else 0
                    disk_info = {
                        "filesystem": df_parts[0],
                        "total": t_b,
                        "used": u_b,
                        "free": a_b,
                        "percent": pct,
                        "mount": df_parts[5]
                    }
                except (ValueError, IndexError):
                    pass

        # 5. CPU Usage calculation from /proc/stat
        if len(sections) > 4:
            stat_line = sections[4].strip()
            if stat_line.startswith('cpu '):
                fields = [int(x) for x in stat_line.split()[1:] if x.isdigit()]
                if len(fields) >= 4:
                    idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
                    total = sum(fields)
                    prev_total = _cpu_stat_cache["total"]
                    prev_idle = _cpu_stat_cache["idle"]
                    if prev_total > 0 and total > prev_total:
                        d_total = total - prev_total
                        d_idle = idle - prev_idle
                        cpu_percent = round(max(0.0, min(100.0, (1.0 - (d_idle / d_total)) * 100)), 1)
                    else:
                        cpu_percent = round(min(100.0, (loadavg[0] / max(1, cpu_cores)) * 100), 1)
                    _cpu_stat_cache["total"] = total
                    _cpu_stat_cache["idle"] = idle
                    _cpu_stat_cache["ts"] = time.time()

        # 6. RAM & Swap Usage from /proc/meminfo
        if len(sections) > 5:
            meminfo = {}
            for line in sections[5].strip().splitlines():
                p = line.split(':')
                if len(p) == 2:
                    k = p[0].strip()
                    v = p[1].strip().split()[0]
                    if v.isdigit():
                        meminfo[k] = int(v) * 1024
            m_total = meminfo.get('MemTotal', 0)
            m_avail = meminfo.get('MemAvailable', 0)
            m_free = meminfo.get('MemFree', 0)
            m_buffers = meminfo.get('Buffers', 0)
            m_cached = meminfo.get('Cached', 0)
            m_used = (m_total - m_avail) if m_avail > 0 else (m_total - m_free - m_buffers - m_cached)
            m_pct = round((m_used / m_total) * 100, 1) if m_total > 0 else 0
            ram_info = {
                "total": m_total,
                "used": m_used,
                "free": m_free,
                "available": m_avail,
                "buffers_cached": m_buffers + m_cached,
                "used_percent": m_pct
            }
            s_total = meminfo.get('SwapTotal', 0)
            s_free = meminfo.get('SwapFree', 0)
            s_used = s_total - s_free
            s_pct = round((s_used / s_total) * 100, 1) if s_total > 0 else 0
            swap_info = {
                "total": s_total,
                "used": s_used,
                "free": s_free,
                "used_percent": s_pct
            }

    # Query enriched VM details (Network IPs, interfaces, OS, kernel, arch, CPU model)
    vm_details = get_vm_details()
    pub_ip = vm_details.get('public_ip') or host_ip
    priv_ip = vm_details.get('primary_private_ip') or ''
    hname = vm_details.get('hostname') or hostname

    login_host = conn.get('host', '')

    return {
        "status": "success",
        "app_name": APP_NAME,
        "app_version": APP_VERSION,
        "login_host": login_host,
        "public_ip": pub_ip,
        "private_ip": priv_ip,
        "hostname": hname,
        "vm_details": vm_details,
        "uptime": uptime_str,
        "load_average": loadavg,
        "cpu": {
            "cores": cpu_cores,
            "percent": cpu_percent
        },
        "disk": disk_info,
        "ram": ram_info,
        "swap": swap_info
    }


@app.route('/api/system-info', methods=['GET'])
def api_system_info():
    return jsonify(get_system_vitals())


@app.route('/api/servers/active', methods=['GET'])
def api_active_server():
    conn = get_active_conn() or {}
    login_host = conn.get('host', '')
    vm_details = get_vm_details() if login_host else {}
    pub_ip = vm_details.get('public_ip') or login_host
    priv_ip = vm_details.get('primary_private_ip') or ''
    hname = vm_details.get('hostname') or get_display_hostname()
    return jsonify({
        "status": "success",
        "app_name": APP_NAME,
        "app_version": APP_VERSION,
        "active": bool(conn),
        "login_host": login_host,
        "host": login_host or pub_ip,
        "public_ip": pub_ip,
        "private_ip": priv_ip,
        "username": conn.get('username', ''),
        "port": conn.get('port', 22),
        "key_path": conn.get('key_path', ''),
        "key_name": conn.get('key_name', 'In-Memory Key'),
        "has_in_memory_key": conn.get('has_in_memory_key', False),
        "hostname": hname,
        "vm_details": vm_details
    })


# ==============================================================================
# File Browser & Text Editor API Endpoints
# ==============================================================================
@app.route('/api/files/list', methods=['POST'])
def api_files_list():
    data = request.get_json() or {}
    raw_path = str(data.get('path', '')).strip() or '/etc/systemd/system'
    target_json = json.dumps(raw_path)

    script = '''import os, json, stat, sys, pwd, grp
target = ''' + target_json + '''
target = os.path.expanduser(target)
if not os.path.exists(target):
    print(json.dumps({"error": "Path not found: " + target}))
    sys.exit(0)
if not os.path.isdir(target):
    target = os.path.dirname(target) or "/"
real_path = os.path.abspath(target)
items = []
try:
    for entry in os.scandir(real_path):
        try:
            st = entry.stat(follow_symlinks=False)
            is_d = entry.is_dir(follow_symlinks=False)
            is_l = entry.is_symlink()
            try:
                u = pwd.getpwuid(st.st_uid).pw_name
            except Exception:
                u = str(st.st_uid)
            try:
                g = grp.getgrgid(st.st_gid).gr_name
            except Exception:
                g = str(st.st_gid)
            items.append({
                "name": entry.name,
                "is_dir": is_d,
                "is_symlink": is_l,
                "size": 0 if is_d else st.st_size,
                "mode": stat.filemode(st.st_mode),
                "owner": u + ":" + g,
                "mtime": int(st.st_mtime)
            })
        except Exception:
            pass
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(0)
items.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
parent = os.path.dirname(real_path) if real_path != "/" else "/"
print(json.dumps({"current_path": real_path, "parent_path": parent, "items": items}))
'''
    b64_script = base64.b64encode(script.encode('utf-8')).decode('ascii')
    cmd = f"echo '{b64_script}' | base64 -d | sudo python3"
    stdout, stderr, code = run_remote_command(cmd, sudo=True)
    if code != 0 or not stdout.strip():
        return jsonify({"status": "error", "message": stderr or "Failed to list directory."}), 500
    try:
        res_data = json.loads(stdout.strip())
        if "error" in res_data:
            return jsonify({"status": "error", "message": res_data["error"]}), 400
        res_data["status"] = "success"
        return jsonify(res_data)
    except Exception as e:
        return jsonify({"status": "error", "message": f"Parsing error: {str(e)}"}), 500


@app.route('/api/files/read', methods=['POST'])
def api_files_read():
    data = request.get_json() or {}
    path = str(data.get('path', '')).strip()
    if not path:
        return jsonify({"status": "error", "message": "File path is required."}), 400

    q_path = shlex.quote(path)
    cmd_check = f"sudo stat -c '%s|%F' {q_path} 2>/dev/null"
    stdout, stderr, code = run_remote_command(cmd_check, sudo=True)
    if code != 0 or not stdout.strip():
        return jsonify({"status": "error", "message": f"File does not exist: {path}"}), 404
    parts = stdout.strip().split('|')
    size = int(parts[0]) if parts[0].isdigit() else 0
    if size > 5 * 1024 * 1024:
        return jsonify({"status": "error", "message": f"File is too large ({size} bytes). Maximum supported size for text editing is 5MB."}), 400

    cmd_read = f"sudo base64 -w 0 {q_path}"
    stdout_b64, stderr, code = run_remote_command(cmd_read, sudo=True)
    if code != 0:
        return jsonify({"status": "error", "message": stderr or "Failed to read file."}), 500

    try:
        raw_bytes = base64.b64decode(stdout_b64.strip())
        if b'\x00' in raw_bytes[:1024]:
            return jsonify({"status": "error", "message": "Binary file detected. Binary files cannot be opened in text editor."}), 400
        content = raw_bytes.decode('utf-8', errors='replace')

        is_service = path.endswith('.service') or '/systemd/' in path
        is_nginx = 'nginx' in path or path.endswith('.conf')

        return jsonify({
            "status": "success",
            "path": path,
            "filename": os.path.basename(path),
            "content": content,
            "size": size,
            "is_service": is_service,
            "is_nginx": is_nginx
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/files/write', methods=['POST'])
def api_files_write():
    data = request.get_json() or {}
    path = str(data.get('path', '')).strip()
    content = data.get('content', '')
    create_backup = bool(data.get('backup', True))

    if not path:
        return jsonify({"status": "error", "message": "File path is required."}), 400

    q_path = shlex.quote(path)
    if create_backup:
        q_bak = shlex.quote(f"{path}.bak")
        run_remote_command(f"sudo cp -f {q_path} {q_bak} 2>/dev/null", sudo=True)

    b64_content = base64.b64encode(content.encode('utf-8')).decode('ascii')
    cmd = f"echo {shlex.quote(b64_content)} | base64 -d | sudo tee {q_path} > /dev/null"
    stdout, stderr, code = run_remote_command(cmd, sudo=True)
    if code != 0:
        return jsonify({"status": "error", "message": stderr or "Failed to write file."}), 500

    is_service = path.endswith('.service') or '/systemd/' in path
    is_nginx = 'nginx' in path or path.endswith('.conf')

    return jsonify({
        "status": "success",
        "message": f"Successfully saved {os.path.basename(path)}",
        "path": path,
        "is_service": is_service,
        "is_nginx": is_nginx
    })


@app.route('/api/files/create', methods=['POST'])
def api_files_create():
    data = request.get_json() or {}
    path = str(data.get('path', '')).strip()
    item_type = str(data.get('type', 'file')).strip()
    if not path:
        return jsonify({"status": "error", "message": "Path is required."}), 400

    q_path = shlex.quote(path)
    cmd = f"sudo mkdir -p {q_path}" if item_type == 'dir' else f"sudo touch {q_path}"
    stdout, stderr, code = run_remote_command(cmd, sudo=True)
    if code != 0:
        return jsonify({"status": "error", "message": stderr or "Creation failed."}), 500
    return jsonify({"status": "success", "message": f"Created {item_type}: {os.path.basename(path)}"})


@app.route('/api/files/delete', methods=['POST'])
def api_files_delete():
    data = request.get_json() or {}
    path = str(data.get('path', '')).strip()
    if not path or path in ('/', '/etc', '/root', '/home', '/var', '/usr', '/bin'):
        return jsonify({"status": "error", "message": "Cannot delete protected system directory."}), 400

    cmd = f"sudo rm -rf {shlex.quote(path)}"
    stdout, stderr, code = run_remote_command(cmd, sudo=True)
    if code != 0:
        return jsonify({"status": "error", "message": stderr or "Deletion failed."}), 500
    return jsonify({"status": "success", "message": f"Deleted {os.path.basename(path)}"})


@app.route('/api/files/service-reload', methods=['POST'])
def api_files_service_reload():
    stdout, stderr, code = run_remote_command("sudo systemctl daemon-reload", sudo=True)
    if code == 0:
        return jsonify({"status": "success", "message": "systemd daemon-reload completed successfully."})
    return jsonify({"status": "error", "message": stderr or stdout or "Failed to reload systemd daemon."}), 500


@app.route('/api/files/nginx-test', methods=['POST'])
def api_files_nginx_test():
    stdout, stderr, code = run_remote_command("sudo nginx -t", sudo=True)
    full_output = (stderr.strip() + "\n" + stdout.strip()).strip()
    if code == 0:
        return jsonify({"status": "success", "message": full_output or "Syntax is OK and test is successful."})
    return jsonify({"status": "syntax_error", "message": full_output or "Nginx syntax error detected."}), 400


@app.route('/api/services', methods=['GET'])
def api_services():
    try:
        show_all = request.args.get('all', 'false').lower() in ('true', '1', 't')
        state_arg = "--all" if show_all else "--state=running"
        cmd = f"systemctl list-units --type=service {state_arg} --output=json --no-pager"
        stdout, stderr, code = run_remote_command(cmd)

        if code != 0 or not stdout.strip():
            cmd_fallback = f"systemctl list-units --type=service {state_arg} --no-pager --no-legend"
            stdout_fb, _, code_fb = run_remote_command(cmd_fallback)
            if code_fb == 0 and stdout_fb.strip():
                formatted = []
                for line in stdout_fb.strip().splitlines():
                    parts = line.split(None, 4)
                    if len(parts) >= 4:
                        u_name = parts[0].replace('.service', '')
                        desc = parts[4] if len(parts) > 4 else ""
                        formatted.append({
                            "unit": u_name,
                            "load": parts[1],
                            "active": parts[2],
                            "sub": parts[3],
                            "description": desc
                        })
                return jsonify(formatted)

            return jsonify({
                "status": "error",
                "message": f"Failed to retrieve services: {stderr.strip()}"
            }), 500

        services = json.loads(stdout)
        formatted_services = []
        for s in services:
            unit_name = s.get("unit", "unknown").replace(".service", "")
            formatted_services.append({
                "unit": unit_name,
                "load": s.get("load", "loaded"),
                "active": s.get("active", "active"),
                "sub": s.get("sub", "running"),
                "description": s.get("description", "")
            })
        return jsonify(formatted_services)
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/services/control', methods=['POST'])
def control_service():
    try:
        data = request.get_json() or {}
        unit = data.get("unit")
        action = data.get("action")

        if not unit or not action:
            return jsonify({"status": "error", "message": "Unit and action are required."}), 400

        if action not in ('stop', 'restart'):
            return jsonify({"status": "error", "message": "Invalid action. Must be 'stop' or 'restart'."}), 400

        if not re.match(r'^[a-zA-Z0-9_\-\.\@]+$', unit):
            return jsonify({"status": "error", "message": "Invalid unit name."}), 400

        password = request.headers.get('X-Sudo-Password')
        cmd = f"systemctl {action} {shlex.quote(unit + '.service')}"
        stdout, stderr, code = run_remote_command(cmd, sudo=True, custom_sudo_password=password)

        stderr_lower = stderr.lower()
        if code != 0 and ("incorrect password" in stderr_lower or "try again" in stderr_lower or "password required" in stderr_lower):
            return jsonify({"status": "sudo_auth_required", "message": "Incorrect or required sudo password on remote host."}), 401

        if code == 0:
            return jsonify({"status": "success", "message": f"Successfully performed {action} on service {unit}."})
        return jsonify({"status": "error", "message": stderr.strip() or stdout.strip()}), 500
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/ports', methods=['GET'])
def api_ports():
    try:
        password = request.headers.get('X-Sudo-Password')
        stdout, stderr, code = run_remote_command("ss -tulpn", sudo=True, custom_sudo_password=password)

        if code != 0 or not stdout.strip():
            stdout, stderr, code = run_remote_command("ss -tuln")

        lines = stdout.strip().split('\n')
        ports_list = []

        if len(lines) > 1:
            for line in lines[1:]:
                parts = re.split(r'\s+', line.strip())
                if len(parts) >= 5:
                    netid = parts[0]
                    state = parts[1]
                    local_addr_port = parts[4]

                    process_name = "N/A"
                    pid = "N/A"

                    if len(parts) >= 7:
                        process_col = " ".join(parts[6:])
                        pid_match = re.search(r'pid=(\d+)', process_col)
                        name_match = re.search(r'"([^"]+)"', process_col)
                        if pid_match:
                            pid = pid_match.group(1)
                        if name_match:
                            process_name = name_match.group(1)

                    if ':' in local_addr_port:
                        addr, port = local_addr_port.rsplit(':', 1)
                    else:
                        addr, port = local_addr_port, "unknown"

                    if addr == "*":
                        addr = "0.0.0.0"
                    elif addr == "[::]":
                        addr = "::"

                    ports_list.append({
                        "protocol": netid.upper(),
                        "state": state,
                        "local_address": addr,
                        "port": port,
                        "process": process_name,
                        "pid": pid
                    })

        return jsonify(ports_list)
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/ports/kill', methods=['POST'])
def kill_port_process():
    try:
        data = request.get_json() or {}
        pid = str(data.get("pid", "")).strip()
        port = data.get("port", "")

        if not pid or not pid.isdigit() or pid == "0":
            return jsonify({"status": "error", "message": "Valid numeric PID required."}), 400

        password = request.headers.get('X-Sudo-Password')
        cmd = f"kill -9 {int(pid)}"
        stdout, stderr, code = run_remote_command(cmd, sudo=True, custom_sudo_password=password)

        stderr_lower = stderr.lower()
        if code != 0 and ("incorrect password" in stderr_lower or "try again" in stderr_lower or "password required" in stderr_lower):
            return jsonify({"status": "sudo_auth_required", "message": "Incorrect or required sudo password on remote host."}), 401

        if code == 0:
            return jsonify({"status": "success", "message": f"Successfully terminated PID {pid} listening on port {port}."})
        return jsonify({"status": "error", "message": stderr.strip() or stdout.strip()}), 500
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/memory', methods=['GET'])
def api_memory():
    try:
        data = get_system_vitals()
        data["services"] = get_services_memory()
        data["processes"] = get_top_processes()
        return jsonify(data)
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/logs/<unit>', methods=['GET'])
def api_get_logs(unit):
    if not re.match(r'^[a-zA-Z0-9_\-\.]+$', unit):
        return jsonify({"status": "error", "message": "Invalid unit name."}), 400

    limit = request.args.get('limit', default=50, type=int)
    limit = max(10, min(500, limit))

    try:
        if unit.lower() in ('system', 'syslog', 'systemd'):
            cmd = f"journalctl -n {int(limit)} --no-pager"
        else:
            clean_unit = unit[:-8] if unit.endswith('.service') else unit
            service_name = f"{clean_unit}.service"
            cmd = f"journalctl -u {shlex.quote(service_name)} -n {int(limit)} --no-pager"
        # Run non-sudo first to avoid audit logging loop and disk writes
        stdout, stderr, code = run_remote_command(cmd, sudo=False)

        # Only fallback to sudo if permission is denied
        if code != 0 and ("permission denied" in stderr.lower() or "not privileged" in stderr.lower() or "requires authentication" in stderr.lower()):
            password = request.headers.get('X-Sudo-Password')
            stdout, stderr, code = run_remote_command(cmd, sudo=True, custom_sudo_password=password)

        if code == 0:
            filtered_lines = [
                line for line in stdout.splitlines()
                if not ("sudo[" in line or "pam_unix(sudo:session)" in line or "COMMAND=" in line)
            ]
            logs_content = "\n".join(filtered_lines)
        else:
            logs_content = f"Failed to retrieve logs: {stderr.strip() or stdout.strip()}"

        return jsonify({
            "status": "success",
            "unit": unit,
            "logs": logs_content
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


# ==============================================================================
# User Account Management API Endpoints
# ==============================================================================
@app.route('/api/users', methods=['GET'])
def api_get_users():
    """Retrieve all system and standard user accounts, groups, admin status, and lock status."""
    conn = get_active_conn()
    if not conn:
        return jsonify({"status": "error", "message": "No active remote connection."}), 401

    password = request.headers.get('X-Sudo-Password')

    py_script = """
import sys, os, json, pwd, grp, subprocess

# Detect admin group and members
sudo_members = set()
admin_group_found = 'sudo'
for gname in ('sudo', 'wheel', 'admin'):
    try:
        g = grp.getgrnam(gname)
        sudo_members.update(g.gr_mem)
        admin_group_found = gname
    except KeyError:
        pass

# Lock status from /etc/shadow
shadow_locked = {}
try:
    with open('/etc/shadow', 'r') as f:
        for line in f:
            parts = line.strip().split(':')
            if len(parts) >= 2:
                p = parts[1]
                shadow_locked[parts[0]] = p.startswith('!') or p.startswith('*') or p == ''
except Exception:
    pass

# Currently logged-in users from `who`
logged_in = set()
try:
    out = subprocess.check_output(['who'], stderr=subprocess.DEVNULL, text=True)
    for line in out.splitlines():
        if line.strip():
            logged_in.add(line.split()[0])
except Exception:
    pass

users = []
for p in pwd.getpwall():
    # SSH keys count
    ssh_keys_count = 0
    ak_path = os.path.join(p.pw_dir, '.ssh', 'authorized_keys')
    try:
        if os.path.exists(ak_path):
            with open(ak_path, 'r', errors='ignore') as akf:
                ssh_keys_count = len([l for l in akf if l.strip() and not l.strip().startswith('#')])
    except Exception:
        pass

    user_groups = []
    try:
        user_groups = [g.gr_name for g in grp.getgrall() if p.pw_name in g.gr_mem]
        p_grp = grp.getgrgid(p.pw_gid).gr_name
        if p_grp not in user_groups:
            user_groups.insert(0, p_grp)
    except Exception:
        pass

    is_admin = p.pw_name in sudo_members or ('sudo' in user_groups) or ('wheel' in user_groups) or p.pw_uid == 0
    is_sys = (p.pw_uid < 1000 and p.pw_uid != 0) or p.pw_name == 'nobody'

    users.append({
        'username': p.pw_name,
        'uid': p.pw_uid,
        'gid': p.pw_gid,
        'fullname': p.pw_gecos.split(',')[0] if p.pw_gecos else '',
        'home': p.pw_dir,
        'shell': p.pw_shell,
        'groups': user_groups,
        'is_admin': is_admin,
        'is_locked': shadow_locked.get(p.pw_name, False),
        'is_system': is_sys,
        'is_root': p.pw_uid == 0,
        'is_logged_in': p.pw_name in logged_in,
        'ssh_keys_count': ssh_keys_count
    })

print(json.dumps({'users': users, 'admin_group': admin_group_found}))
"""
    cmd = f"python3 -c {shlex.quote(py_script)}"
    # First try sudo if password is provided or passwordless sudo works
    stdout, stderr, code = run_remote_command(cmd, sudo=True, custom_sudo_password=password)

    # Fallback to non-sudo if sudo auth was required but not given
    stderr_lower = stderr.lower()
    if code != 0 and ("incorrect password" in stderr_lower or "password required" in stderr_lower):
        stdout_nosudo, stderr_nosudo, code_nosudo = run_remote_command(cmd, sudo=False)
        if code_nosudo == 0:
            stdout, stderr, code = stdout_nosudo, stderr_nosudo, code_nosudo

    if code != 0 or not stdout.strip():
        return jsonify({"status": "error", "message": f"Failed to inspect user accounts: {stderr.strip() or stdout.strip()}"}), 500

    try:
        data = json.loads(stdout.strip())
        users_list = data.get('users', [])
        admin_group = data.get('admin_group', 'sudo')
        current_user = conn.get('username', 'opc')

        def sort_key(u):
            if u['username'] == current_user:
                return (0, 0)
            if u['is_root']:
                return (1, 0)
            if not u['is_system']:
                return (2, u['uid'])
            return (3, u['uid'])

        users_list.sort(key=sort_key)

        return jsonify({
            "status": "success",
            "users": users_list,
            "current_user": current_user,
            "admin_group": admin_group
        })
    except Exception as e:
        return jsonify({"status": "error", "message": f"Failed to parse user accounts: {str(e)}"}), 500


@app.route('/api/users/create', methods=['POST'])
def api_create_user():
    """Create a new user account on the remote Linux host."""
    try:
        data = request.get_json() or {}
        username = str(data.get('username', '')).strip().lower()
        fullname = str(data.get('fullname', '')).strip()
        password = str(data.get('password', '')).strip()
        shell = str(data.get('shell', '/bin/bash')).strip()
        is_admin = bool(data.get('is_admin', False))
        ssh_key = str(data.get('ssh_key', '')).strip()

        if not username or not re.match(r'^[a-z_][a-z0-9_-]{0,31}$', username):
            return jsonify({"status": "error", "message": "Invalid username. Must start with a letter/underscore and contain up to 32 alphanumeric/hyphen characters."}), 400

        allowed_shells = ('/bin/bash', '/bin/sh', '/bin/zsh', '/usr/sbin/nologin', '/bin/false')
        if shell not in allowed_shells:
            shell = '/bin/bash'

        sudo_password = request.headers.get('X-Sudo-Password')

        # Check if user already exists
        check_out, _, _ = run_remote_command(f"id {shlex.quote(username)}")
        if check_out.strip():
            return jsonify({"status": "error", "message": f"User '{username}' already exists."}), 400

        # Build useradd command
        gecos = shlex.quote(fullname) if fullname else "''"
        useradd_cmd = f"useradd -m -s {shlex.quote(shell)} -c {gecos} {shlex.quote(username)}"
        stdout, stderr, code = run_remote_command(useradd_cmd, sudo=True, custom_sudo_password=sudo_password)

        if code != 0:
            stderr_l = stderr.lower()
            if "password required" in stderr_l or "incorrect password" in stderr_l:
                return jsonify({"status": "sudo_auth_required", "message": "Sudo authentication required to create user."}), 401
            return jsonify({"status": "error", "message": f"Failed to create user: {stderr.strip() or stdout.strip()}"}), 500

        # Set initial password if provided
        if password:
            chpwd_cmd = f"echo {shlex.quote(f'{username}:{password}')} | chpasswd"
            run_remote_command(chpwd_cmd, sudo=True, custom_sudo_password=sudo_password)

        # Grant admin (sudo / wheel) group if selected
        if is_admin:
            detect_grp_cmd = "getent group sudo >/dev/null 2>&1 && echo sudo || (getent group wheel >/dev/null 2>&1 && echo wheel || echo admin)"
            g_out, _, _ = run_remote_command(detect_grp_cmd, sudo=True, custom_sudo_password=sudo_password)
            target_grp = g_out.strip() or 'sudo'
            run_remote_command(f"usermod -aG {shlex.quote(target_grp)} {shlex.quote(username)}", sudo=True, custom_sudo_password=sudo_password)

        # Add initial authorized SSH public key if provided
        if ssh_key:
            safe_key = ssh_key.replace('\r', '').strip()
            key_cmd = f"""python3 -c "
import os, pwd
u = {repr(username)}
p = pwd.getpwnam(u)
ssh_dir = os.path.join(p.pw_dir, '.ssh')
os.makedirs(ssh_dir, exist_ok=True)
os.chmod(ssh_dir, 0o700)
os.chown(ssh_dir, p.pw_uid, p.pw_gid)
ak_file = os.path.join(ssh_dir, 'authorized_keys')
with open(ak_file, 'a') as f:
    f.write({repr(safe_key + chr(10))})
os.chmod(ak_file, 0o600)
os.chown(ak_file, p.pw_uid, p.pw_gid)
" """
            run_remote_command(key_cmd, sudo=True, custom_sudo_password=sudo_password)

        return jsonify({"status": "success", "message": f"User account '{username}' created successfully."})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/users/delete', methods=['POST'])
def api_delete_user():
    """Delete a user account, with optional home directory removal."""
    try:
        conn = get_active_conn() or {}
        current_user = conn.get('username')

        data = request.get_json() or {}
        username = str(data.get('username', '')).strip().lower()
        remove_home = bool(data.get('remove_home', False))

        if not username or not re.match(r'^[a-z_][a-z0-9_-]{0,31}$', username):
            return jsonify({"status": "error", "message": "Invalid username."}), 400

        if username == 'root':
            return jsonify({"status": "error", "message": "Cannot delete the root superuser account."}), 400

        if username == current_user:
            return jsonify({"status": "error", "message": "Cannot delete the currently connected user session."}), 400

        sudo_password = request.headers.get('X-Sudo-Password')
        del_flag = "-r" if remove_home else ""
        cmd = f"userdel {del_flag} {shlex.quote(username)}"

        stdout, stderr, code = run_remote_command(cmd, sudo=True, custom_sudo_password=sudo_password)
        if code != 0:
            stderr_l = stderr.lower()
            if "password required" in stderr_l or "incorrect password" in stderr_l:
                return jsonify({"status": "sudo_auth_required", "message": "Sudo authentication required to delete user."}), 401
            return jsonify({"status": "error", "message": stderr.strip() or stdout.strip()}), 500

        return jsonify({"status": "success", "message": f"User '{username}' deleted successfully."})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/users/toggle-lock', methods=['POST'])
def api_toggle_lock():
    """Lock or unlock a user's login access."""
    try:
        conn = get_active_conn() or {}
        current_user = conn.get('username')

        data = request.get_json() or {}
        username = str(data.get('username', '')).strip().lower()
        action = str(data.get('action', '')).strip().lower()

        if action not in ('lock', 'unlock'):
            return jsonify({"status": "error", "message": "Action must be 'lock' or 'unlock'."}), 400

        if username == 'root' and action == 'lock':
            return jsonify({"status": "error", "message": "Cannot lock root superuser."}), 400

        if username == current_user and action == 'lock':
            return jsonify({"status": "error", "message": "Cannot lock the currently active SSH user."}), 400

        sudo_password = request.headers.get('X-Sudo-Password')
        flag = "-l" if action == 'lock' else "-u"
        cmd = f"passwd {flag} {shlex.quote(username)}"

        stdout, stderr, code = run_remote_command(cmd, sudo=True, custom_sudo_password=sudo_password)
        if code != 0:
            stderr_l = stderr.lower()
            if "password required" in stderr_l or "incorrect password" in stderr_l:
                return jsonify({"status": "sudo_auth_required", "message": "Sudo authentication required."}), 401
            return jsonify({"status": "error", "message": stderr.strip() or stdout.strip()}), 500

        action_word = "locked" if action == 'lock' else "unlocked"
        return jsonify({"status": "success", "message": f"User '{username}' has been {action_word}."})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/users/toggle-admin', methods=['POST'])
def api_toggle_admin():
    """Grant or revoke administrator (sudo/wheel) privileges for a user."""
    try:
        conn = get_active_conn() or {}
        current_user = conn.get('username')

        data = request.get_json() or {}
        username = str(data.get('username', '')).strip().lower()
        is_admin = bool(data.get('is_admin', False))

        if not username:
            return jsonify({"status": "error", "message": "Username is required."}), 400

        if username == 'root' and not is_admin:
            return jsonify({"status": "error", "message": "Cannot revoke admin privileges from root."}), 400

        if username == current_user and not is_admin:
            return jsonify({"status": "error", "message": "Cannot revoke admin privileges from the currently active session user."}), 400

        sudo_password = request.headers.get('X-Sudo-Password')

        detect_grp_cmd = "getent group sudo >/dev/null 2>&1 && echo sudo || (getent group wheel >/dev/null 2>&1 && echo wheel || echo admin)"
        g_out, _, _ = run_remote_command(detect_grp_cmd, sudo=True, custom_sudo_password=sudo_password)
        target_grp = g_out.strip() or 'sudo'

        if is_admin:
            cmd = f"usermod -aG {shlex.quote(target_grp)} {shlex.quote(username)}"
        else:
            cmd = f"gpasswd -d {shlex.quote(username)} {shlex.quote(target_grp)} || deluser {shlex.quote(username)} {shlex.quote(target_grp)}"

        stdout, stderr, code = run_remote_command(cmd, sudo=True, custom_sudo_password=sudo_password)
        if code != 0:
            stderr_l = stderr.lower()
            if "password required" in stderr_l or "incorrect password" in stderr_l:
                return jsonify({"status": "sudo_auth_required", "message": "Sudo authentication required."}), 401
            return jsonify({"status": "error", "message": stderr.strip() or stdout.strip()}), 500

        status_msg = f"Granted administrator privileges to '{username}'." if is_admin else f"Revoked administrator privileges from '{username}'."
        return jsonify({"status": "success", "message": status_msg})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/users/change-password', methods=['POST'])
def api_change_password():
    """Reset a user's password and optionally force password change on next login."""
    try:
        data = request.get_json() or {}
        username = str(data.get('username', '')).strip().lower()
        password = str(data.get('password', '')).strip()
        force_change = bool(data.get('force_change', False))

        if not username or not password:
            return jsonify({"status": "error", "message": "Username and new password are required."}), 400

        sudo_password = request.headers.get('X-Sudo-Password')
        cmd = f"echo {shlex.quote(f'{username}:{password}')} | chpasswd"
        stdout, stderr, code = run_remote_command(cmd, sudo=True, custom_sudo_password=sudo_password)

        if code != 0:
            stderr_l = stderr.lower()
            if "password required" in stderr_l or "incorrect password" in stderr_l:
                return jsonify({"status": "sudo_auth_required", "message": "Sudo authentication required."}), 401
            return jsonify({"status": "error", "message": stderr.strip() or stdout.strip()}), 500

        if force_change:
            run_remote_command(f"chage -d 0 {shlex.quote(username)}", sudo=True, custom_sudo_password=sudo_password)

        return jsonify({"status": "success", "message": f"Password successfully updated for '{username}'."})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/users/ssh-keys', methods=['POST'])
def api_ssh_keys():
    """Read or update authorized SSH public keys for a specific user."""
    try:
        data = request.get_json() or {}
        username = str(data.get('username', '')).strip().lower()
        action = str(data.get('action', 'get')).strip()
        keys_content = str(data.get('keys', ''))

        if not username:
            return jsonify({"status": "error", "message": "Username is required."}), 400

        sudo_password = request.headers.get('X-Sudo-Password')

        if action == 'get':
            py_read = f"""python3 -c "
import os, pwd
try:
    p = pwd.getpwnam({repr(username)})
    ak = os.path.join(p.pw_dir, '.ssh', 'authorized_keys')
    if os.path.exists(ak):
        with open(ak, 'r', errors='ignore') as f:
            print(f.read())
    else:
        print('')
except Exception:
    print('')
" """
            stdout, stderr, code = run_remote_command(py_read, sudo=True, custom_sudo_password=sudo_password)
            if code != 0 and ("password required" in stderr.lower() or "incorrect password" in stderr.lower()):
                return jsonify({"status": "sudo_auth_required", "message": "Sudo authentication required."}), 401

            return jsonify({"status": "success", "keys": stdout})

        elif action == 'save':
            py_save = f"""python3 -c "
import os, pwd
u = {repr(username)}
p = pwd.getpwnam(u)
ssh_dir = os.path.join(p.pw_dir, '.ssh')
os.makedirs(ssh_dir, exist_ok=True)
os.chmod(ssh_dir, 0o700)
os.chown(ssh_dir, p.pw_uid, p.pw_gid)
ak_file = os.path.join(ssh_dir, 'authorized_keys')
with open(ak_file, 'w') as f:
    f.write({repr(keys_content.replace('\r', ''))})
os.chmod(ak_file, 0o600)
os.chown(ak_file, p.pw_uid, p.pw_gid)
" """
            stdout, stderr, code = run_remote_command(py_save, sudo=True, custom_sudo_password=sudo_password)
            if code != 0 and ("password required" in stderr.lower() or "incorrect password" in stderr.lower()):
                return jsonify({"status": "sudo_auth_required", "message": "Sudo authentication required."}), 401

            if code != 0:
                return jsonify({"status": "error", "message": stderr.strip() or stdout.strip()}), 500

            return jsonify({"status": "success", "message": f"SSH authorized_keys updated for '{username}'."})

        return jsonify({"status": "error", "message": "Invalid action."}), 400
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


if __name__ == '__main__':
    debug_mode = os.environ.get('FLASK_DEBUG', 'False').lower() in ('true', '1', 't')
    app.run(host='0.0.0.0', port=8000, debug=debug_mode)

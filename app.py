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
import paramiko
from flask import Flask, request, jsonify, render_template, redirect, session

app = Flask(__name__)
app.secret_key = os.environ.get('FLASK_SECRET_KEY', 'dashboard-ssh-remote-secret-key-2026')

app.config['TEMPLATES_AUTO_RELOAD'] = True

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


def load_key_from_string(key_text, passphrase=None):
    """Parses a private key string (RSA, Ed25519, ECDSA, DSS) using Paramiko in memory without disk writes."""
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
    allowed_paths = ('/login', '/api/login', '/static/')
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

        client.close()
        return True, "Success"
    except Exception as e:
        return False, str(e)


def get_ssh_client():
    """Establish an SSH client from active connection details."""
    conn = get_active_conn()
    if not conn or not conn.get('host'):
        return None, "No active remote host connection."

    session_id = session.get('session_id')
    key_info = _SESSION_KEYS.get(session_id) if session_id else None
    passphrase = conn.get('passphrase')

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        if key_info and key_info.get('key_content'):
            pkey = load_key_from_string(key_info['key_content'], passphrase)
            client.connect(
                hostname=conn['host'].strip(),
                port=int(conn.get('port', 22)),
                username=conn.get('username', 'opc').strip(),
                pkey=pkey,
                timeout=8,
                banner_timeout=8
            )
            return client, None
        elif conn.get('key_path'):
            key_path = normalize_key_path(conn.get('key_path', ''))
            if not os.path.exists(key_path):
                return None, f"Private key file not found: {key_path}"
            client.connect(
                hostname=conn['host'].strip(),
                port=int(conn.get('port', 22)),
                username=conn.get('username', 'opc').strip(),
                key_filename=key_path,
                password=passphrase.strip() if (passphrase and str(passphrase).strip()) else None,
                timeout=8,
                banner_timeout=8
            )
            return client, None
        else:
            return None, "No SSH key found for this active session."
    except Exception as e:
        return None, f"SSH connection to {conn['host']} failed: {str(e)}"


def run_remote_command(cmd, sudo=False, custom_sudo_password=None):
    """Execute command on the active remote host via SSH."""
    conn = get_active_conn()
    if not conn:
        return "", "No active remote connection.", 1

    client, err = get_ssh_client()
    if err:
        # Fallback to OpenSSH CLI only if key exists on disk
        raw_key_path = conn.get('key_path', '')
        if not raw_key_path:
            return "", err, 1
        key_path = normalize_key_path(raw_key_path)
        if not os.path.exists(key_path):
            return "", err, 1

        host = conn['host']
        user = conn.get('username', 'opc')
        port = str(conn.get('port', 22))
        try:
            full_cmd = cmd
            if sudo:
                pwd = custom_sudo_password or conn.get('sudo_password')
                full_cmd = f"echo '{pwd}' | sudo -S {cmd}" if pwd else f"sudo -n {cmd}"
            ssh_args = [
                "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=5",
                "-i", key_path, "-p", port, f"{user}@{host}", full_cmd
            ]
            res = subprocess.run(ssh_args, capture_output=True, text=True, timeout=12)
            return res.stdout, res.stderr, res.returncode
        except Exception:
            return "", err, 1

    full_cmd = cmd
    if sudo:
        pwd = custom_sudo_password or conn.get('sudo_password')
        if pwd:
            full_cmd = f"echo '{pwd}' | sudo -S {cmd}"
        else:
            full_cmd = f"sudo -n {cmd}"

    try:
        stdin, stdout, stderr = client.exec_command(full_cmd, timeout=12)
        out = stdout.read().decode('utf-8', errors='replace')
        err_out = stderr.read().decode('utf-8', errors='replace')
        code = stdout.channel.recv_exit_status()
        client.close()
        return out, err_out, code
    except Exception as e:
        try:
            client.close()
        except Exception:
            pass
        return "", str(e), 1


_hostname_cache = {"val": None, "host": None, "ts": 0}
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
    return f"OCI-VM ({conn['host']})"


@app.context_processor
def inject_globals():
    conn = get_active_conn() or {}
    return {
        'system_ip': conn.get('host', '127.0.0.1'),
        'system_hostname': get_display_hostname()
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
    session.clear()
    return redirect('/login')


# ==============================================================================
# Page Views
# ==============================================================================
@app.route('/')
def index():
    return redirect('/memory')

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


# ==============================================================================
# API Endpoints
# ==============================================================================
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

    return {
        "status": "success",
        "public_ip": host_ip,
        "hostname": hostname,
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
    return jsonify({
        "status": "success",
        "active": bool(conn),
        "host": conn.get('host', ''),
        "username": conn.get('username', ''),
        "port": conn.get('port', 22),
        "key_path": conn.get('key_path', ''),
        "key_name": conn.get('key_name', 'In-Memory Key'),
        "has_in_memory_key": conn.get('has_in_memory_key', False),
        "hostname": get_display_hostname()
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

    cmd_check = f"sudo stat -c '%s|%F' '{path}' 2>/dev/null"
    stdout, stderr, code = run_remote_command(cmd_check, sudo=True)
    if code != 0 or not stdout.strip():
        return jsonify({"status": "error", "message": f"File does not exist: {path}"}), 404
    parts = stdout.strip().split('|')
    size = int(parts[0]) if parts[0].isdigit() else 0
    if size > 5 * 1024 * 1024:
        return jsonify({"status": "error", "message": f"File is too large ({size} bytes). Maximum supported size for text editing is 5MB."}), 400

    cmd_read = f"sudo base64 -w 0 '{path}'"
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

    if create_backup:
        run_remote_command(f"sudo cp -f '{path}' '{path}.bak' 2>/dev/null", sudo=True)

    b64_content = base64.b64encode(content.encode('utf-8')).decode('ascii')
    cmd = f"echo '{b64_content}' | base64 -d | sudo tee '{path}' > /dev/null"
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

    if item_type == 'dir':
        cmd = f"sudo mkdir -p '{path}'"
    else:
        cmd = f"sudo touch '{path}'"
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

    cmd = f"sudo rm -rf '{path}'"
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
        cmd = "systemctl list-units --type=service --state=running --output=json --no-pager"
        stdout, stderr, code = run_remote_command(cmd)

        if code != 0 or not stdout.strip():
            cmd_fallback = "systemctl list-units --type=service --state=running --no-pager --no-legend"
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
        cmd = f"systemctl {action} {unit}.service"
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
        stdout, stderr, code = run_remote_command(f"kill -9 {pid}", sudo=True, custom_sudo_password=password)

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
    service_name = f"{unit}.service"

    try:
        cmd = f"journalctl -u {service_name} -n {limit} --no-pager"
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


if __name__ == '__main__':
    debug_mode = os.environ.get('FLASK_DEBUG', 'False').lower() in ('true', '1', 't')
    app.run(host='0.0.0.0', port=8000, debug=debug_mode)

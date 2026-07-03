import os
import subprocess
import re
import json
from flask import Flask, request, jsonify, render_template, redirect

app = Flask(__name__)

# Configurable default password for sudo operations, defaults to 'viswa'
DEFAULT_SUDO_PASSWORD = os.environ.get('DASHBOARD_SUDO_PASSWORD', 'viswa')

import logging

class WerkzeugFilter(logging.Filter):
    def filter(self, record):
        msg = record.getMessage()
        if "/api/logs" in msg:
            return False
        if " 304 " in msg or msg.strip().endswith(" 304 -"):
            return False
        return True

werkzeug_logger = logging.getLogger('werkzeug')
werkzeug_logger.addFilter(WerkzeugFilter())

import ctypes
try:
    libc = ctypes.CDLL("libc.so.6")
except Exception:
    libc = None

@app.after_request
def after_request_trim(response):
    if libc:
        try:
            libc.malloc_trim(0)
        except Exception:
            pass
    return response


def get_services_memory():
    service_mem = []
    try:
        # Get current system services with their MemoryCurrent property
        cmd = "systemctl show '*.service' --property=Id,MemoryCurrent --no-pager"
        res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if res.returncode == 0:
            lines = res.stdout.strip().split('\n')
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
                        try:
                            #cat /sys/fs/cgroup/system.slice/flaskapp.service/memory.stat | grep "^anon " | awk '{printf "anon: %.2f MB\n", $2/1024/1024}'3
                            cgroup_stat_path = f"/sys/fs/cgroup/system.slice/{unit}.service/memory.stat"
                            with open(cgroup_stat_path, 'r') as f:
                                for stat_line in f:
                                    if stat_line.startswith('anon '):
                                        current_mem = int(stat_line.split()[1])
                                        break
                        except Exception:
                            pass
                        service_mem.append({
                            "name": unit,
                            "memory": current_mem
                        })
                        current_mem = None
                        
            # Sort by memory descending
            service_mem.sort(key=lambda x: x["memory"], reverse=True)
    except Exception as e:
        pass
    return service_mem

def get_top_processes():
    proc_list = []
    try:
        # Get top 10 memory-consuming processes using ps
        cmd = "ps -eo pid,comm,rss --no-headers --sort=-rss"
        res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if res.returncode == 0:
            lines = res.stdout.strip().split('\n')
            for line in lines[:10]:
                parts = line.strip().split()
                if len(parts) >= 3:
                    pid = parts[0]
                    name = parts[1]
                    try:
                        rss_kb = int(parts[2])
                        memory_bytes = rss_kb * 1024
                        proc_list.append({
                            "pid": pid,
                            "name": name,
                            "memory": memory_bytes
                        })
                    except ValueError:
                        pass
    except Exception as e:
        pass
    return proc_list

# Views
@app.route('/')
def index():
    return redirect('/services')

@app.route('/services')
def services_view():
    return render_template('services.html')

@app.route('/ports')
def ports_view():
    return render_template('ports.html')

@app.route('/memory')
def memory_view():
    return render_template('memory.html')



@app.route('/api/services', methods=['GET'])
def api_services():
    try:
        import platform
        if platform.system() == 'Windows':
            # Mock running services for Windows development environment
            mock_services = [
                {"unit": "dashboard", "load": "loaded", "active": "active", "sub": "running", "description": "Dashboard Web App Service"},
                {"unit": "dbus", "load": "loaded", "active": "active", "sub": "running", "description": "D-Bus System Message Bus"},
                {"unit": "ssh", "load": "loaded", "active": "active", "sub": "running", "description": "OpenSSH Daemon"},
                {"unit": "systemd-journald", "load": "loaded", "active": "active", "sub": "running", "description": "Journal Service"},
                {"unit": "NetworkManager", "load": "loaded", "active": "active", "sub": "running", "description": "Network Manager"},
                {"unit": "polkit", "load": "loaded", "active": "active", "sub": "running", "description": "Authorization Manager"}
            ]
            return jsonify(mock_services)

        # Check systemd active services using JSON output format
        cmd = "systemctl list-units --type=service --state=running --output=json --no-pager"
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, check=True)
        
        # Parse output JSON
        services = json.loads(result.stdout)
        
        formatted_services = []
        has_flask_service = False
        for s in services:
            unit_name = s.get("unit", "unknown").replace(".service", "")
            if unit_name == 'dashboard':
                has_flask_service = True
            formatted_services.append({
                "unit": unit_name,
                "load": s.get("load", "loaded"),
                "active": s.get("active", "active"),
                "sub": s.get("sub", "running"),
                "description": s.get("description", "")
            })
            
        # If the flask service is not running in systemd, inject the manual python process row
        if not has_flask_service:
            formatted_services.insert(0, {
                "unit": "dashboard",
                "load": "loaded",
                "active": "active",
                "sub": "running (manual)",
                "description": "Flask Application (Running via terminal)"
            })
        return jsonify(formatted_services)
    except Exception as e:
        return jsonify({
            "status": "error",
            "message": f"Failed to retrieve services: {str(e)}"
        }), 500

@app.route('/api/services/control', methods=['POST'])
def control_service():
    try:
        data = request.get_json() or {}
        unit = data.get("unit")
        action = data.get("action")
        
        if not unit or not action:
            return jsonify({
                "status": "error",
                "message": "Unit and action are required."
            }), 400
            
        if action not in ('stop', 'restart'):
            return jsonify({
                "status": "error",
                "message": "Invalid action. Must be 'stop' or 'restart'."
            }), 400
            
        # Validate unit name to prevent shell injection
        if not re.match(r'^[a-zA-Z0-9_\-\.\@]+$', unit):
            return jsonify({
                "status": "error",
                "message": "Invalid unit name."
            }), 400
            
        import platform
        if platform.system() == 'Windows':
            return jsonify({
                "status": "success",
                "message": f"[Windows Mock] Successfully performed {action} on service {unit}."
            })
            
        password = request.headers.get('X-Sudo-Password', DEFAULT_SUDO_PASSWORD)
        # Execute systemctl command using sudo
        cmd = f"echo {password} | sudo -S systemctl {action} {unit}.service"
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        
        stderr_lower = result.stderr.lower()
        if result.returncode != 0 and ("incorrect password" in stderr_lower or "try again" in stderr_lower or "password required" in stderr_lower):
            return jsonify({
                "status": "sudo_auth_required",
                "message": "Incorrect sudo password or sudo authorization required."
            }), 401
            
        if result.returncode == 0:
            return jsonify({
                "status": "success",
                "message": f"Successfully performed {action} on service {unit}."
            })
        else:
            return jsonify({
                "status": "error",
                "message": f"Failed to control service: {result.stderr.strip()}"
            }), 500
    except Exception as e:
        return jsonify({
            "status": "error",
            "message": str(e)
        }), 500

@app.route('/api/ports', methods=['GET'])
def api_ports():
    try:
        # Try using sudo ss -tulpn first
        password = request.headers.get('X-Sudo-Password', DEFAULT_SUDO_PASSWORD)
        cmd = f"echo {password} | sudo -S ss -tulpn"
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        
        # Check if password was wrong
        stderr_lower = result.stderr.lower()
        if result.returncode != 0 and ("incorrect password" in stderr_lower or "try again" in stderr_lower or "password required" in stderr_lower):
            # Only return 401 if they explicitly sent a custom password (i.e. not the default password)
            if request.headers.get('X-Sudo-Password') and request.headers.get('X-Sudo-Password') != DEFAULT_SUDO_PASSWORD:
                return jsonify({
                    "status": "sudo_auth_required",
                    "message": "Incorrect sudo password."
                }), 401
            
            # Otherwise, fall back to non-sudo ss -tuln
            cmd = "ss -tuln"
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        elif result.returncode != 0 or not result.stdout.strip():
            cmd = "ss -tuln"
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
            
        lines = result.stdout.strip().split('\n')
        ports_list = []
        
        if len(lines) > 1:
            for line in lines[1:]:
                parts = re.split(r'\s+', line.strip())
                if len(parts) >= 5:
                    netid = parts[0]
                    state = parts[1]
                    local_addr_port = parts[4]
                    
                    # Extract process details if present
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
                            
                    # Separate address and port
                    if ':' in local_addr_port:
                        addr, port = local_addr_port.rsplit(':', 1)
                    else:
                        addr = local_addr_port
                        port = "unknown"
                        
                    # Standardize local host formats for display
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
        return jsonify({
            "status": "error",
            "message": f"Failed to retrieve ports: {str(e)}"
        }), 500

@app.route('/api/ports/kill', methods=['POST'])
def kill_port_process():
    try:
        data = request.get_json() or {}
        pid = data.get("pid")
        port = data.get("port")
        
        if not pid or pid == "N/A":
            return jsonify({
                "status": "error",
                "message": "Invalid PID provided."
            }), 400
            
        # Validate PID is numeric
        if not str(pid).isdigit():
            return jsonify({
                "status": "error",
                "message": "PID must be numeric."
            }), 400
            
        # Execute kill command using sudo
        password = request.headers.get('X-Sudo-Password', DEFAULT_SUDO_PASSWORD)
        cmd = f"echo {password} | sudo -S kill -9 {pid}"
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        
        stderr_lower = result.stderr.lower()
        if result.returncode != 0 and ("incorrect password" in stderr_lower or "try again" in stderr_lower or "password required" in stderr_lower):
            return jsonify({
                "status": "sudo_auth_required",
                "message": "Incorrect sudo password or sudo authorization required."
            }), 401
            
        if result.returncode == 0:
            return jsonify({
                "status": "success",
                "message": f"Successfully terminated process with PID {pid} listening on port {port}."
            })
        else:
            return jsonify({
                "status": "error",
                "message": f"Failed to kill process: {result.stderr.strip()}"
            }), 500
    except Exception as e:
        return jsonify({
            "status": "error",
            "message": str(e)
        }), 500

@app.route('/api/memory', methods=['GET'])
def api_memory():
    try:
        import platform
        if platform.system() == 'Windows':
            total = 4 * 1024 * 1024 * 1024 # 4 GB
            used = int(total * 0.45) # 45% used
            free = total - used
            available = free
            buffers = int(total * 0.05)
            cached = int(total * 0.15)
            used_percent = 45.0
            
            swap_total = 2 * 1024 * 1024 * 1024 # 2 GB
            swap_used = int(swap_total * 0.1) # 10% used
            swap_free = swap_total - swap_used
            swap_percent = 10.0
            
            services_mem = [
                {"unit": "dashboard", "memory": 128 * 1024 * 1024, "formatted": "128.00 MB"},
                {"unit": "dbus", "memory": 16 * 1024 * 1024, "formatted": "16.00 MB"},
                {"unit": "ssh", "memory": 24 * 1024 * 1024, "formatted": "24.00 MB"},
                {"unit": "systemd-journald", "memory": 64 * 1024 * 1024, "formatted": "64.00 MB"},
                {"unit": "NetworkManager", "memory": 48 * 1024 * 1024, "formatted": "48.00 MB"}
            ]
            
            processes_mem = [
                {"pid": 1234, "name": "python", "memory": 128 * 1024 * 1024, "formatted": "128.00 MB"},
                {"pid": 5678, "name": "dbus-daemon", "memory": 16 * 1024 * 1024, "formatted": "16.00 MB"},
                {"pid": 9012, "name": "sshd", "memory": 24 * 1024 * 1024, "formatted": "24.00 MB"}
            ]
            
            return jsonify({
                "ram": {
                    "total": total,
                    "used": used,
                    "free": free,
                    "available": available,
                    "buffers_cached": buffers + cached,
                    "used_percent": used_percent
                },
                "swap": {
                    "total": swap_total,
                    "used": swap_used,
                    "free": swap_free,
                    "used_percent": swap_percent
                },
                "services": services_mem,
                "processes": processes_mem
            })

        meminfo = {}
        with open('/proc/meminfo', 'r') as f:
            for line in f:
                parts = line.split(':')
                if len(parts) == 2:
                    name = parts[0].strip()
                    val_str = parts[1].strip().split()[0]
                    meminfo[name] = int(val_str) * 1024 # convert to Bytes
                    
        total = meminfo.get('MemTotal', 0)
        free = meminfo.get('MemFree', 0)
        available = meminfo.get('MemAvailable', 0)
        buffers = meminfo.get('Buffers', 0)
        cached = meminfo.get('Cached', 0)
        
        # Calculate RAM usage
        if available > 0:
            used = total - available
        else:
            used = total - free - buffers - cached
            
        used_percent = round((used / total) * 100, 1) if total > 0 else 0
        
        # Swap usage
        swap_total = meminfo.get('SwapTotal', 0)
        swap_free = meminfo.get('SwapFree', 0)
        swap_used = swap_total - swap_free
        swap_percent = round((swap_used / swap_total) * 100, 1) if swap_total > 0 else 0
        
        # Service memory breakdown
        services_mem = get_services_memory()
        
        # Top processes memory breakdown
        processes_mem = get_top_processes()
        
        return jsonify({
            "ram": {
                "total": total,
                "used": used,
                "free": free,
                "available": available,
                "buffers_cached": buffers + cached,
                "used_percent": used_percent
            },
            "swap": {
                "total": swap_total,
                "used": swap_used,
                "free": swap_free,
                "used_percent": swap_percent
            },
            "services": services_mem,
            "processes": processes_mem
        })
    except Exception as e:
        return jsonify({
            "status": "error",
            "message": f"Failed to retrieve memory stats: {str(e)}"
        }), 500


@app.route('/logs')
def logs_view():
    unit = request.args.get('unit', default='dashboard')
    if unit not in ('flaskapp', 'dashboard'):
        unit = 'dashboard'
    return render_template('logs.html', selected_unit=unit)

@app.route('/api/logs/<unit>', methods=['GET'])
def api_get_logs(unit):
    if unit not in ('flaskapp', 'dashboard'):
        return jsonify({
            "status": "error",
            "message": "Access denied. Logs are only available for flaskapp and dashboard."
        }), 403
        
    limit = request.args.get('limit', default=50, type=int)
    if limit <= 0 or limit > 500:
        limit = 50
        
    service_name = f"{unit}.service"
    
    try:
        import platform
        if platform.system() == 'Windows':
            import datetime
            now = datetime.datetime.now().strftime("%b %d %H:%M:%S")
            logs_content = (
                f"{now} radxa systemd[1]: Starting {service_name}...\n"
                f"{now} radxa systemd[1]: Started {service_name}.\n"
                f"{now} radxa {unit}[1234]: [Simulated Windows log row 1]\n"
                f"{now} radxa {unit}[1234]: [Simulated Windows log row 2]"
            )
        else:
            password = request.headers.get('X-Sudo-Password', DEFAULT_SUDO_PASSWORD)
            cmd = f"echo {password} | sudo -S journalctl -u {service_name} -n {limit} --no-pager"
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
            
            stderr_lower = result.stderr.lower()
            if result.returncode != 0 and ("incorrect password" in stderr_lower or "try again" in stderr_lower or "password required" in stderr_lower):
                if request.headers.get('X-Sudo-Password') and request.headers.get('X-Sudo-Password') != DEFAULT_SUDO_PASSWORD:
                    return jsonify({
                        "status": "sudo_auth_required",
                        "message": "Incorrect sudo password or sudo authorization required."
                    }), 401
                
                # Fallback to non-sudo journalctl
                cmd_fallback = f"journalctl -u {service_name} -n {limit} --no-pager"
                result = subprocess.run(cmd_fallback, shell=True, capture_output=True, text=True)
                
            if result.returncode == 0:
                # Filter out sudo polling/execution noise to prevent feedback loops in log view
                filtered_lines = []
                for line in result.stdout.splitlines():
                    if "sudo[" in line or "pam_unix(sudo:session)" in line or "COMMAND=" in line:
                        continue
                    filtered_lines.append(line)
                logs_content = "\n".join(filtered_lines)
            else:
                logs_content = f"Failed to retrieve logs: {result.stderr.strip()}"
                
        return jsonify({
            "status": "success",
            "unit": unit,
            "logs": logs_content
        })
    except Exception as e:
        return jsonify({
            "status": "error",
            "message": str(e)
        }), 500


if __name__ == '__main__':
    import os
    debug_mode = os.environ.get('FLASK_DEBUG', 'False').lower() in ('true', '1', 't')
    app.run(host='0.0.0.0', port=8000)

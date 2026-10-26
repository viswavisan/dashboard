// Global Layout and UI utilities
document.addEventListener('DOMContentLoaded', () => {
    // Sidebar toggle for mobile layouts
    const sidebar = document.getElementById('app-sidebar');
    const sidebarToggle = document.getElementById('sidebar-toggle');

    if (sidebarToggle && sidebar) {
        sidebarToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            sidebar.classList.toggle('open');
        });

        // Close sidebar when clicking outside on mobile
        document.addEventListener('click', (e) => {
            if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && e.target !== sidebarToggle) {
                sidebar.classList.remove('open');
            }
        });
    }

    // Live system clock ticker
    const systemTimeEl = document.getElementById('system-time');
    if (systemTimeEl) {
        const updateTime = () => {
            const now = new Date();
            systemTimeEl.textContent = now.toTimeString().split(' ')[0];
        };
        updateTime();
        setInterval(updateTime, 1000);
    }

    initServicesControl();
    initPortsControl();
    initMemoryControl();
    initLogsControl();
    initServersControl();
    initFilesControl();
});

// Helper: Format bytes to human readable sizes
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}


// Helper: Authenticated fetch wrapper for sudo password prompts
async function authenticatedFetch(url, options = {}) {
    if (!options.headers) {
        options.headers = {};
    }

    // Retrieve sudo password from sessionStorage
    const savedPassword = sessionStorage.getItem('sudo_password');
    options.headers['X-Sudo-Password'] = savedPassword;

    let response = await fetch(url, options);

    if (response.status === 401) {
        // Clear cached wrong password
        sessionStorage.removeItem('sudo_password');

        // Prompt user
        const newPassword = prompt("Sudo password authorization required:");
        if (newPassword !== null) {
            const passwordToUse = newPassword.trim();
            sessionStorage.setItem('sudo_password', passwordToUse);
            options.headers['X-Sudo-Password'] = passwordToUse;
            // Retry the fetch
            response = await fetch(url, options);
        }
    }

    return response;
}


// ==========================================
// 2. RUNNING SERVICES CONTROLLER
// ==========================================
function initServicesControl() {
    const servicesList = document.getElementById('services-list');
    if (!servicesList) return; // Not on Services page

    const searchInput = document.getElementById('services-search');
    const refreshBtn = document.getElementById('refresh-services-btn');
    const autoRefreshCb = document.getElementById('auto-refresh-services');
    const countBadge = document.getElementById('running-count');
    const statusMsg = document.getElementById('services-status-msg');

    let servicesCache = [];
    const criticalServices = ['ssh', 'sshd', 'dbus', 'systemd-journald', 'NetworkManager', 'systemd-resolved', 'polkit'];

    async function fetchServices() {
        const refreshIcon = refreshBtn ? refreshBtn.querySelector('svg') : null;
        if (refreshIcon) refreshIcon.classList.add('spinning');
        statusMsg.textContent = 'Updating services...';

        try {
            const response = await fetch('/api/services');
            if (!response.ok) throw new Error('Query error');
            servicesCache = await response.json();
            renderServices();

            const timestamp = new Date().toTimeString().split(' ')[0];
            statusMsg.textContent = `Synced at ${timestamp}`;
        } catch (error) {
            statusMsg.textContent = `Sync Error: ${error.message}`;
        } finally {
            if (refreshIcon) refreshIcon.classList.remove('spinning');
        }
    }

    function renderServices() {
        const query = searchInput.value.toLowerCase().trim();
        const filtered = servicesCache.filter(s =>
            s.unit.toLowerCase().includes(query) ||
            s.description.toLowerCase().includes(query)
        );

        if (filtered.length === 0) {
            servicesList.innerHTML = `
                <tr>
                    <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 30px;">
                        No services matches the search query.
                    </td>
                </tr>
            `;
            countBadge.textContent = '0 Matches';
            return;
        }

        servicesList.innerHTML = filtered.map(s => {
            const isCritical = criticalServices.includes(s.unit);
            const stopDisabled = isCritical ? 'disabled' : '';
            return `
                <tr>
                    <td style="font-weight: 600; color: #fff;">${s.unit}</td>
                    <td><span class="badge badge-secondary">${s.load}</span></td>
                    <td><span class="badge badge-success">${s.active}</span></td>
                    <td><span class="badge badge-success">${s.sub}</span></td>
                    <td class="desc-col">${s.description}</td>
                    <td style="text-align: right; white-space: nowrap;">
                        <a href="/logs?unit=${encodeURIComponent(s.unit)}" class="btn-info" style="margin-right: 4px; text-decoration: none;">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                <polyline points="14 2 14 8 20 8"></polyline>
                                <line x1="16" y1="13" x2="8" y2="13"></line>
                                <line x1="16" y1="17" x2="8" y2="17"></line>
                            </svg>
                            <span>Logs</span>
                        </a>
                        <button class="btn-warning" onclick="controlService('${s.unit}', 'restart')" style="margin-right: 4px;">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
                            </svg>
                            <span>Restart</span>
                        </button>
                        <button class="btn-danger" ${stopDisabled} onclick="controlService('${s.unit}', 'stop')">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                            </svg>
                            <span>Stop</span>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

        countBadge.textContent = `${filtered.length} Active`;
    }

    // Service control action handler
    window.controlService = async function (unit, action) {
        if (!confirm(`Are you sure you want to ${action} the service "${unit}"?`)) {
            return;
        }

        statusMsg.textContent = `${action === 'stop' ? 'Stopping' : 'Restarting'} ${unit}...`;

        try {
            const response = await authenticatedFetch('/api/services/control', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ unit, action })
            });
            const data = await response.json();
            if (response.ok && data.status === 'success') {
                statusMsg.textContent = data.message;
                fetchServices(); // Reload list
            } else {
                alert(`Error: ${data.message || 'Action failed.'}`);
                statusMsg.textContent = `Action failed.`;
            }
        } catch (error) {
            alert(`Network Error: ${error.message}`);
            statusMsg.textContent = `Network error.`;
        }
    };

    // Bind events
    if (searchInput) searchInput.addEventListener('input', renderServices);
    if (refreshBtn) refreshBtn.addEventListener('click', fetchServices);

    // Auto polling (2 minutes)
    setInterval(() => {
        if (autoRefreshCb && autoRefreshCb.checked) {
            fetchServices();
        }
    }, 120000);

    // Initial load
    fetchServices();
}

// ==========================================
// 3. ACTIVE PORTS CONTROLLER
// ==========================================
function initPortsControl() {
    const portsList = document.getElementById('ports-list');
    if (!portsList) return; // Not on Ports page

    const searchInput = document.getElementById('ports-search');
    const protoFilter = document.getElementById('protocol-filter');
    const refreshBtn = document.getElementById('refresh-ports-btn');
    const autoRefreshCb = document.getElementById('auto-refresh-ports');
    const countBadge = document.getElementById('ports-count');
    const statusMsg = document.getElementById('ports-status-msg');

    let portsCache = [];

    async function fetchPorts() {
        const refreshIcon = refreshBtn ? refreshBtn.querySelector('svg') : null;
        if (refreshIcon) refreshIcon.classList.add('spinning');
        statusMsg.textContent = 'Updating ports...';

        try {
            const response = await authenticatedFetch('/api/ports');
            if (!response.ok) throw new Error('Query error');
            portsCache = await response.json();
            renderPorts();

            const timestamp = new Date().toTimeString().split(' ')[0];
            statusMsg.textContent = `Synced at ${timestamp}`;
        } catch (error) {
            statusMsg.textContent = `Sync Error: ${error.message}`;
        } finally {
            if (refreshIcon) refreshIcon.classList.remove('spinning');
        }
    }

    function renderPorts() {
        const query = searchInput.value.toLowerCase().trim();
        const selectedProto = protoFilter.value;

        const filtered = portsCache.filter(p => {
            const matchesSearch = p.port.toString().includes(query) ||
                p.process.toLowerCase().includes(query) ||
                p.local_address.includes(query);
            const matchesProto = selectedProto === 'ALL' || p.protocol === selectedProto;
            return matchesSearch && matchesProto;
        });

        if (filtered.length === 0) {
            portsList.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">
                        No open ports matched your criteria.
                    </td>
                </tr>
            `;
            countBadge.textContent = '0 Matches';
            return;
        }

        portsList.innerHTML = filtered.map(p => {
            const protoBadgeClass = p.protocol === 'TCP' ? 'badge-primary' : 'badge-warning';
            const isDisable = p.pid === 'N/A' || p.pid === '';
            const disabledAttr = isDisable ? 'disabled' : '';
            return `
                <tr>
                    <td><span class="badge ${protoBadgeClass}">${p.protocol}</span></td>
                    <td><span class="badge badge-secondary">${p.state}</span></td>
                    <td style="font-family: monospace; font-size: 0.85rem;">${p.local_address}</td>
                    <td style="font-weight: 600; color: var(--accent-cyan); font-family: monospace;">${p.port}</td>
                    <td style="font-weight: 500;">${p.process}</td>
                    <td style="font-family: monospace; color: var(--text-muted); font-size: 0.85rem;">${p.pid}</td>
                    <td style="text-align: right;">
                        <button class="btn-danger" ${disabledAttr} onclick="killPortProcess('${p.pid}', '${p.port}', '${p.process}')">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                            <span>Kill</span>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');

        countBadge.textContent = `${filtered.length} Open`;
    }

    // Process kill handler
    window.killPortProcess = async function (pid, port, processName) {
        if (!confirm(`Are you sure you want to terminate process "${processName}" (PID ${pid}) listening on port ${port}?`)) {
            return;
        }

        try {
            statusMsg.textContent = `Terminating PID ${pid}...`;
            const response = await authenticatedFetch('/api/ports/kill', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ pid, port })
            });
            const data = await response.json();
            if (response.ok && data.status === 'success') {
                statusMsg.textContent = data.message;
                fetchPorts(); // Refresh table immediately
            } else {
                alert(`Error: ${data.message || 'Failed to terminate process.'}`);
                statusMsg.textContent = `Failed to kill process.`;
            }
        } catch (error) {
            alert(`Network Error: ${error.message}`);
            statusMsg.textContent = `Network error.`;
        }
    };

    // Bind events
    if (searchInput) searchInput.addEventListener('input', renderPorts);
    if (protoFilter) protoFilter.addEventListener('change', renderPorts);
    if (refreshBtn) refreshBtn.addEventListener('click', fetchPorts);

    // Auto polling (2 minutes)
    setInterval(() => {
        if (autoRefreshCb && autoRefreshCb.checked) {
            fetchPorts();
        }
    }, 120000);

    // Initial load
    fetchPorts();
}

// ==========================================
// 4. MEMORY UTILIZATION CONTROLLER
// ==========================================
function initMemoryControl() {
    const ramPctEl = document.getElementById('ram-pct');
    if (!ramPctEl) return; // Not on Memory page

    const ramFill = document.getElementById('ram-gauge-fill');
    const ramTotal = document.getElementById('ram-total');
    const ramUsed = document.getElementById('ram-used');
    const ramFree = document.getElementById('ram-free');
    const ramCached = document.getElementById('ram-cached');

    const swapPctEl = document.getElementById('swap-pct');
    const swapFill = document.getElementById('swap-gauge-fill');
    const swapTotal = document.getElementById('swap-total');
    const swapUsed = document.getElementById('swap-used');
    const swapFree = document.getElementById('swap-free');

    const refreshBtn = document.getElementById('refresh-memory-btn');
    const autoRefreshCb = document.getElementById('auto-refresh-memory');

    const serviceList = document.getElementById('service-memory-list');
    const breakdownCount = document.getElementById('memory-breakdown-count');

    // Gauge Circumference (radius is 50)
    // C = 2 * PI * r = 314.159
    const gaugeCircumference = 314.159;

    function setGaugePercentage(element, circle, pct) {
        if (element) element.textContent = `${pct}%`;
        if (circle) {
            const offset = gaugeCircumference - (pct / 100) * gaugeCircumference;
            circle.style.strokeDashoffset = offset;
        }
    }

    async function fetchMemory() {
        const refreshIcon = refreshBtn ? refreshBtn.querySelector('svg') : null;
        if (refreshIcon) refreshIcon.classList.add('spinning');

        try {
            const response = await fetch('/api/memory');
            if (!response.ok) throw new Error('Query error');
            const data = await response.json();

            // 1. System Vitals Banner: Public IP, Hostname, Uptime, Load Average
            const vitalIp = document.getElementById('vital-ip');
            const vitalUptime = document.getElementById('vital-uptime');
            const vitalLoadAvg = document.getElementById('vital-loadavg');
            const vitalHostname = document.getElementById('vital-hostname');

            if (vitalIp && data.public_ip) vitalIp.textContent = data.public_ip;
            if (vitalUptime && data.uptime) vitalUptime.textContent = data.uptime;
            if (vitalLoadAvg && data.load_average) {
                vitalLoadAvg.textContent = data.load_average.map(v => typeof v === 'number' ? v.toFixed(2) : v).join(', ');
            }
            if (vitalHostname && data.hostname) vitalHostname.textContent = data.hostname;

            // 2. CPU Utilization Details
            const cpuPctEl = document.getElementById('cpu-pct');
            const cpuFill = document.getElementById('cpu-gauge-fill');
            const cpuCores = document.getElementById('cpu-cores');
            const cpuLoad1 = document.getElementById('cpu-load1');
            const cpuLoad5 = document.getElementById('cpu-load5');
            const cpuLoad15 = document.getElementById('cpu-load15');

            if (data.cpu) {
                setGaugePercentage(cpuPctEl, cpuFill, data.cpu.percent || 0);
                if (cpuCores) cpuCores.textContent = `${data.cpu.cores || 1} Cores`;
            }
            if (data.load_average && data.load_average.length >= 3) {
                if (cpuLoad1) cpuLoad1.textContent = Number(data.load_average[0]).toFixed(2);
                if (cpuLoad5) cpuLoad5.textContent = Number(data.load_average[1]).toFixed(2);
                if (cpuLoad15) cpuLoad15.textContent = Number(data.load_average[2]).toFixed(2);
            }

            // 3. Storage (Disk /) Details
            const diskPctEl = document.getElementById('disk-pct');
            const diskFill = document.getElementById('disk-gauge-fill');
            const diskTotal = document.getElementById('disk-total');
            const diskUsed = document.getElementById('disk-used');
            const diskFree = document.getElementById('disk-free');
            const diskMount = document.getElementById('disk-mount');

            if (data.disk) {
                setGaugePercentage(diskPctEl, diskFill, data.disk.percent || 0);
                if (diskTotal) diskTotal.textContent = formatBytes(data.disk.total || 0);
                if (diskUsed) diskUsed.textContent = formatBytes(data.disk.used || 0);
                if (diskFree) diskFree.textContent = formatBytes(data.disk.free || 0);
                if (diskMount) diskMount.textContent = data.disk.mount || '/';
            }

            // 4. RAM Details
            setGaugePercentage(ramPctEl, ramFill, data.ram.used_percent);
            if (ramTotal) ramTotal.textContent = formatBytes(data.ram.total);
            if (ramUsed) ramUsed.textContent = formatBytes(data.ram.used);
            if (ramFree) ramFree.textContent = formatBytes(data.ram.available);
            if (ramCached) ramCached.textContent = formatBytes(data.ram.buffers_cached);

            // 5. Swap Details
            setGaugePercentage(swapPctEl, swapFill, data.swap.used_percent);
            if (swapTotal) swapTotal.textContent = formatBytes(data.swap.total);
            if (swapUsed) swapUsed.textContent = formatBytes(data.swap.used);
            if (swapFree) swapFree.textContent = formatBytes(data.swap.free);

            // Services Memory Breakdown Table
            if (serviceList && data.services) {
                if (breakdownCount) breakdownCount.textContent = `${data.services.length} services tracked`;

                if (data.services.length === 0) {
                    serviceList.innerHTML = `
                        <tr>
                            <td colspan="3" style="text-align: center; color: var(--text-muted); padding: 30px;">
                                No active services reporting memory metrics.
                            </td>
                        </tr>
                    `;
                } else {
                    const totalRam = data.ram.total;
                    serviceList.innerHTML = data.services.map(s => {
                        const pctOfTotal = totalRam > 0 ? ((s.memory / totalRam) * 100).toFixed(2) : 0;
                        return `
                            <tr>
                                <td style="font-weight: 600; color: #fff;">${s.name}</td>
                                <td style="font-family: monospace; font-weight: 500; color: var(--accent-cyan);">${formatBytes(s.memory)}</td>
                                <td>
                                    <div class="proportion-bar-container">
                                        <div class="proportion-bar-outer">
                                            <div class="proportion-bar-inner" style="width: ${pctOfTotal}%;"></div>
                                        </div>
                                        <span class="proportion-pct-text">${pctOfTotal}%</span>
                                    </div>
                                </td>
                            </tr>
                        `;
                    }).join('');
                }
            }

            // Process Memory Breakdown Table
            const processList = document.getElementById('process-memory-list');
            const processBreakdownCount = document.getElementById('process-breakdown-count');
            if (processList && data.processes) {
                if (processBreakdownCount) processBreakdownCount.textContent = `${data.processes.length} processes tracked`;

                if (data.processes.length === 0) {
                    processList.innerHTML = `
                        <tr>
                            <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 30px;">
                                No active processes reporting memory metrics.
                            </td>
                        </tr>
                    `;
                } else {
                    const totalRam = data.ram.total;
                    processList.innerHTML = data.processes.map(p => {
                        const pctOfTotal = totalRam > 0 ? ((p.memory / totalRam) * 100).toFixed(2) : 0;
                        return `
                            <tr>
                                <td style="font-family: monospace; color: var(--text-muted); font-size: 0.85rem;">${p.pid}</td>
                                <td style="font-weight: 600; color: #fff;">${p.name}</td>
                                <td style="font-family: monospace; font-weight: 500; color: var(--accent-cyan);">${formatBytes(p.memory)}</td>
                                <td>
                                    <div class="proportion-bar-container">
                                        <div class="proportion-bar-outer">
                                            <div class="proportion-bar-inner" style="width: ${pctOfTotal}%;"></div>
                                        </div>
                                        <span class="proportion-pct-text">${pctOfTotal}%</span>
                                    </div>
                                </td>
                            </tr>
                        `;
                    }).join('');
                }
            }

        } catch (error) {
            console.error('Failed to sync memory stats:', error);
        } finally {
            if (refreshIcon) refreshIcon.classList.remove('spinning');
        }
    }

    // Bind events
    if (refreshBtn) refreshBtn.addEventListener('click', fetchMemory);

    // Auto polling (every 2 minutes)
    setInterval(() => {
        if (autoRefreshCb && autoRefreshCb.checked) {
            fetchMemory();
        }
    }, 120000);

    // Initial load
    fetchMemory();
}


// ==========================================
// 6. APPLICATION LOGS CONTROLLER
// ==========================================
function initLogsControl() {
    const logsContainer = document.getElementById('logs-container');
    if (!logsContainer) return; // Not on Logs page

    const logsOutput = document.getElementById('logs-output');
    const logsSearch = document.getElementById('logs-search');
    const serviceSelect = document.getElementById('logs-service-select');
    const limitSelect = document.getElementById('logs-limit-select');
    const autoRefreshCb = document.getElementById('auto-refresh-logs');
    const refreshBtn = document.getElementById('refresh-logs-btn');
    const copyBtn = document.getElementById('copy-logs-btn');
    const terminalTitle = document.getElementById('terminal-title');

    let rawLogs = '';
    let autoRefreshInterval = null;

    async function fetchLogs() {
        const unit = serviceSelect.value;
        const limit = limitSelect ? limitSelect.value : 50;
        const refreshIcon = refreshBtn ? refreshBtn.querySelector('svg') : null;
        if (refreshIcon) refreshIcon.classList.add('spinning');

        if (terminalTitle) {
            terminalTitle.textContent = (unit === 'system' || unit === 'syslog')
                ? 'System Journal (Syslog) - all units'
                : `${unit}.service - stdout/stderr logs`;
        }

        try {
            const response = await fetch(`/api/logs/${unit}?limit=${limit}`);
            if (!response.ok) throw new Error('Query error');
            const data = await response.json();

            if (data.status === 'success') {
                rawLogs = data.logs || '';
                renderLogs();
            } else {
                throw new Error(data.message || 'Fetch failed');
            }
        } catch (error) {
            logsOutput.textContent = `Error fetching logs: ${error.message}`;
            logsOutput.style.color = 'var(--error-color)';
        } finally {
            if (refreshIcon) refreshIcon.classList.remove('spinning');
        }
    }

    async function loadAvailableServices(selectedUnit) {
        try {
            const response = await fetch('/api/services?all=true');
            if (!response.ok) return;
            const services = await response.json();
            if (!Array.isArray(services) || services.length === 0) return;

            const activeUnit = serviceSelect.value || selectedUnit || 'dashboard';

            // Partition into groups
            const coreAppUnits = new Set(['dashboard', 'flaskapp']);
            const runningServices = [];
            const otherServices = [];

            services.forEach(s => {
                const u = s.unit;
                if (!u || u === 'unknown' || coreAppUnits.has(u)) return;
                if (s.sub === 'running' || s.active === 'active') {
                    runningServices.push(s);
                } else {
                    otherServices.push(s);
                }
            });

            runningServices.sort((a, b) => a.unit.localeCompare(b.unit));
            otherServices.sort((a, b) => a.unit.localeCompare(b.unit));

            let html = '';

            // Group 1: Core & System
            html += '<optgroup label="System & Applications">';
            html += `<option value="dashboard"${activeUnit === 'dashboard' ? ' selected' : ''}>dashboard.service</option>`;
            html += `<option value="system"${activeUnit === 'system' ? ' selected' : ''}>System Journal (Syslog)</option>`;
            if (services.some(s => s.unit === 'flaskapp')) {
                html += `<option value="flaskapp"${activeUnit === 'flaskapp' ? ' selected' : ''}>flaskapp.service</option>`;
            }
            html += '</optgroup>';

            // Group 2: Running Services
            if (runningServices.length > 0) {
                html += '<optgroup label="Running Services">';
                runningServices.forEach(s => {
                    const sel = activeUnit === s.unit ? ' selected' : '';
                    html += `<option value="${s.unit}"${sel}>${s.unit}.service</option>`;
                });
                html += '</optgroup>';
            }

            // Group 3: Other Services
            if (otherServices.length > 0) {
                html += '<optgroup label="Other Available Services">';
                otherServices.forEach(s => {
                    const sel = activeUnit === s.unit ? ' selected' : '';
                    html += `<option value="${s.unit}"${sel}>${s.unit}.service (${s.active})</option>`;
                });
                html += '</optgroup>';
            }

            serviceSelect.innerHTML = html;

            // Ensure custom unit passed via query exists in dropdown
            if (!Array.from(serviceSelect.options).some(o => o.value === activeUnit)) {
                const opt = document.createElement('option');
                opt.value = activeUnit;
                opt.textContent = `${activeUnit}.service`;
                opt.selected = true;
                serviceSelect.insertBefore(opt, serviceSelect.firstChild);
            }
            serviceSelect.value = activeUnit;
        } catch (e) {
            console.warn('Could not populate full services list for logs dropdown:', e);
        }
    }

    function renderLogs() {
        logsOutput.style.color = '#cbd5e1'; // Reset color
        const query = logsSearch ? logsSearch.value.toLowerCase().trim() : '';

        if (!rawLogs) {
            logsOutput.textContent = 'No logs found for this service.';
            const el200 = document.getElementById('status-200-count');
            const el404 = document.getElementById('status-404-count');
            const el500 = document.getElementById('status-500-count');
            if (el200) el200.textContent = '0';
            if (el404) el404.textContent = '0';
            if (el500) el500.textContent = '0';
            return;
        }

        // Parse status codes from all log lines
        let count200 = 0;
        let count404 = 0;
        let count500 = 0;
        const allLines = rawLogs.split('\n');
        allLines.forEach(line => {
            const match = line.match(/"\s+(\d{3})\s+[\d\-]+/);
            if (match) {
                const status = match[1];
                if (status === '200') count200++;
                else if (status === '404') count404++;
                else if (status === '500') count500++;
            }
        });

        const el200 = document.getElementById('status-200-count');
        const el404 = document.getElementById('status-404-count');
        const el500 = document.getElementById('status-500-count');
        if (el200) el200.textContent = count200;
        if (el404) el404.textContent = count404;
        if (el500) el500.textContent = count500;

        if (!query) {
            logsOutput.textContent = rawLogs;
        } else {
            const lines = rawLogs.split('\n');
            const filteredLines = lines.filter(line => line.toLowerCase().includes(query));
            if (filteredLines.length === 0) {
                logsOutput.textContent = `No log lines matching "${query}" found.`;
            } else {
                logsOutput.textContent = filteredLines.join('\n');
            }
        }

        // Auto-scroll logs to bottom
        logsContainer.scrollTop = logsContainer.scrollHeight;
    }

    function setupAutoRefresh() {
        if (autoRefreshInterval) clearInterval(autoRefreshInterval);
        if (autoRefreshCb && autoRefreshCb.checked) {
            autoRefreshInterval = setInterval(fetchLogs, 120000);
        }
    }

    // Event listeners
    if (serviceSelect) {
        serviceSelect.addEventListener('change', () => {
            const unit = serviceSelect.value;
            // Update URL without page reload
            try {
                const newUrl = new URL(window.location);
                newUrl.searchParams.set('unit', unit);
                window.history.replaceState({}, '', newUrl);
            } catch (e) {}

            fetchLogs();
            setupAutoRefresh();
        });
    }

    if (limitSelect) {
        limitSelect.addEventListener('change', () => {
            fetchLogs();
        });
    }

    if (logsSearch) {
        logsSearch.addEventListener('input', () => {
            renderLogs();
        });
    }

    if (autoRefreshCb) {
        autoRefreshCb.addEventListener('change', () => {
            setupAutoRefresh();
        });
    }

    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            fetchLogs();
        });
    }

    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            const textToCopy = logsOutput.textContent;
            navigator.clipboard.writeText(textToCopy).then(() => {
                const originalText = copyBtn.innerHTML;
                copyBtn.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; color: var(--success-color);">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                    <span style="font-size: 0.75rem; color: var(--success-color);">Copied!</span>
                `;
                setTimeout(() => {
                    copyBtn.innerHTML = originalText;
                }, 2000);
            }).catch(err => {
                alert('Failed to copy logs: ' + err);
            });
        });
    }

    // Initial load
    const urlParams = new URLSearchParams(window.location.search);
    const unitParam = urlParams.get('unit') || (logsContainer ? logsContainer.getAttribute('data-unit') : 'dashboard');
    if (unitParam) {
        let exists = Array.from(serviceSelect.options).some(opt => opt.value === unitParam);
        if (!exists) {
            const opt = document.createElement('option');
            opt.value = unitParam;
            opt.textContent = (unitParam === 'system' || unitParam === 'syslog') ? 'System Journal (Syslog)' : `${unitParam}.service`;
            serviceSelect.appendChild(opt);
        }
        serviceSelect.value = unitParam;
    }

    // Populate full dynamic list of system services in the background
    loadAvailableServices(unitParam);

    fetchLogs().then(() => {
        logsContainer.scrollTop = logsContainer.scrollHeight;
    });
    setupAutoRefresh();
}


// ==========================================
// 7. GLOBAL UTILITIES & CLIPBOARD
// ==========================================
window.copyToClipboard = function(text) {
    if (!text) return;
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => {
            showGlobalToast(`Copied to clipboard: ${text}`);
        }).catch(() => {
            fallbackCopy(text);
        });
    } else {
        fallbackCopy(text);
    }
};

function fallbackCopy(text) {
    const tempInput = document.createElement('input');
    tempInput.value = text;
    document.body.appendChild(tempInput);
    tempInput.select();
    try {
        document.execCommand('copy');
        showGlobalToast(`Copied to clipboard: ${text}`);
    } catch (e) {
        prompt("Copy text manually:", text);
    }
    document.body.removeChild(tempInput);
}

function showGlobalToast(msg, duration = 2500) {
    let toast = document.getElementById('server-toast') || document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'dynamic-toast';
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.display = 'block';
    setTimeout(() => {
        toast.style.display = 'none';
    }, duration);
}


// ==========================================
// 8. SERVER FLEET & SAVED SESSIONS CONTROLLER
// ==========================================
function initServersControl() {
    const serversGrid = document.getElementById('servers-grid');
    if (!serversGrid) return; // Not on Server List page

    const STORAGE_KEY = 'ssh_dashboard_saved_sessions';
    const serverSearch = document.getElementById('server-search');
    const savedCountBadge = document.getElementById('saved-server-count');
    const addServerBtn = document.getElementById('btn-add-server');
    const modal = document.getElementById('server-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalCloseBtn = document.getElementById('btn-close-modal');
    const modalCancelBtn = document.getElementById('btn-cancel-modal');
    const serverForm = document.getElementById('server-form');

    const inputOrigName = document.getElementById('edit-orig-name');
    const inputName = document.getElementById('server-name');
    const inputHost = document.getElementById('server-host');
    const inputPort = document.getElementById('server-port');
    const inputUser = document.getElementById('server-user');
    const inputKey = document.getElementById('server-key');
    const inputSudo = document.getElementById('server-sudo');

    let activeHostInfo = null;

    function getSavedSessions() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) return JSON.parse(raw);
        } catch (e) {
            console.error(e);
        }
        return {};
    }

    function saveSessions(sessions) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
        } catch (e) {
            console.error(e);
        }
    }

    async function loadActiveServer() {
        try {
            const res = await fetch('/api/servers/active');
            if (res.ok) {
                const data = await res.json();
                if (data.status === 'success') {
                    activeHostInfo = data;
                    const ipEl = document.getElementById('active-host-ip');
                    const nameEl = document.getElementById('active-host-name');
                    if (ipEl && data.host) ipEl.textContent = data.host;
                    if (nameEl && data.hostname) nameEl.textContent = data.hostname;

                    // If user has no saved sessions yet, seed the current one
                    const sessions = getSavedSessions();
                    if (Object.keys(sessions).length === 0 && data.host) {
                        const seedName = data.hostname && data.hostname !== 'Not Connected' 
                            ? `OCI Ampere (${data.hostname})` 
                            : 'OCI Ampere VM';
                        sessions[seedName] = {
                            name: seedName,
                            host: data.host,
                            port: data.port || 22,
                            username: data.username || 'opc',
                            key_path: data.key_path || '',
                            sudo_password: ''
                        };
                        saveSessions(sessions);
                    }
                }
            }
        } catch (e) {
            console.error('Failed to query active server:', e);
        }
        renderServerGrid();
    }

    function renderServerGrid() {
        const sessions = getSavedSessions();
        const names = Object.keys(sessions);
        const filter = (serverSearch ? serverSearch.value.trim().toLowerCase() : '');

        const filteredNames = names.filter(name => {
            const s = sessions[name];
            return name.toLowerCase().includes(filter) ||
                   (s.host && s.host.toLowerCase().includes(filter)) ||
                   (s.username && s.username.toLowerCase().includes(filter));
        });

        if (savedCountBadge) {
            savedCountBadge.textContent = `${names.length} saved`;
        }

        if (names.length === 0) {
            serversGrid.innerHTML = `
                <div class="empty-servers-card dashboard-card">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
                        <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
                        <line x1="6" y1="6" x2="6.01" y2="6"></line>
                        <line x1="6" y1="18" x2="6.01" y2="18"></line>
                    </svg>
                    <h4>No Saved Servers in Browser Memory</h4>
                    <p>Click "Add Server" to save connection profiles for your fleet.</p>
                </div>
            `;
            return;
        }

        if (filteredNames.length === 0) {
            serversGrid.innerHTML = `
                <div class="empty-servers-card dashboard-card">
                    <h4>No matching servers found</h4>
                    <p>Try refining your search keyword.</p>
                </div>
            `;
            return;
        }

        const activeIp = activeHostInfo ? activeHostInfo.host : null;

        serversGrid.innerHTML = filteredNames.map(name => {
            const s = sessions[name];
            const isCurrent = activeIp && s.host && (s.host.trim() === activeIp.trim());

            return `
                <div class="server-card dashboard-card ${isCurrent ? 'is-active-server' : ''}">
                    <div class="server-card-header">
                        <div class="server-title-group">
                            <span class="server-indicator-dot ${isCurrent ? 'online' : 'offline'}"></span>
                            <h4 class="server-card-name" title="${name}">${name}</h4>
                        </div>
                        ${isCurrent 
                            ? '<span class="status-pill status-online">Connected</span>' 
                            : '<span class="status-pill status-saved">Saved</span>'}
                    </div>

                    <div class="server-card-body">
                        <div class="server-meta-row">
                            <span class="s-label">Public IP</span>
                            <div class="ip-copy-group">
                                <span class="s-value font-mono highlight-ip">${s.host || 'unconfigured'}</span>
                                <button class="btn-copy-mini" onclick="copyToClipboard('${s.host}')" title="Copy IP">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                                    </svg>
                                </button>
                            </div>
                        </div>

                        <div class="server-meta-row">
                            <span class="s-label">User & Port</span>
                            <span class="s-value font-mono">${s.username || 'opc'} : ${s.port || 22}</span>
                        </div>

                        <div class="server-meta-row">
                            <span class="s-label">Key</span>
                            <span class="s-value font-mono key-path-truncate" title="${s.key_name || s.key_path || 'In-Memory Key'}">${s.key_name || (s.key_path ? s.key_path.split('\\').pop().split('/').pop() : (s.key_content ? 'In-Memory Key' : 'None'))}</span>
                        </div>
                    </div>

                    <div class="server-card-footer">
                        ${isCurrent 
                            ? `<button class="btn btn-secondary btn-sm" disabled style="opacity: 0.6; cursor: default;">
                                   <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                       <polyline points="20 6 9 17 4 12"></polyline>
                                   </svg>
                                   <span>Active Now</span>
                               </button>`
                            : `<button class="btn btn-primary btn-sm btn-switch-host" onclick="switchToServer('${name.replace(/'/g, "\\'")}')">
                                   <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                       <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                                   </svg>
                                   <span>Connect</span>
                               </button>`
                        }
                        <div class="server-btn-actions">
                            <button class="btn-icon-btn" onclick="openEditServerModal('${name.replace(/'/g, "\\'")}')" title="Edit Server">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                                </svg>
                            </button>
                            <button class="btn-icon-btn btn-danger-hover" onclick="deleteServer('${name.replace(/'/g, "\\'")}')" title="Delete Profile">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="3 6 5 6 21 6"></polyline>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    // Connect / Switch to server
    window.switchToServer = async function(name) {
        const sessions = getSavedSessions();
        const s = sessions[name];
        if (!s) return;

        showGlobalToast(`Connecting to ${name}...`, 5000);
        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    host: s.host,
                    port: s.port || 22,
                    username: s.username,
                    key_path: s.key_path || '',
                    key_content: s.key_content || '',
                    key_name: s.key_name || '',
                    passphrase: s.passphrase || '',
                    sudo_password: s.sudo_password || ''
                })
            });
            const data = await res.json();
            if (res.ok && data.status === 'success') {
                showGlobalToast(`Connected to ${name}! Loading vitals...`);
                setTimeout(() => {
                    window.location.href = '/memory';
                }, 600);
            } else {
                alert(`Connection failed: ${data.message || 'Unknown error'}`);
                showGlobalToast(`Failed to connect to ${name}.`);
            }
        } catch (e) {
            alert(`Network error connecting to ${name}: ${e.message}`);
        }
    };

    // Open Edit Modal
    window.openEditServerModal = function(name) {
        const sessions = getSavedSessions();
        const s = sessions[name];
        if (!s) return;

        modalTitle.textContent = `Edit "${name}"`;
        inputOrigName.value = name;
        inputName.value = s.name || name;
        inputHost.value = s.host || '';
        inputPort.value = s.port || 22;
        inputUser.value = s.username || 'opc';
        inputKey.value = s.key_path || (s.key_content ? `[In-Memory Key: ${s.key_name || 'Uploaded'}]` : '');
        inputSudo.value = s.sudo_password || '';

        modal.style.display = 'flex';
    };

    // Delete Server
    window.deleteServer = function(name) {
        if (!confirm(`Are you sure you want to delete profile "${name}"?`)) return;
        const sessions = getSavedSessions();
        delete sessions[name];
        saveSessions(sessions);
        showGlobalToast(`Deleted profile "${name}"`);
        renderServerGrid();
    };

    // Open Add Server Modal
    if (addServerBtn) {
        addServerBtn.addEventListener('click', () => {
            modalTitle.textContent = 'Add Remote Server';
            inputOrigName.value = '';
            inputName.value = '';
            inputHost.value = '';
            inputPort.value = 22;
            inputUser.value = 'opc';
            inputKey.value = '';
            inputSudo.value = '';
            modal.style.display = 'flex';
        });
    }

    const closeModal = () => {
        modal.style.display = 'none';
    };

    if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeModal);
    if (modalCancelBtn) modalCancelBtn.addEventListener('click', closeModal);
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
    }

    // Save Server Form Submit
    if (serverForm) {
        serverForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const origName = inputOrigName.value.trim();
            const newName = inputName.value.trim();
            const host = inputHost.value.trim();
            const port = parseInt(inputPort.value, 10) || 22;
            const user = inputUser.value.trim();
            const keyVal = inputKey.value.trim();
            const sudo = inputSudo.value;

            if (!newName || !host || !user) {
                alert('Please fill in Name, Host, and Username.');
                return;
            }

            const sessions = getSavedSessions();
            const existing = (origName && sessions[origName]) ? sessions[origName] : {};

            // If renamed, remove old key
            if (origName && origName !== newName) {
                delete sessions[origName];
            }

            const isMemoryPlaceholder = keyVal.startsWith('[In-Memory');
            const finalKeyPath = isMemoryPlaceholder ? '' : keyVal;
            const finalKeyContent = isMemoryPlaceholder ? (existing.key_content || '') : (keyVal ? '' : (existing.key_content || ''));
            const finalKeyName = isMemoryPlaceholder ? (existing.key_name || 'In-Memory Key') : (keyVal ? keyVal.split(/[/\\]/).pop() : (existing.key_name || 'In-Memory Key'));

            sessions[newName] = {
                name: newName,
                host: host,
                port: port,
                username: user,
                key_path: finalKeyPath,
                key_content: finalKeyContent,
                key_name: finalKeyName,
                passphrase: existing.passphrase || '',
                sudo_password: sudo
            };

            saveSessions(sessions);
            closeModal();
            showGlobalToast(`Saved "${newName}" to browser memory.`);
            renderServerGrid();
        });
    }

    if (serverSearch) {
        serverSearch.addEventListener('input', renderServerGrid);
    }

    // Initial load for server fleet page
    loadActiveServer();
}


// ==========================================
// 9. REMOTE FILE BROWSER & EDITOR CONTROLLER
// ==========================================
function initFilesControl() {
    const fileListTbody = document.getElementById('file-list-tbody');
    if (!fileListTbody) return; // Not on Files page

    let currentDir = sessionStorage.getItem('last_browser_path') || '/etc/systemd/system';
    let currentFiles = [];
    let activeFilePath = null;
    let originalFileContent = '';
    let isDirty = false;

    // Elements
    const breadcrumbsContainer = document.getElementById('breadcrumbs-container');
    const directPathInput = document.getElementById('direct-path-input');
    const directPathForm = document.getElementById('path-direct-form');
    const btnUpDir = document.getElementById('btn-up-dir');
    const btnRefresh = document.getElementById('btn-refresh-files');
    const fileSearchFilter = document.getElementById('file-search-filter');
    const dirCountBadge = document.getElementById('dir-count-badge');
    const bookmarkPills = document.querySelectorAll('.bookmark-pill');

    const editorEmptyState = document.getElementById('editor-empty-state');
    const editorActiveState = document.getElementById('editor-active-state');
    const editorFilePath = document.getElementById('editor-file-path');
    const editorFileIcon = document.getElementById('editor-file-icon');
    const editorDirtyIndicator = document.getElementById('editor-dirty-indicator');
    const codeArea = document.getElementById('file-code-area');
    const lineNumbers = document.getElementById('line-numbers');
    const alertBanner = document.getElementById('editor-alert-banner');

    const btnSave = document.getElementById('btn-editor-save');
    const btnReload = document.getElementById('btn-editor-reload');
    const btnCopy = document.getElementById('btn-editor-copy');
    const btnDaemonReload = document.getElementById('btn-daemon-reload');
    const btnNginxTest = document.getElementById('btn-nginx-test');

    const footerLinesCount = document.getElementById('footer-lines-count');
    const footerSize = document.getElementById('footer-size');
    const footerCursorPos = document.getElementById('footer-cursor-pos');
    const footerStatusMsg = document.getElementById('footer-status-msg');

    // Modals
    const newItemModal = document.getElementById('new-item-modal');
    const newItemTitle = document.getElementById('modal-new-item-title');
    const newItemType = document.getElementById('new-item-type');
    const newItemName = document.getElementById('new-item-name');
    const newItemForm = document.getElementById('new-item-form');
    const btnNewFile = document.getElementById('btn-new-file');
    const btnNewFolder = document.getElementById('btn-new-folder');

    // Helper: File Icon based on extension
    function getFileIcon(filename, isDir, isSymlink) {
        if (isDir) return '📁';
        if (isSymlink) return '🔗';
        const lower = filename.toLowerCase();
        if (lower.endsWith('.service') || lower.endsWith('.target') || lower.endsWith('.socket')) return '⚙️';
        if (lower.endsWith('.conf') || lower.includes('nginx')) return '🌐';
        if (lower.endsWith('.sh') || lower.endsWith('.bash')) return '📜';
        if (lower.endsWith('.log')) return '📄';
        if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml')) return '🔣';
        if (lower.endsWith('.py')) return '🐍';
        return '📄';
    }

    // Update Line Numbers
    function updateLineNumbers() {
        if (!codeArea || !lineNumbers) return;
        const lines = codeArea.value.split('\n');
        const count = lines.length;
        lineNumbers.innerHTML = Array.from({ length: count }, (_, i) => `<div>${i + 1}</div>`).join('');
        if (footerLinesCount) footerLinesCount.textContent = `${count} line${count === 1 ? '' : 's'}`;
        if (footerSize) footerSize.textContent = formatBytes(new Blob([codeArea.value]).size);
    }

    // Sync scrolling of line numbers with textarea
    if (codeArea && lineNumbers) {
        codeArea.addEventListener('scroll', () => {
            lineNumbers.scrollTop = codeArea.scrollTop;
        });
    }

    // Update Cursor Position
    function updateCursorPos() {
        if (!codeArea || !footerCursorPos) return;
        const text = codeArea.value.substring(0, codeArea.selectionStart);
        const lines = text.split('\n');
        const line = lines.length;
        const col = lines[lines.length - 1].length + 1;
        footerCursorPos.textContent = `Ln ${line}, Col ${col}`;
    }

    // Tab key indentation support in textarea
    if (codeArea) {
        codeArea.addEventListener('keydown', (e) => {
            // Ctrl+S / Cmd+S save shortcut
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                saveActiveFile();
                return;
            }

            // Tab key indents with 4 spaces
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = codeArea.selectionStart;
                const end = codeArea.selectionEnd;
                codeArea.value = codeArea.value.substring(0, start) + '    ' + codeArea.value.substring(end);
                codeArea.selectionStart = codeArea.selectionEnd = start + 4;
                markDirty(true);
                updateLineNumbers();
                updateCursorPos();
            }
        });

        codeArea.addEventListener('input', () => {
            markDirty(true);
            updateLineNumbers();
            updateCursorPos();
        });

        codeArea.addEventListener('click', updateCursorPos);
        codeArea.addEventListener('keyup', updateCursorPos);
    }

    function markDirty(dirty) {
        isDirty = dirty;
        if (editorDirtyIndicator) {
            editorDirtyIndicator.style.display = dirty ? 'inline' : 'none';
        }
        if (footerStatusMsg) {
            footerStatusMsg.textContent = dirty ? 'Unsaved changes' : 'Ready';
        }
    }

    // Render Breadcrumbs
    function renderBreadcrumbs(path) {
        if (!breadcrumbsContainer) return;
        const parts = path.split('/').filter(Boolean);
        let accumulated = '';
        let html = `<button type="button" class="crumb-btn" onclick="navigateToDir('/')">/</button>`;

        parts.forEach((part, idx) => {
            accumulated += '/' + part;
            const full = accumulated;
            const isLast = idx === parts.length - 1;
            html += `<span class="crumb-sep">/</span>`;
            if (isLast) {
                html += `<span class="crumb-current">${part}</span>`;
            } else {
                html += `<button type="button" class="crumb-btn" onclick="navigateToDir('${full}')">${part}</button>`;
            }
        });

        breadcrumbsContainer.innerHTML = html;
        if (directPathInput) directPathInput.value = path;
    }

    // Load Directory
    window.navigateToDir = async function(path) {
        if (!path) return;
        fileListTbody.innerHTML = `
            <tr class="placeholder-row">
                <td colspan="4" style="text-align: center; padding: 40px; color: var(--text-muted);">
                    <div class="loader-spinner"></div>
                    <span>Scanning ${path}...</span>
                </td>
            </tr>
        `;

        try {
            const res = await authenticatedFetch('/api/files/list', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path })
            });
            const data = await res.json();

            if (res.ok && data.status === 'success') {
                currentDir = data.current_path;
                currentFiles = data.items || [];
                sessionStorage.setItem('last_browser_path', currentDir);
                renderBreadcrumbs(currentDir);
                renderFileList();
            } else {
                fileListTbody.innerHTML = `
                    <tr>
                        <td colspan="4" style="text-align: center; color: #ef4444; padding: 30px;">
                            Error: ${data.message || 'Failed to read directory'}
                        </td>
                    </tr>
                `;
            }
        } catch (e) {
            fileListTbody.innerHTML = `
                <tr>
                    <td colspan="4" style="text-align: center; color: #ef4444; padding: 30px;">
                        Network error loading directory: ${e.message}
                    </td>
                </tr>
            `;
        }
    };

    // Render File List Table
    function renderFileList() {
        const filter = (fileSearchFilter ? fileSearchFilter.value.trim().toLowerCase() : '');
        const filtered = currentFiles.filter(item => item.name.toLowerCase().includes(filter));

        if (dirCountBadge) {
            dirCountBadge.textContent = `${filtered.length} item${filtered.length === 1 ? '' : 's'}`;
        }

        if (filtered.length === 0) {
            fileListTbody.innerHTML = `
                <tr>
                    <td colspan="4" style="text-align: center; color: var(--text-muted); padding: 30px;">
                        No items found in this directory.
                    </td>
                </tr>
            `;
            return;
        }

        fileListTbody.innerHTML = filtered.map(item => {
            const fullPath = (currentDir === '/' ? '/' : currentDir + '/') + item.name;
            const icon = getFileIcon(item.name, item.is_dir, item.is_symlink);
            const sizeDisplay = item.is_dir ? '--' : formatBytes(item.size);

            return `
                <tr class="file-item-row ${item.is_dir ? 'is-dir' : 'is-file'}">
                    <td>
                        <div class="file-name-cell" onclick="${item.is_dir ? `navigateToDir('${fullPath.replace(/'/g, "\\'")}')` : `openFile('${fullPath.replace(/'/g, "\\'")}')`}">
                            <span class="file-icon">${icon}</span>
                            <span class="file-name-text ${item.is_dir ? 'dir-name' : 'regular-file-name'}" title="${item.name}">${item.name}</span>
                        </div>
                    </td>
                    <td class="font-mono text-muted text-xs">${item.mode || '--'}</td>
                    <td class="font-mono text-xs">${sizeDisplay}</td>
                    <td style="text-align: right;">
                        <button type="button" class="btn-icon-mini btn-danger-hover" onclick="event.stopPropagation(); deleteFileItem('${fullPath.replace(/'/g, "\\'")}', ${item.is_dir})" title="Delete ${item.name}">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                        </button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    // Open File in Editor
    window.openFile = async function(filePath) {
        if (isDirty) {
            if (!confirm('You have unsaved changes in the current file. Discard changes and open this file?')) {
                return;
            }
        }

        if (footerStatusMsg) footerStatusMsg.textContent = 'Opening file...';
        hideAlertBanner();

        try {
            const res = await authenticatedFetch('/api/files/read', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: filePath })
            });
            const data = await res.json();

            if (res.ok && data.status === 'success') {
                activeFilePath = data.path;
                originalFileContent = data.content || '';

                if (editorEmptyState) editorEmptyState.style.display = 'none';
                if (editorActiveState) editorActiveState.style.display = 'flex';

                if (editorFilePath) editorFilePath.textContent = data.path;
                if (editorFileIcon) editorFileIcon.textContent = getFileIcon(data.filename, false, false);
                if (codeArea) {
                    codeArea.value = originalFileContent;
                    codeArea.scrollTop = 0;
                }

                // Show context action buttons
                if (btnDaemonReload) btnDaemonReload.style.display = data.is_service ? 'inline-flex' : 'none';
                if (btnNginxTest) btnNginxTest.style.display = data.is_nginx ? 'inline-flex' : 'none';

                markDirty(false);
                updateLineNumbers();
                updateCursorPos();
                if (footerStatusMsg) footerStatusMsg.textContent = 'File loaded';
            } else {
                alert(`Cannot open file: ${data.message || 'Unknown error'}`);
                if (footerStatusMsg) footerStatusMsg.textContent = 'Open failed';
            }
        } catch (e) {
            alert(`Network error opening file: ${e.message}`);
        }
    };

    window.openPresetFile = function(path) {
        openFile(path);
    };

    // Save Active File
    async function saveActiveFile() {
        if (!activeFilePath) return;

        const content = codeArea ? codeArea.value : '';
        if (footerStatusMsg) footerStatusMsg.textContent = 'Saving file...';
        btnSave.disabled = true;

        try {
            const res = await authenticatedFetch('/api/files/write', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: activeFilePath,
                    content: content,
                    backup: true
                })
            });
            const data = await res.json();

            if (res.ok && data.status === 'success') {
                originalFileContent = content;
                markDirty(false);
                const now = new Date().toLocaleTimeString();
                if (footerStatusMsg) footerStatusMsg.textContent = `Saved at ${now}`;
                showGlobalToast(`Saved ${activeFilePath.split('/').pop()} successfully!`);

                // If user edited an nginx or systemd file, prompt or show contextual banner
                if (data.is_service) {
                    showAlertBanner('info', `File saved! Recommended: Click <strong>"daemon-reload"</strong> to apply changes.`);
                } else if (data.is_nginx) {
                    showAlertBanner('info', `Nginx file saved! Recommended: Click <strong>"nginx -t"</strong> to verify syntax.`);
                }
            } else {
                alert(`Failed to save file: ${data.message || 'Unknown error'}`);
                if (footerStatusMsg) footerStatusMsg.textContent = 'Save failed';
            }
        } catch (e) {
            alert(`Network error saving file: ${e.message}`);
            if (footerStatusMsg) footerStatusMsg.textContent = 'Network error';
        } finally {
            btnSave.disabled = false;
        }
    }

    // Delete Item
    window.deleteFileItem = async function(filePath, isDir) {
        const itemType = isDir ? 'folder' : 'file';
        const name = filePath.split('/').pop();
        if (!confirm(`Are you sure you want to permanently delete this ${itemType}: "${name}"?`)) {
            return;
        }

        try {
            const res = await authenticatedFetch('/api/files/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: filePath })
            });
            const data = await res.json();
            if (res.ok && data.status === 'success') {
                showGlobalToast(`Deleted ${name}`);
                if (activeFilePath === filePath) {
                    editorActiveState.style.display = 'none';
                    editorEmptyState.style.display = 'flex';
                    activeFilePath = null;
                }
                navigateToDir(currentDir);
            } else {
                alert(`Delete failed: ${data.message || 'Permission denied'}`);
            }
        } catch (e) {
            alert(`Error deleting item: ${e.message}`);
        }
    };

    // Alert Banner Helper
    function showAlertBanner(type, messageHtml) {
        if (!alertBanner) return;
        alertBanner.className = `editor-alert-banner alert-${type}`;
        alertBanner.innerHTML = messageHtml;
        alertBanner.style.display = 'block';
    }

    function hideAlertBanner() {
        if (alertBanner) alertBanner.style.display = 'none';
    }

    // Context Action: daemon-reload
    if (btnDaemonReload) {
        btnDaemonReload.addEventListener('click', async () => {
            btnDaemonReload.disabled = true;
            showAlertBanner('info', 'Executing <code>systemctl daemon-reload</code>...');
            try {
                const res = await authenticatedFetch('/api/files/service-reload', { method: 'POST' });
                const data = await res.json();
                if (res.ok && data.status === 'success') {
                    showAlertBanner('success', `✔ ${data.message}`);
                    showGlobalToast('systemd daemon-reload successful!');
                } else {
                    showAlertBanner('error', `❌ ${data.message}`);
                }
            } catch (e) {
                showAlertBanner('error', `Network error: ${e.message}`);
            } finally {
                btnDaemonReload.disabled = false;
            }
        });
    }

    // Context Action: nginx -t
    if (btnNginxTest) {
        btnNginxTest.addEventListener('click', async () => {
            btnNginxTest.disabled = true;
            showAlertBanner('info', 'Running <code>nginx -t</code> syntax check...');
            try {
                const res = await authenticatedFetch('/api/files/nginx-test', { method: 'POST' });
                const data = await res.json();
                if (res.ok && data.status === 'success') {
                    showAlertBanner('success', `✔ Nginx Syntax Test Passed:<br><pre style="margin:4px 0 0;font-size:0.75rem;">${data.message}</pre>`);
                    showGlobalToast('Nginx syntax test passed!');
                } else {
                    showAlertBanner('error', `❌ Nginx Syntax Error Detected:<br><pre style="margin:4px 0 0;font-size:0.75rem;">${data.message}</pre>`);
                }
            } catch (e) {
                showAlertBanner('error', `Network error: ${e.message}`);
            } finally {
                btnNginxTest.disabled = false;
            }
        });
    }

    // Button Bindings
    if (btnSave) btnSave.addEventListener('click', saveActiveFile);

    if (btnReload) {
        btnReload.addEventListener('click', () => {
            if (activeFilePath) {
                if (isDirty && !confirm('Discard all unsaved edits and reload from server?')) return;
                openFile(activeFilePath);
            }
        });
    }

    if (btnCopy) {
        btnCopy.addEventListener('click', () => {
            if (codeArea) {
                copyToClipboard(codeArea.value);
            }
        });
    }

    if (btnRefresh) {
        btnRefresh.addEventListener('click', () => {
            navigateToDir(currentDir);
        });
    }

    if (btnUpDir) {
        btnUpDir.addEventListener('click', () => {
            if (currentDir === '/') return;
            const parent = currentDir.substring(0, currentDir.lastIndexOf('/')) || '/';
            navigateToDir(parent);
        });
    }

    if (directPathForm) {
        directPathForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const p = directPathInput.value.trim();
            if (p) navigateToDir(p);
        });
    }

    if (fileSearchFilter) {
        fileSearchFilter.addEventListener('input', renderFileList);
    }

    // Bookmarks Click
    bookmarkPills.forEach(pill => {
        pill.addEventListener('click', () => {
            const p = pill.dataset.path;
            if (p) navigateToDir(p);
        });
    });

    // New Item Modals
    window.closeNewItemModal = function() {
        if (newItemModal) newItemModal.style.display = 'none';
    };

    if (btnNewFile) {
        btnNewFile.addEventListener('click', () => {
            newItemType.value = 'file';
            newItemTitle.textContent = 'Create New File in ' + currentDir;
            newItemName.value = '';
            newItemName.placeholder = 'e.g. my-app.service or site.conf';
            newItemModal.style.display = 'flex';
        });
    }

    if (btnNewFolder) {
        btnNewFolder.addEventListener('click', () => {
            newItemType.value = 'dir';
            newItemTitle.textContent = 'Create New Folder in ' + currentDir;
            newItemName.value = '';
            newItemName.placeholder = 'e.g. conf.d or backups';
            newItemModal.style.display = 'flex';
        });
    }

    if (newItemForm) {
        newItemForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = newItemName.value.trim();
            const type = newItemType.value;
            if (!name) return;

            const fullPath = (currentDir === '/' ? '/' : currentDir + '/') + name;
            closeNewItemModal();

            try {
                const res = await authenticatedFetch('/api/files/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: fullPath, type: type })
                });
                const data = await res.json();
                if (res.ok && data.status === 'success') {
                    showGlobalToast(`Created ${name}`);
                    await navigateToDir(currentDir);
                    if (type === 'file') {
                        openFile(fullPath);
                    }
                } else {
                    alert(`Failed to create ${type}: ${data.message || 'Unknown error'}`);
                }
            } catch (err) {
                alert(`Error creating item: ${err.message}`);
            }
        });
    }

    // Initial load
    navigateToDir(currentDir);
}










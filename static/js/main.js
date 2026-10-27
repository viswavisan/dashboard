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
    initUsersControl();
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

// Helper: Escape HTML string to prevent XSS
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
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

            // Update sidebar & mobile brand dynamically
            const sidebarIp = document.getElementById('sidebar-brand-ip');
            const sidebarHostname = document.getElementById('sidebar-brand-hostname');
            const mobileBrandIp = document.getElementById('mobile-brand-ip');
            const loginHost = data.login_host || data.public_ip;
            if (sidebarIp && loginHost) sidebarIp.textContent = loginHost;
            if (sidebarHostname && data.hostname) sidebarHostname.textContent = data.hostname;
            if (mobileBrandIp && loginHost) mobileBrandIp.textContent = loginHost;

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

    const refreshServerBtn = document.getElementById('btn-refresh-server');
    let activeHostInfo = null;

    if (refreshServerBtn) {
        refreshServerBtn.addEventListener('click', () => {
            loadActiveServer();
            showGlobalToast('Refreshing server details...');
        });
    }

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
        const refreshIcon = refreshServerBtn ? refreshServerBtn.querySelector('svg') : null;
        if (refreshIcon) refreshIcon.classList.add('spinning');

        try {
            const [activeRes, vitalsRes] = await Promise.all([
                fetch('/api/servers/active'),
                fetch('/api/system-info')
            ]);
            let activeData = {};
            let vitalsData = {};
            if (activeRes.ok) activeData = await activeRes.json();
            if (vitalsRes.ok) vitalsData = await vitalsRes.json();

            activeHostInfo = activeData;

            // Merged data
            const pubIp = vitalsData.public_ip || activeData.host || '';
            const privIp = vitalsData.private_ip || (vitalsData.vm_details ? vitalsData.vm_details.primary_private_ip : '') || activeData.private_ip || '';
            const hname = vitalsData.hostname || activeData.hostname || '';
            const vm = vitalsData.vm_details || activeData.vm_details || {};

            // 1. Update Active Server Status card
            const ipEl = document.getElementById('active-host-ip');
            const privIpEl = document.getElementById('active-host-private-ip');
            const nameEl = document.getElementById('active-host-name');
            const userPortEl = document.getElementById('active-host-user-port');
            const activeOsBadge = document.getElementById('active-os-badge');

            if (ipEl && pubIp) ipEl.textContent = pubIp;
            if (privIpEl) privIpEl.textContent = privIp || 'None detected';
            if (nameEl && hname) nameEl.textContent = hname;
            if (userPortEl) userPortEl.textContent = `${activeData.username || 'opc'}@${activeData.login_host || pubIp}:${activeData.port || 22}`;
            if (activeOsBadge && vm.os_name) activeOsBadge.textContent = vm.os_name;

            // 2. Update VM System & Network Specifications Card
            const vmOsBadge = document.getElementById('vm-os-badge');
            const vmVirtBadge = document.getElementById('vm-virt-badge');
            const specOs = document.getElementById('spec-os');
            const specKernel = document.getElementById('spec-kernel');
            const specArch = document.getElementById('spec-arch');
            const specCpu = document.getElementById('spec-cpu');
            const specVirt = document.getElementById('spec-virt');
            const specPublicIp = document.getElementById('spec-public-ip');
            const specPrivateIp = document.getElementById('spec-private-ip');
            const specGateway = document.getElementById('spec-gateway');
            const specDns = document.getElementById('spec-dns');
            const specInterfaces = document.getElementById('spec-interfaces');

            if (vmOsBadge && vm.os_name) vmOsBadge.textContent = vm.os_name;
            if (vmVirtBadge) vmVirtBadge.textContent = vm.virtualization || 'Cloud VM';
            if (specOs) specOs.textContent = vm.os_name || 'Linux';
            if (specKernel) specKernel.textContent = vm.kernel || '—';
            if (specArch) specArch.textContent = vm.arch || '—';
            if (specCpu) {
                const cores = vitalsData.cpu ? vitalsData.cpu.cores : 1;
                specCpu.textContent = vm.cpu_model ? `${vm.cpu_model} (${cores} vCPUs)` : `${cores} vCPUs`;
            }
            if (specVirt) specVirt.textContent = vm.virtualization || 'Cloud / KVM';
            if (specPublicIp) specPublicIp.textContent = pubIp || '—';
            if (specPrivateIp) {
                const privList = (vm.private_ips && vm.private_ips.length) ? vm.private_ips.join(', ') : (privIp || '—');
                specPrivateIp.textContent = privList;
            }
            if (specGateway) specGateway.textContent = vm.gateway || '—';
            if (specDns) specDns.textContent = (vm.dns_servers && vm.dns_servers.length) ? vm.dns_servers.join(', ') : '—';

            if (specInterfaces) {
                if (vm.interfaces && vm.interfaces.length) {
                    specInterfaces.innerHTML = vm.interfaces.map(iface => {
                        const ipsStr = iface.ips.length ? iface.ips.join(', ') : 'No IPv4';
                        return `<span class="badge badge-secondary font-mono" style="font-size: 0.72rem; text-transform: none;">
                            <strong style="color: var(--accent-cyan);">${escapeHtml(iface.name)}</strong>: ${escapeHtml(ipsStr)} (${escapeHtml(iface.state)})
                        </span>`;
                    }).join(' ');
                } else if (privIp) {
                    specInterfaces.innerHTML = `<span class="badge badge-secondary font-mono">${escapeHtml(privIp)}</span>`;
                } else {
                    specInterfaces.textContent = 'None detected';
                }
            }

            // 3. Update Global Sidebar and Mobile Header
            const sidebarIp = document.getElementById('sidebar-brand-ip');
            const sidebarHostname = document.getElementById('sidebar-brand-hostname');
            const mobileBrandIp = document.getElementById('mobile-brand-ip');
            const loginHost = activeData.login_host || activeData.host || pubIp;
            if (sidebarIp && loginHost) sidebarIp.textContent = loginHost;
            if (sidebarHostname && hname) sidebarHostname.textContent = hname;
            if (mobileBrandIp && loginHost) mobileBrandIp.textContent = loginHost;

            // 4. Seed session if user has no saved sessions yet
            const sessions = getSavedSessions();
            if (Object.keys(sessions).length === 0 && pubIp) {
                const seedName = hname && hname !== 'Not Connected' 
                    ? `Server (${hname})` 
                    : 'Primary Server';
                sessions[seedName] = {
                    name: seedName,
                    host: pubIp,
                    port: activeData.port || 22,
                    username: activeData.username || 'opc',
                    key_path: activeData.key_path || '',
                    sudo_password: ''
                };
                saveSessions(sessions);
            }
        } catch (e) {
            console.error('Failed to query active server:', e);
        } finally {
            if (refreshIcon) refreshIcon.classList.remove('spinning');
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
                showGlobalToast(`Connected to ${name}! Loading server details...`);
                setTimeout(() => {
                    window.location.href = '/servers';
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


// ==========================================
// 7. USER ACCOUNTS CONTROLLER
// ==========================================
function initUsersControl() {
    const usersList = document.getElementById('users-list');
    if (!usersList) return; // Not on User Accounts page

    const searchInput = document.getElementById('users-search');
    const filterSelect = document.getElementById('user-type-filter');
    const refreshBtn = document.getElementById('refresh-users-btn');
    const autoRefreshCb = document.getElementById('auto-refresh-users');
    const countBadge = document.getElementById('users-count');
    const statusMsg = document.getElementById('users-status-msg');

    // Stats
    const statStandard = document.getElementById('stat-standard-users');
    const statAdmin = document.getElementById('stat-admin-users');
    const statLocked = document.getElementById('stat-locked-users');
    const statSessions = document.getElementById('stat-active-sessions');

    // Modals & Controls
    const addUserBtn = document.getElementById('add-user-btn');
    const addModal = document.getElementById('add-user-modal');
    const closeAddModal = document.getElementById('close-add-modal');
    const cancelAddModal = document.getElementById('cancel-add-modal');
    const addUserForm = document.getElementById('add-user-form');
    const addUserError = document.getElementById('add-user-error');
    const submitAddBtn = document.getElementById('submit-add-btn');

    const pwdModal = document.getElementById('change-pwd-modal');
    const closePwdModal = document.getElementById('close-pwd-modal');
    const cancelPwdModal = document.getElementById('cancel-pwd-modal');
    const pwdForm = document.getElementById('change-pwd-form');
    const pwdError = document.getElementById('change-pwd-error');
    const submitPwdBtn = document.getElementById('submit-pwd-btn');
    const pwdTargetUsername = document.getElementById('pwd-target-username');
    const pwdUserDisplay = document.getElementById('pwd-user-display');
    const pwdNew = document.getElementById('pwd-new');
    const pwdConfirm = document.getElementById('pwd-confirm');
    const pwdForceChange = document.getElementById('pwd-force-change');

    const keysModal = document.getElementById('ssh-keys-modal');
    const closeKeysModal = document.getElementById('close-keys-modal');
    const cancelKeysModal = document.getElementById('cancel-keys-modal');
    const keysForm = document.getElementById('ssh-keys-form');
    const keysError = document.getElementById('ssh-keys-error');
    const submitKeysBtn = document.getElementById('submit-keys-btn');
    const keysTargetUsername = document.getElementById('keys-target-username');
    const keysUserDisplay = document.getElementById('keys-user-display');
    const keysCountDisplay = document.getElementById('keys-count-display');
    const keysText = document.getElementById('ssh-keys-text');

    const deleteModal = document.getElementById('delete-user-modal');
    const closeDeleteModal = document.getElementById('close-delete-modal');
    const cancelDeleteModal = document.getElementById('cancel-delete-modal');
    const deleteForm = document.getElementById('delete-user-form');
    const deleteError = document.getElementById('delete-user-error');
    const submitDeleteBtn = document.getElementById('submit-delete-btn');
    const deleteTargetUsername = document.getElementById('delete-target-username');
    const deleteUserDisplay = document.getElementById('delete-user-display');
    const deleteHomePath = document.getElementById('delete-home-path');
    const deleteRemoveHome = document.getElementById('delete-remove-home');

    let usersCache = [];
    let currentUsername = '';
    let adminGroupName = 'sudo';
    let autoRefreshTimer = null;

    async function fetchUsers() {
        const refreshIcon = refreshBtn ? refreshBtn.querySelector('svg') : null;
        if (refreshIcon) refreshIcon.classList.add('spinning');
        statusMsg.textContent = 'Inspecting system accounts...';

        try {
            const res = await authenticatedFetch('/api/users');
            if (res.status === 401) return; // handled by authenticatedFetch
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.message || 'Failed to retrieve accounts');
            }

            const data = await res.json();
            usersCache = data.users || [];
            currentUsername = data.current_user || '';
            adminGroupName = data.admin_group || 'sudo';

            updateStats();
            renderUsers();

            const timestamp = new Date().toTimeString().split(' ')[0];
            statusMsg.textContent = `Synced at ${timestamp}`;
        } catch (err) {
            statusMsg.textContent = `Sync Error: ${err.message}`;
        } finally {
            if (refreshIcon) refreshIcon.classList.remove('spinning');
        }
    }

    function updateStats() {
        const standardCount = usersCache.filter(u => !u.is_system || u.is_root).length;
        const adminCount = usersCache.filter(u => u.is_admin).length;
        const lockedCount = usersCache.filter(u => u.is_locked).length;
        const sessionCount = usersCache.filter(u => u.is_logged_in).length;

        if (statStandard) statStandard.textContent = standardCount;
        if (statAdmin) statAdmin.textContent = adminCount;
        if (statLocked) statLocked.textContent = lockedCount;
        if (statSessions) statSessions.textContent = sessionCount;
    }

    function renderUsers() {
        const query = (searchInput ? searchInput.value : '').toLowerCase().trim();
        const filterVal = filterSelect ? filterSelect.value : 'standard';

        let filtered = usersCache.filter(u => {
            // Type filter
            if (filterVal === 'standard' && (u.is_system && !u.is_root)) return false;
            if (filterVal === 'admin' && !u.is_admin) return false;
            if (filterVal === 'system' && (!u.is_system || u.is_root)) return false;

            // Search query
            if (query) {
                const matchName = u.username.toLowerCase().includes(query);
                const matchFull = (u.fullname || '').toLowerCase().includes(query);
                const matchUid = String(u.uid).includes(query);
                const matchShell = (u.shell || '').toLowerCase().includes(query);
                return matchName || matchFull || matchUid || matchShell;
            }
            return true;
        });

        if (countBadge) {
            countBadge.textContent = `${filtered.length} Account${filtered.length === 1 ? '' : 's'}`;
        }

        if (filtered.length === 0) {
            usersList.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 40px; color: var(--text-muted);">
                        No user accounts matched the filter or search criteria.
                    </td>
                </tr>`;
            return;
        }

        usersList.innerHTML = filtered.map(u => {
            const initials = u.username.substring(0, 2).toUpperCase();
            const isCurrent = u.username === currentUsername;
            
            // Avatar style
            let avatarClass = 'user-avatar';
            if (u.is_root) avatarClass += ' root';
            else if (u.is_admin) avatarClass += ' admin';
            else if (u.is_locked) avatarClass += ' locked';

            // Role badge
            let roleBadge = '';
            if (u.is_root) {
                roleBadge = `<span class="badge" style="background: rgba(239, 68, 68, 0.2); border: 1px solid rgba(239, 68, 68, 0.4); color: #fca5a5;">ROOT</span>`;
            } else if (u.is_admin) {
                roleBadge = `<span class="badge badge-primary">ADMIN (${adminGroupName.toUpperCase()})</span>`;
            } else if (u.is_system) {
                roleBadge = `<span class="badge badge-secondary" style="opacity: 0.65;">SYSTEM</span>`;
            } else {
                roleBadge = `<span class="badge badge-secondary">STANDARD</span>`;
            }

            // Status badge
            const statusBadge = u.is_locked
                ? `<span class="badge badge-warning">LOCKED</span>`
                : `<span class="badge badge-success">ACTIVE</span>`;

            // Active session pulse
            const sessionIndicator = u.is_logged_in
                ? `<span class="pulse-session-dot" title="Active logged-in session"></span>`
                : '';

            const currentTag = isCurrent
                ? `<span class="current-user-tag">CURRENT SESSION</span>`
                : '';

            const disabledAttr = (isCurrent || u.is_root) ? 'disabled' : '';

            return `
                <tr>
                    <td>
                        <div class="user-info-cell">
                            <div class="${avatarClass}">${initials}</div>
                            <div class="user-details">
                                <div class="user-name-row">
                                    <span class="user-username">${escapeHtml(u.username)}</span>
                                    ${sessionIndicator}
                                    ${currentTag}
                                </div>
                                <div class="user-fullname">${escapeHtml(u.fullname || '—')}</div>
                            </div>
                        </div>
                    </td>
                    <td>${roleBadge}</td>
                    <td>${statusBadge}</td>
                    <td>
                        <span class="font-mono" style="font-size: 0.84rem; color: var(--text-main);">
                            ${u.uid} <span style="opacity: 0.35;">/</span> ${u.gid}
                        </span>
                    </td>
                    <td>
                        <div class="font-mono" style="font-size: 0.82rem; color: #fff;">${escapeHtml(u.home)}</div>
                        <div class="font-mono" style="font-size: 0.74rem; color: var(--text-muted);">${escapeHtml(u.shell)}</div>
                    </td>
                    <td>
                        <button type="button" class="badge badge-secondary ssh-badge-clickable" onclick="window.openSshKeysModal('${escapeHtml(u.username)}')" title="Manage SSH Authorized Keys">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 3px;">
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                            </svg>
                            ${u.ssh_keys_count || 0} Key${u.ssh_keys_count === 1 ? '' : 's'}
                        </button>
                    </td>
                    <td style="text-align: right;">
                        <div class="action-btn-group">
                            <button type="button" class="btn-action-icon" title="Change Password" onclick="window.openChangePwdModal('${escapeHtml(u.username)}')">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M21 2l-2 2m-1.5 1.5L16 7l-4 4-2-2-4 4 2 2-3 3v2h2l3-3 2 2 4-4-2-2 4-4 1.5-1.5L21 2z"></path>
                                </svg>
                            </button>
                            <button type="button" class="btn-action-icon" title="Manage SSH Keys" onclick="window.openSshKeysModal('${escapeHtml(u.username)}')">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                                    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                                </svg>
                            </button>
                            <button type="button" class="btn-action-icon ${u.is_admin ? 'admin-active' : ''}" 
                                title="${u.is_admin ? 'Revoke Administrator Privileges' : 'Grant Administrator Privileges'}" 
                                onclick="window.toggleUserAdmin('${escapeHtml(u.username)}', ${!u.is_admin})" 
                                ${disabledAttr}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                                </svg>
                            </button>
                            <button type="button" class="btn-action-icon ${u.is_locked ? 'locked-active' : ''}" 
                                title="${u.is_locked ? 'Unlock Account' : 'Lock Account'}" 
                                onclick="window.toggleUserLock('${escapeHtml(u.username)}', '${u.is_locked ? 'unlock' : 'lock'}')" 
                                ${disabledAttr}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                                    <path d="${u.is_locked ? 'M7 11V7a5 5 0 0 1 10 0v4' : 'M7 11V7a5 5 0 0 1 9.9-1'}"></path>
                                </svg>
                            </button>
                            <button type="button" class="btn-action-icon btn-danger-icon" 
                                title="Delete Account" 
                                onclick="window.openDeleteUserModal('${escapeHtml(u.username)}', '${escapeHtml(u.home)}')" 
                                ${disabledAttr}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="3 6 5 6 21 6"></polyline>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                </svg>
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    }

    // Modal Global Functions
    window.openChangePwdModal = function(username) {
        if (!pwdModal) return;
        pwdTargetUsername.value = username;
        pwdUserDisplay.textContent = username;
        pwdNew.value = '';
        pwdConfirm.value = '';
        pwdForceChange.checked = false;
        pwdError.style.display = 'none';
        pwdModal.style.display = 'flex';
        pwdNew.focus();
    };

    window.openSshKeysModal = async function(username) {
        if (!keysModal) return;
        keysTargetUsername.value = username;
        keysUserDisplay.textContent = username;
        keysCountDisplay.textContent = 'loading...';
        keysText.value = 'Retrieving authorized keys...';
        keysText.disabled = true;
        keysError.style.display = 'none';
        keysModal.style.display = 'flex';

        try {
            const res = await authenticatedFetch('/api/users/ssh-keys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username, action: 'get' })
            });
            const data = await res.json();
            if (res.ok && data.status === 'success') {
                const keys = data.keys || '';
                keysText.value = keys;
                keysText.disabled = false;
                const count = keys.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).length;
                keysCountDisplay.textContent = `${count} key${count === 1 ? '' : 's'}`;
            } else {
                keysError.textContent = data.message || 'Failed to read keys';
                keysError.style.display = 'block';
                keysText.disabled = false;
            }
        } catch (err) {
            keysError.textContent = `Error: ${err.message}`;
            keysError.style.display = 'block';
            keysText.disabled = false;
        }
    };

    window.openDeleteUserModal = function(username, homeDir) {
        if (!deleteModal) return;
        deleteTargetUsername.value = username;
        deleteUserDisplay.textContent = username;
        deleteHomePath.textContent = homeDir || `/home/${username}`;
        deleteRemoveHome.checked = false;
        deleteError.style.display = 'none';
        deleteModal.style.display = 'flex';
    };

    window.toggleUserLock = async function(username, action) {
        const confirmMsg = action === 'lock'
            ? `Are you sure you want to lock login access for "${username}"?`
            : `Unlock login access for "${username}"?`;
        if (!confirm(confirmMsg)) return;

        try {
            const res = await authenticatedFetch('/api/users/toggle-lock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username, action: action })
            });
            const data = await res.json();
            if (res.ok && data.status === 'success') {
                showGlobalToast(data.message);
                fetchUsers();
            } else {
                alert(`Lock/Unlock failed: ${data.message || 'Unknown error'}`);
            }
        } catch (err) {
            alert(`Error: ${err.message}`);
        }
    };

    window.toggleUserAdmin = async function(username, makeAdmin) {
        const confirmMsg = makeAdmin
            ? `Grant administrator (sudo/wheel) privileges to "${username}"?`
            : `Revoke administrator privileges from "${username}"?`;
        if (!confirm(confirmMsg)) return;

        try {
            const res = await authenticatedFetch('/api/users/toggle-admin', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username, is_admin: makeAdmin })
            });
            const data = await res.json();
            if (res.ok && data.status === 'success') {
                showGlobalToast(data.message);
                fetchUsers();
            } else {
                alert(`Admin toggle failed: ${data.message || 'Unknown error'}`);
            }
        } catch (err) {
            alert(`Error: ${err.message}`);
        }
    };

    // Modal Close Listeners
    if (closeAddModal) closeAddModal.addEventListener('click', () => addModal.style.display = 'none');
    if (cancelAddModal) cancelAddModal.addEventListener('click', () => addModal.style.display = 'none');

    if (closePwdModal) closePwdModal.addEventListener('click', () => pwdModal.style.display = 'none');
    if (cancelPwdModal) cancelPwdModal.addEventListener('click', () => pwdModal.style.display = 'none');

    if (closeKeysModal) closeKeysModal.addEventListener('click', () => keysModal.style.display = 'none');
    if (cancelKeysModal) cancelKeysModal.addEventListener('click', () => keysModal.style.display = 'none');

    if (closeDeleteModal) closeDeleteModal.addEventListener('click', () => deleteModal.style.display = 'none');
    if (cancelDeleteModal) cancelDeleteModal.addEventListener('click', () => deleteModal.style.display = 'none');

    // Add User Form Submit
    if (addUserBtn) {
        addUserBtn.addEventListener('click', () => {
            document.getElementById('new-username').value = '';
            document.getElementById('new-fullname').value = '';
            document.getElementById('new-password').value = '';
            document.getElementById('new-shell').value = '/bin/bash';
            document.getElementById('new-is-admin').checked = false;
            document.getElementById('new-ssh-key').value = '';
            addUserError.style.display = 'none';
            addModal.style.display = 'flex';
            document.getElementById('new-username').focus();
        });
    }

    if (addUserForm) {
        addUserForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            addUserError.style.display = 'none';

            const username = document.getElementById('new-username').value.trim();
            const fullname = document.getElementById('new-fullname').value.trim();
            const password = document.getElementById('new-password').value;
            const shell = document.getElementById('new-shell').value;
            const isAdmin = document.getElementById('new-is-admin').checked;
            const sshKey = document.getElementById('new-ssh-key').value.trim();

            if (!username) return;

            submitAddBtn.disabled = true;
            submitAddBtn.textContent = 'Creating...';

            try {
                const res = await authenticatedFetch('/api/users/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username: username,
                        fullname: fullname,
                        password: password,
                        shell: shell,
                        is_admin: isAdmin,
                        ssh_key: sshKey
                    })
                });
                const data = await res.json();
                if (res.ok && data.status === 'success') {
                    showGlobalToast(`Created user account "${username}"`);
                    addModal.style.display = 'none';
                    fetchUsers();
                } else {
                    addUserError.textContent = data.message || 'Failed to create user';
                    addUserError.style.display = 'block';
                }
            } catch (err) {
                addUserError.textContent = `Error: ${err.message}`;
                addUserError.style.display = 'block';
            } finally {
                submitAddBtn.disabled = false;
                submitAddBtn.textContent = 'Create User';
            }
        });
    }

    // Change Password Form Submit
    if (pwdForm) {
        pwdForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            pwdError.style.display = 'none';

            const username = pwdTargetUsername.value;
            const p1 = pwdNew.value;
            const p2 = pwdConfirm.value;
            const forceChange = pwdForceChange.checked;

            if (p1 !== p2) {
                pwdError.textContent = 'Passwords do not match.';
                pwdError.style.display = 'block';
                return;
            }

            submitPwdBtn.disabled = true;
            submitPwdBtn.textContent = 'Updating...';

            try {
                const res = await authenticatedFetch('/api/users/change-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username: username,
                        password: p1,
                        force_change: forceChange
                    })
                });
                const data = await res.json();
                if (res.ok && data.status === 'success') {
                    showGlobalToast(`Password updated for "${username}"`);
                    pwdModal.style.display = 'none';
                    fetchUsers();
                } else {
                    pwdError.textContent = data.message || 'Failed to update password';
                    pwdError.style.display = 'block';
                }
            } catch (err) {
                pwdError.textContent = `Error: ${err.message}`;
                pwdError.style.display = 'block';
            } finally {
                submitPwdBtn.disabled = false;
                submitPwdBtn.textContent = 'Update Password';
            }
        });
    }

    // Save SSH Keys Form Submit
    if (keysForm) {
        keysForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            keysError.style.display = 'none';

            const username = keysTargetUsername.value;
            const keysContent = keysText.value;

            submitKeysBtn.disabled = true;
            submitKeysBtn.textContent = 'Saving...';

            try {
                const res = await authenticatedFetch('/api/users/ssh-keys', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username: username,
                        action: 'save',
                        keys: keysContent
                    })
                });
                const data = await res.json();
                if (res.ok && data.status === 'success') {
                    showGlobalToast(`SSH keys updated for "${username}"`);
                    keysModal.style.display = 'none';
                    fetchUsers();
                } else {
                    keysError.textContent = data.message || 'Failed to save keys';
                    keysError.style.display = 'block';
                }
            } catch (err) {
                keysError.textContent = `Error: ${err.message}`;
                keysError.style.display = 'block';
            } finally {
                submitKeysBtn.disabled = false;
                submitKeysBtn.textContent = 'Save SSH Keys';
            }
        });
    }

    // Delete User Form Submit
    if (deleteForm) {
        deleteForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            deleteError.style.display = 'none';

            const username = deleteTargetUsername.value;
            const removeHome = deleteRemoveHome.checked;

            submitDeleteBtn.disabled = true;
            submitDeleteBtn.textContent = 'Deleting...';

            try {
                const res = await authenticatedFetch('/api/users/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username: username,
                        remove_home: removeHome
                    })
                });
                const data = await res.json();
                if (res.ok && data.status === 'success') {
                    showGlobalToast(`Deleted user account "${username}"`);
                    deleteModal.style.display = 'none';
                    fetchUsers();
                } else {
                    deleteError.textContent = data.message || 'Failed to delete user';
                    deleteError.style.display = 'block';
                }
            } catch (err) {
                deleteError.textContent = `Error: ${err.message}`;
                deleteError.style.display = 'block';
            } finally {
                submitDeleteBtn.disabled = false;
                submitDeleteBtn.textContent = 'Confirm Deletion';
            }
        });
    }

    // Filter and search listeners
    if (searchInput) searchInput.addEventListener('input', renderUsers);
    if (filterSelect) filterSelect.addEventListener('change', renderUsers);

    if (refreshBtn) {
        refreshBtn.addEventListener('click', fetchUsers);
    }

    if (autoRefreshCb) {
        autoRefreshCb.addEventListener('change', () => {
            if (autoRefreshCb.checked) {
                autoRefreshTimer = setInterval(fetchUsers, 120000); // 2m
            } else if (autoRefreshTimer) {
                clearInterval(autoRefreshTimer);
                autoRefreshTimer = null;
            }
        });
    }

    // Initial load
    fetchUsers();
}










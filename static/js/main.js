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
    
    // Retrieve sudo password from sessionStorage or default to 'viswa'
    const savedPassword = sessionStorage.getItem('sudo_password') || 'viswa';
    options.headers['X-Sudo-Password'] = savedPassword;
    
    let response = await fetch(url, options);
    
    if (response.status === 401) {
        // Clear cached wrong password
        sessionStorage.removeItem('sudo_password');
        
        // Prompt user
        const newPassword = prompt("Sudo password authorization required (default: viswa):");
        if (newPassword !== null) {
            const passwordToUse = newPassword.trim() || 'viswa';
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
                        ${(s.unit === 'dashboard' || s.unit === 'flaskapp') ? `
                        <a href="/logs?unit=${s.unit}" class="btn-info" style="margin-right: 4px; text-decoration: none;">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                <polyline points="14 2 14 8 20 8"></polyline>
                                <line x1="16" y1="13" x2="8" y2="13"></line>
                                <line x1="16" y1="17" x2="8" y2="17"></line>
                            </svg>
                            <span>Logs</span>
                        </a>` : ''}
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

    // Auto polling
    setInterval(() => {
        if (autoRefreshCb && autoRefreshCb.checked) {
            fetchServices();
        }
    }, 5000);

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

    // Auto polling
    setInterval(() => {
        if (autoRefreshCb && autoRefreshCb.checked) {
            fetchPorts();
        }
    }, 5000);

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

            // RAM Details
            setGaugePercentage(ramPctEl, ramFill, data.ram.used_percent);
            if (ramTotal) ramTotal.textContent = formatBytes(data.ram.total);
            if (ramUsed) ramUsed.textContent = formatBytes(data.ram.used);
            if (ramFree) ramFree.textContent = formatBytes(data.ram.available);
            if (ramCached) ramCached.textContent = formatBytes(data.ram.buffers_cached);

            // Swap Details
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

    // Auto polling (every 5 seconds for memory metrics)
    setInterval(() => {
        if (autoRefreshCb && autoRefreshCb.checked) {
            fetchMemory();
        }
    }, 5000);

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

        terminalTitle.textContent = `${unit}.service - stdout/stderr logs`;

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
            autoRefreshInterval = setInterval(fetchLogs, 3000);
        }
    }

    // Event listeners
    if (serviceSelect) {
        serviceSelect.addEventListener('change', () => {
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
    const unitParam = urlParams.get('unit');
    if (unitParam && (unitParam === 'flaskapp' || unitParam === 'dashboard')) {
        serviceSelect.value = unitParam;
    }

    fetchLogs().then(() => {
        logsContainer.scrollTop = logsContainer.scrollHeight;
    });
    setupAutoRefresh();
}








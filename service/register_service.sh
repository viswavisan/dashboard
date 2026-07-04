#!/bin/bash

# Change directory to the parent directory (root of the project)
echo "Navigating to project root directory..."
cd "$(dirname "$0")/.." || exit 1

# Create venv if not available
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment (.venv)..."
    python3 -m venv .venv
else
    echo "Virtual environment (.venv) already exists."
fi

# Activate venv
echo "Activating virtual environment..."
. .venv/bin/activate

# Install requirements
UPDATE_REQS=true
read -p "Do you want to install/update dependencies from requirements.txt? (y/N): " choice
case "$choice" in 
    [yY][eE][sS]|[yY]) UPDATE_REQS=true ;;
    *) UPDATE_REQS=false; echo "Skipping dependency installation." ;;
esac

if [ "$UPDATE_REQS" = true ]; then
    echo "Installing dependencies from requirements.txt..."
    pip install -r requirements.txt
fi

# Check if port 8000 is already in use by another process
if ss -lnt | grep -q ":8000\b"; then
    if systemctl is-active --quiet dashboard.service 2>/dev/null; then
        echo "Port 8000 is in use (likely by the currently running dashboard.service)."
    else
        echo "WARNING: Port 8000 is already in use by another process!"
        # Show process details if available
        sudo ss -lntp | grep ":8000\b" || true
        echo "Please free port 8000 before running the service, or the service start may fail."
    fi
fi

# Determine whether to create/overwrite the service file
CREATE_SERVICE=true
if [ -f /etc/systemd/system/dashboard.service ]; then
    read -p "Service file /etc/systemd/system/dashboard.service already exists. Overwrite? (y/N): " choice
    case "$choice" in 
        [yY][eE][sS]|[yY]) CREATE_SERVICE=true ;;
        *) CREATE_SERVICE=false; echo "Skipping service file creation." ;;
    esac
fi

if [ "$CREATE_SERVICE" = true ]; then
    echo "Creating service file at /etc/systemd/system/dashboard.service..."
    APP_DIR=$(pwd)
    APP_USER=${SUDO_USER:-$(whoami)}
    
    sudo tee /etc/systemd/system/dashboard.service > /dev/null <<EOF
[Unit]
Description=Dashboard Web App Service
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/.venv/bin/python app.py
Restart=always

[Install]
WantedBy=multi-user.target
EOF

    echo "Reloading systemd daemon..."
    sudo systemctl daemon-reload
fi

echo "Enabling dashboard.service..."
sudo systemctl enable dashboard.service

echo "Restarting dashboard.service..."
sudo systemctl restart dashboard.service

# Wait a short moment for service to initialize
echo "Waiting for service to start..."
sleep 2

# Check status and print recent logs
if systemctl is-active --quiet dashboard.service; then
    echo "SUCCESS: dashboard.service is active and running!"
else
    echo "ERROR: dashboard.service failed to start. Current status details:"
    sudo systemctl status dashboard.service --no-pager
fi

echo "Recent logs for dashboard.service:"
echo "--------------------------------------------------"
sudo journalctl -u dashboard.service -n 15 --no-pager
echo "--------------------------------------------------"
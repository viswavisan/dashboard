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
echo "Installing dependencies from requirements.txt..."
pip install -r requirements.txt

# If service file is not in /etc/systemd/system, create it
if [ ! -f /etc/systemd/system/dashboard.service ]; then
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
else
    echo "Service file already exists in systemd."
fi

# Daemon reload, enable and restart the service
echo "Reloading systemd daemon..."
sudo systemctl daemon-reload

echo "Enabling dashboard.service..."
sudo systemctl enable dashboard.service

echo "Restarting dashboard.service..."
sudo systemctl restart dashboard.service

echo "Service registration and setup completed successfully!"
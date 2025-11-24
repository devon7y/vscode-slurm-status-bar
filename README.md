# VS Code Slurm Status Bar

A VS Code extension that displays real-time Slurm job status directly in your status bar. Monitor your HPC cluster jobs without leaving your editor!

## Features

- **Real-time monitoring**: Status updates every second in VS Code
- **Smart timers**:
  - Countdown timer for running jobs (shows time remaining)
  - Count-up timer for pending jobs (shows wait time)
- **Multiple job support**: View all your jobs at once with clear formatting
- **Flicker-free updates**: Atomic file writes prevent UI glitches
- **Remote-SSH compatible**: Works seamlessly with VS Code's Remote-SSH extension
- **Automatic updates**: Set it and forget it with LaunchAgent/systemd auto-start

## Requirements

- **VS Code** 1.60.0 or higher
- **SSH access** to a Slurm cluster
- **Bash** 4.0+ (for the monitoring script)
- **SSH key authentication** (passwordless login to cluster)

## Installation

### Step 1: Install the VS Code Extension

#### Option A: From VSIX (Manual Installation)
1. Download the latest `.vsix` file from [Releases](https://github.com/devon7y/vscode-slurm-status-bar/releases)
2. Open VS Code
3. Press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux)
4. Type "Extensions: Install from VSIX"
5. Select the downloaded `.vsix` file

#### Option B: From VS Code Marketplace (Coming Soon)
Search for "Slurm Status Bar" in the VS Code Extensions marketplace.

### Step 2: Set Up the Monitoring Script

1. **Clone this repository** (or download the script):
   ```bash
   git clone https://github.com/devon7y/vscode-slurm-status-bar.git
   cd vscode-slurm-status-bar
   ```

2. **Make the script executable**:
   ```bash
   chmod +x scripts/slurm_monitor.sh
   ```

3. **Test the script manually**:
   ```bash
   ./scripts/slurm_monitor.sh YOUR_CLUSTER_HOSTNAME
   ```

   Replace `YOUR_CLUSTER_HOSTNAME` with your Slurm cluster's hostname (e.g., `mycluster.university.edu`).

4. **Verify it's working**:
   ```bash
   cat ~/.slurm_status_bar.txt
   ```
   You should see your job status (or "No active jobs").

### Step 3: Auto-Start on Login (Recommended)

#### For macOS (LaunchAgent)

1. **Copy the example LaunchAgent**:
   ```bash
   cp examples/launchd/com.user.slurm-status.plist ~/Library/LaunchAgents/
   ```

2. **Edit the file** to customize it:
   ```bash
   nano ~/Library/LaunchAgents/com.user.slurm-status.plist
   ```

   Update these values:
   - Replace `USER` with your username
   - Replace `YOUR_REMOTE_SERVER` with your cluster hostname
   - Update the script path if you cloned to a different location

3. **Load the LaunchAgent**:
   ```bash
   launchctl load ~/Library/LaunchAgents/com.user.slurm-status.plist
   ```

4. **Verify it's running**:
   ```bash
   launchctl list | grep slurm
   ```

#### For Linux (systemd)

Create `~/.config/systemd/user/slurm-status.service`:

```ini
[Unit]
Description=Slurm Status Monitor
After=network.target

[Service]
Type=simple
ExecStart=/path/to/vscode-slurm-status-bar/scripts/slurm_monitor.sh YOUR_CLUSTER_HOSTNAME
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Then enable and start:
```bash
systemctl --user enable slurm-status.service
systemctl --user start slurm-status.service
```

## Configuration

### Script Behavior

The monitoring script (`scripts/slurm_monitor.sh`) has the following behavior:

- **Refresh interval**: Queries `squeue` every 60 seconds (configurable in script)
- **Local updates**: Updates display every 1 second (smooth countdown/countup)
- **Status file**: Writes to `~/.slurm_status_bar.txt`

To change the refresh interval, edit `REFRESH_INTERVAL` in the script:
```bash
REFRESH_INTERVAL=60  # Change to desired seconds
```

### VS Code Extension Behavior

The extension:
- Reads `~/.slurm_status_bar.txt` every 1 second
- Displays in the **left side** of the status bar (priority 0)
- Shows tooltip with job state legend on hover

## How It Works

```
┌─────────────────┐
│  Slurm Cluster  │
│   (squeue)      │
└────────┬────────┘
         │ SSH every 60s
         ▼
┌─────────────────────────┐
│  Monitoring Script      │
│  slurm_monitor.sh       │
│  - Fetches job data     │
│  - Counts down/up       │
│  - Updates every 1s     │
└────────┬────────────────┘
         │ Writes
         ▼
┌─────────────────────────┐
│  ~/.slurm_status_bar.txt│
└────────┬────────────────┘
         │ Reads every 1s
         ▼
┌─────────────────────────┐
│  VS Code Extension      │
│  Displays in status bar │
└─────────────────────────┘
```

### Status Format

**Running jobs** (count down):
```
my_job (R) 28:45
```

**Pending jobs** (count up):
```
my_job (PD) 5:32
```

**Multiple jobs**:
```
job1 (R) 1:23:45 | job2 (PD) 3:12 | job3 (R) 45:20
```

### Job State Codes

- **R** - Running
- **PD** - Pending (waiting in queue)
- **CG** - Completing
- **CD** - Completed
- **F** - Failed
- **CA** - Cancelled

## Troubleshooting

### Extension shows "No Slurm status"

**Cause**: The status file doesn't exist or the script isn't running.

**Solution**:
1. Check if script is running: `ps aux | grep slurm_monitor`
2. Check if file exists: `cat ~/.slurm_status_bar.txt`
3. Manually run script to test: `./scripts/slurm_monitor.sh YOUR_CLUSTER`

### Status not updating

**Cause**: Script may have crashed or SSH connection issues.

**Solution**:
1. Check script logs (if using LaunchAgent): `cat /tmp/slurm-status.err`
2. Test SSH connection: `ssh YOUR_CLUSTER squeue -u $USER`
3. Restart the script

### Status bar shows old data

**Cause**: Script stopped but file still exists with stale data.

**Solution**:
1. Kill any running scripts: `pkill -f slurm_monitor`
2. Remove status file: `rm ~/.slurm_status_bar.txt`
3. Restart the script

### SSH password prompts

**Cause**: SSH key authentication not set up.

**Solution**:
1. Generate SSH key: `ssh-keygen -t ed25519`
2. Copy to cluster: `ssh-copy-id YOUR_CLUSTER`
3. Test passwordless login: `ssh YOUR_CLUSTER echo "success"`

### Status bar flickering (rare)

**Cause**: Race condition between write and read (should be fixed in v0.4.0+).

**Solution**: Update to the latest version of both script and extension.

## Development

### Building from Source

```bash
# Clone the repo
git clone https://github.com/devon7y/vscode-slurm-status-bar.git
cd vscode-slurm-status-bar

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Package extension
npx @vscode/vsce package
```

This creates a `.vsix` file you can install.

### Project Structure

```
vscode-slurm-status-bar/
├── src/
│   └── extension.ts        # Extension code
├── scripts/
│   └── slurm_monitor.sh    # Monitoring script
├── examples/
│   └── launchd/            # Auto-start examples
├── package.json            # Extension manifest
├── tsconfig.json           # TypeScript config
└── README.md
```

### Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch: `git checkout -b my-feature`
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Acknowledgments

Built for researchers and engineers who need to keep an eye on their HPC jobs while coding.

## Support

- **Issues**: [GitHub Issues](https://github.com/devon7y/vscode-slurm-status-bar/issues)
- **Discussions**: [GitHub Discussions](https://github.com/devon7y/vscode-slurm-status-bar/discussions)

---

Made with ❤️ for the HPC community

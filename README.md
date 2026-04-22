# HPC Usage Dashboard

A VS Code extension that shows Slurm job status in the status bar by reading a local file that is continuously updated by a small monitor script.

The current monitor can:

- merge jobs from multiple clusters into one line
- show GPU fairshare values before the job list
- append fairshare history rows to `~/.slurm_fairshare_history.csv`
- count down running jobs and count up pending jobs locally between refreshes
- survive transient SSH issues better by reusing existing SSH ControlMaster sessions
- use different SSH aliases for job polling and fairshare polling when automation-node keys differ by command scope

The VS Code hover now also shows:

- a cleaner per-job summary
- the latest fairshare sample timestamp
- compact CPU and GPU fairshare trends based on `~/.slurm_fairshare_history.csv`
- a link to open a full fairshare graph panel
- a link to open the fairshare history CSV directly

The graph panel now supports:

- selectable date ranges with 24H, 7D, 30D, 90D, 1Y, and All presets
- custom start and end datetime filters
- CPU and GPU series on the same chart, with one checkbox for CPU and one for GPU
- one selectable overlay metric on a separate right-side y-axis, including job-load and node-availability metrics
- aggregation modes for raw, 15m, 1h, and 6h views
- per-HPC isolate mode
- a square chart with a zoomed y-axis so shallow slopes are easier to see
- hover inspection for exact values at the nearest recorded sample
- drag-selection on the chart to measure net fairshare change over a chosen time window
- selection-aware tooltips that show the end-of-selection value and net change together
- bottom-of-page job statistics cards, including totals and per-cluster snapshots
- event markers for job submits, starts, ends, and large queue changes
- a job event table and lag/correlation cards for relating fairshare to job load and GPU node availability
- opening in the active editor group when launched from the status bar

## What You Install

This repo has two parts:

1. The VS Code extension.
2. The monitor script that writes `~/.slurm_status_bar.txt`.

The extension does not talk to Slurm directly. It only reads `~/.slurm_status_bar.txt` every second. The monitor script is the part that runs `ssh`, `squeue`, and optionally `sshare`.

The monitor also appends a CSV history file at `~/.slurm_fairshare_history.csv` with columns:

```text
timestamp,fir_cpu,fir_gpu,ror_cpu,ror_gpu,nibi_cpu,nibi_gpu,tril_cpu,tril_gpu
```

Each refresh cycle writes one row. If a cluster's fairshare is disabled or unavailable for that cycle, its cell is left blank.

The monitor also appends a job summary CSV at `~/.slurm_job_history.csv` with one row per refresh cycle. It records job counts, running vs pending totals, remaining and time-limit hours, and estimated CPU/GPU-hours overall plus per cluster, so you can compare job load against fairshare changes later.

The monitor also appends:

- `~/.slurm_job_snapshot_history.csv` with one row per active job at each refresh, used for event markers and the per-job event log
- `~/.slurm_node_history.csv` with GPU-node availability snapshots such as schedulable, down, and drain counts per cluster

## Requirements

You need:

- VS Code 1.60.0 or newer
- `ssh`
- `python3` 3.8 or newer
- access to one or more Slurm clusters where `squeue` works for your account

Recommended:

- SSH aliases in `~/.ssh/config`
- SSH ControlMaster enabled for faster polling
- key-based SSH login
- robot-node aliases with constrained SSH keys if you want unattended access without a passcode refresh

Optional:

- `sshpass`
- a passcode file for headless reconnects, usually `~/.claude/hpc_passcode`

## Quick Start

If you already have working SSH aliases such as `fir`, `ror`, and `nibi`, this is the shortest path:

```bash
git clone https://github.com/devon7y/vscode-slurm-status-bar.git
cd vscode-slurm-status-bar
chmod +x scripts/slurm_monitor.sh

export SLURM_STATUS_BAR_REMOTE_USER=YOUR_CLUSTER_USERNAME
export SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT=YOUR_GPU_ACCOUNT

./scripts/slurm_monitor.sh fir ror nibi
```

Then open another terminal and confirm the status file is being updated:

```bash
cat ~/.slurm_status_bar.txt
```

You should see output like:

```text
Fir: 0.372 | Ror: 0.064 | Nibi: 0.774 | my_job (R) 1:23:45 | other_job (PD) 2:17
```

After that, set the monitor to auto-start on login and install the VS Code extension from a `.vsix`.

## 1. Install the VS Code Extension

### Option A: Install a Release `.vsix`

1. Download the latest `.vsix` from [Releases](https://github.com/devon7y/vscode-slurm-status-bar/releases).
2. In VS Code, open the command palette.
3. Run `Extensions: Install from VSIX`.
4. Select the downloaded file.

### Option B: Build Your Own `.vsix`

```bash
git clone https://github.com/devon7y/vscode-slurm-status-bar.git
cd vscode-slurm-status-bar
npm install
npm run compile
npx @vscode/vsce package
```

That creates a `.vsix` you can install locally.

## 2. Configure SSH Access

The monitor works best if you can run `ssh <alias> "squeue ..."` without interactive prompts. In automation-node mode, you can use one alias for `squeue` and a different alias for `sshare`.

Example `~/.ssh/config`:

```sshconfig
Host fir
  HostName fir.alliancecan.ca
  User YOUR_CLUSTER_USERNAME
  ControlMaster auto
  ControlPersist 8h
  ControlPath ~/.ssh/cm-%C

Host ror
  HostName rorqual.alliancecan.ca
  User YOUR_CLUSTER_USERNAME
  ControlMaster auto
  ControlPersist 8h
  ControlPath ~/.ssh/cm-%C

Host nibi
  HostName nibi.alliancecan.ca
  User YOUR_CLUSTER_USERNAME
  ControlMaster auto
  ControlPersist 8h
  ControlPath ~/.ssh/cm-%C
```

Notes:

- You can use any alias names, not just `fir`, `ror`, `nibi`, and `tril`.
- If the alias is not one of the built-in labels above, the status line uses the alias text directly.
- If your macOS or Linux username is different from your cluster username, set `SLURM_STATUS_BAR_REMOTE_USER`.

Before using the monitor, test SSH manually:

```bash
ssh fir "squeue -u YOUR_CLUSTER_USERNAME --noheader"
ssh fir "sshare -u YOUR_CLUSTER_USERNAME -l -P"
```

Repeat that for each cluster alias you plan to monitor.

Example automation-node aliases:

```sshconfig
Host robot-fir-slurm
  HostName robot.fir.alliancecan.ca
  User YOUR_CLUSTER_USERNAME
  IdentityFile ~/.ssh/id_ed25519_robot_slurm
  IdentitiesOnly yes
  BatchMode no
  RequestTTY no
  AddressFamily inet
  ControlMaster auto
  ControlPersist 12h
  ControlPath ~/.ssh/cm-robot-slurm-%C

Host robot-fir-fairshare
  HostName robot.fir.alliancecan.ca
  User YOUR_CLUSTER_USERNAME
  IdentityFile ~/.ssh/id_ed25519_robot_fairshare
  IdentitiesOnly yes
  BatchMode no
  RequestTTY no
  AddressFamily inet
  ControlMaster auto
  ControlPersist 12h
  ControlPath ~/.ssh/cm-robot-fairshare-%C

Host robot-tril-slurm
  HostName trig-robot1.scinet.utoronto.ca
  User YOUR_CLUSTER_USERNAME
  IdentityFile ~/.ssh/id_ed25519_robot_slurm
  IdentitiesOnly yes
  BatchMode no
  RequestTTY no
  AddressFamily inet
  ControlMaster auto
  ControlPersist 12h
  ControlPath ~/.ssh/cm-robot-slurm-%C
```

Then test directly:

```bash
ssh robot-fir-slurm "squeue -u YOUR_CLUSTER_USERNAME --noheader"
ssh robot-fir-fairshare "sshare -u YOUR_CLUSTER_USERNAME -l -P"
```

If your automation-node setup does not support `sshare` yet, you can still run the monitor by disabling fairshare display.

On the current Alliance robot-node setup for this repo, `BatchMode no` is required. The SSH negotiation completes with a zero-prompt `keyboard-interactive` step after the key is accepted, and `BatchMode yes` blocks that path even though no human input is needed.

## 3. Choose the Right Environment Variables

The monitor uses environment variables so you do not have to edit the script for normal setup.

| Variable | Required | Purpose |
| --- | --- | --- |
| `SLURM_STATUS_BAR_REMOTE_USER` | Usually | Cluster username when it differs from your local username |
| `SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT` | Recommended | Account row to read from `sshare` for fairshare display |
| `SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT_<REMOTE>` | Optional | Per-cluster fairshare account override, for example `SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT_FIR` |
| `SLURM_STATUS_BAR_SSH_ALIAS_<REMOTE>` | Optional | Override the SSH alias for both job and fairshare queries for one logical remote |
| `SLURM_STATUS_BAR_SQUEUE_ALIAS_<REMOTE>` | Optional | Override only the alias used for `squeue` on one logical remote |
| `SLURM_STATUS_BAR_FAIRSHARE_ALIAS_<REMOTE>` | Optional | Override only the alias used for `sshare` on one logical remote |
| `SLURM_STATUS_BAR_DISABLE_FAIRSHARE` | Optional | Disable fairshare lookups globally and hide fairshare entries from the status line |
| `SLURM_STATUS_BAR_DISABLE_FAIRSHARE_<REMOTE>` | Optional | Disable fairshare lookups only for one logical remote |
| `SLURM_STATUS_BAR_DISABLE_PASSCODE_FALLBACK` | Optional | Skip `sshpass` fallback and let key-based aliases connect directly |
| `SLURM_STATUS_BAR_SSHPASS_FILE` | Optional | Passcode file used by `sshpass` if no ControlMaster session is active |

Fairshare selection behavior:

- If `SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT_<REMOTE>` is set, that account is used for that remote.
- Otherwise, if `SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT` is set, that account is used for all remotes.
- Otherwise, the monitor auto-selects the first fairshare row for your user that looks GPU-related.
- If multiple rows are plausible, the monitor logs a warning to stderr and picks one. In that case, set the account explicitly.

If fairshare lookup fails, the display shows `?` for that cluster and the job list still updates.

Alias selection behavior:

- If `SLURM_STATUS_BAR_SQUEUE_ALIAS_<REMOTE>` is set, that alias is used for `squeue`.
- If `SLURM_STATUS_BAR_FAIRSHARE_ALIAS_<REMOTE>` is set, that alias is used for `sshare`.
- Otherwise, if `SLURM_STATUS_BAR_SSH_ALIAS_<REMOTE>` is set, that alias is used for both.
- Otherwise, the logical remote name itself is used as the SSH alias.

## 4. Run the Monitor Manually First

Always test the monitor manually before setting up LaunchAgent or systemd.

### Single cluster

```bash
export SLURM_STATUS_BAR_REMOTE_USER=YOUR_CLUSTER_USERNAME
export SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT=YOUR_GPU_ACCOUNT
./scripts/slurm_monitor.sh fir
```

### Multiple clusters

```bash
export SLURM_STATUS_BAR_REMOTE_USER=YOUR_CLUSTER_USERNAME
export SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT_FIR=YOUR_FIR_GPU_ACCOUNT
export SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT_ROR=YOUR_ROR_GPU_ACCOUNT
export SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT_NIBI=YOUR_NIBI_GPU_ACCOUNT
./scripts/slurm_monitor.sh fir ror nibi tril
```

### Automation-node mode

```bash
export SLURM_STATUS_BAR_REMOTE_USER=YOUR_CLUSTER_USERNAME
export SLURM_STATUS_BAR_DISABLE_PASSCODE_FALLBACK=1
export SLURM_STATUS_BAR_SQUEUE_ALIAS_FIR=robot-fir-slurm
export SLURM_STATUS_BAR_FAIRSHARE_ALIAS_FIR=robot-fir-fairshare
export SLURM_STATUS_BAR_SQUEUE_ALIAS_ROR=robot-ror-slurm
export SLURM_STATUS_BAR_FAIRSHARE_ALIAS_ROR=robot-ror-fairshare
export SLURM_STATUS_BAR_SQUEUE_ALIAS_NIBI=robot-nibi-slurm
export SLURM_STATUS_BAR_FAIRSHARE_ALIAS_NIBI=robot-nibi-fairshare
export SLURM_STATUS_BAR_SQUEUE_ALIAS_TRIL=robot-tril-slurm
export SLURM_STATUS_BAR_FAIRSHARE_ALIAS_TRIL=robot-tril-fairshare
./scripts/slurm_monitor.sh fir ror nibi tril
```

### Automation-node mode without fairshare

If your robot-node setup allows `squeue` but not `sshare` yet:

```bash
export SLURM_STATUS_BAR_REMOTE_USER=YOUR_CLUSTER_USERNAME
export SLURM_STATUS_BAR_DISABLE_PASSCODE_FALLBACK=1
export SLURM_STATUS_BAR_DISABLE_FAIRSHARE=1
export SLURM_STATUS_BAR_SQUEUE_ALIAS_FIR=robot-fir-slurm
export SLURM_STATUS_BAR_SQUEUE_ALIAS_ROR=robot-ror-slurm
export SLURM_STATUS_BAR_SQUEUE_ALIAS_NIBI=robot-nibi-slurm
export SLURM_STATUS_BAR_SQUEUE_ALIAS_TRIL=robot-tril-slurm
./scripts/slurm_monitor.sh fir ror nibi tril
```

### Passcode-based fallback

If your workflow uses a passcode file and `sshpass`, set:

```bash
export SLURM_STATUS_BAR_SSHPASS_FILE="$HOME/.claude/hpc_passcode"
```

The monitor first tries `ssh -O check <remote>`. If that existing shared SSH session is not available, it can fall back to `sshpass` with the configured passcode file.

If you use robot-node aliases with key-based auth, set `SLURM_STATUS_BAR_DISABLE_PASSCODE_FALLBACK=1` and you do not need `sshpass`.

### Verify the result

In another shell:

```bash
cat ~/.slurm_status_bar.txt
```

If the monitor is healthy:

- the file exists
- the file changes over time
- the prefix contains one fairshare value per configured cluster
- the rest of the line contains zero or more jobs

## 5. Auto-Start on Login

### macOS with LaunchAgent

1. Copy the example plist:

```bash
mkdir -p ~/Library/LaunchAgents
cp examples/launchd/com.user.slurm-status.plist ~/Library/LaunchAgents/
```

2. Edit it:

```bash
nano ~/Library/LaunchAgents/com.user.slurm-status.plist
```

3. Update:

- the script path
- the cluster aliases in `ProgramArguments`
- `SLURM_STATUS_BAR_REMOTE_USER`
- `SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT` or per-cluster fairshare env vars
- optionally `SLURM_STATUS_BAR_SSHPASS_FILE`

4. Load it:

```bash
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.user.slurm-status.plist
launchctl enable "gui/$(id -u)/com.user.slurm-status"
launchctl kickstart -k "gui/$(id -u)/com.user.slurm-status"
```

5. Check status and logs:

```bash
launchctl print "gui/$(id -u)/com.user.slurm-status"
tail -f /tmp/slurm-status.log
tail -f /tmp/slurm-status.err
```

If you update the plist later, unload and reload it:

```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.user.slurm-status.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.user.slurm-status.plist
```

### Linux with systemd user services

Create `~/.config/systemd/user/slurm-status.service`:

```ini
[Unit]
Description=Slurm Status Monitor
After=network.target

[Service]
Type=simple
Environment=SLURM_STATUS_BAR_REMOTE_USER=YOUR_CLUSTER_USERNAME
Environment=SLURM_STATUS_BAR_DISABLE_PASSCODE_FALLBACK=1
Environment=SLURM_STATUS_BAR_DISABLE_FAIRSHARE=1
Environment=SLURM_STATUS_BAR_SQUEUE_ALIAS_FIR=robot-fir-slurm
Environment=SLURM_STATUS_BAR_SQUEUE_ALIAS_ROR=robot-ror-slurm
Environment=SLURM_STATUS_BAR_SQUEUE_ALIAS_NIBI=robot-nibi-slurm
Environment=SLURM_STATUS_BAR_SQUEUE_ALIAS_TRIL=robot-tril-slurm
ExecStart=/path/to/vscode-slurm-status-bar/scripts/slurm_monitor.sh fir ror nibi tril
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Then enable and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable slurm-status.service
systemctl --user start slurm-status.service
systemctl --user status slurm-status.service
```

## 6. What the Status Line Means

Example:

```text
Fir: 0.372 | Ror: 0.064 | Nibi: 0.774 | train_model (R) 1:23:45 | embed_docs (PD) 2:17
```

Interpretation:

- `Fir: 0.372` is the fairshare value selected from that cluster's `sshare` output
- `Ror: 0.064` is the fairshare value for the second configured cluster
- `train_model (R) 1:23:45` is a running job with time left from Slurm
- `embed_docs (PD) 2:17` is a pending job counting up locally from when it was first seen

Common job state codes:

- `R`: running
- `PD`: pending
- `CG`: completing
- `CD`: completed
- `F`: failed
- `CA`: cancelled

## Configuration Details

### Refresh timing

- Remote refresh interval: `60` seconds
- Local display update interval: `1` second

If you want to change the remote refresh interval, edit `REFRESH_INTERVAL` in [scripts/slurm_monitor.py](scripts/slurm_monitor.py).

### Backend layout

- [scripts/slurm_monitor.sh](scripts/slurm_monitor.sh) is a thin shell wrapper
- [scripts/slurm_monitor.py](scripts/slurm_monitor.py) contains the real monitor logic
- [src/extension.ts](src/extension.ts) is the VS Code extension that renders the status file

### How jobs are merged

- Jobs from all configured remotes are merged into one line.
- The job entries do not include the cluster name.
- Internally, the monitor keys jobs by `remote:jobid` to avoid collisions.

## Troubleshooting

### VS Code shows `No Slurm status`

Check:

```bash
cat ~/.slurm_status_bar.txt
ps aux | grep slurm_monitor
```

If the file does not exist, run the monitor manually:

```bash
./scripts/slurm_monitor.sh fir ror nibi
```

### The file exists but fairshare shows `?`

This usually means one of these:

- `sshare` failed on that cluster
- the wrong remote username is being used
- the monitor could not find the right fairshare account row
- fairshare is intentionally disabled for that cluster

Test directly:

```bash
ssh fir "sshare -u YOUR_CLUSTER_USERNAME -l -P"
```

If your account row is ambiguous, set `SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT` or a per-remote override.

### Jobs do not appear even though `squeue` works manually

Check whether the username differs between local and remote environments:

```bash
echo "$USER"
ssh fir "whoami"
```

If they differ, set:

```bash
export SLURM_STATUS_BAR_REMOTE_USER=YOUR_CLUSTER_USERNAME
```

### SSH prompts appear when running headlessly

The monitor is designed to work best with existing SSH ControlMaster sessions. If your cluster setup needs a passcode file:

1. install `sshpass`
2. store the passcode in a file readable only by you
3. set `SLURM_STATUS_BAR_SSHPASS_FILE`

You can also avoid this entirely by setting up key-based SSH or starting the shared SSH session yourself before the monitor runs.

For robot-node aliases, prefer key-based auth with `BatchMode no` and set `SLURM_STATUS_BAR_DISABLE_PASSCODE_FALLBACK=1`.

### LaunchAgent starts but immediately exits

Check:

```bash
tail -100 /tmp/slurm-status.err
launchctl print "gui/$(id -u)/com.user.slurm-status"
```

Common causes:

- wrong script path
- missing `python3`
- missing environment variables
- SSH alias works in your interactive shell but not from LaunchAgent because `~/.ssh/config` or PATH assumptions are wrong

### Stale status line

If the process died but the file remains, clear the file and restart the monitor:

```bash
pkill -f slurm_monitor.py
rm -f ~/.slurm_status_bar.txt
```

Then rerun the script manually before restarting your background service.

## Development

Build from source:

```bash
git clone https://github.com/devon7y/vscode-slurm-status-bar.git
cd vscode-slurm-status-bar
npm install
npm run compile
npx @vscode/vsce package
```

Project structure:

```text
vscode-slurm-status-bar/
├── src/
│   └── extension.ts
├── scripts/
│   ├── slurm_monitor.sh
│   └── slurm_monitor.py
├── examples/
│   └── launchd/
│       └── com.user.slurm-status.plist
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT License. See [LICENSE](LICENSE).

## Support

- Issues: [GitHub Issues](https://github.com/devon7y/vscode-slurm-status-bar/issues)
- Discussions: [GitHub Discussions](https://github.com/devon7y/vscode-slurm-status-bar/discussions)

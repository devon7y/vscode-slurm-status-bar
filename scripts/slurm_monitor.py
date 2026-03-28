#!/usr/bin/env python3

from __future__ import annotations

import getpass
import os
import pathlib
import re
import shlex
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass


STATUS_FILE = pathlib.Path.home() / ".slurm_status_bar.txt"
DEFAULT_PASSCODE_FILE = pathlib.Path.home() / ".claude" / "hpc_passcode"
PASSCODE_FILE = pathlib.Path(
    os.environ.get("SLURM_STATUS_BAR_SSHPASS_FILE", str(DEFAULT_PASSCODE_FILE))
)
FAIRSHARE_ACCOUNT_ENV = "SLURM_STATUS_BAR_FAIRSHARE_ACCOUNT"
REFRESH_INTERVAL = 60
TIME_PATTERN = re.compile(r"^(?:(\d+)-)?(\d+(?::\d+){0,2})$")
REMOTE_LABELS = {"fir": "Fir", "ror": "Ror"}


@dataclass
class JobState:
    name: str
    state: str
    time_left_seconds: int
    pending_elapsed_seconds: int = 0


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def env_key_for_remote(prefix: str, remote: str) -> str:
    remote_key = re.sub(r"[^A-Za-z0-9]+", "_", remote).upper()
    return f"{prefix}_{remote_key}"


def run_command(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True)


def find_sshpass() -> str | None:
    candidates = [
        shutil.which("sshpass"),
        "/opt/homebrew/bin/sshpass",
        "/usr/local/bin/sshpass",
        "/opt/local/bin/sshpass",
    ]
    for candidate in candidates:
        if candidate and os.path.exists(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def ensure_connection(remote: str) -> bool:
    check = run_command(["ssh", "-O", "check", remote])
    if check.returncode == 0:
        return True

    if not PASSCODE_FILE.exists():
        return False

    sshpass = find_sshpass()
    if not sshpass:
        return False

    reconnect = run_command(
        [
            sshpass,
            "-P",
            "Passcode",
            "-f",
            str(PASSCODE_FILE),
            "ssh",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-fN",
            remote,
        ]
    )
    if reconnect.returncode != 0:
        return False

    recheck = run_command(["ssh", "-O", "check", remote])
    return recheck.returncode == 0


def time_to_seconds(time_str: str) -> int:
    value = time_str.strip()
    if not value or value in {"N/A", "UNLIMITED"}:
        return 0

    match = TIME_PATTERN.fullmatch(value)
    if not match:
        return 0

    total_seconds = 0
    days = int(match.group(1) or 0)
    total_seconds += days * 86400

    parts = [int(part) for part in match.group(2).split(":")]
    if len(parts) == 3:
        hours, minutes, seconds = parts
        total_seconds += hours * 3600 + minutes * 60 + seconds
    elif len(parts) == 2:
        minutes, seconds = parts
        total_seconds += minutes * 60 + seconds
    elif len(parts) == 1:
        total_seconds += parts[0]

    return total_seconds


def seconds_to_time(seconds: int) -> str:
    if seconds <= 0:
        return "0:00"

    days, remainder = divmod(seconds, 86400)
    hours, remainder = divmod(remainder, 3600)
    minutes, secs = divmod(remainder, 60)

    if days > 0:
        return f"{days}-{hours:02d}:{minutes:02d}:{secs:02d}"
    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def fetch_jobs(remote: str, user: str) -> list[tuple[str, str, str, int]]:
    if not ensure_connection(remote):
        raise RuntimeError(f"unable to establish SSH connection to {remote}")

    remote_cmd = (
        f"squeue -u {shlex.quote(user)} --noheader -o '%i|%j|%t|%L'"
    )
    result = run_command(["ssh", remote, remote_cmd])
    if result.returncode != 0:
        details = (result.stderr or result.stdout).strip()
        raise RuntimeError(details or f"squeue failed on {remote}")

    jobs: list[tuple[str, str, str, int]] = []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split("|", 3)
        if len(parts) != 4:
            continue
        job_id, name, state, time_left = parts
        jobs.append((job_id, name, state, time_to_seconds(time_left)))
    return jobs


def fetch_fairshare(remote: str, user: str) -> str:
    if not ensure_connection(remote):
        raise RuntimeError(f"unable to establish SSH connection to {remote}")

    remote_cmd = f"sshare -u {shlex.quote(user)} -l -P"
    result = run_command(["ssh", remote, remote_cmd])
    if result.returncode != 0:
        details = (result.stderr or result.stdout).strip()
        raise RuntimeError(details or f"sshare failed on {remote}")

    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if len(lines) < 2:
        raise RuntimeError(f"unexpected sshare output on {remote}")

    header = [column.strip() for column in lines[0].split("|")]
    try:
        account_idx = header.index("Account")
        user_idx = header.index("User")
        fairshare_idx = header.index("FairShare")
    except ValueError as exc:
        raise RuntimeError(f"missing sshare column on {remote}: {exc}") from exc

    preferred_account = (
        os.environ.get(env_key_for_remote(FAIRSHARE_ACCOUNT_ENV, remote))
        or os.environ.get(FAIRSHARE_ACCOUNT_ENV)
        or ""
    ).strip()
    matching_rows: list[tuple[str, str]] = []

    for line in lines[1:]:
        columns = [column.strip() for column in line.split("|")]
        if len(columns) <= max(account_idx, user_idx, fairshare_idx):
            continue
        if columns[user_idx] != user:
            continue
        matching_rows.append(
            (columns[account_idx], columns[fairshare_idx].strip())
        )

    if not matching_rows:
        raise RuntimeError(f"no fairshare rows found for user {user} on {remote}")

    selected_account = ""
    selected_fairshare = ""

    if preferred_account:
        for account, fairshare in matching_rows:
            if account == preferred_account:
                selected_account = account
                selected_fairshare = fairshare
                break
        if not selected_account:
            raise RuntimeError(
                f"fairshare row for account {preferred_account} not found on {remote}"
            )
    else:
        gpu_rows = [
            (account, fairshare)
            for account, fairshare in matching_rows
            if "gpu" in account.lower()
        ]
        candidates = gpu_rows or matching_rows
        selected_account, selected_fairshare = candidates[0]
        if len(candidates) > 1:
            log(
                "Warning: multiple fairshare rows matched on "
                f"{remote}; using {selected_account}. "
                f"Set {FAIRSHARE_ACCOUNT_ENV} or "
                f"{env_key_for_remote(FAIRSHARE_ACCOUNT_ENV, remote)} "
                "to override."
            )

    try:
        return f"{float(selected_fairshare):.3f}"
    except ValueError:
        return selected_fairshare


def refresh_jobs(
    jobs_by_key: dict[str, JobState],
    fairshare_by_remote: dict[str, str],
    remotes: list[str],
    user: str,
) -> None:
    for remote in remotes:
        try:
            jobs = fetch_jobs(remote, user)
        except Exception as exc:  # noqa: BLE001
            log(f"Warning: failed to query {remote}: {exc}")
            continue

        try:
            fairshare_by_remote[remote] = fetch_fairshare(remote, user)
        except Exception as exc:  # noqa: BLE001
            log(f"Warning: failed to fetch fairshare for {remote}: {exc}")

        seen_keys: set[str] = set()
        for job_id, name, state, time_left_seconds in jobs:
            job_key = f"{remote}:{job_id}"
            seen_keys.add(job_key)

            previous = jobs_by_key.get(job_key)
            pending_elapsed_seconds = 0
            if state == "PD" and previous and previous.state == "PD":
                pending_elapsed_seconds = previous.pending_elapsed_seconds

            jobs_by_key[job_key] = JobState(
                name=name,
                state=state,
                time_left_seconds=time_left_seconds,
                pending_elapsed_seconds=pending_elapsed_seconds,
            )

        stale_keys = [
            job_key
            for job_key in jobs_by_key
            if job_key.startswith(f"{remote}:") and job_key not in seen_keys
        ]
        for stale_key in stale_keys:
            jobs_by_key.pop(stale_key, None)


def tick_jobs(jobs_by_key: dict[str, JobState]) -> None:
    for job in jobs_by_key.values():
        if job.state == "PD":
            job.pending_elapsed_seconds += 1
        elif job.time_left_seconds > 0:
            job.time_left_seconds -= 1


def build_output(
    jobs_by_key: dict[str, JobState],
    fairshare_by_remote: dict[str, str],
    remotes: list[str],
) -> str:
    parts: list[str] = []

    for remote in remotes:
        label = REMOTE_LABELS.get(remote, remote)
        fairshare = fairshare_by_remote.get(remote, "?")
        parts.append(f"{label}: {fairshare}")

    if not jobs_by_key:
        parts.append("No active jobs")
        return " | ".join(parts)

    sorted_jobs = sorted(
        jobs_by_key.values(),
        key=lambda job: (job.name.lower(), job.state, job.time_left_seconds),
    )

    for job in sorted_jobs:
        seconds = (
            job.pending_elapsed_seconds
            if job.state == "PD"
            else job.time_left_seconds
        )
        parts.append(f"{job.name} ({job.state}) {seconds_to_time(seconds)}")
    return " | ".join(parts)


def write_status(output: str) -> None:
    temp_path = STATUS_FILE.with_suffix(".txt.tmp")
    temp_path.write_text(output + "\n", encoding="utf-8")
    temp_path.replace(STATUS_FILE)


def main() -> int:
    remotes = sys.argv[1:] or ["fir", "ror"]
    user = os.environ.get("SLURM_STATUS_BAR_REMOTE_USER", getpass.getuser())
    jobs_by_key: dict[str, JobState] = {}
    fairshare_by_remote: dict[str, str] = {}
    counter = 0

    while True:
        if counter <= 0:
            refresh_jobs(jobs_by_key, fairshare_by_remote, remotes, user)
            counter = REFRESH_INTERVAL

        write_status(build_output(jobs_by_key, fairshare_by_remote, remotes))
        tick_jobs(jobs_by_key)
        counter -= 1
        time.sleep(1)


if __name__ == "__main__":
    raise SystemExit(main())

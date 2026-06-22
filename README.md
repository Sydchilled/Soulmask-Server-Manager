# ChillWithSyd — Soulmask Server Manager

A browser-based management panel for running and administering **Soulmask** dedicated server clusters on Windows and Linux. Built for server operators who want full control without touching config files manually.

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Platform: Windows & Linux](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-blue)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)

---

## Features

- **Cluster management** — run and monitor multiple Soulmask servers side by side (e.g. Shifting Sands + Cloud Mist Forest)
- **Live server controls** — start, stop, restart, and wipe servers from a clean web UI
- **Gameplay tuning** — sliders and inputs for XP rates, harvest rates, taming speed, day/night cycle, and more
- **Mod management** — add, remove, and reorder Steam Workshop mods with automatic SteamCMD sync
- **Cluster configuration** — edit all server settings (ports, passwords, player limits, etc.) without touching `.ini` files
- **Auto-update** — keep your server binaries up to date via SteamCMD on a schedule or on demand
- **Console log viewer** — live server output streamed to the browser
- **Windows & Linux support** — native installers for both platforms

---

## Requirements

- [Node.js](https://nodejs.org/) v18 or higher
- [SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD) installed and accessible
- A Steam account that owns Soulmask (for downloading server files)
- Windows 10/11 or a modern Linux distro (Ubuntu 20.04+ recommended)

---

## Installation

### Windows

1. Download the latest `.exe` installer from the [Releases](../../releases) page
2. Run the installer and follow the prompts
3. Launch **ChillWithSyd Server Manager** from your desktop or Start menu
4. Open your browser to `http://localhost:3000`

### Linux

1. Download the latest `.sh` installer from the [Releases](../../releases) page
2. Make it executable and run it:
   ```bash
   chmod +x chillwithsyd-soulmask-setup.sh
   ./chillwithsyd-soulmask-setup.sh
   ```
3. Start the manager:
   ```bash
   cd ~/chillwithsyd
   npm start
   ```
4. Open your browser to `http://localhost:3000`

---

## Quick Start

1. On first launch, the setup wizard will ask for:
   - Your SteamCMD path
   - Where to install server files
   - How many servers to run in your cluster
2. The manager will download the Soulmask dedicated server files automatically
3. Configure each server's settings from the **Config** tab
4. Hit **Start** — you're live

---

## Cluster Setup (Multi-Map)

ChillWithSyd supports running a full cluster out of the box. Each server in the cluster gets its own:

- Port configuration (game port, query port, RCON port)
- Map selection (Shifting Sands, Cloud Mist Forest, etc.)
- Independent mod list
- Separate save data and config

Players can travel between maps using in-game cluster portals as long as both servers share the same **Cluster ID** and **session name prefix** — the manager handles this automatically.

---

## Gameplay Settings

The **Tuning** tab exposes the most commonly adjusted gameplay multipliers:

| Setting | Default | Description |
|---|---|---|
| XP Rate | 1.0 | Experience gain multiplier |
| Harvest Rate | 1.0 | Resource yield multiplier |
| Taming Speed | 1.0 | NPC capture speed multiplier |
| Day Length | 1.0 | Real-time length of in-game day |
| Night Length | 1.0 | Real-time length of in-game night |
| Player Food Drain | 1.0 | Hunger rate multiplier |
| Player Water Drain | 1.0 | Thirst rate multiplier |

Changes apply on next server restart.

---

## Mod Management

1. Go to the **Mods** tab for a server
2. Paste a Steam Workshop URL or mod ID
3. Click **Add Mod** — the manager fetches metadata and queues a SteamCMD sync
4. Drag to reorder mods (load order matters!)
5. Restart the server to apply

---

## Updating the Server

Click **Check for Updates** on the dashboard or enable **Auto-Update** in settings. The manager will run SteamCMD in the background and notify you when an update is ready. Servers are stopped, updated, and restarted automatically if auto-update is on.

---

## Screenshots

*Coming soon*

---

## Manual

A full 32-page PDF manual covering all features, advanced configuration, troubleshooting, and cluster networking is available in the [Releases](../../releases) page alongside each installer.

---

## License

[MIT](LICENSE) — free to use, modify, and distribute.

---

## Credits

Built by [Sydchilled](https://github.com/Sydchilled) for the ChillWithSyd gaming community.

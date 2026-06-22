/**
 * ChillWithSyd Server Manager - Backend
 * Cross-platform (Windows & Linux) Node.js server manager
 * Supports multiple server instances
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const os = require('os');

// ─── CONFIG ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.CWS_PORT || '3000', 10);
const IS_WINDOWS = os.platform() === 'win32';

const DEFAULT_PATHS = {
  win32: 'D:\\soulmask\\steamcmd\\steamapps\\common\\Soulmask Dedicated Server For Windows',
  linux: '/home/steam/soulmask'
};

const SERVERS_FILE = path.join(__dirname, 'servers.json');

const SERVER_DEFAULTS = () => ({
  name: 'Server 1',
  serverPath: DEFAULT_PATHS[os.platform()] || DEFAULT_PATHS.linux,
  serverName: 'ChillWithSyd',
  maxPlayers: 10,
  serverPassword: '',
  adminPassword: 'admin123',
  port: 8777,
  queryPort: 27015,
  echoPort: 18888,
  gameMode: 'pve',
  map: 'Level01_Main',
  saving: 600,
  backup: 300,
  backupDir: path.join(__dirname, 'backups'),
  rconPsw: '',
  rconPort: 19000,
  extraArgs: '',
  checkUpdatesOnStart: false,
  // Cluster settings
  clusterRole: 'standalone',   // 'standalone' | 'main' | 'client'
  mainServerPort: 20000,       // main server only: TCP broadcast port for cluster
  clientServerConnect: '',     // client server only: 'ip:port' of main server
  mods: [],                    // array of { id, name } objects
  // Scheduled backup settings
  scheduledBackupEnabled: false,
  scheduledBackupIntervalHours: 3,
  scheduledBackupKeepCount: 10,
  // Auto-save keep count (for cleanup)
  autoSaveKeepCount: 20,
  // Scheduled restart settings
  dailyRestartEnabled: false,
  dailyRestartTime: '04:00',
  weeklyRestartEnabled: false,
  weeklyRestartDay: 0, // 0=Sunday
  weeklyRestartTime: '04:00',
  restartWarnMinutes: 10,
  restartUpdateCheck: true,
});

function loadServers() {
  if (fs.existsSync(SERVERS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8'));
      if (Array.isArray(data) && data.length) return data;
    } catch {}
  }
  // Migrate old single-config if present
  const OLD = path.join(__dirname, 'manager-config.json');
  if (fs.existsSync(OLD)) {
    try {
      const old = JSON.parse(fs.readFileSync(OLD, 'utf8'));
      const migrated = [{ ...SERVER_DEFAULTS(), ...old, id: 'srv1', name: 'Server 1' }];
      fs.writeFileSync(SERVERS_FILE, JSON.stringify(migrated, null, 2));
      return migrated;
    } catch {}
  }
  return [{ ...SERVER_DEFAULTS(), id: 'srv1', name: 'Server 1' }];
}

function saveServers(servers) {
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2));
}

function getServer(id) {
  return loadServers().find(s => s.id === id) || null;
}

// ─── MULTI-INSTANCE STATE ──────────────────────────────────────────────────────

const instances = {}; // id -> { process, logs, startTime }

function getInstance(id) {
  if (!instances[id]) instances[id] = { process: null, logs: [], startTime: null };
  return instances[id];
}

function addLog(id, type, message) {
  const inst = getInstance(id);
  inst.logs.push({ time: new Date().toISOString(), type, message });
  if (inst.logs.length > 500) inst.logs.shift();
  console.log(`[${id}:${type.toUpperCase()}] ${message}`);
}

// ─── SERVER EXE ───────────────────────────────────────────────────────────────

function findServerExe(serverPath) {
  // Confirmed correct paths from official guide: saraserenity.net/soulmask/dedicated_server_guide.php
  // Windows: WS\Binaries\Win64\WSServer-Win64-Shipping.exe
  // Linux:   WS/Binaries/Linux/WSServer-Linux-Shipping  OR  WSServer.sh in root
  const WIN_CANDIDATES = [
    path.join(serverPath, 'WS', 'Binaries', 'Win64', 'WSServer-Win64-Shipping.exe'),  // CORRECT
    path.join(serverPath, 'WS', 'Binaries', 'Win64', 'WS-Win64-Shipping.exe'),         // old name
    path.join(serverPath, 'WSServer-Win64-Shipping.exe'),                               // root fallback
  ];
  const LIN_CANDIDATES = [
    path.join(serverPath, 'WS', 'Binaries', 'Linux', 'WSServer-Linux-Shipping'),       // CORRECT
    path.join(serverPath, 'WSServer.sh'),                                               // shell wrapper
    path.join(serverPath, 'WS', 'Binaries', 'Linux', 'WS-Linux-Shipping'),             // old name
  ];
  const candidates = IS_WINDOWS ? WIN_CANDIDATES : LIN_CANDIDATES;
  for (const c of candidates) { if (fs.existsSync(c)) return c; }

  // Last resort: scan up to 3 levels deep for any shipping exe
  function scan(dir, depth) {
    if (depth > 3) return null;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) {
          const n = e.name.toLowerCase();
          if (IS_WINDOWS && n.includes('wsserver') && n.endsWith('.exe')) return path.join(dir, e.name);
          if (!IS_WINDOWS && (n.includes('wsserver') || n === 'wsserver.sh')) return path.join(dir, e.name);
        }
      }
      for (const e of entries) {
        if (e.isDirectory()) { const f = scan(path.join(dir, e.name), depth+1); if (f) return f; }
      }
    } catch {}
    return null;
  }
  return scan(serverPath, 0) || candidates[0];
}

function getServerExe(cfg) {
  const found = findServerExe(cfg.serverPath);
  if (found) return found;
  return IS_WINDOWS
    ? path.join(cfg.serverPath, 'WSServer-Win64-Shipping.exe')
    : path.join(cfg.serverPath, 'WSServer.sh');
}

function buildLaunchArgs(cfg) {
  const mapName = cfg.map || 'Level01_Main';
  const args = [
    mapName, '-server', '-log', '-UTF8Output', '-forcepassthrough',
    `-MULTIHOME=0.0.0.0`,
    `-PORT=${cfg.port || 8777}`,
    `-QueryPort=${cfg.queryPort || 27015}`,
    `-EchoPort=${cfg.echoPort || 18888}`,
    `-SteamServerName="${cfg.serverName}"`,
    `-MaxPlayers=${cfg.maxPlayers}`,
    `-saving=${cfg.saving || 600}`,
    `-backup=${cfg.backup || 300}`,
    `-online=Steam`,
    // serverid ties player account data to THIS server — never change it after players join
    // defaults to a stable hash of the server name so it persists across restarts
    `-serverid=${cfg.serverId || _stableId(cfg.serverName || 'ChillWithSyd')}`,
  ];
  const mode = (cfg.gameMode || 'pve').toLowerCase();
  if (mode === 'pvp') args.push('-pvp'); else args.push('-pve');
  if (cfg.serverPassword) args.push(`-PSW="${cfg.serverPassword}"`);
  if (cfg.adminPassword)  args.push(`-adminpsw="${cfg.adminPassword}"`);
  // -initbackup creates a backup on startup — good safety net
  args.push('-initbackup');
  if (cfg.rconPsw) {
    args.push(`-rconpsw=${cfg.rconPsw}`);
    args.push(`-rconport=${cfg.rconPort || 19000}`);
  }
  // Mods — use(-mod="id1,id2,id3") syntax confirmed from Soulmask wiki
  const mods = cfg.mods || [];
  if (mods.length > 0) {
    const modIds = mods.map(m => m.id).join(',');
    args.push(`use(-mod=\\"${modIds}\\")`);
  }
  // IMPORTANT: do not add these for standalone servers — they change how player data is stored
  const role = cfg.clusterRole || 'standalone';
  if (role === 'main') {
    args.push(`-mainserverport=${cfg.mainServerPort || 20000}`);
  } else if (role === 'client' && cfg.clientServerConnect) {
    args.push(`-clientserverconnect=${cfg.clientServerConnect}`);
  }
  if (cfg.extraArgs) args.push(...cfg.extraArgs.split(' ').filter(Boolean));
  return args;
}

function _stableId(str) {
  // Simple stable numeric hash from server name — used as serverid
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h) % 99999 + 1;
}

function getWorldSavePath(id) {
  const cfg = getServer(id) || loadServers()[0];
  const mapName = cfg.map || 'Level01_Main';

  // Auto-saves (auto_0_YYYYMMDDHHMMSS.db) live in the Worlds/Dedicated folder
  // world.db may also appear in WS/Saved directly but that doesn't have auto-saves
  // Always prioritise the deep path where auto-saves actually are
  const candidates = [
    path.join(cfg.serverPath, 'WS', 'Saved', 'Worlds', 'Dedicated', mapName),
    path.join(cfg.serverPath, 'WS', 'Saved', 'Worlds', 'Dedicated', 'DLC_Level01_Main'),
    path.join(cfg.serverPath, 'WS', 'Saved', 'Worlds', 'Dedicated'),
    path.join(cfg.serverPath, 'WS', 'Saved', 'Worlds'),
    path.join(cfg.serverPath, 'WS', 'Saved'),
  ];
  // Return first candidate that exists and has .db files
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.readdirSync(c).some(f => f.endsWith('.db'))) return c;
    } catch {}
  }
  // Default: use the map-specific path even if not yet created
  return path.join(cfg.serverPath, 'WS', 'Saved', 'Worlds', 'Dedicated', mapName);
}

function getWorldSaveInfo(id) {
  const savePath = getWorldSavePath(id);
  if (!fs.existsSync(savePath)) {
    return { ok: false, error: `Save directory not found: ${savePath}\n\nThe server must be started once to create the save folder.`, path: savePath };
  }
  try {
    const files = fs.readdirSync(savePath);
    const worldDb = path.join(savePath, 'world.db');
    // Auto-saves can be named auto_0_TIMESTAMP.db, auto_TIMESTAMP.db, or other .db files
    // Include all .db files that aren't world.db itself
    const autoSaves = files
      .filter(f => f.endsWith('.db') && f !== 'world.db' && !f.endsWith('.pre-restore.bak'))
      .map(f => {
        const full = path.join(savePath, f);
        const stat = fs.statSync(full);
        return { name: f, size: (stat.size / 1024 / 1024).toFixed(1) + ' MB', modified: stat.mtime };
      })
      .sort((a, b) => new Date(b.modified) - new Date(a.modified));
    
    const mainStat = fs.existsSync(worldDb) ? fs.statSync(worldDb) : null;
    return {
      ok: true,
      path: savePath,
      worldDb: worldDb,
      worldDbExists: !!mainStat,
      worldDbSize: mainStat ? (mainStat.size / 1024 / 1024).toFixed(1) + ' MB' : null,
      worldDbModified: mainStat ? mainStat.mtime : null,
      autoSaves,
      autoSaveCount: autoSaves.length,
      autoSaveTotalSize: (autoSaves.reduce((sum, f) => {
        try { return sum + fs.statSync(path.join(savePath, f.name)).size; } catch { return sum; }
      }, 0) / 1024 / 1024).toFixed(1) + ' MB'
    };
  } catch(e) {
    return { ok: false, error: e.message, path: savePath };
  }
}

function cleanAutoSaves(id, keepCount) {
  const info = getWorldSaveInfo(id);
  if (!info.ok) return { ok: false, error: info.error };
  const keep = parseInt(keepCount) || 5;
  const toDelete = info.autoSaves.slice(keep); // already sorted newest first, so slice after keep
  let deleted = 0;
  const errors = [];
  toDelete.forEach(f => {
    try {
      fs.unlinkSync(path.join(info.path, f.name));
      deleted++;
    } catch(e) { errors.push(f.name + ': ' + e.message); }
  });
  return { ok: true, deleted, kept: Math.min(keep, info.autoSaves.length), errors };
}

// ─── SERVER CONTROL ───────────────────────────────────────────────────────────

function startServer(id, skipUpdateCheck) {
  const inst = getInstance(id);
  if (inst.process) return { ok: false, error: 'Server is already running' };
  const cfg = getServer(id);
  if (!cfg) return { ok: false, error: 'Server not found: ' + id };

  // Run update check before starting if enabled
  if (!skipUpdateCheck && cfg.checkUpdatesOnStart !== false) {
    addLog(id, 'info', '🔄 Checking for Steam/game updates before start...');
    checkForUpdates(id, () => _doStartServer(id));
    return { ok: true, message: 'Update check running — server will start after.' };
  }

  return _doStartServer(id);
}

function _doStartServer(id) {
  const inst = getInstance(id);
  if (inst.process) return { ok: false, error: 'Server is already running' };
  const cfg = getServer(id);
  if (!cfg) return { ok: false, error: 'Server not found: ' + id };

  const exe = getServerExe(cfg);
  if (!fs.existsSync(exe)) {
    let contents = '';
    try {
      const entries = fs.readdirSync(cfg.serverPath);
      contents = entries.length
        ? `\n\nFound in ${cfg.serverPath}:\n  ${entries.slice(0,20).join('\n  ')}`
        : `\n\n${cfg.serverPath} exists but is empty.`;
    } catch { contents = `\n\n${cfg.serverPath} does not exist or cannot be read.`; }
    return { ok: false, error: `Executable not found. Searched: ${cfg.serverPath}${contents}` };
  }

  const args = buildLaunchArgs(cfg);
  addLog(id, 'info', `Starting: ${exe}`);
  addLog(id, 'info', `Map: ${cfg.map || 'Level01_Main'} | Port: ${cfg.port || 8777} | Players: ${cfg.maxPlayers || 10}`);
  addLog(id, 'save', `Auto-save: RAM every ${cfg.saving || 600}s | Disk every ${cfg.backup || 300}s (passing -backup=${cfg.backup || 300} -saving=${cfg.saving || 600})`);
  const role = cfg.clusterRole || 'standalone';
  if (role === 'main') addLog(id, 'info', `🔗 Cluster MAIN — broadcast port ${cfg.mainServerPort || 20000}`);
  else if (role === 'client') addLog(id, 'info', `🔗 Cluster CLIENT — connecting to ${cfg.clientServerConnect}`);
  const mods = cfg.mods || [];
  if (mods.length > 0) addLog(id, 'info', `🧩 Mods (${mods.length}): ${mods.map(m => m.name || m.id).join(', ')}`);

  // SteamAppId MUST be set as env var or the server won't connect to Steam
  const spawnEnv = { ...process.env, SteamAppId: '2646460' };

  // cwd must be the server root so relative DLL paths resolve correctly
  const cwd = cfg.serverPath;

  try {
    inst.process = spawn(exe, args, {
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
      cwd: fs.existsSync(cwd) ? cwd : undefined
    });
    inst.process.stdin.write('\n');
    inst.startTime = Date.now();

    const parseLine = (line, type) => {
      if (!line.trim()) return;
      if (line.includes('S_API FAIL')) return;
      if (line.includes('Redirecting stderr')) return;

      // Detect and highlight save-related output from the game
      const lower = line.toLowerCase();
      if (lower.includes('save') || lower.includes('backup') || lower.includes('world.db') || lower.includes('worldsave')) {
        addLog(id, 'save', line.trim());
      } else {
        addLog(id, type, line.trim());
      }
    };

    inst.process.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => parseLine(l, 'server')));
    inst.process.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => parseLine(l, 'error')));

    // Also watch WS.log file for save events — the game writes detailed save info there
    const logFile = path.join(cfg.serverPath, 'WS', 'Saved', 'Logs', 'WS.log');
    let logWatcher = null;
    let logSize = 0;
    const watchLog = () => {
      if (!fs.existsSync(logFile)) return;
      try {
        const stat = fs.statSync(logFile);
        if (stat.size <= logSize) return;
        const fd = fs.openSync(logFile, 'r');
        const buf = Buffer.alloc(stat.size - logSize);
        fs.readSync(fd, buf, 0, buf.length, logSize);
        fs.closeSync(fd);
        logSize = stat.size;
        buf.toString('utf8').split('\n').filter(Boolean).forEach(line => {
          const lower = line.toLowerCase();
          if (lower.includes('save') || lower.includes('backup') || lower.includes('world')) {
            addLog(id, 'save', '[WS.log] ' + line.trim());
          }
        });
      } catch {}
    };

    // Start watching log file once server is up (give it 5 seconds to create it)
    setTimeout(() => {
      if (fs.existsSync(logFile)) {
        try { logSize = fs.statSync(logFile).size; } catch {}
      }
      logWatcher = setInterval(watchLog, 5000);
    }, 5000);

    inst.logWatcher = logWatcher;
    inst.process.on('exit', code => {
      addLog(id, 'info', `Server exited with code ${code}`);
      if (inst.logWatcher) { clearInterval(inst.logWatcher); inst.logWatcher = null; }
      inst.process = null; inst.startTime = null;
    });
    inst.process.on('error', err => {
      addLog(id, 'error', 'Failed to start: ' + err.message);
      if (inst.logWatcher) { clearInterval(inst.logWatcher); inst.logWatcher = null; }
      inst.process = null; inst.startTime = null;
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function saveWorldNow(id) {
  // Correct remote console commands (confirmed: saraserenity.net/soulmask/remote_console.php):
  // SaveWorld 0     — writes current world state to in-memory DB
  // BackupDatabaseByHour (alias: bkh) — flushes to disk with timestamp filename
  // These must be sent via Telnet on EchoPort (18888), NOT stdin
  // Note: "quit"/"q" just disconnects from Telnet, does NOT shut down server

  const inst = getInstance(id);
  if (!inst.process) return { ok: false, error: 'Server is not running' };
  const cfg = getServer(id) || loadServers()[0];
  const echoPort = cfg.echoPort || 18888;
  const ts = new Date().toLocaleTimeString();

  addLog(id, 'save', `[${ts}] 💾 Manual world save triggered`);
  addLog(id, 'info', `Connecting to EchoPort ${echoPort}...`);

  const net = require('net');
  const client = net.createConnection({ port: echoPort, host: '127.0.0.1' });
  client.setTimeout(5000);

  client.on('connect', () => {
    addLog(id, 'info', 'EchoPort connected — sending SaveWorld 0...');
    // Step 1: SaveWorld 0 — write world state to in-memory DB
    client.write('SaveWorld 0\n');
    setTimeout(() => {
      // Step 2: BackupDatabaseByHour — flush to disk with timestamp
      addLog(id, 'info', 'Sending BackupDatabaseByHour...');
      client.write('BackupDatabaseByHour\n');
      setTimeout(() => {
        try { client.destroy(); } catch {}
        // Verify world.db was updated
        setTimeout(() => {
          try {
            const savePath = getWorldSavePath(id);
            const worldDb = path.join(savePath, 'world.db');
            if (fs.existsSync(worldDb)) {
              const stat = fs.statSync(worldDb);
              const ageSec = Math.round((Date.now() - stat.mtimeMs) / 1000);
              if (ageSec < 15) {
                addLog(id, 'save', `✓ world.db updated ${ageSec}s ago — save confirmed`);
              } else {
                // BackupDatabaseByHour creates a NEW file, not update world.db
                // Check the save folder for recently created .db files
                const files = fs.readdirSync(savePath)
                  .filter(f => f.endsWith('.db') && f !== 'world.db')
                  .map(f => ({ name: f, mtime: fs.statSync(path.join(savePath, f)).mtimeMs }))
                  .sort((a, b) => b.mtime - a.mtime);
                if (files.length > 0 && (Date.now() - files[0].mtime) < 15000) {
                  addLog(id, 'save', `✓ Backup file created: ${files[0].name}`);
                } else {
                  addLog(id, 'warn', `world.db last modified ${ageSec}s ago — EchoPort may not be responding to commands`);
                  addLog(id, 'info', 'Make sure EchoPort 18888 is not blocked by firewall');
                }
              }
            }
          } catch(e) { addLog(id, 'warn', 'Could not verify save: ' + e.message); }
        }, 3000);
      }, 1000);
    }, 1000);
  });

  client.on('data', d => {
    const msg = d.toString().trim();
    if (msg) addLog(id, 'save', '[EchoPort] ' + msg);
  });

  client.on('error', err => {
    addLog(id, 'warn', `EchoPort connection failed: ${err.message}`);
    addLog(id, 'warn', 'Cannot save remotely — EchoPort 18888 is not available');
    addLog(id, 'info', 'To save: press ~ in-game → gm key [adminpassword] → gm saveworld');
    addLog(id, 'info', 'Or use Stop & Save which shuts down with a world save');
  });

  client.on('timeout', () => {
    client.destroy();
    addLog(id, 'warn', 'EchoPort timed out — check port 18888 is not blocked by firewall');
  });

  return { ok: true, message: 'Save commands sent via EchoPort — check Server Logs' };
}

function stopServer(id) {
  const inst = getInstance(id);
  if (!inst.process) return { ok: false, error: 'Server is not running' };
  const cfg = getServer(id) || loadServers()[0];
  const echoPort = cfg.echoPort || 18888;
  const pid = inst.process.pid;

  addLog(id, 'info', 'Stopping server — sending save and shutdown commands...');

  let forceTimer = null;

  inst.process.once('exit', (code) => {
    if (forceTimer) clearTimeout(forceTimer);
    addLog(id, 'save', `✓ Server exited (code ${code}) — world saved`);
    if (inst.logWatcher) { clearInterval(inst.logWatcher); inst.logWatcher = null; }
    inst.process = null; inst.startTime = null;
  });

  // Method 1: stdin — immediate, no connection overhead, pipe is already open
  let stdinSent = false;
  try {
    if (inst.process.stdin && !inst.process.stdin.destroyed) {
      inst.process.stdin.write('SaveWorld 0\n');
      inst.process.stdin.write('shutdown 5\n');
      stdinSent = true;
      addLog(id, 'save', 'SaveWorld 0 + shutdown 5 sent via stdin — server saving and exiting in ~5s');
    }
  } catch(e) {
    addLog(id, 'warn', 'stdin write failed: ' + e.message);
  }

  // Method 2: Telnet in parallel — no waiting, just a belt-and-braces backup
  const net = require('net');
  const client = net.createConnection({ port: echoPort, host: '127.0.0.1' });
  client.setTimeout(3000);
  client.on('connect', () => {
    client.write('SaveWorld 0\n');
    setTimeout(() => {
      client.write('shutdown 5\n');
      addLog(id, 'info', 'SaveWorld 0 + shutdown 5 also sent via Telnet EchoPort ' + echoPort);
      setTimeout(() => { try { client.destroy(); } catch {} }, 1000);
    }, 300);
  });
  client.on('data', d => {
    const msg = d.toString().trim();
    if (msg) addLog(id, 'info', '[EchoPort] ' + msg);
  });
  client.on('error', () => {
    if (!stdinSent) addLog(id, 'warn', 'Both stdin and Telnet failed — open server console and press Ctrl+C');
  });
  client.on('timeout', () => { client.destroy(); });

  // Force-kill after 30 seconds
  forceTimer = setTimeout(() => {
    if (inst.process && inst.process.pid === pid) {
      addLog(id, 'warn', 'Shutdown timeout (30s) — force stopping');
      try {
        if (IS_WINDOWS) execSync(`taskkill /PID ${pid} /T /F`);
        else inst.process.kill('SIGKILL');
      } catch {}
      inst.process = null; inst.startTime = null;
    }
  }, 30000);

  return { ok: true, message: 'Save and shutdown sent — server will exit in ~5 seconds.' };
}

function getStatus(id) {
  const inst = getInstance(id);
  const cfg = getServer(id);
  return {
    id,
    running: !!inst.process,
    pid: inst.process?.pid || null,
    uptime: inst.startTime ? Math.floor((Date.now() - inst.startTime) / 1000) : 0,
    platform: os.platform(),
    hostname: os.hostname(),
    serverPath: cfg?.serverPath || '',
    port: cfg?.port || '',
    backupInterval: cfg?.backup || 300,
    memory: inst.process ? getProcessMemory(inst.process.pid) : null,
    clusterRole: cfg?.clusterRole || 'standalone',
    mainServerPort: cfg?.mainServerPort || 20000,
    clientServerConnect: cfg?.clientServerConnect || '',
    mods: cfg?.mods || [],
  };
}

function getAllStatus() {
  const servers = loadServers();
  return servers.map(s => getStatus(s.id));
}

function getProcessMemory(pid) {
  try {
    if (IS_WINDOWS) {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' });
      const match = out.match(/"[\d,]+ K"/);
      if (match) return Math.round(parseInt(match[0].replace(/[",\sK]/g, '')) / 1024) + ' MB';
    } else {
      const out = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8' }).trim();
      return Math.round(parseInt(out) / 1024) + ' MB';
    }
  } catch { return null; }
}

// ─── GAMEXISHU.JSON ───────────────────────────────────────────────────────────

function getGameXishuPath(id) {
  const cfg = getServer(id) || loadServers()[0];
  const settingsDir = path.join(cfg.serverPath, 'WS', 'Saved', 'GameplaySettings');
  // The active file depends on whether -coef was used at launch
  // If -coef=NAME was used, file is GameXishu_NAME.json
  // Otherwise it's GameXishu.json
  // Return whatever actually exists — prefer the most recently modified
  if (!fs.existsSync(settingsDir)) return path.join(settingsDir, 'GameXishu.json');
  try {
    const files = fs.readdirSync(settingsDir)
      .filter(f => f.startsWith('GameXishu') && f.endsWith('.json'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(settingsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > 0) return path.join(settingsDir, files[0].name);
  } catch {}
  return path.join(settingsDir, 'GameXishu.json');
}

function getGameXishuDiagnostic(id) {
  const cfg = getServer(id) || loadServers()[0];
  const settingsDir = path.join(cfg.serverPath, 'WS', 'Saved', 'GameplaySettings');
  const configDir = path.join(cfg.serverPath, 'WS', 'Config', 'GameplaySettings');

  const result = {
    settingsDir,
    settingsDirExists: fs.existsSync(settingsDir),
    savedFiles: [],
    templateFiles: [],
    activeFile: null,
    activeFileContents: null,
    structure: null,
    slot0Sample: null,
  };

  // List saved GameXishu files
  if (result.settingsDirExists) {
    try {
      result.savedFiles = fs.readdirSync(settingsDir)
        .filter(f => f.startsWith('GameXishu') && f.endsWith('.json'))
        .map(f => {
          const full = path.join(settingsDir, f);
          const stat = fs.statSync(full);
          return { name: f, size: (stat.size/1024).toFixed(1)+'KB', modified: stat.mtime };
        });
    } catch(e) { result.savedFilesError = e.message; }
  }

  // List template files
  if (fs.existsSync(configDir)) {
    try {
      result.templateFiles = fs.readdirSync(configDir)
        .filter(f => f.includes('Template') && f.endsWith('.json'));
    } catch {}
  }

  // Read the active file
  const activePath = getGameXishuPath(id);
  result.activeFile = activePath;
  if (fs.existsSync(activePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(activePath, 'utf8'));
      result.structure = detectGameXishuStructure(raw);
      // Show slot 0 sample — first 10 keys
      let slot0 = null;
      if (result.structure.type === 'numericKeys') slot0 = raw['0'];
      else if (result.structure.type === 'array') slot0 = raw[0];
      else if (result.structure.type === 'sets') slot0 = raw.Sets?.[0];
      else slot0 = raw;
      if (slot0) {
        const keys = Object.keys(slot0);
        result.slot0Sample = {};
        keys.slice(0, 15).forEach(k => result.slot0Sample[k] = slot0[k]);
        result.totalKeys = keys.length;
      }
      // Show raw for small files
      if (JSON.stringify(raw).length < 50000) result.activeFileContents = raw;
    } catch(e) { result.readError = e.message; }
  }

  return result;
}

function detectGameXishuStructure(data) {
  // Structure 1: {"0":{...},"1":{...},"2":{...}} — numeric string keys (most common in 1.0)
  if (typeof data === 'object' && !Array.isArray(data) && data !== null) {
    const numericKeys = Object.keys(data).filter(k => /^\d+$/.test(k) && typeof data[k] === 'object');
    if (numericKeys.length > 0) return { type: 'numericKeys', keys: numericKeys.sort() };
  }
  // Structure 2: [{...},{...},{...}] — array of slot objects
  if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
    return { type: 'array' };
  }
  // Structure 3: {Sets:[{...},{...}]} — wrapped array
  if (data && Array.isArray(data.Sets)) {
    return { type: 'sets' };
  }
  // Structure 4: flat object — single set of values
  return { type: 'flat' };
}

function readGameXishu(id) {
  const p = getGameXishuPath(id);
  if (!fs.existsSync(p)) {
    return { ok: false, error: `GameXishu.json not found at:\n${p}\n\nBoot and stop the server once to generate this file.`, path: p };
  }
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    const structure = detectGameXishuStructure(data);
    let settings = {};

    if (structure.type === 'numericKeys') {
      // Merge all slots — slot 0 takes base, others fill in any missing keys
      structure.keys.forEach(k => { if (typeof data[k] === 'object') Object.assign(settings, data[k]); });
      // Slot 0 is authoritative — re-apply it last so it wins
      if (data['0']) Object.assign(settings, data['0']);
    } else if (structure.type === 'array') {
      data.forEach(slot => { if (typeof slot === 'object') Object.assign(settings, slot); });
      if (data[0]) Object.assign(settings, data[0]);
    } else if (structure.type === 'sets') {
      data.Sets.forEach(slot => { if (typeof slot === 'object') Object.assign(settings, slot); });
      if (data.Sets[0]) Object.assign(settings, data.Sets[0]);
    } else {
      settings = data;
    }

    return { ok: true, settings, path: p, structure: structure.type };
  } catch(e) {
    return { ok: false, error: 'Failed to parse GameXishu.json: ' + e.message, path: p };
  }
}

function writeGameXishu(id, updates) {
  const p = getGameXishuPath(id);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // IMPORTANT: Server must be stopped before editing, or it will overwrite
  // our changes with its in-memory state when it shuts down.
  let rawData = null;
  if (fs.existsSync(p)) {
    try {
      rawData = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch(e) {
      return { ok: false, error: 'Could not parse existing file: ' + e.message };
    }
  }

  try {
    if (rawData === null) {
      // File doesn't exist yet — create with all three slots populated fully
      rawData = { '0': { ...updates }, '1': { ...updates }, '2': { ...updates } };
    } else {
      const structure = detectGameXishuStructure(rawData);

      if (structure.type === 'numericKeys') {
        // Force ALL updates into EVERY slot — not just keys that already exist
        // This ensures all three game mode slots get the same settings
        structure.keys.forEach(k => {
          if (typeof rawData[k] === 'object') {
            Object.assign(rawData[k], updates);
          }
        });
        // Guarantee slots 0,1,2 all exist even if file only had some
        ['0','1','2'].forEach(k => {
          if (!rawData[k]) rawData[k] = { ...updates };
        });

      } else if (structure.type === 'array') {
        rawData.forEach(slot => { if (typeof slot === 'object') Object.assign(slot, updates); });
        // Ensure 3 slots
        while (rawData.length < 3) rawData.push({ ...updates });

      } else if (structure.type === 'sets') {
        rawData.Sets.forEach(slot => { if (typeof slot === 'object') Object.assign(slot, updates); });
        while (rawData.Sets.length < 3) rawData.Sets.push({ ...updates });

      } else {
        Object.assign(rawData, updates);
      }
    }

    // Backup before write
    if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak');
    fs.writeFileSync(p, JSON.stringify(rawData, null, 2), 'utf8');
    return { ok: true, path: p };
  } catch(e) {
    return { ok: false, error: 'Write failed: ' + e.message };
  }
}

// ─── BACKUPS ──────────────────────────────────────────────────────────────────

function createBackup(id) {
  const cfg = getServer(id) || loadServers()[0];
  const savePath = path.join(cfg.serverPath, 'WS', 'Saved');
  if (!fs.existsSync(savePath)) return { ok: false, error: `Save directory not found: ${savePath}` };
  const backupDir = cfg.backupDir;
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupDir, `backup-${id}-${ts}`);
  try {
    if (IS_WINDOWS) execSync(`xcopy "${savePath}" "${dest}" /E /I /Q`);
    else execSync(`cp -r "${savePath}" "${dest}"`);
    addLog(id, 'info', `Backup created: ${dest}`);
    return { ok: true, path: dest };
  } catch (err) { return { ok: false, error: err.message }; }
}

function listBackups() {
  const servers = loadServers();
  const dirs = [...new Set(servers.map(s => s.backupDir))];
  const result = [];
  for (const backupDir of dirs) {
    if (!fs.existsSync(backupDir)) continue;
    fs.readdirSync(backupDir).filter(f => f.startsWith('backup-')).forEach(name => {
      const full = path.join(backupDir, name);
      const stat = fs.statSync(full);
      // Check what's inside the backup
      let hasWorldDb = false;
      let hasGameXishu = false;
      try {
        const files = fs.readdirSync(full, { recursive: true }).map(f => f.toString());
        hasWorldDb = files.some(f => f.endsWith('world.db'));
        hasGameXishu = files.some(f => f.includes('GameXishu'));
      } catch {}
      result.push({ name, created: stat.birthtime, size: getDirSize(full), hasWorldDb, hasGameXishu });
    });
  }
  return result.sort((a, b) => new Date(b.created) - new Date(a.created));
}

function restoreBackup(id, backupName) {
  const inst = getInstance(id);
  if (inst.process) return { ok: false, error: 'Server must be stopped before restoring a backup.' };

  const cfg = getServer(id) || loadServers()[0];
  const backupDir = cfg.backupDir;
  const backupPath = path.join(backupDir, backupName);

  if (!fs.existsSync(backupPath)) return { ok: false, error: `Backup not found: ${backupPath}` };

  const savePath = path.join(cfg.serverPath, 'WS', 'Saved');

  // Step 1: Safety backup of current state
  const safetyTs = new Date().toISOString().replace(/[:.]/g, '-');
  const safetyDest = path.join(backupDir, `pre-restore-${id}-${safetyTs}`);
  try {
    if (fs.existsSync(savePath)) {
      if (IS_WINDOWS) execSync(`xcopy "${savePath}" "${safetyDest}" /E /I /Q`);
      else execSync(`cp -r "${savePath}" "${safetyDest}"`);
      addLog(id, 'info', `Safety backup created: ${safetyDest}`);
    }
  } catch(e) {
    return { ok: false, error: 'Could not create safety backup: ' + e.message };
  }

  // Step 2: Delete current Saved folder entirely, then copy backup in clean
  // This prevents xcopy merge leaving stale files
  try {
    if (IS_WINDOWS) {
      if (fs.existsSync(savePath)) execSync(`rmdir /S /Q "${savePath}"`);
      execSync(`xcopy "${backupPath}" "${savePath}" /E /I /Q`);
    } else {
      if (fs.existsSync(savePath)) execSync(`rm -rf "${savePath}"`);
      execSync(`cp -r "${backupPath}" "${savePath}"`);
    }
    addLog(id, 'info', `Restored from backup: ${backupName}`);
    return {
      ok: true,
      safetyBackup: safetyDest,
      restoredFrom: backupPath,
      steps: [
        `Safety backup saved to: ${safetyDest}`,
        `Old WS/Saved deleted`,
        `Backup restored to: ${savePath}`,
        `Start the server to load the restored world`
      ]
    };
  } catch(e) {
    // Try to recover if delete succeeded but copy failed
    addLog(id, 'error', 'Restore failed: ' + e.message + ' — attempting recovery from safety backup');
    try {
      if (IS_WINDOWS) execSync(`xcopy "${safetyDest}" "${savePath}" /E /I /Q`);
      else execSync(`cp -r "${safetyDest}" "${savePath}"`);
      return { ok: false, error: 'Restore failed but original was recovered: ' + e.message };
    } catch(e2) {
      return { ok: false, error: 'Restore failed and recovery also failed. Safety backup at: ' + safetyDest };
    }
  }
}

function restoreAutoSave(id, autoSaveName) {
  const inst = getInstance(id);
  if (inst.process) return { ok: false, error: 'Server must be stopped before restoring.' };

  const savePath = getWorldSavePath(id);
  const autoSaveFile = path.join(savePath, autoSaveName);
  const worldDb = path.join(savePath, 'world.db');

  if (!fs.existsSync(autoSaveFile)) return { ok: false, error: `Auto-save not found: ${autoSaveName}` };

  try {
    // Backup current world.db first
    const bakPath = worldDb + '.pre-restore.bak';
    if (fs.existsSync(worldDb)) {
      fs.copyFileSync(worldDb, bakPath);
      addLog(id, 'info', `Current world.db backed up to: ${bakPath}`);
    }
    // Copy the auto-save file as the new world.db
    fs.copyFileSync(autoSaveFile, worldDb);
    addLog(id, 'info', `Restored world.db from: ${autoSaveName}`);
    return {
      ok: true,
      restoredFrom: autoSaveName,
      steps: [
        `Current world.db backed up to world.db.pre-restore.bak`,
        `Auto-save ${autoSaveName} copied to world.db`,
        `Start the server to load the restored world`
      ]
    };
  } catch(e) {
    return { ok: false, error: 'Restore failed: ' + e.message };
  }
}

function getDirSize(dir) {
  let size = 0;
  try { const files = fs.readdirSync(dir); for (const f of files) { const fp = path.join(dir, f); const s = fs.statSync(fp); size += s.isDirectory() ? getDirSize(fp) : s.size; } } catch {}
  return (size / 1024 / 1024).toFixed(1) + ' MB';
}

// ─── INSTALLER ────────────────────────────────────────────────────────────────

const STEAM_APP_ID = { win32: '3017310', linux: '3017300' };
let installProcess = null;
let installLogs = [];
let installStatus = 'idle';

function getInstallerInfo() {
  return { status: installStatus, logs: installLogs, steamcmdPresent: checkSteamCmd(), platform: os.platform() };
}

function checkForUpdates(id, callback) {
  // Run steamcmd app_update to check for and apply any updates before starting
  const cfg = getServer(id) || loadServers()[0];
  const appId = '2646460';

  if (!checkSteamCmd()) {
    addLog(id, 'warn', 'SteamCMD not found — skipping update check. Install via the Installer tab.');
    return callback(false);
  }

  addLog(id, 'info', '🔄 Checking for Steam updates (app_update ' + appId + ')...');
  const steamCmd = getSteamCmdPath();
  const args = ['+login', 'anonymous', '+force_install_dir', cfg.serverPath, '+app_update', appId, '+quit'];

  let updateProc;
  try {
    updateProc = require('child_process').spawn(steamCmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch(e) {
    addLog(id, 'warn', 'Update check failed to start: ' + e.message);
    return callback(false);
  }

  let updated = false;
  const handleLine = (line) => {
    line = line.trim();
    if (!line) return;
    if (line.includes('Update state') || line.includes('Downloading') || line.includes('Verifying')) {
      addLog(id, 'info', '[Steam] ' + line);
    } else if (line.includes('already up to date') || line.includes('up-to-date')) {
      addLog(id, 'save', '✓ Server is up to date');
    } else if (line.includes('Success') && line.includes('Update')) {
      addLog(id, 'save', '✓ Update applied: ' + line);
      updated = true;
    } else if (line.includes('Error') || line.includes('error')) {
      addLog(id, 'warn', '[Steam] ' + line);
    }
  };

  updateProc.stdout.on('data', d => d.toString().split('\n').forEach(handleLine));
  updateProc.stderr.on('data', d => d.toString().split('\n').forEach(handleLine));

  updateProc.on('exit', (code) => {
    if (code === 0) {
      addLog(id, 'info', 'Update check complete — starting server...');
    } else {
      addLog(id, 'warn', 'Update check exited with code ' + code + ' — starting server anyway...');
    }
    callback(updated);
  });

  updateProc.on('error', (e) => {
    addLog(id, 'warn', 'Update check error: ' + e.message + ' — starting server anyway...');
    callback(false);
  });
}

function checkSteamCmd() {
  try { execSync(IS_WINDOWS ? 'where steamcmd' : 'which steamcmd', { stdio: 'ignore' }); return true; } catch {}
  const local = IS_WINDOWS ? path.join(__dirname, 'steamcmd', 'steamcmd.exe') : path.join(__dirname, 'steamcmd', 'steamcmd.sh');
  return fs.existsSync(local);
}

function getSteamCmdPath() {
  if (IS_WINDOWS) {
    const local = path.join(__dirname, 'steamcmd', 'steamcmd.exe');
    if (fs.existsSync(local)) return local;
    return 'steamcmd.exe';
  }
  const local = path.join(__dirname, 'steamcmd', 'steamcmd.sh');
  if (fs.existsSync(local)) return local;
  return 'steamcmd';
}

function addInstallLog(type, message) {
  const entry = { time: new Date().toISOString(), type, message };
  installLogs.push(entry);
  if (installLogs.length > 1000) installLogs.shift();
  console.log(`[INSTALL:${type}] ${message}`);
}

function startInstall(installPath, appIdOverride) {
  if (installProcess) return { ok: false, error: 'Install already running' };
  installLogs = []; installStatus = 'running';
  const appId = appIdOverride || STEAM_APP_ID[os.platform()] || STEAM_APP_ID.linux;
  if (!fs.existsSync(installPath)) { try { fs.mkdirSync(installPath, { recursive: true }); } catch(e) { installStatus = 'error'; return { ok: false, error: 'Could not create dir: ' + e.message }; } }
  const steamCmd = getSteamCmdPath();
  const args = ['+login', 'anonymous', '+force_install_dir', installPath, '+app_update', appId, 'validate', '+quit'];
  addInstallLog('info', `Installing (App ID: ${appId})`);
  addInstallLog('info', `Destination: ${installPath}`);
  addInstallLog('info', 'SteamCMD will self-update first, then download server files...');
  try {
    installProcess = spawn(steamCmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    installProcess.stdin.write('\n');
    const parseLine = (line, type) => {
      if (!line.trim() || line.includes('S_API FAIL') || line.includes('Redirecting stderr')) return;
      addInstallLog(type, line.trim());
    };
    installProcess.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => parseLine(l, 'stdout')));
    installProcess.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => parseLine(l, 'info')));
    installProcess.on('exit', code => {
      installProcess = null;
      const success = code === 0 || code === 7;
      installStatus = success ? 'done' : 'error';
      if (success) {
        addInstallLog('info', `✓ Installation complete! (exit code ${code})`);
        // Auto-update first server's path if it's still default
        const servers = loadServers();
        if (servers[0] && servers[0].serverPath === (DEFAULT_PATHS[os.platform()] || DEFAULT_PATHS.linux)) {
          servers[0].serverPath = installPath;
          saveServers(servers);
          addInstallLog('info', 'Server path saved to Server 1 configuration.');
        }
      } else {
        addInstallLog('error', `✗ SteamCMD exited with code ${code}`);
      }
    });
    installProcess.on('error', err => { installStatus = 'error'; addInstallLog('error', 'Launch failed: ' + err.message); installProcess = null; });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

function cancelInstall() {
  if (!installProcess) return { ok: false, error: 'No install running' };
  try {
    if (IS_WINDOWS) execSync(`taskkill /PID ${installProcess.pid} /T /F`);
    else installProcess.kill('SIGTERM');
    installStatus = 'idle'; installProcess = null;
    addInstallLog('info', 'Installation cancelled.');
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
}

// ─── STEAMCMD SELF-INSTALLER ──────────────────────────────────────────────────

let steamcmdInstallStatus = 'idle';
let steamcmdInstallLogs = [];
let steamcmdInstallProcess = null;

function addSteamCmdLog(type, msg) {
  steamcmdInstallLogs.push({ time: new Date().toISOString(), type, message: msg });
  if (steamcmdInstallLogs.length > 300) steamcmdInstallLogs.shift();
  console.log(`[STEAMCMD:${type}] ${msg}`);
}

function getSteamCmdInstallInfo() {
  return { status: steamcmdInstallStatus, logs: steamcmdInstallLogs, present: checkSteamCmd(), platform: os.platform(), localPath: IS_WINDOWS ? path.join(__dirname, 'steamcmd', 'steamcmd.exe') : path.join(__dirname, 'steamcmd', 'steamcmd.sh') };
}

function installSteamCmd(res) {
  if (steamcmdInstallProcess) return json(res, { ok: false, error: 'Already running' });
  if (checkSteamCmd()) return json(res, { ok: true, alreadyPresent: true });
  steamcmdInstallLogs = []; steamcmdInstallStatus = 'running';
  const steamcmdDir = path.join(__dirname, 'steamcmd');
  if (!fs.existsSync(steamcmdDir)) fs.mkdirSync(steamcmdDir, { recursive: true });
  json(res, { ok: true });
  if (IS_WINDOWS) _installSteamCmdWindows(steamcmdDir);
  else _installSteamCmdLinux(steamcmdDir);
}

function _installSteamCmdWindows(steamcmdDir) {
  const zipPath = path.join(steamcmdDir, 'steamcmd.zip');
  const url = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';
  addSteamCmdLog('info', 'Downloading SteamCMD for Windows...');
  const ps = `$ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri '${url}' -OutFile '${zipPath}'; Expand-Archive -Path '${zipPath}' -DestinationPath '${steamcmdDir}' -Force; Remove-Item '${zipPath}'; Write-Output 'Done.'`;
  steamcmdInstallProcess = spawn('powershell', ['-NoProfile', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'] });
  steamcmdInstallProcess.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => addSteamCmdLog('info', l.trim())));
  steamcmdInstallProcess.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => addSteamCmdLog('error', l.trim())));
  steamcmdInstallProcess.on('exit', code => {
    steamcmdInstallProcess = null;
    const exePath = path.join(steamcmdDir, 'steamcmd.exe');
    if (code === 0 && fs.existsSync(exePath)) { addSteamCmdLog('info', '✓ Downloaded. Running first-time update...'); _runSteamCmdFirstTime(exePath); }
    else { steamcmdInstallStatus = 'error'; addSteamCmdLog('error', `Download failed (code ${code})`); }
  });
  steamcmdInstallProcess.on('error', err => { steamcmdInstallProcess = null; steamcmdInstallStatus = 'error'; addSteamCmdLog('error', 'PowerShell error: ' + err.message); });
}

function _installSteamCmdLinux(steamcmdDir) {
  addSteamCmdLog('info', 'Installing SteamCMD for Linux...');
  const hasApt = (() => { try { execSync('which apt-get', { stdio: 'ignore' }); return true; } catch { return false; } })();
  if (hasApt) {
    addSteamCmdLog('info', 'Using apt-get...');
    steamcmdInstallProcess = spawn('bash', ['-c', 'apt-get install -y lib32gcc-s1 steamcmd 2>&1 || (add-apt-repository multiverse -y && dpkg --add-architecture i386 && apt-get update -qq && apt-get install -y lib32gcc-s1 steamcmd 2>&1)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    const tarUrl = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz';
    const tarPath = path.join(steamcmdDir, 'steamcmd_linux.tar.gz');
    addSteamCmdLog('info', 'Downloading tar.gz...');
    steamcmdInstallProcess = spawn('bash', ['-c', `curl -sqL "${tarUrl}" -o "${tarPath}" && tar -xzf "${tarPath}" -C "${steamcmdDir}" && rm "${tarPath}" && chmod +x "${steamcmdDir}/steamcmd.sh" && echo "Done"`], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  steamcmdInstallProcess.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => addSteamCmdLog('info', l.trim())));
  steamcmdInstallProcess.stderr.on('data', d => d.toString().split('\n').filter(Boolean).forEach(l => addSteamCmdLog(l.toLowerCase().includes('error') ? 'error' : 'info', l.trim())));
  steamcmdInstallProcess.on('exit', code => {
    steamcmdInstallProcess = null;
    if (checkSteamCmd()) { steamcmdInstallStatus = 'done'; addSteamCmdLog('info', '✓ SteamCMD installed.'); _runSteamCmdFirstTime(getSteamCmdPath()); }
    else { steamcmdInstallStatus = 'error'; addSteamCmdLog('error', `Install failed (code ${code})`); }
  });
  steamcmdInstallProcess.on('error', err => { steamcmdInstallProcess = null; steamcmdInstallStatus = 'error'; addSteamCmdLog('error', err.message); });
}

function _runSteamCmdFirstTime(exe) {
  addSteamCmdLog('info', 'Running SteamCMD self-update...');
  const proc = spawn(exe, ['+quit'], { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdin.write('\n');
  proc.stdout.on('data', d => d.toString().split('\n').filter(l => l.trim() && !l.includes('S_API FAIL') && !l.includes('Redirecting')).forEach(l => addSteamCmdLog('info', l.trim())));
  proc.stderr.on('data', d => d.toString().split('\n').filter(l => l.trim() && !l.includes('S_API FAIL') && !l.includes('Redirecting')).forEach(l => addSteamCmdLog('info', l.trim())));
  proc.on('exit', () => { steamcmdInstallStatus = 'done'; addSteamCmdLog('info', '✓ SteamCMD ready.'); });
  proc.on('error', () => { steamcmdInstallStatus = 'done'; addSteamCmdLog('info', '✓ SteamCMD binary present.'); });
}

// ─── PATH UTILITIES ───────────────────────────────────────────────────────────

function validateInstallPath(p) {
  const result = { path: p, exists: false, isDir: false, canWrite: false, empty: false, hasSoulmask: false, warnings: [] };
  try {
    if (fs.existsSync(p)) {
      const stat = fs.statSync(p);
      result.exists = true; result.isDir = stat.isDirectory();
      if (result.isDir) {
        try { fs.accessSync(p, fs.constants.W_OK); result.canWrite = true; } catch {}
        const entries = fs.readdirSync(p);
        result.empty = entries.length === 0;
        result.hasSoulmask = entries.some(e => e.toLowerCase().includes('ws') || e.toLowerCase().includes('soulmask'));
        if (result.hasSoulmask) result.warnings.push('Soulmask files may already be present here.');
        if (!result.canWrite) result.warnings.push('Directory may not be writable.');
      } else result.warnings.push('Path exists but is not a directory.');
    } else {
      const parent = path.dirname(p);
      if (fs.existsSync(parent)) {
        try { fs.accessSync(parent, fs.constants.W_OK); result.canWrite = true; } catch {}
        result.warnings.push('Directory will be created during install.');
        if (!result.canWrite) result.warnings.push('Parent directory may not be writable.');
      } else { result.warnings.push('Parent directory does not exist — will be created recursively.'); result.canWrite = true; }
    }
  } catch(e) { result.warnings.push('Error checking path: ' + e.message); }
  return result;
}

function browsePath(p) {
  try {
    let target = path.resolve(p);
    let attempts = 0;
    while (!fs.existsSync(target) && attempts < 8) { target = path.dirname(target); attempts++; }
    if (!fs.existsSync(target)) return { entries: [], cwd: p };
    const entries = fs.readdirSync(target, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => ({ name: e.name, fullPath: path.join(target, e.name) })).sort((a, b) => a.name.localeCompare(b.name));
    return { entries, cwd: target, parent: path.dirname(target) !== target ? path.dirname(target) : null };
  } catch(e) { return { entries: [], cwd: p, error: e.message }; }
}

function getDiskInfo(p) {
  try {
    let check = p; let attempts = 0;
    while (!fs.existsSync(check) && attempts < 8) { check = path.dirname(check); attempts++; }
    if (IS_WINDOWS) {
      const drive = check.match(/^([A-Za-z]:\\?)/)?.[1] || 'C:\\';
      const out = execSync(`powershell -NoProfile -Command "(Get-PSDrive ${drive[0]}) | Select-Object Used,Free | ConvertTo-Json"`, { encoding: 'utf8', timeout: 5000 }).trim();
      const d = JSON.parse(out);
      const free = d.Free || 0, used = d.Used || 0, total = free + used;
      return { total: _fmtBytes(total), free: _fmtBytes(free), used: _fmtBytes(used), pctUsed: total ? Math.round((used / total) * 100) : 0, enoughForSingle: free > 30e9, enoughForBoth: free > 60e9, drive };
    } else {
      const out = execSync(`df -Pk "${check}"`, { encoding: 'utf8', timeout: 5000 });
      const parts = out.trim().split('\n')[1].trim().split(/\s+/);
      const total = parseInt(parts[1]) * 1024, used = parseInt(parts[2]) * 1024, free = parseInt(parts[3]) * 1024;
      return { total: _fmtBytes(total), free: _fmtBytes(free), used: _fmtBytes(used), pctUsed: total ? Math.round((used / total) * 100) : 0, enoughForSingle: free > 30e9, enoughForBoth: free > 60e9, filesystem: parts[0] };
    }
  } catch(e) { return { error: e.message }; }
}

function _fmtBytes(b) {
  if (b > 1e12) return (b/1e12).toFixed(1)+' TB';
  if (b > 1e9)  return (b/1e9).toFixed(1)+' GB';
  if (b > 1e6)  return (b/1e6).toFixed(1)+' MB';
  return b+' B';
}

function getPathPresets() {
  if (IS_WINDOWS) {
    return [
      { label: 'D: SteamCMD (your setup)', path: 'D:\\soulmask\\steamcmd\\steamapps\\common\\Soulmask Dedicated Server For Windows' },
      { label: 'C: SteamCMD', path: 'C:\\steamcmd\\steamapps\\common\\Soulmask Dedicated Server For Windows' },
      { label: 'D: SteamCMD root', path: 'D:\\steamcmd\\steamapps\\common\\Soulmask Dedicated Server For Windows' },
      { label: 'E: SteamCMD', path: 'E:\\steamcmd\\steamapps\\common\\Soulmask Dedicated Server For Windows' },
      { label: 'C: Custom', path: 'C:\\SoulmaskServer' },
    ];
  }
  return [
    { label: 'Home (steam)', path: '/home/steam/soulmask' },
    { label: 'Home (current)', path: `${os.homedir()}/soulmask` },
    { label: 'Opt', path: '/opt/soulmask' },
    { label: 'Srv', path: '/srv/soulmask' },
    { label: 'Steam default', path: '/home/steam/.steam/steamapps/common/Soulmask Dedicated Server For Linux' },
  ];
}

// ─── HTTP SERVER ───────────────────────────────────────────────────────────────

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (pathname.startsWith('/api/')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const data = body ? (() => { try { return JSON.parse(body); } catch { return {}; } })() : {};
      const id = url.searchParams.get('id') || data.id;

      // ── Server list management ──
      if (pathname === '/api/servers' && req.method === 'GET') return json(res, loadServers());
      if (pathname === '/api/servers/add') {
        const servers = loadServers();
        const newId = 'srv' + Date.now();
        const newServer = { ...SERVER_DEFAULTS(), ...data, id: newId, name: data.name || `Server ${servers.length + 1}` };
        // Auto-increment ports to avoid conflicts
        const maxPort = Math.max(...servers.map(s => s.port || 8777));
        const maxQuery = Math.max(...servers.map(s => s.queryPort || 27015));
        const maxEcho = Math.max(...servers.map(s => s.echoPort || 18888));
        newServer.port = maxPort + 1;
        newServer.queryPort = maxQuery + 1;
        newServer.echoPort = maxEcho + 1;
        servers.push(newServer);
        saveServers(servers);
        return json(res, { ok: true, server: newServer });
      }
      if (pathname === '/api/servers/import') {
        // Import an existing server installation by scanning its folder
        const serverPath = (data.serverPath || '').trim();
        if (!serverPath) return json(res, { ok: false, error: 'serverPath required' });
        if (!fs.existsSync(serverPath)) return json(res, { ok: false, error: `Folder not found: ${serverPath}` });

        // Find the exe to confirm it is a Soulmask server folder
        const exe = findServerExe(serverPath);
        if (!fs.existsSync(exe)) return json(res, { ok: false, error: `WSServer exe not found in: ${serverPath}\nExpected at: WS\\Binaries\\Win64\\WSServer-Win64-Shipping.exe` });

        // Auto-detect map from save folder
        let detectedMap = 'Level01_Main';
        const savesBase = path.join(serverPath, 'WS', 'Saved', 'Worlds', 'Dedicated');
        if (fs.existsSync(savesBase)) {
          const maps = fs.readdirSync(savesBase).filter(f => {
            try { return fs.statSync(path.join(savesBase, f)).isDirectory(); } catch { return false; }
          });
          if (maps.includes('DLC_Level01_Main')) detectedMap = 'DLC_Level01_Main';
          else if (maps.length > 0) detectedMap = maps[0];
        }

        // Try to read server name from existing GameXishu or StartServer.bat
        let detectedName = path.basename(serverPath);
        const batPath = path.join(serverPath, 'StartServer.bat');
        if (fs.existsSync(batPath)) {
          try {
            const bat = fs.readFileSync(batPath, 'utf8');
            const m = bat.match(/-SteamServerName[= ]"?([^"\s-]+)"?/i);
            if (m) detectedName = m[1];
          } catch {}
        }

        // Check for existing world.db to confirm save data
        const saveDir = path.join(savesBase, detectedMap);
        const worldDb = path.join(saveDir, 'world.db');
        const hasWorldDb = fs.existsSync(worldDb);
        let worldDbSize = null;
        if (hasWorldDb) {
          try { worldDbSize = (fs.statSync(worldDb).size / 1024 / 1024).toFixed(1) + ' MB'; } catch {}
        }

        // Build the new server config
        const servers = loadServers();
        const newId = 'srv' + Date.now();
        const maxPort  = Math.max(...servers.map(s => s.port || 8777));
        const maxQuery = Math.max(...servers.map(s => s.queryPort || 27015));
        const maxEcho  = Math.max(...servers.map(s => s.echoPort || 18888));

        const newServer = {
          ...SERVER_DEFAULTS(),
          id: newId,
          name: detectedName,
          serverPath,
          map: detectedMap,
          port: servers.length > 0 ? maxPort + 1 : 8777,
          queryPort: servers.length > 0 ? maxQuery + 1 : 27015,
          echoPort: servers.length > 0 ? maxEcho + 1 : 18888,
        };
        servers.push(newServer);
        saveServers(servers);

        return json(res, {
          ok: true,
          server: newServer,
          detected: {
            map: detectedMap,
            name: detectedName,
            hasWorldDb,
            worldDbSize,
            saveDir
          }
        });
      }
      if (pathname === '/api/servers/remove') {
        if (!id) return json(res, { ok: false, error: 'id required' });
        const servers = loadServers().filter(s => s.id !== id);
        if (servers.length === 0) return json(res, { ok: false, error: 'Cannot remove last server' });
        saveServers(servers);
        return json(res, { ok: true });
      }
      if (pathname === '/api/servers/rename') {
        if (!id || !data.name) return json(res, { ok: false, error: 'id and name required' });
        const servers = loadServers();
        const s = servers.find(s => s.id === id);
        if (!s) return json(res, { ok: false, error: 'Server not found' });
        s.name = data.name;
        saveServers(servers);
        return json(res, { ok: true });
      }

      // ── Per-server status & control ──
      if (pathname === '/api/status') return json(res, id ? getStatus(id) : getAllStatus());
      if (pathname === '/api/start') { if (!id) return json(res, { ok: false, error: 'id required' }); return json(res, startServer(id, url.searchParams.get('skip_update') === '1')); }
      if (pathname === '/api/stop')  { if (!id) return json(res, { ok: false, error: 'id required' }); return json(res, stopServer(id)); }
      if (pathname === '/api/save')  { if (!id) return json(res, { ok: false, error: 'id required' }); return json(res, saveWorldNow(id)); }
      if (pathname === '/api/restart') {
        if (!id) return json(res, { ok: false, error: 'id required' });
        stopServer(id);
        setTimeout(() => json(res, startServer(id)), 2000);
        return;
      }
      if (pathname === '/api/logs') {
        if (!id) return json(res, { error: 'id required' });
        const since = parseInt(url.searchParams.get('since') || '0');
        return json(res, { logs: getInstance(id).logs.slice(since) });
      }

      // ── Per-server config ──
      if (pathname === '/api/config' && req.method === 'GET') {
        if (!id) return json(res, { error: 'id required' });
        return json(res, getServer(id) || {});
      }
      if (pathname === '/api/config' && req.method === 'POST') {
        if (!id) return json(res, { ok: false, error: 'id required' });
        const servers = loadServers();
        const idx = servers.findIndex(s => s.id === id);
        if (idx < 0) return json(res, { ok: false, error: 'Server not found' });
        servers[idx] = { ...servers[idx], ...data, id };
        saveServers(servers);
        return json(res, { ok: true });
      }

      // ── Tuning ──
      if (pathname === '/api/tuning/read') return json(res, readGameXishu(id));
      if (pathname === '/api/tuning/write') return json(res, writeGameXishu(id, data));
      if (pathname === '/api/tuning/diagnostic') return json(res, getGameXishuDiagnostic(id));
      if (pathname === '/api/tuning/raw') {
        // Read raw file contents as string
        const p = getGameXishuPath(id);
        if (!fs.existsSync(p)) return json(res, { ok: false, error: 'File not found: ' + p });
        try { return json(res, { ok: true, path: p, contents: fs.readFileSync(p, 'utf8') }); }
        catch(e) { return json(res, { ok: false, error: e.message }); }
      }
      if (pathname === '/api/tuning/rawwrite') {
        // Write raw JSON string directly — bypass our structure detection
        const p = getGameXishuPath(id);
        if (!data.contents) return json(res, { ok: false, error: 'No contents provided' });
        try {
          // Validate it's parseable JSON first
          JSON.parse(data.contents);
          if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak');
          fs.writeFileSync(p, data.contents, 'utf8');
          return json(res, { ok: true, path: p });
        } catch(e) { return json(res, { ok: false, error: 'Invalid JSON: ' + e.message }); }
      }

      // ── Backups ──
      if (pathname === '/api/backup/create') return json(res, createBackup(id));
      if (pathname === '/api/backup/list') return json(res, { backups: listBackups() });
      if (pathname === '/api/backup/history') return json(res, getBackupHistory(id));
      if (pathname === '/api/backup/restore') {
        if (!data.name) return json(res, { ok: false, error: 'Backup name required' });
        return json(res, restoreBackup(id, data.name));
      }
      if (pathname === '/api/backup/delete') {
        if (!data.name) return json(res, { ok: false, error: 'Name required' });
        const cfg = getServer(id) || loadServers()[0];
        const full = path.join(cfg.backupDir, data.name);
        try {
          if (IS_WINDOWS) execSync(`rmdir /S /Q "${full}"`);
          else execSync(`rm -rf "${full}"`);
          return json(res, { ok: true });
        } catch(e) { return json(res, { ok: false, error: e.message }); }
      }
      if (pathname === '/api/scheduler/status') return json(res, getSchedulerStatus(id));
      if (pathname === '/api/scheduler/save') {
        const cfg = getServer(id);
        if (!cfg) return json(res, { ok: false, error: 'Server not found' });
        Object.assign(cfg, {
          scheduledBackupEnabled: !!data.scheduledBackupEnabled,
          scheduledBackupIntervalHours: parseInt(data.scheduledBackupIntervalHours) || 3,
          scheduledBackupKeepCount: parseInt(data.scheduledBackupKeepCount) || 10,
          autoSaveKeepCount: parseInt(data.autoSaveKeepCount) || 20,
          dailyRestartEnabled: !!data.dailyRestartEnabled,
          dailyRestartTime: data.dailyRestartTime || '04:00',
          weeklyRestartEnabled: !!data.weeklyRestartEnabled,
          weeklyRestartDay: parseInt(data.weeklyRestartDay) || 0,
          weeklyRestartTime: data.weeklyRestartTime || '04:00',
          restartWarnMinutes: parseInt(data.restartWarnMinutes) || 10,
          restartUpdateCheck: data.restartUpdateCheck !== false,
        });
        saveServers(loadServers().map(s => s.id === id ? cfg : s));
        initScheduler(id);
        return json(res, { ok: true });
      }
      if (pathname === '/api/scheduler/backup-now') {
        return json(res, createScheduledBackup(id));
      }
      if (pathname === '/api/path/drives') {
        // List available drives (Windows) or mount points (Linux)
        const drives = [];
        if (IS_WINDOWS) {
          try {
            const out = execSync('wmic logicaldisk get DeviceID,Size,FreeSpace /format:csv', { encoding: 'utf8' });
            out.split('\n').filter(l => l.includes(':')).forEach(line => {
              const parts = line.trim().split(',');
              if (parts.length >= 3) {
                const letter = parts[1]?.trim();
                const free = parseInt(parts[0]?.trim()) || 0;
                const size = parseInt(parts[2]?.trim()) || 0;
                if (letter) drives.push({ letter, free: (free/1073741824).toFixed(1)+'GB', size: (size/1073741824).toFixed(1)+'GB' });
              }
            });
          } catch(e) {
            // Fallback: try common drive letters
            'CDEFGHIJKLMNOP'.split('').forEach(l => {
              try { fs.accessSync(l + ':\\'); drives.push({ letter: l + ':', free: '?', size: '?' }); } catch {}
            });
          }
        } else {
          try {
            const out = execSync("df -h --output=target,avail,size | tail -n +2", { encoding: 'utf8' });
            out.split('\n').filter(Boolean).forEach(line => {
              const parts = line.trim().split(/\s+/);
              if (parts[0]) drives.push({ letter: parts[0], free: parts[1] || '?', size: parts[2] || '?' });
            });
          } catch {}
        }
        return json(res, { ok: true, drives });
      }
      if (pathname === '/api/world/autosaves') {
        const basic = listAutoSaves(id);
        // Also do a deep scan to find .db files anywhere under WS/Saved
        const cfg = getServer(id) || loadServers()[0];
        const wsRoot = path.join(cfg.serverPath, 'WS', 'Saved');
        const found = [];
        function scan(dir, depth) {
          if (depth > 5) return;
          try {
            fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
              if (e.isDirectory()) scan(path.join(dir, e.name), depth + 1);
              else if (e.name.endsWith('.db')) {
                const full = path.join(dir, e.name);
                const stat = fs.statSync(full);
                found.push({
                  name: e.name,
                  relativePath: full.replace(cfg.serverPath, '').replace(/\\/g, '/'),
                  size: (stat.size / 1024 / 1024).toFixed(1) + ' MB',
                  modified: stat.mtime
                });
              }
            });
          } catch {}
        }
        if (fs.existsSync(wsRoot)) scan(wsRoot, 0);
        found.sort((a, b) => new Date(b.modified) - new Date(a.modified));
        return json(res, { ...basic, deepScan: found, deepScanRoot: wsRoot });
      }
      if (pathname === '/api/world/restore') {
        if (!data.name) return json(res, { ok: false, error: 'Auto-save name required' });
        return json(res, restoreAutoSave(id, data.name));
      }
      if (pathname === '/api/world/info') return json(res, getWorldSaveInfo(id));
      if (pathname === '/api/world/clean') return json(res, cleanAutoSaves(id, data.keepCount));

      // ── Installer ──
      if (pathname === '/api/install/info') return json(res, getInstallerInfo());
      if (pathname === '/api/install/start') {
        const { installPath, appId } = data;
        if (!installPath) return json(res, { ok: false, error: 'installPath required' });
        return json(res, startInstall(installPath, appId));
      }
      if (pathname === '/api/install/cancel') return json(res, cancelInstall());
      if (pathname === '/api/install/logs') {
        const since = parseInt(url.searchParams.get('since') || '0');
        return json(res, { logs: installLogs.slice(since), status: installStatus });
      }

      // ── SteamCMD ──
      if (pathname === '/api/steamcmd/info') return json(res, getSteamCmdInstallInfo());
      if (pathname === '/api/steamcmd/install') return installSteamCmd(res);
      if (pathname === '/api/steamcmd/logs') {
        const since = parseInt(url.searchParams.get('since') || '0');
        return json(res, { logs: steamcmdInstallLogs.slice(since), status: steamcmdInstallStatus });
      }

      // ── Path utils ──
      if (pathname === '/api/path/validate') { const { p } = data; if (!p) return json(res, { ok: false, error: 'No path' }); return json(res, validateInstallPath(p)); }
      if (pathname === '/api/path/browse')   { return json(res, browsePath(data.p || (IS_WINDOWS ? 'C:\\' : '/'))); }
      if (pathname === '/api/path/disk')     { return json(res, getDiskInfo(data.p || (IS_WINDOWS ? 'C:\\' : '/'))); }
      if (pathname === '/api/path/presets')  { return json(res, getPathPresets()); }
      if (pathname === '/api/path/ls') {
        const { p } = data;
        if (!p) return json(res, { ok: false, error: 'No path' });
        try {
          if (!fs.existsSync(p)) return json(res, { ok: false, error: 'Path does not exist: ' + p });
          const entries = fs.readdirSync(p, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory(), isExe: !e.isDirectory() && (e.name.endsWith('.exe') || e.name.endsWith('.sh') || e.name.endsWith('.bat')) })).sort((a,b) => (b.isExe - a.isExe) || a.name.localeCompare(b.name));
          return json(res, { ok: true, path: p, entries });
        } catch(e) { return json(res, { ok: false, error: e.message }); }
      }

      json(res, { error: 'Not found' }, 404);
    });
    return;
  }

  // Serve manual PDF
  if (pathname === '/manual') {
    const pdfPaths = [
      path.join(__dirname, 'ChillWithSyd-Server-Manager-Manual.pdf'),
      path.join(__dirname, 'manual', 'ChillWithSyd-Server-Manager-Manual.pdf'),
    ];
    const pdfFile = pdfPaths.find(p => fs.existsSync(p));
    if (!pdfFile) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      return res.end('<h2>Manual not found</h2><p>Place ChillWithSyd-Server-Manager-Manual.pdf in the same folder as server.js</p>');
    }
    const pdf = fs.readFileSync(pdfFile);
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="ChillWithSyd-Server-Manager-Manual.pdf"' });
    return res.end(pdf);
  }

  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`\n💜 ChillWithSyd Server Manager running at http://localhost:${PORT}\n`);
  console.log(`Platform: ${os.platform()} (${os.arch()})`);
  console.log(`Servers: ${SERVERS_FILE}\n`);
});

// ── UNIFIED BACKUP HISTORY ────────────────────────────────────────────────────
function getBackupHistory(id) {
  const cfg = getServer(id) || loadServers()[0];
  const items = [];

  const backupDir = cfg.backupDir;
  if (fs.existsSync(backupDir)) {
    try {
      fs.readdirSync(backupDir).forEach(name => {
        if (!name.startsWith('backup-') && !name.startsWith('pre-restore-')) return;
        const full = path.join(backupDir, name);
        try {
          const stat = fs.statSync(full);
          items.push({
            type: name.startsWith('pre-restore-') ? 'pre-restore' : name.includes('-sched-') ? 'scheduled' : 'manual',
            name, path: full,
            size: getDirSize(full),
            modified: stat.mtime,
            restoreType: 'backup'
          });
        } catch {}
      });
    } catch {}
  }

  const savePath = getWorldSavePath(id);
  if (fs.existsSync(savePath)) {
    try {
      fs.readdirSync(savePath)
        .filter(f => f.endsWith('.db') && f !== 'world.db' && !f.endsWith('.bak'))
        .forEach(name => {
          const full = path.join(savePath, name);
          try {
            const stat = fs.statSync(full);
            items.push({ type: 'autosave', name, path: full, size: (stat.size/1024/1024).toFixed(1)+' MB', modified: stat.mtime, restoreType: 'autosave' });
          } catch {}
        });
    } catch {}
  }

  items.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  const backups = items.filter(i => i.type !== 'autosave' && i.type !== 'pre-restore');
  const autoSaves = items.filter(i => i.type === 'autosave');
  return { ok: true, items, stats: { totalBackups: backups.length, totalAutoSaves: autoSaves.length, lastBackup: backups[0]?.modified || null, lastAutoSave: autoSaves[0]?.modified || null } };
}

// ── SCHEDULED BACKUP ──────────────────────────────────────────────────────────
function createScheduledBackup(id) {
  const cfg = getServer(id) || loadServers()[0];
  const backupDir = cfg.backupDir;
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupDir, `backup-${id}-sched-${ts}`);
  const savePath = path.join(cfg.serverPath, 'WS', 'Saved');
  try {
    if (IS_WINDOWS) execSync(`xcopy "${savePath}" "${dest}" /E /I /Q`);
    else execSync(`cp -r "${savePath}" "${dest}"`);
    addLog(id, 'save', `✓ Scheduled backup created: ${path.basename(dest)}`);
    cleanOldScheduledBackups(id, cfg.scheduledBackupKeepCount || 10);
    return { ok: true, name: path.basename(dest) };
  } catch(e) {
    addLog(id, 'warn', `Scheduled backup failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

function cleanOldScheduledBackups(id, keepCount) {
  const cfg = getServer(id) || loadServers()[0];
  const backupDir = cfg.backupDir;
  if (!fs.existsSync(backupDir)) return;
  try {
    const scheduled = fs.readdirSync(backupDir)
      .filter(f => f.includes('-sched-'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    scheduled.slice(keepCount).forEach(f => {
      try {
        if (IS_WINDOWS) execSync(`rmdir /S /Q "${path.join(backupDir, f.name)}"`);
        else execSync(`rm -rf "${path.join(backupDir, f.name)}"`);
      } catch {}
    });
    const removed = Math.max(0, scheduled.length - keepCount);
    if (removed > 0) addLog(id, 'info', `Kept ${keepCount} scheduled backups, removed ${removed} old ones`);
  } catch {}
}

// ── SCHEDULER ENGINE ──────────────────────────────────────────────────────────
const schedulerState = {};

function getNextTime(timeStr, dayOfWeek) {
  const now = new Date();
  const [h, m] = (timeStr || '04:00').split(':').map(Number);
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(h, m);
  if (dayOfWeek !== undefined) {
    const daysUntil = (dayOfWeek - now.getDay() + 7) % 7;
    next.setDate(now.getDate() + (daysUntil === 0 && next <= now ? 7 : daysUntil));
  } else {
    if (next <= now) next.setDate(next.getDate() + 1);
  }
  // Never return a time less than 60s from now — prevents instant firing on manager restart
  if (next - now < 60000) next.setDate(next.getDate() + 1);
  return next;
}

function formatTimeUntil(date) {
  if (!date) return null;
  const ms = new Date(date) - Date.now();
  if (ms < 0) return 'overdue';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

function scheduleRestartFor(id, when, reason) {
  const cfg = getServer(id) || loadServers()[0];
  const warnMs = (cfg.restartWarnMinutes || 10) * 60000;
  let msUntil = new Date(when) - Date.now();

  // Safety guard — if the scheduled time is in the past or less than 60s away,
  // it means the time already passed (e.g. manager restarted at 04:01 with a 04:00 schedule).
  // Push it forward to tomorrow / next week instead of firing immediately.
  if (msUntil < 60000) {
    addLog(id, 'info', `⏰ ${reason} time already passed — rescheduling for next occurrence`);
    const newWhen = getNextTime(
      cfg.dailyRestartTime || cfg.weeklyRestartTime || '04:00',
      reason.toLowerCase().includes('weekly') ? (cfg.weeklyRestartDay || 0) : undefined
    );
    // Force it to the NEXT occurrence by adding 1 day if daily
    if (!reason.toLowerCase().includes('weekly')) {
      newWhen.setDate(newWhen.getDate() + (msUntil < 0 ? 0 : 1));
    }
    msUntil = newWhen - Date.now();
  }
  if (!schedulerState[id]) schedulerState[id] = {};
  if (schedulerState[id].warnTimer) clearTimeout(schedulerState[id].warnTimer);
  if (schedulerState[id].restartTimer) clearTimeout(schedulerState[id].restartTimer);
  if (msUntil > warnMs) {
    schedulerState[id].warnTimer = setTimeout(() => {
      addLog(id, 'warn', `⏰ ${reason} in ${cfg.restartWarnMinutes || 10} minutes — server will save and restart`);
    }, msUntil - warnMs);
  }
  schedulerState[id].restartTimer = setTimeout(() => {
    addLog(id, 'info', `⏰ ${reason} — stopping server...`);
    const inst = getInstance(id);
    if (inst.process) {
      stopServer(id);
      let waited = 0;
      const poll = setInterval(() => {
        waited += 1000;
        if (!getInstance(id).process || waited > 45000) {
          clearInterval(poll);
          if (!getInstance(id).process) {
            addLog(id, 'info', `⏰ ${reason} — starting server...`);
            startServer(id, !(getServer(id)?.restartUpdateCheck !== false));
          }
        }
      }, 1000);
    } else {
      addLog(id, 'info', `⏰ ${reason} — server not running, skipping restart`);
    }
    initScheduler(id);
  }, msUntil);
}

function initScheduler(id) {
  const cfg = getServer(id);
  if (!cfg) return;
  if (!schedulerState[id]) schedulerState[id] = {};
  if (schedulerState[id].backupInterval) clearInterval(schedulerState[id].backupInterval);

  if (cfg.scheduledBackupEnabled) {
    const intervalMs = (cfg.scheduledBackupIntervalHours || 3) * 3600000;
    schedulerState[id].nextBackup = new Date(Date.now() + intervalMs);
    schedulerState[id].backupInterval = setInterval(() => {
      addLog(id, 'save', `⏰ Scheduled backup starting...`);
      createScheduledBackup(id);
      schedulerState[id].nextBackup = new Date(Date.now() + intervalMs);
    }, intervalMs);
  } else {
    schedulerState[id].nextBackup = null;
  }

  if (cfg.dailyRestartEnabled) {
    const next = getNextTime(cfg.dailyRestartTime || '04:00');
    schedulerState[id].nextDailyRestart = next;
    scheduleRestartFor(id, next, 'Daily restart');
  } else {
    schedulerState[id].nextDailyRestart = null;
    if (schedulerState[id].restartTimer) clearTimeout(schedulerState[id].restartTimer);
  }

  if (cfg.weeklyRestartEnabled && !cfg.dailyRestartEnabled) {
    const next = getNextTime(cfg.weeklyRestartTime || '04:00', cfg.weeklyRestartDay || 0);
    schedulerState[id].nextWeeklyRestart = next;
    scheduleRestartFor(id, next, 'Weekly restart');
  } else if (!cfg.weeklyRestartEnabled) {
    schedulerState[id].nextWeeklyRestart = null;
  }
}

function getSchedulerStatus(id) {
  const s = schedulerState[id] || {};
  const cfg = getServer(id) || loadServers()[0];
  return {
    ok: true,
    scheduledBackupEnabled: !!cfg.scheduledBackupEnabled,
    scheduledBackupIntervalHours: cfg.scheduledBackupIntervalHours || 3,
    scheduledBackupKeepCount: cfg.scheduledBackupKeepCount || 10,
    autoSaveKeepCount: cfg.autoSaveKeepCount || 20,
    dailyRestartEnabled: !!cfg.dailyRestartEnabled,
    dailyRestartTime: cfg.dailyRestartTime || '04:00',
    weeklyRestartEnabled: !!cfg.weeklyRestartEnabled,
    weeklyRestartDay: cfg.weeklyRestartDay || 0,
    weeklyRestartTime: cfg.weeklyRestartTime || '04:00',
    restartWarnMinutes: cfg.restartWarnMinutes || 10,
    restartUpdateCheck: cfg.restartUpdateCheck !== false,
    nextBackup: s.nextBackup || null,
    nextDailyRestart: s.nextDailyRestart || null,
    nextWeeklyRestart: s.nextWeeklyRestart || null,
    nextBackupIn: formatTimeUntil(s.nextBackup),
    nextDailyRestartIn: formatTimeUntil(s.nextDailyRestart),
    nextWeeklyRestartIn: formatTimeUntil(s.nextWeeklyRestart),
  };
}

function initAllSchedulers() {
  const servers = loadServers();
  servers.forEach(s => {
    const cfg = getServer(s.id);
    if (!cfg) return;
    // Log what's being scheduled so it's visible in server logs on manager start
    const parts = [];
    if (cfg.scheduledBackupEnabled) parts.push(`backup every ${cfg.scheduledBackupIntervalHours || 3}h`);
    if (cfg.dailyRestartEnabled) parts.push(`daily restart at ${cfg.dailyRestartTime || '04:00'}`);
    if (cfg.weeklyRestartEnabled) parts.push(`weekly restart ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][cfg.weeklyRestartDay || 0]} at ${cfg.weeklyRestartTime || '04:00'}`);
    if (parts.length) addLog(s.id, 'info', `Schedules loaded: ${parts.join(', ')}`);
    initScheduler(s.id);
  });
}

// Start schedulers when module loads
initAllSchedulers();

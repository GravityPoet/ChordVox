# ChordVox Complete Cleanup Instructions

## When to Use This

Use this guide when you want a truly clean local reset of ChordVox, for example:

- You want to uninstall the installed app and remove local state
- Development, staging, and production behavior feels inconsistent
- Permissions or login-item behavior seems stuck after reinstalling
- You want to wipe caches, logs, model downloads, and temp files before testing again

Today, ChordVox isolates user data by channel:

- Production: `~/Library/Application Support/chordvox`
- Development: `~/Library/Application Support/ChordVox-development`
- Staging: `~/Library/Application Support/ChordVox-staging`

That separation prevents the old "prod and dev share one folder" problem, but a full cleanup is still useful when you want to reset everything at once.

## Quick Solution: Use the Cleanup Script

### Step 1: Run the automated cleanup script

```bash
cd /path/to/ChordVox-Pro
bash scripts/complete-uninstall.sh
```

This script will:
- Stop all ChordVox processes
- Remove installed app bundles from `/Applications` and `~/Applications`
- Remove login items
- Delete production, development, and staging application data
- Clear caches, logs, saved state, preferences, crash reports, and temp files
- Optionally remove downloaded model caches
- Optionally remove the local project `.env`
- Print the `tccutil` commands needed for a full macOS permission reset

### Step 2: Start fresh

**For Production:**
```bash
# Download fresh DMG from releases
# Install and run normally
```

**For Development:**
```bash
# Make sure you have ARM64 Node.js
node -p "process.arch"  # Should output: arm64

# Clean install
rm -rf node_modules package-lock.json
npm install

# Run dev
npm run dev
```

---

## Manual Cleanup (if script doesn't work)

### 1. Stop all ChordVox processes

```bash
# Installed app and helper processes
pkill -x "ChordVox" || true
pkill -x "ChordVox Helper" || true
pkill -x "ChordVox Helper (Renderer)" || true
pkill -x "ChordVox Helper (GPU)" || true
pkill -x "ChordVox Helper (Plugin)" || true

# Dev Electron process shape used by npm run dev
pkill -f "scripts/run-electron.js --dev" || true
```

### 2. Remove the Application

```bash
rm -rf /Applications/ChordVox.app
rm -rf "$HOME/Applications/ChordVox.app"
osascript -e 'tell application "System Events" to if exists login item "ChordVox" then delete login item "ChordVox"'
```

### 3. Remove Application Data

**Application Support** (production, development, staging):
```bash
rm -rf "$HOME/Library/Application Support/chordvox"
rm -rf "$HOME/Library/Application Support/ChordVox"
rm -rf "$HOME/Library/Application Support/ChordVox-development"
rm -rf "$HOME/Library/Application Support/ChordVox-staging"
```

**Preferences** (system-level settings):
```bash
rm -rf "$HOME/Library/Preferences/com.gravitypoet.chordvox.plist"
rm -rf "$HOME/Library/Preferences/com.gravitypoet.chordvox.helper.plist"
```

**Caches**:
```bash
rm -rf "$HOME/Library/Caches/ChordVox"
rm -rf "$HOME/Library/Caches/chordvox"
```

**Logs**:
```bash
rm -rf "$HOME/Library/Logs/ChordVox"
rm -rf "$HOME/Library/Logs/chordvox"
```

**Saved Application State**:
```bash
rm -rf "$HOME/Library/Saved Application State/com.gravitypoet.chordvox.savedState"
```

### 4. Remove Model Caches (optional)

```bash
rm -rf "$HOME/.cache/chordvox"
rm -rf "$HOME/.cache/whisper"
rm -rf "$HOME/Library/Application Support/whisper"
```

### 5. Remove Temp Files

```bash
rm -rf /tmp/chordvox*
find /tmp -name "whisper_audio_*" -delete
rm -rf "$HOME/Library/Application Support/CrashReporter"/ChordVox_*
```

### 6. Clean Development Environment

If you're setting up for development:

```bash
cd /path/to/ChordVox-Pro

# Remove local environment and dependencies
rm -f .env
rm -rf node_modules
rm -f package-lock.json

# Clear npm cache
npm cache clean --force
```

### 7. Reset macOS System Permissions (Optional)

The cleanup script **cannot** remove macOS system permissions. These persist even after uninstalling.

**This is usually fine** - permissions will automatically apply to a fresh install.

**To completely reset permissions** (rarely needed):

```bash
# Reset microphone permission
tccutil reset Microphone com.gravitypoet.chordvox

# Reset accessibility permission
tccutil reset Accessibility com.gravitypoet.chordvox

# Reset screen capture permission
tccutil reset ScreenCapture com.gravitypoet.chordvox

# For dev mode (Terminal)
tccutil reset Microphone com.apple.Terminal
tccutil reset Accessibility com.apple.Terminal
```

After running these commands, macOS will prompt for permissions again when you run the app.

**When to reset permissions:**
- Microphone not working after reinstall
- "Permission denied" errors even though you granted access
- Troubleshooting strange permission issues

**Note:** You cannot manually remove apps from System Settings → Privacy lists. They only disappear when the app is uninstalled, but the permission record persists in the TCC database.

---

## Complete Fresh Start for Development

After cleanup, follow these steps for a clean dev environment:

### 1. Verify ARM64 Node.js (Apple Silicon Macs)

```bash
# Check architecture
node -p "process.arch"  # Must show: arm64

# If it shows x64, install ARM64 Node:
# Option A: Using nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install --lts
nvm use --lts

# Option B: Download from nodejs.org
# Get macOS ARM64 installer from https://nodejs.org/
```

### 2. Clean Install Dependencies

```bash
cd /path/to/ChordVox-Pro

# Remove everything
rm -rf node_modules package-lock.json

# Fresh install
npm install

# Verify better-sqlite3 architecture
file node_modules/better-sqlite3/build/Release/better_sqlite3.node
# Should show: Mach-O 64-bit bundle arm64
```

### 3. Setup Environment

```bash
# Create fresh .env file
touch .env

# Add your API keys
echo "OPENAI_API_KEY=your_key_here" >> .env
```

### 4. Run Development Mode

```bash
npm run dev
```

---

## Troubleshooting

### Issue: "better-sqlite3 architecture mismatch"

**Solution:**
```bash
# Your Node is running in x64 mode via Rosetta
# Follow "Verify ARM64 Node.js" section above
```

### Issue: "Microphone prints 'you' instead of transcription"

**Solution:**
```bash
# Corrupted database or settings - run cleanup script
bash scripts/complete-uninstall.sh

# Then reinstall/re-run
```

### Issue: "Database initialization failed"

**Solution:**
```bash
# Remove app data specifically
rm -rf "$HOME/Library/Application Support/chordvox"
rm -rf "$HOME/Library/Application Support/ChordVox-development"

# Rebuild dependencies
npm run postinstall
```

### Issue: Production DMG works but dev doesn't

**Cause:** The channels no longer share one user-data folder, but old local state can still survive in caches, permissions, login items, model downloads, or an old installed app bundle.

**Solution:**
1. Run complete cleanup script
2. Remove the installed app bundle if you're focusing on development
3. Reinstall dependencies and start one channel cleanly

---

## Data Locations Reference

All ChordVox data is stored in these locations:

| Type | Location |
|------|----------|
| **Production userData** | `~/Library/Application Support/chordvox/` |
| **Development userData** | `~/Library/Application Support/ChordVox-development/` |
| **Staging userData** | `~/Library/Application Support/ChordVox-staging/` |
| **Databases / settings** | Inside each channel's userData folder |
| **API Keys** | `.env` file in project root (dev) |
| **Channel logs** | `<userData>/logs/` |
| **Legacy log dirs** | `~/Library/Logs/ChordVox/`, `~/Library/Logs/chordvox/` |
| **Model caches** | `~/.cache/chordvox/`, `~/.cache/whisper/`, `~/Library/Application Support/whisper/` |
| **Preferences** | `~/Library/Preferences/com.gravitypoet.chordvox.plist`, `~/Library/Preferences/com.gravitypoet.chordvox.helper.plist` |
| **Caches** | `~/Library/Caches/ChordVox/`, `~/Library/Caches/chordvox/` |
| **Temp Audio / temp dirs** | `/tmp/whisper_audio_*`, `/tmp/chordvox*` |
| **Installed app bundles** | `/Applications/ChordVox.app`, `~/Applications/ChordVox.app` |

---

## Prevention Tips

1. **Use one clean channel at a time when debugging** - Production, development, and staging are isolated, but stale local state can still linger
2. **Remove the installed app when focusing on development** - This avoids confusion about which copy you launched
3. **Check Node architecture** - Always verify `node -p "process.arch"` shows `arm64`
4. **Clean installs** - When switching modes, run cleanup script first
5. **Backup data** - Export important transcriptions before cleanup

---

## Getting Help

If cleanup doesn't solve your issue:

1. Check the architecture: `node -p "process.arch"`
2. Check Node version: `node -v`
3. Check Electron version: `npm list electron`
4. Run with debug mode: `npm run dev -- --debug`
5. Check logs in:
   - `~/Library/Application Support/chordvox/logs/`
   - `~/Library/Application Support/ChordVox-development/logs/`
   - `~/Library/Application Support/ChordVox-staging/logs/`

Report issues with this information at: [GitHub Issues](https://github.com/GravityPoet/ChordVox/issues)

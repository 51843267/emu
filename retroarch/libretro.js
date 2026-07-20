/**
 * RetroArch Web Player
 *
 * This provides the basic JavaScript for the RetroArch web player.
 */

const defaultCore = "fceumm";
var liteMode = !!(window.__playEmbed);
var deferStart = !!(window.__playEmbed && window.__playEmbed.deferStart);
var autoStart = liteMode && !deferStart;
if (liteMode) {
   var _raNoop = function() {};
   console.log = console.info = console.warn = console.debug = console.error = _raNoop;
}

var BrowserFS = BrowserFS;
var afs;
var zipfs;
var xhrfs;
var initializationCount = 0;
var Module;
var currentCore;
var reloadTimeout;
var retroArchRunning = false;
var canvas = document.getElementById("canvas");
var bundleReady = false;
var pendingRomUrl = (window.__playEmbed && window.__playEmbed.romUrl) || null;
var pendingRomName = (window.__playEmbed && window.__playEmbed.romName) || null;
var currentContentPath = null;
var CORE_OPTIONS_PATH = '/home/web_user/retroarch/userdata/retroarch-core-options.cfg';
var embedCoreOptions = { fceumm_region: 'NTSC' };

function reportLoadProgress(percent, message) {
   if (suppressLoadProgress) return;
   var pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
   var msg = message || '';
   if (window.PlayRetroShell && window.PlayRetroShell.setLoadProgress) {
      window.PlayRetroShell.setLoadProgress(pct, msg);
   }
   try {
      window.dispatchEvent(new CustomEvent('playretro-load-progress', {
         detail: { percent: pct, message: msg }
      }));
   } catch (e) {}
}

async function fetchArrayBufferWithProgress(url, onProgress, estimatedBytes) {
   var resp = await fetch(url);
   if (!resp.ok) {
      throw new Error('HTTP ' + resp.status);
   }
   var total = parseInt(resp.headers.get('Content-Length') || '0', 10);
   if (!total) {
      try {
         var head = await fetch(url, { method: 'HEAD' });
         if (head.ok) {
            total = parseInt(head.headers.get('Content-Length') || '0', 10);
         }
      } catch (e) {}
   }
   var estimate = total || (estimatedBytes > 0 ? estimatedBytes : 0);
   if (!resp.body || typeof onProgress !== 'function') {
      var full = await resp.arrayBuffer();
      onProgress(100);
      return full;
   }
   var reader = resp.body.getReader();
   var received = 0;
   var chunks = [];
   while (true) {
      var part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
      received += part.value.length;
      if (estimate > 0) {
         onProgress(Math.min(99, Math.round((received / estimate) * 100)));
      }
   }
   var merged = new Uint8Array(received);
   var offset = 0;
   for (var i = 0; i < chunks.length; i++) {
      merged.set(chunks[i], offset);
      offset += chunks[i].length;
   }
   onProgress(100);
   return merged.buffer;
}

function startSmoothProgress(from, to, durationMs, message) {
   var start = Date.now();
   var timer = setInterval(function () {
      var t = Math.min(1, (Date.now() - start) / durationMs);
      var pct = from + Math.round((to - from) * t);
      reportLoadProgress(pct, message + ' ' + pct + '%');
   }, 150);
   return function stop(finalPct, finalMessage) {
      clearInterval(timer);
      if (finalPct != null) {
         reportLoadProgress(finalPct, finalMessage || message);
      }
   };
}
var pendingRelaunch = null;
var relaunchInProgress = false;
/** 作弊静默重载时禁止刷「下载/编译核心」进度条 */
var suppressLoadProgress = false;
var arcadeCheatRelaunchQueued = null;

(function loadSavedCoreOptions() {
   try {
      var saved = JSON.parse(localStorage.getItem('retro_shell_region_v1') || '{}') || {};
      if (saved.nes) embedCoreOptions.fceumm_region = saved.nes;
   } catch (e) {}
})();

var MINIMAL_RETROARCH_CFG_BASE = [
   'libretro_directory = "/home/web_user/retroarch/cores"',
   'content_directory = "/home/web_user/retroarch/userdata/content"',
   'savefile_directory = "/home/web_user/retroarch/userdata/saves"',
   'savestate_directory = "/home/web_user/retroarch/userdata/states"',
   'savestate_auto_save = "false"',
   'savestate_auto_load = "false"',
   'savestate_file_compression = "false"',
   'savestate_slot = "0"',
   'sort_savestates_enable = "false"',
   'sort_savefiles_enable = "false"',
   'system_directory = "/home/web_user/retroarch/system"',
   'video_driver = "gl"',
   'audio_driver = "rwebaudio"',
   'input_driver = "rwebinput"',
   'video_shader_dir = "/home/web_user/retroarch/shaders"',
   'video_shader_enable = "false"',
   'menu_on_startup = "false"',
   'rgui_show_start_screen = "false"',
   'video_font_enable = "false"',
   'notification_show_autoconfig = "false"',
   'notification_show_remap_load = "false"',
   'notification_show_config_override_load = "false"',
   'notification_show_set_initial_disk = "false"',
   'notification_show_disk_control = "false"',
   'notification_show_cheats_applied = "false"',
   'notification_show_refresh_rate = "false"',
   'aspect_ratio_index = "22"',
   'video_crop_overscan = "true"',
   'video_scale_integer = "false"',
   'video_force_aspect = "true"',
   'video_allow_rotate = "true"',
   'rewind_enable = "true"',
   'rewind_buffer_size = "20"',
   /* 快存/快取：键盘 1/2（shell 也会拦截） */
   'input_save_state = "1"',
   'input_load_state = "2"',
   /* 其余热键全部关掉，避免游戏中误触；快进/快退/重置等走面板命令 */
   'input_toggle_fast_forward = "nul"',
   'input_hold_fast_forward = "nul"',
   'input_rewind = "nul"',
   'input_slowmotion = "nul"',
   'input_pause_toggle = "nul"',
   'input_frame_advance = "nul"',
   'input_reset = "nul"',
   'input_exit_emulator = "nul"',
   'input_menu_toggle = "nul"',
   'input_toggle_fullscreen = "nul"',
   'input_screenshot = "nul"',
   'input_audio_mute = "nul"',
   'input_volume_up = "nul"',
   'input_volume_down = "nul"',
   'input_shader_next = "nul"',
   'input_shader_prev = "nul"',
   'input_shader_toggle = "nul"',
   'input_cheat_index_plus = "nul"',
   'input_cheat_index_minus = "nul"',
   'input_cheat_toggle = "nul"',
   'input_state_slot_increase = "nul"',
   'input_state_slot_decrease = "nul"',
   'input_grab_mouse_toggle = "nul"',
   'input_movie_record_toggle = "nul"',
   'input_netplay_flip_players = "nul"',
   'input_disk_eject_toggle = "nul"',
   'input_disk_next = "nul"',
   'input_disk_prev = "nul"',
   'input_overlay_next = "nul"',
   'input_toggle_statistics = "nul"',
   'input_fps_toggle = "nul"',
   'input_desktop_menu_toggle = "nul"',
   'input_game_focus_toggle = "nul"',
   'input_menu_toggle_gamepad_combo = "0"',
   'input_quit_gamepad_combo = "0"'
];

var DEFAULT_INPUT_LINES = [
   'input_player1_a = "x"',
   'input_player1_b = "z"',
   'input_player1_up = "up"',
   'input_player1_down = "down"',
   'input_player1_left = "left"',
   'input_player1_right = "right"',
   'input_player1_start = "enter"',
   'input_player1_select = "shift"'
];

function buildEmbedCoreOptionsCfg() {
   var lines = [];
   Object.keys(embedCoreOptions).forEach(function(key) {
      lines.push(key + ' = "' + embedCoreOptions[key] + '"');
   });
   return lines.length ? lines.join('\n') + '\n' : '';
}

function writeEmbedCoreOptions() {
   if (!liteMode) return false;
   if (!Module || !Module.FS) return false;
   try {
      Module.FS.writeFile(CORE_OPTIONS_PATH, buildEmbedCoreOptionsCfg());
      return true;
   } catch (e) {
      return false;
   }
}

var setCoreVariableFn;

function getSetCoreVariableFn() {
   if (setCoreVariableFn !== undefined) return setCoreVariableFn;
   setCoreVariableFn = null;
   if (Module && Module.cwrap) {
      var names = ['ejs_set_variable', 'set_variable'];
      for (var i = 0; i < names.length; i++) {
         try {
            var fn = Module.cwrap(names[i], 'null', ['string', 'string']);
            if (typeof fn === 'function') {
               setCoreVariableFn = fn;
               break;
            }
         } catch (e) {}
      }
   }
   return setCoreVariableFn;
}

function trackContentPath(path) {
   if (path && path !== '--menu') currentContentPath = path;
}

function trackContentFromArgs(args) {
   if (!args) return;
   for (var i = 0; i < args.length - 1; i++) {
      if (args[i] === '-v' && args[i + 1] && args[i + 1] !== '--menu') {
         trackContentPath(args[i + 1]);
         return;
      }
   }
}

function reloadGameWithOptions() {
   if (!Module || !retroArchRunning) return false;
   writeEmbedCoreOptions();
   if (currentContentPath) {
      requestRelaunch(ModuleBase.corePath, currentContentPath);
      return true;
   }
   if (Module.retroArchSend && currentCore) {
      return Module.retroArchSend(
         'LOAD_CORE /home/web_user/retroarch/cores/' + currentCore + '_libretro.core'
      );
   }
   return false;
}

function applyCoreOptionLive(key, value) {
   embedCoreOptions[key] = value;
   if (!Module || !retroArchRunning) return true;
   writeEmbedCoreOptions();
   var setVar = getSetCoreVariableFn();
   if (setVar) {
      try {
         setVar(key, value);
         return true;
      } catch (e) {}
   }
   return reloadGameWithOptions();
}

function buildEmbedRetroArchCfg() {
   var inputLines = DEFAULT_INPUT_LINES;
   if (window.PlayRetroShell && window.PlayRetroShell.getRetroArchInputLines) {
      var shellProfile = window.__playEmbed && window.__playEmbed.shellProfile;
      var shellLines = window.PlayRetroShell.getRetroArchInputLines(shellProfile);
      if (shellLines && shellLines.length) inputLines = shellLines;
   }
   return MINIMAL_RETROARCH_CFG_BASE.concat(inputLines).join('\n') + '\n';
}

function applyEmbedLayout() {
   if (!liteMode || !canvas) return;
   var nav = document.querySelector('nav.navbar');
   if (nav) nav.style.display = 'none';
   document.documentElement.style.margin = '0';
   document.documentElement.style.padding = '0';
   document.documentElement.style.overflow = 'hidden';
   document.body.style.margin = '0';
   document.body.style.padding = '0';
   document.body.style.overflow = 'hidden';
   document.body.style.background = '#000';
   if (window.PlayRetroShell && window.PlayRetroShell.applyLayout) {
      window.PlayRetroShell.applyLayout();
      return;
   }
   var w = document.documentElement.clientWidth || window.innerWidth || 320;
   if (w < 1) w = 320;
   var h = Math.round(w * 240 / 256);
   canvas.style.width = w + 'px';
   canvas.style.height = h + 'px';
   canvas.style.maxWidth = '100vw';
   canvas.style.display = 'block';
   canvas.style.margin = '0';
   canvas.style.border = 'none';
   var container = document.querySelector('.webplayer-container');
   if (container) {
      container.style.minHeight = '0';
      container.style.padding = '0';
      container.style.height = h + 'px';
      container.style.lineHeight = '0';
   }
   var wrap = document.getElementById('canvas_div');
   if (wrap) wrap.style.lineHeight = '0';
   postEmbedResize(h);
}

function postEmbedResize(canvasHeight) {
   try {
      if (window.parent && window.parent !== window) {
         var totalH = canvasHeight;
         var platform = 'pc';
         if (window.PlayRetroShell && window.PlayRetroShell.getEmbedReportHeight) {
            var reported = window.PlayRetroShell.getEmbedReportHeight();
            if (reported > 0) {
               totalH = reported;
               if (document.body.classList.contains('rs-pc-embed')) platform = 'pc';
               else if (document.body.classList.contains('rs-mobile')) platform = 'mobile';
            }
         } else if (window.PlayRetroShell && window.PlayRetroShell.getStandardEmbedTotalHeight) {
            if (document.body.classList.contains('rs-mobile')
                && !document.documentElement.classList.contains('rs-immersive-landscape')) {
               totalH = window.PlayRetroShell.getStandardEmbedTotalHeight();
               platform = 'mobile';
            } else if (document.body.classList.contains('rs-pc-embed')
                && window.PlayRetroShell.getPcEmbedStackHeight) {
               totalH = window.PlayRetroShell.getPcEmbedStackHeight();
               platform = 'pc';
            } else if (window.PlayRetroShell.getShellExtraHeight) {
               totalH += window.PlayRetroShell.getShellExtraHeight();
            }
         } else if (document.body.classList.contains('has-touch-controls')) {
            totalH += 140;
            platform = 'mobile';
         }
         window.parent.postMessage({ type: 'retroarch-embed-resize', height: totalH, platform: platform }, '*');
      }
   } catch (e) {}
}

var STATE_DIR = '/home/web_user/retroarch/userdata/states';
var MIN_STATE_BYTES = 8192;

function ensureStateDir() {
   if (!Module || !Module.FS) return false;
   try { Module.FS.mkdirTree(STATE_DIR); } catch (e) {}
   return true;
}

function stateBasename() {
   if (!currentContentPath) return 'game';
   return currentContentPath.split('/').pop().split('?')[0] || 'game';
}

function listStateFiles() {
   if (!ensureStateDir()) return [];
   var entries = [];
   try {
      Module.FS.readdir(STATE_DIR).forEach(function(name) {
         if (name === '.' || name === '..') return;
         var path = STATE_DIR + '/' + name;
         try {
            var st = Module.FS.stat(path);
            if (Module.FS.isFile(st.mode)) {
               entries.push({ name: name, path: path, mtime: st.mtime || 0 });
            }
         } catch (e) {}
      });
   } catch (e) {}
   entries.sort(function(a, b) { return b.mtime - a.mtime; });
   return entries;
}

function statePathCandidates() {
   var base = stateBasename();
   var stripped = base.replace(/\.(zip|7z|nes|fds)$/i, '');
   var names = [base, stripped];
   var paths = [];
   var dirs = [STATE_DIR];
   if (currentCore) dirs.push(STATE_DIR + '/' + currentCore);
   dirs.forEach(function (dir) {
      names.forEach(function (name) {
         if (!name) return;
         paths.push(dir + '/' + name + '.state');
         paths.push(dir + '/' + name + '.state0');
         paths.push(dir + '/' + name + '.auto');
      });
   });
   if (currentContentPath) {
      paths.push(currentContentPath + '.state');
      paths.push(currentContentPath + '.state0');
   }
   return paths;
}

function walkStateFiles(dir, out, depth) {
   if (!Module || !Module.FS || depth > 5) return;
   try {
      Module.FS.readdir(dir).forEach(function(name) {
         if (name === '.' || name === '..') return;
         var path = dir + '/' + name;
         try {
            var st = Module.FS.stat(path);
            if (Module.FS.isDir(st.mode)) {
               walkStateFiles(path, out, depth + 1);
               return;
            }
            if (/\.state(\d+|\.auto)?$/i.test(name) || name.indexOf('.state') >= 0) {
               out.push({ path: path, mtime: st.mtime || 0, size: st.size || 0 });
            }
         } catch (e) {}
      });
   } catch (e) {}
}

function findStateFilesAfterSave() {
   var out = [];
   walkStateFiles('/home/web_user/retroarch', out, 0);
   out.sort(function(a, b) {
      if (b.mtime !== a.mtime) return b.mtime - a.mtime;
      return b.size - a.size;
   });
   return out;
}

function readStateFileAt(path) {
   if (!path || !Module || !Module.FS) return null;
   try {
      var data = Module.FS.readFile(path);
      if (data && data.length) return data;
   } catch (e) {}
   return null;
}

function pickReadableStatePath() {
   var i;
   var candidates = statePathCandidates();
   for (i = 0; i < candidates.length; i++) {
      var data = readStateFileAt(candidates[i]);
      if (data) return { path: candidates[i], data: data };
   }
   var files = findStateFilesAfterSave();
   for (i = 0; i < files.length; i++) {
      var blob = readStateFileAt(files[i].path);
      if (blob) return { path: files[i].path, data: blob };
   }
   return null;
}

function pickNewestStateFile() {
   var files = findStateFilesAfterSave();
   var i;
   for (i = 0; i < files.length; i++) {
      var data = readStateFileAt(files[i].path);
      if (data && data.length) return { path: files[i].path, data: data, mtime: files[i].mtime };
   }
   return pickReadableStatePath();
}

function snapshotStateMtimes() {
   var map = {};
   findStateFilesAfterSave().forEach(function (f) {
      map[f.path] = { mtime: f.mtime || 0, size: f.size || 0 };
   });
   return map;
}

function findValidStateExport(beforeSnap, requireChange) {
   var files = findStateFilesAfterSave();
   var best = null;
   var bestLen = 0;
   var i;
   for (i = 0; i < files.length; i++) {
      var f = files[i];
      if ((f.size || 0) < MIN_STATE_BYTES) continue;
      var data = readStateFileAt(f.path);
      if (!data || data.length < MIN_STATE_BYTES) continue;
      var prev = beforeSnap[f.path];
      var changed = !prev || prev.size !== data.length;
      if (requireChange && !changed) continue;
      if (data.length > bestLen) {
         bestLen = data.length;
         best = data;
      }
   }
   return best;
}

function findExportedStateData(beforeSnap, requireChange) {
   return findValidStateExport(beforeSnap, requireChange !== false);
}

function writeStateToAllCandidates(data) {
   var candidates = statePathCandidates();
   var written = false;
   var i;
   for (i = 0; i < candidates.length; i++) {
      try {
         Module.FS.writeFile(candidates[i], data);
         written = true;
      } catch (e) {}
   }
   if (!written) {
      var fallback = STATE_DIR + '/' + stateBasename().replace(/\.(zip|7z|nes|fds)$/i, '') + '.state';
      try {
         Module.FS.writeFile(fallback, data);
         written = true;
      } catch (e) {}
   }
   return written;
}

function backupQuickStateFiles() {
   var seen = {};
   var backups = [];
   function add(path) {
      if (!path || seen[path]) return;
      var data = readStateFileAt(path);
      if (!data) return;
      seen[path] = true;
      backups.push({ path: path, data: new Uint8Array(data) });
   }
   statePathCandidates().forEach(add);
   listStateFiles().forEach(function (entry) { add(entry.path); });
   return backups;
}

function restoreQuickStateFiles(backups) {
   if (!backups || !Module || !Module.FS) return;
   backups.forEach(function (item) {
      try { Module.FS.writeFile(item.path, item.data); } catch (e) {}
   });
}

function exportStateAsync() {
   return new Promise(function(resolve) {
      if (!Module || !retroArchRunning) {
         resolve(null);
         return;
      }
      var backups = backupQuickStateFiles();
      var beforeSnap = snapshotStateMtimes();
      if (!triggerSaveState()) {
         resolve(null);
         return;
      }
      var tries = 0;
      function attempt() {
         tries++;
         var requireChange = tries < 25;
         var data = findExportedStateData(beforeSnap, requireChange);
         if (data) {
            restoreQuickStateFiles(backups);
            resolve(new Uint8Array(data));
            return;
         }
         if (tries < 40) {
            setTimeout(attempt, 120);
            return;
         }
         restoreQuickStateFiles(backups);
         resolve(null);
      }
      setTimeout(attempt, 150);
   });
}

function importStateFromBufferAsync(data) {
   return new Promise(function (resolve) {
      if (!Module || !retroArchRunning || !data || !data.length) {
         resolve(false);
         return;
      }
      if (data.length < MIN_STATE_BYTES) {
         resolve(false);
         return;
      }
      if (!ensureStateDir()) {
         resolve(false);
         return;
      }
      var backups = backupQuickStateFiles();
      if (!writeStateToAllCandidates(data)) {
         resolve(false);
         return;
      }
      if (canvas && canvas.focus) canvas.focus();
      setTimeout(function () {
         try {
            if (Module._cmd_unpause) Module._cmd_unpause();
            if (Module._cmd_load_state) Module._cmd_load_state();
            else if (Module.retroArchSend) Module.retroArchSend('LOAD_STATE');
         } catch (e) {}
         setTimeout(function () {
            restoreQuickStateFiles(backups);
            resolve(true);
         }, 800);
      }, 120);
   });
}

function importStateFromBuffer(data) {
   if (!Module || !retroArchRunning || !data) return false;
   importStateFromBufferAsync(data);
   return true;
}

function triggerSaveState() {
   if (!Module || !retroArchRunning) return false;
   try {
      if (canvas && canvas.focus) canvas.focus();
      if (Module._cmd_save_state) {
         Module._cmd_save_state();
         return true;
      }
      if (Module.retroArchSend) {
         Module.retroArchSend('SAVE_STATE');
         return true;
      }
   } catch (e) {}
   return false;
}

function triggerLoadState() {
   if (!Module || !retroArchRunning) return false;
   try {
      if (canvas && canvas.focus) canvas.focus();
      if (Module._cmd_unpause) Module._cmd_unpause();
      if (Module._cmd_load_state) {
         Module._cmd_load_state();
         return true;
      }
      if (Module.retroArchSend) {
         Module.retroArchSend('LOAD_STATE');
         return true;
      }
   } catch (e) {}
   return false;
}

function triggerReset() {
   if (!Module || !retroArchRunning) return false;
   try {
      if (canvas && canvas.focus) canvas.focus();
      if (Module._cmd_unpause) Module._cmd_unpause();
      if (Module._cmd_reset) Module._cmd_reset();
      if (Module.retroArchSend) Module.retroArchSend('RESET');
      return true;
   } catch (e) {
      return false;
   }
}

function guessStateWritePath() {
   var base = stateBasename();
   return STATE_DIR + '/' + base + '.state';
}

function modulePreRun(module) {
   var mod = module || Module || window.Module;
   if (!mod) return;
   if (!mod.ENV) mod.ENV = {};
   if (mod.corePath) mod.ENV["LIBRARY_PATH"] = mod.corePath;
}

var ModuleBase = {
   noInitialRun: true,
   retroArchSend: function(msg) {
      this.EmscriptenSendCommand(msg);
   },
   retroArchRecv: function() {
      return this.EmscriptenReceiveCommandReply();
   },
   retroArchExit: function(core, content) {
      if (pendingRelaunch) {
         var p = pendingRelaunch;
         pendingRelaunch = null;
         if (p.fallback) clearTimeout(p.fallback);
         relaunch(p.core, p.content).then(function (ok) {
            if (p.resolve) p.resolve(ok !== false);
         });
         return;
      }
      if (!liteMode) relaunch(core, content);
   },
   print: function(text) {
      console.log("stdout:", text);
   },
   printErr: function(text) {
      console.log("stderr:", text);
   },
   canvas: canvas
};

function cleanupStorage() {
   localStorage.clear();
   if (BrowserFS.FileSystem.IndexedDB.isAvailable()) {
      var req = indexedDB.deleteDatabase("RetroArch");
      req.onsuccess = function() {
         console.log("Deleted database successfully");
      };
      req.onerror = function() {
         console.error("Couldn't delete database");
      };
      req.onblocked = function() {
         console.error("Couldn't delete database due to the operation being blocked");
      };
   }

   document.getElementById("btnClean").disabled = true;
}

function idbfsInit() {
   if (liteMode) {
      afs = new BrowserFS.FileSystem.InMemory();
      console.log("WEBPLAYER: lite userdata ready");
      appInitialized();
      return;
   }
   var imfs = new BrowserFS.FileSystem.InMemory();
   if (BrowserFS.FileSystem.IndexedDB.isAvailable()) {
      BrowserFS.FileSystem.IndexedDB.Create({storeName: "RetroArch"}, function(e, idbfs) {
         if (e) {
            // fallback to imfs
            afs = new BrowserFS.FileSystem.InMemory();
            console.error("WEBPLAYER: error (idbfs): " + e + " falling back to in-memory filesystem");
            appInitialized();
         } else {
            // initialize afs by copying files from async storage to sync storage.
            BrowserFS.FileSystem.AsyncMirror.Create({sync: imfs, async: idbfs}, function(e, fs) {
               if (e) {
                  afs = new BrowserFS.FileSystem.InMemory();
                  console.error("WEBPLAYER: error (afs): " + e + " falling back to in-memory filesystem");
                  appInitialized();
               } else {
                  afs = fs;
                  console.log("WEBPLAYER: idbfs setup successful");
                  appInitialized();
               }
            });
         }
      });
   } else {
      afs = new BrowserFS.FileSystem.InMemory();
      console.error("WEBPLAYER: idbfs not available; falling back to in-memory filesystem");
      appInitialized();
   }
}

function zipfsInit() {
   zipfs = new BrowserFS.FileSystem.InMemory();
   if (liteMode) {
      console.log("WEBPLAYER: lite mode, skip bundle.zip");
      appInitialized();
      return;
   }
   console.log("WEBPLAYER: zipfs ready (bundle loading in background)");
   appInitialized();

   let buffer = new ArrayBuffer(256 * 1024 * 1024);
   let bufferView = new Uint8Array(buffer);
   let idx = 0;
   Promise.all([
      fetch("assets/frontend/bundle.zip.aa"),
      fetch("assets/frontend/bundle.zip.ab"),
      fetch("assets/frontend/bundle.zip.ac"),
      fetch("assets/frontend/bundle.zip.ad"),
      fetch("assets/frontend/bundle.zip.ae")
   ]).then(function(resps) {
      for (let i = 0; i < resps.length; i++) {
         if (!resps[i].ok) throw new Error("bundle part " + i + " HTTP " + resps[i].status);
      }
      return Promise.all(resps.map((r) => r.arrayBuffer()));
   }).then(function(buffers) {
      for (let buf of buffers) {
         bufferView.set(new Uint8Array(buf), idx, buf.byteLength);
         idx += buf.byteLength;
      }
      BrowserFS.FileSystem.ZipFS.Create({zipData: BrowserFS.BFSRequire('buffer').Buffer(new Uint8Array(buffer, 0, idx))}, function(e, fs) {
         if (e) {
            console.warn("WEBPLAYER: zipfs unpack failed: " + e);
            bundleReady = true;
         } else {
            zipfs = fs;
            bundleReady = true;
            console.log("WEBPLAYER: zipfs bundle loaded");
            if (initializationCount >= 3) remountZipfs();
         }
      });
   }).catch(function(err) {
      console.warn("WEBPLAYER: bundle download failed: " + err);
      bundleReady = true;
   });
}

function remountZipfs() {
   try {
      var mfs = new BrowserFS.FileSystem.MountableFileSystem();
      mfs.mount('/home/web_user/retroarch', zipfs);
      mfs.mount('/home/web_user/retroarch/cores', new BrowserFS.FileSystem.InMemory());
      mfs.mount('/home/web_user/retroarch/userdata', afs);
      mfs.mount('/home/web_user/retroarch/userdata/content/downloads', xhrfs);
      BrowserFS.initialize(mfs);
      if (Module && Module.FS) mountBrowserFS();
   } catch (e) {
      console.warn("WEBPLAYER: remount failed: " + e);
   }
}

function xhrfsInit() {
   if (liteMode) {
      xhrfs = new BrowserFS.FileSystem.InMemory();
      console.log("WEBPLAYER: lite mode, skip core index");
      appInitialized();
      return;
   }
   // create an XmlHttpRequest filesystem for core assets
   BrowserFS.FileSystem.XmlHttpRequest.Create({baseUrl: "assets/cores/", index: "assets/cores/.index-xhr"}, function(e, fs) {
      if (e) {
         xhrfs = new BrowserFS.FileSystem.InMemory();
         console.error("WEBPLAYER: error (xhrfs): " + e + " falling back to in-memory filesystem");
         appInitialized();
      } else {
         xhrfs = fs;
         console.log("WEBPLAYER: xhrfs setup successful");
         appInitialized();
      }
   });
}

function appInitialized() {
   initializationCount++;
   if (initializationCount == 3) {
      finishFileSystemSetup();
      preLoadingComplete();
   }
}

function preLoadingComplete() {
   $('#icnRun').removeClass('fa-spinner').removeClass('fa-spin');
   $('#icnRun').addClass('fa-play');
   $('#btnRun').contents().filter(function() { return this.nodeType === 3; }).last().replaceWith(' Run');

   if (liteMode && deferStart) {
      if (window.PlayRetroShell && window.PlayRetroShell.showStartOverlay) {
         window.PlayRetroShell.showStartOverlay(function () {
            deferStart = false;
            if (window.__playEmbed) window.__playEmbed.deferStart = false;
            reportLoadProgress(6, '准备加载…');
            startRetroArch();
         });
      }
      return;
   }

   if (liteMode && autoStart) {
      reportLoadProgress(5, '准备中…');
   }

   if (autoStart) {
      startRetroArch();
   } else {
      // Make the Preview image clickable to start RetroArch.
      $('.webplayer-preview').addClass('loaded').click(function() {
         startRetroArch();
      });
      $('#btnRun').removeClass('disabled').removeAttr("disabled").click(function() {
         startRetroArch();
      });
   }
}

function mountBrowserFS() {
   var BFS = new BrowserFS.EmscriptenFS(Module.FS, Module.PATH, Module.ERRNO_CODES);
   Module.FS.mount(BFS, {
      root: '/home'
   }, '/home');

   // create fake core files for RetroArch
   Module.FS.writeFile("/home/web_user/retroarch/cores/" + currentCore + "_libretro.core", new Uint8Array());
   for (let core of Object.keys(libretroCores)) {
      Module.FS.writeFile("/home/web_user/retroarch/cores/" + core + "_libretro.core", new Uint8Array());
   }
   if (liteMode) {
      try { Module.FS.mkdir("/home/web_user/retroarch/userdata/content"); } catch (e) {}
      try { Module.FS.mkdir("/home/web_user/retroarch/userdata/saves"); } catch (e) {}
      try { Module.FS.mkdir("/home/web_user/retroarch/userdata/states"); } catch (e) {}
      Module.FS.writeFile("/home/web_user/retroarch/userdata/retroarch.cfg", buildEmbedRetroArchCfg());
      Module.FS.writeFile(CORE_OPTIONS_PATH, buildEmbedCoreOptionsCfg());
   }
}

function writeEmbedRetroArchCfg() {
   if (!liteMode || !Module || !Module.FS) return false;
   try {
      Module.FS.writeFile("/home/web_user/retroarch/userdata/retroarch.cfg", buildEmbedRetroArchCfg());
      return true;
   } catch (e) {
      return false;
   }
}

function applyEmbedKeymap() {
   if (!liteMode || !Module || !retroArchRunning) return false;
   try {
      if (!writeEmbedRetroArchCfg()) return false;
      if (Module._cmd_reload_config) Module._cmd_reload_config();
      return true;
   } catch (e) {
      return false;
   }
}

async function applyKeymapAndRelaunch() {
   if (!liteMode || !window.__playEmbed) return;
   var url = pendingRomUrl || window.__playEmbed.romUrl;
   var name = pendingRomName || window.__playEmbed.romName;
   if (!url || !name) return;
   writeEmbedRetroArchCfg();
   if (retroArchRunning && Module) {
      var contentPath = '/home/web_user/retroarch/userdata/content/' + name;
      trackContentPath(contentPath);
      await requestRelaunch(ModuleBase.corePath, contentPath);
   }
}

function finishFileSystemSetup() {
   // create a mountable filesystem that will server as a root mountpoint for browserfs
   var mfs = new BrowserFS.FileSystem.MountableFileSystem();

   mfs.mount('/home/web_user/retroarch', zipfs);
   mfs.mount('/home/web_user/retroarch/cores', new BrowserFS.FileSystem.InMemory());
   mfs.mount('/home/web_user/retroarch/userdata', afs);
   mfs.mount('/home/web_user/retroarch/userdata/content/downloads', xhrfs);
   BrowserFS.initialize(mfs);

   console.log("WEBPLAYER: filesystem initialization successful");
}

function startRetroArch() {
   if (pendingRomUrl) {
      startRetroArchWithRom(pendingRomUrl, pendingRomName);
      return;
   }
   if (Module) {
      launchRetroArch();
      return;
   }
   var btnRun = document.getElementById("btnRun");
   if (btnRun) btnRun.disabled = true;
   $('#icnRun').addClass('fa-spinner fa-spin');
   console.log("WEBPLAYER: loading core " + currentCore + "...");
   loadCore(currentCore).then(function() {
      console.log("WEBPLAYER: wasm runtime initialized");
      mountBrowserFS();
      launchRetroArch();
   }).catch(function(err) {
      console.error("WEBPLAYER: core load failed", err);
      alert("核心加载失败，请刷新重试");
      var btnRun = document.getElementById("btnRun");
      if (btnRun) btnRun.disabled = false;
      $('#icnRun').removeClass('fa-spinner fa-spin');
   });
}

var arcadeBiosRomsetCache = {};

function crc32Bytes(u8) {
   var crc = 0xFFFFFFFF;
   for (var i = 0; i < u8.length; i++) {
      crc ^= u8[i];
      for (var j = 0; j < 8; j++) {
         crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
      }
   }
   return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u16le(n) {
   return new Uint8Array([n & 255, (n >>> 8) & 255]);
}

function u32le(n) {
   return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
}

function concatBytes(parts) {
   var total = 0;
   for (var i = 0; i < parts.length; i++) total += parts[i].length;
   var out = new Uint8Array(total);
   var off = 0;
   for (var j = 0; j < parts.length; j++) {
      out.set(parts[j], off);
      off += parts[j].length;
   }
   return out;
}

function buildStoreZip(files) {
   // Uncompressed ZIP (store). Reliable for FBNeo web which disables 7z.
   var locals = [];
   var centrals = [];
   var offset = 0;
   var names = Object.keys(files);
   for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var data = toFsBytes(files[name]);
      var nameBytes = new Uint8Array(name.length);
      for (var ni = 0; ni < name.length; ni++) nameBytes[ni] = name.charCodeAt(ni) & 0xff;
      var crc = crc32Bytes(data);
      var local = concatBytes([
         new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
         u16le(20), u16le(0), u16le(0), u16le(0), u16le(0),
         u32le(crc), u32le(data.length), u32le(data.length),
         u16le(nameBytes.length), u16le(0), nameBytes, data
      ]);
      var central = concatBytes([
         new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
         u16le(20), u16le(20), u16le(0), u16le(0), u16le(0), u16le(0),
         u32le(crc), u32le(data.length), u32le(data.length),
         u16le(nameBytes.length), u16le(0), u16le(0), u16le(0), u16le(0),
         u32le(0), u32le(offset), nameBytes
      ]);
      locals.push(local);
      centrals.push(central);
      offset += local.length;
   }
   var centralBuf = concatBytes(centrals);
   var end = concatBytes([
      new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
      u16le(0), u16le(0), u16le(names.length), u16le(names.length),
      u32le(centralBuf.length), u32le(offset), u16le(0)
   ]);
   return concatBytes(locals.concat([centralBuf, end]));
}

async function readZipFileMap(buffer) {
   var zipFs = await openZipFsFromBuffer(buffer);
   var out = {};
   function walk(zipPath) {
      var listing = zipFs.readdirSync(zipPath);
      for (var i = 0; i < listing.length; i++) {
         var name = listing[i];
         if (!name || name === '.' || name === '..') continue;
         var full = zipPath === '/' ? '/' + name : zipPath + '/' + name;
         var stat = zipFs.statSync(full);
         if (stat.isDirectory()) {
            walk(full);
            continue;
         }
         out[name.split('/').pop()] = toFsBytes(zipFs.readFileSync(full));
      }
   }
   walk('/');
   return out;
}

async function mergeArcadeBiosIntoRom(romBuf) {
   // Proven path: put BIOS file entries into the game zip itself.
   // Companion neogeo.zip beside the ROM is unreliable on RetroArch web VFS.
   var essentialNeo = {
      'sp-s3.sp1': 1,
      'sm1.sm1': 1,
      'sfix.sfix': 1,
      '000-lo.lo': 1,
      'asia-s3.rom': 1,
      'sp-s2.sp1': 1,
      'uni-bios_3_0.rom': 1
   };
   var packs = [
      { name: 'neogeo.zip', filter: essentialNeo },
      { name: 'pgm.zip', filter: null },
      { name: 'isgsm.zip', filter: null }
   ];
   var merged = {};
   var gameFiles = await readZipFileMap(romBuf);
   Object.keys(gameFiles).forEach(function (k) { merged[k] = gameFiles[k]; });
   var added = 0;
   for (var i = 0; i < packs.length; i++) {
      var pack = packs[i];
      var packBuf = arcadeBiosRomsetCache[pack.name];
      if (!packBuf) continue;
      var biosFiles = await readZipFileMap(packBuf);
      Object.keys(biosFiles).forEach(function (name) {
         if (pack.filter && !pack.filter[name]) return;
         if (!merged[name]) {
            merged[name] = biosFiles[name];
            added++;
         }
      });
   }
   if (!added) return toFsBytes(romBuf);
   console.log('WEBPLAYER: merged arcade BIOS files into ROM zip', added);
   return buildStoreZip(merged);
}

function isArcadeEmbedBios() {
   var embed = window.__playEmbed;
   if (!embed) return false;
   if (embed.shellProfile === 'arcade') return true;
   var core = String(embed.core || currentCore || '').toLowerCase();
   return /^(fbneo|fbalpha2012)/.test(core) || core.indexOf('arcade') !== -1;
}

function toFsBytes(data) {
   if (!data) return new Uint8Array(0);
   if (data instanceof Uint8Array) return data;
   if (data instanceof ArrayBuffer) return new Uint8Array(data);
   if (typeof data.byteLength === 'number' && data.buffer) {
      return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
   }
   return new Uint8Array(data);
}

function ensureFsDir(path) {
   try { Module.FS.mkdirTree(path); } catch (e) {}
}

function writeArcadeBiosRomset(fileName, data) {
   var bytes = toFsBytes(data);
   if (!bytes.length) return false;
   arcadeBiosRomsetCache[fileName] = bytes;
   var dirs = [
      '/home/web_user/retroarch/userdata/content',
      '/home/web_user/retroarch/system',
      '/home/web_user/retroarch/system/fbneo'
   ];
   for (var i = 0; i < dirs.length; i++) {
      ensureFsDir(dirs[i]);
      Module.FS.writeFile(dirs[i] + '/' + fileName, bytes);
   }
   console.log('WEBPLAYER: arcade BIOS romset ready', fileName, bytes.length);
   return true;
}

async function fetchBiosArrayBuffer(url) {
   if (!/^https?:/i.test(url)) url = location.origin + (url.charAt(0) === '/' ? url : '/' + url);
   var resp = await fetch(url);
   if (!resp.ok) return null;
   return await resp.arrayBuffer();
}

async function loadArcadeBiosRomsets() {
   // FBNeo searches: game folder → SYSTEM/fbneo/ → SYSTEM/
   // Prefer standalone /bios/neogeo.zip etc.; fall back to nested files inside arcade-bios.zip.
   var packs = ['neogeo.zip', 'pgm.zip', 'isgsm.zip'];
   var wrote = false;
   var nested = null;

   async function loadNestedPack(name) {
      if (!nested) {
         var container = (window.__playEmbed && window.__playEmbed.biosUrl) || '/bios/arcade-bios.zip';
         var buf = await fetchBiosArrayBuffer(container);
         if (!buf) return null;
         nested = await openZipFsFromBuffer(buf);
      }
      if (!nested) return null;
      try {
         if (nested.readdirSync('/').indexOf(name) === -1) return null;
         return nested.readFileSync('/' + name);
      } catch (e) {
         return null;
      }
   }

   for (var i = 0; i < packs.length; i++) {
      var name = packs[i];
      reportLoadProgress(68 + Math.round((i / packs.length) * 10), '加载 BIOS… ' + name);
      var data = null;
      try {
         data = await fetchBiosArrayBuffer('/bios/' + name);
      } catch (e) {}
      if (!data) {
         try { data = await loadNestedPack(name); } catch (e) {}
      }
      if (data && writeArcadeBiosRomset(name, data)) wrote = true;
   }
   return wrote;
}

function openZipFsFromBuffer(buffer) {
   return new Promise(function(resolve, reject) {
      try {
         var BFSBuffer = BrowserFS.BFSRequire('buffer').Buffer;
         BrowserFS.FileSystem.ZipFS.Create({ zipData: BFSBuffer(new Uint8Array(buffer)) }, function(err, zipFs) {
            if (err) reject(err);
            else resolve(zipFs);
         });
      } catch (e) {
         reject(e);
      }
   });
}

async function loadEmbedBios() {
   if (!liteMode || !Module || !Module.FS) return false;
   ensureFsDir('/home/web_user/retroarch/system');
   var urls = [];
   var embed = window.__playEmbed;
   if (embed && embed.biosUrl) urls.push(embed.biosUrl);
   if (embed && embed.shellProfile === 'ps') {
      urls.push('/bios/SCPH1001.BIN', '/bios/scph1001.bin');
   }
   var wrote = false;
   if (isArcadeEmbedBios()) {
      try {
         reportLoadProgress(68, '加载街机 BIOS…');
         if (await loadArcadeBiosRomsets()) wrote = true;
      } catch (e) {
         console.error('WEBPLAYER: arcade BIOS load failed', e);
      }
      return wrote;
   }
   for (var i = 0; i < urls.length; i++) {
      var url = urls[i];
      if (!url) continue;
      var file = url.split('/').pop().split('?')[0];
      if (!/^https?:/i.test(url)) url = location.origin + (url.charAt(0) === '/' ? url : '/' + url);
      try {
         if (/\.zip$/i.test(file)) {
            reportLoadProgress(68, '加载 BIOS…');
            if (await loadEmbedBiosZip(url, {})) wrote = true;
            continue;
         }
         if (!/\.bin$/i.test(file)) continue;
         reportLoadProgress(68, '加载 BIOS…');
         var biosBuf = await fetchArrayBufferWithProgress(url, function (sub) {
            reportLoadProgress(68 + Math.round(sub * 0.12), '加载 BIOS… ' + sub + '%');
         });
         Module.FS.writeFile('/home/web_user/retroarch/system/' + file.toUpperCase(), toFsBytes(biosBuf));
         wrote = true;
      } catch (e) {}
   }
   return wrote;
}

function loadEmbedBiosZip(url, opts) {
   opts = opts || {};
   return fetch(url).then(function(resp) {
      if (!resp.ok) return false;
      return resp.arrayBuffer();
   }).then(function(buffer) {
      if (!buffer) return false;
      return openZipFsFromBuffer(buffer).then(function(zipFs) {
         return writeZipFsBiosEntries(zipFs, '/', opts);
      });
   }).catch(function() {
      return false;
   });
}

function writeZipFsBiosEntries(zipFs, zipPath, opts) {
   opts = opts || {};
   var wrote = false;
   var systemDir = '/home/web_user/retroarch/system';
   var listing = zipFs.readdirSync(zipPath);
   for (var i = 0; i < listing.length; i++) {
      var name = listing[i];
      if (!name || name === '.' || name === '..') continue;
      var full = zipPath === '/' ? '/' + name : zipPath + '/' + name;
      var stat = zipFs.statSync(full);
      if (stat.isDirectory()) {
         if (writeZipFsBiosEntries(zipFs, full, opts)) wrote = true;
         continue;
      }
      var data = zipFs.readFileSync(full);
      var baseName = name.split('/').pop();
      ensureFsDir(systemDir);
      Module.FS.writeFile(systemDir + '/' + baseName, toFsBytes(data));
      wrote = true;
   }
   return wrote;
}

async function startRetroArchWithRom(url, name) {
   if (!name) {
      try {
         name = decodeURIComponent(url.split('/').pop().split('?')[0]);
      } catch (e) {
         name = url.split('/').pop().split('?')[0];
      }
   }
   var btn = document.getElementById("btnRun");
   if (btn) btn.disabled = true;
   $('#icnRun').addClass('fa-spinner fa-spin');
   if (liteMode) {
      reportLoadProgress(6, '准备加载…');
   }
   try {
      if (!Module) {
         await loadCore(currentCore);
         console.log("WEBPLAYER: wasm runtime initialized");
      }
      if (!retroArchRunning) {
         mountBrowserFS();
      }
      await loadEmbedBios();
      console.log("WEBPLAYER: fetching ROM " + url);
      reportLoadProgress(82, '下载游戏…');
      var romBuf = await fetchArrayBufferWithProgress(url, function (sub) {
         reportLoadProgress(82 + Math.round(sub * 0.13), '下载游戏… ' + sub + '%');
      });
      if (isArcadeEmbedBios() && /\.zip$/i.test(name)) {
         reportLoadProgress(93, '注入街机 BIOS…');
         try {
            romBuf = await mergeArcadeBiosIntoRom(romBuf);
         } catch (mergeErr) {
            console.error('WEBPLAYER: arcade BIOS merge failed', mergeErr);
         }
      }
      if (isArcadeEmbedBios()) {
         reportLoadProgress(95, '准备街机作弊…');
         try {
            await prepareArcadeCheatsBeforeLaunch(name);
         } catch (cheatErr) {
            console.warn('WEBPLAYER: arcade cheat prepare failed', cheatErr);
         }
      }
      var contentPath = '/home/web_user/retroarch/userdata/content/' + name;
      reportLoadProgress(96, '写入游戏…');
      Module.FS.writeFile(contentPath, toFsBytes(romBuf), { encoding: 'binary' });
      trackContentPath(contentPath);
      if (retroArchRunning) {
         await requestRelaunch(ModuleBase.corePath, contentPath);
      } else {
         ModuleBase.arguments = ["-v", contentPath, "-c", "/home/web_user/retroarch/userdata/retroarch.cfg"];
         if (Module) Module.arguments = ModuleBase.arguments;
         launchRetroArch();
      }
   } catch (err) {
      console.error("WEBPLAYER: ROM load failed", err);
      alert("ROM 加载失败: " + err.message);
      if (btn) btn.disabled = false;
      $('#icnRun').removeClass('fa-spinner fa-spin');
   }
}

function launchRetroArch() {
   applyEmbedLayout();
   $('.webplayer').show();
   $('.webplayer-preview').hide();
   var btnRun = document.getElementById("btnRun");
   if (btnRun) btnRun.disabled = true;

   if (!liteMode) {
      $('#btnAdd').removeClass("disabled").removeAttr("disabled").click(function() {
         $('#btnRom').click();
      });
      $('#btnRom').removeAttr("disabled").change(function(e) {
         selectFiles(e.target.files);
      });
      $('#btnMenu').removeClass("disabled").removeAttr("disabled").click(function() {
         Module.retroArchSend("MENU_TOGGLE");
         Module.canvas.focus();
      });
      $('#btnFullscreen').removeClass("disabled").removeAttr("disabled").click(function() {
         Module.retroArchSend("FULLSCREEN_TOGGLE");
         Module.canvas.focus();
      });
   }

   trackContentFromArgs(Module.arguments);
   retroArchRunning = true;
   if (liteMode) {
      reportLoadProgress(98, '启动中…');
      if (window.PlayRetroShell && window.PlayRetroShell.hideStartOverlay) {
         window.PlayRetroShell.hideStartOverlay();
      }
   }
   Module.callMain(Module.arguments);
   if (liteMode) {
      reportLoadProgress(100, '完成');
      try {
         window.dispatchEvent(new CustomEvent('playretro-ready'));
      } catch (e) {}
      if (isArcadeEmbedBios()) {
         scheduleArcadeCheatSoftApply('first-boot');
      }
      if (window.PlayRetroShell && window.PlayRetroShell.scheduleDeferredLayout) {
         window.PlayRetroShell.scheduleDeferredLayout();
      } else {
         setTimeout(applyEmbedLayout, 50);
         setTimeout(applyEmbedLayout, 400);
      }
   }
}

function selectFiles(files) {
   $('#btnAdd').addClass('disabled');
   $('#icnAdd').removeClass('fa-plus');
   $('#icnAdd').addClass('fa-spinner spinning');
   var count = files.length;

   for (var i = 0; i < count; i++) {
      filereader = new FileReader();
      filereader.file_name = files[i].name;
      filereader.readAsArrayBuffer(files[i]);
      filereader.onload = function() {
         uploadData(this.result, this.file_name)
      };
      filereader.onloadend = function(evt) {
         console.log("WEBPLAYER: file: " + this.file_name + " upload complete");
         if (evt.target.readyState == FileReader.DONE) {
            $('#btnAdd').removeClass('disabled');
            $('#icnAdd').removeClass('fa-spinner spinning');
            $('#icnAdd').addClass('fa-plus');
         }
      }
   }
}

function uploadData(data, name) {
   var dataView = new Uint8Array(data);
   Module.FS.createDataFile('/', name, dataView, true, false);

   var data = Module.FS.readFile(name, {
      encoding: 'binary'
   });
   var contentPath = '/home/web_user/retroarch/userdata/content/' + name;
   Module.FS.writeFile(contentPath, data, {
      encoding: 'binary'
   });
   Module.FS.unlink(name);
   trackContentPath(contentPath);

   if (retroArchRunning && Module) {
      console.log("WEBPLAYER: auto loading " + contentPath);
      requestRelaunch(ModuleBase.corePath, contentPath);
   }
}

// When the browser has loaded everything.
$(function() {
   // create core list
   var coreArray = Object.entries(libretroCores);
   var coreNames = Object.values(libretroCores).sort();
   var coreSelector = document.getElementById("core-selector");
   for (let name of coreNames) {
      let a = document.createElement("a");
      a.href = ".";
      a.dataset.core = coreArray.find(i => i[1] == name)[0];
      a.textContent = name;
      a.classList.add("dropdown-item");
      coreSelector.appendChild(a);
   }

   // Enable data clear
   $('#btnClean').click(function() {
      cleanupStorage();
   });

   // Enable all available ToolTips.
   if (!liteMode && $.fn.tooltip) {
      $('.tooltip-enable').tooltip({
         placement: 'right'
      });
   }

   // Allow hiding the top menu.
   $('.showMenu').hide();
   $('#btnHideMenu, .showMenu').click(function() {
      $('nav').slideToggle('slow');
      $('.showMenu').toggle('slow');
   });

   // Attempt to disable some default browser keys.
   var keys = {
      9: "tab",
      13: "enter",
      16: "shift",
      18: "alt",
      27: "esc",
      33: "rePag",
      34: "avPag",
      35: "end",
      36: "home",
      37: "left",
      38: "up",
      39: "right",
      40: "down",
      112: "F1",
      113: "F2",
      114: "F3",
      115: "F4",
      116: "F5",
      117: "F6",
      118: "F7",
      119: "F8",
      120: "F9",
      121: "F10",
      122: "F11",
      123: "F12"
   };
   window.addEventListener('keydown', function(e) {
      if (keys[e.which]) {
         e.preventDefault();
      }
   });

   // Switch the core when selecting one.
   $('#core-selector a').click(function(e) {
      e.preventDefault();
      var core = $(this).data('core');
      if (!core) return;
      localStorage.setItem("core", core);
      if (Module && retroArchRunning) {
         Module.retroArchSend("LOAD_CORE /home/web_user/retroarch/cores/" + core + "_libretro.core");

         // maybe RetroArch crashed? reload if RetroArch doesn't exit within a second.
         if (reloadTimeout) clearTimeout(reloadTimeout);
         reloadTimeout = setTimeout(function() {
            location.reload();
         }, 1000);
      } else {
         location.reload();
      }
   });

   // Find which core to load.
   if (liteMode) {
      var embedCore = window.__playEmbed && window.__playEmbed.core;
      if (embedCore) {
         currentCore = embedCore;
      } else {
         var storedCore = localStorage.getItem("core");
         currentCore = (storedCore === 'nes' || storedCore === 'md' || storedCore === 'sega32x' || storedCore === 'atari2600' || storedCore === 'a26' || storedCore === 'gamegear' || storedCore === 'gg' || storedCore === 'gb' || storedCore === 'gbc' || storedCore === 'gba' || storedCore === 'pce' || storedCore === 'ps' || storedCore === 'psx' || storedCore === 'ws' || storedCore === 'wsc' || storedCore === 'sfc' || storedCore === 'sfchack' || storedCore === 'snes' || storedCore === 'gambatte' || storedCore === 'mgba' || storedCore === 'picodrive' || storedCore === 'mednafen_pce_fast' || storedCore === 'pcsx_rearmed' || storedCore === 'mednafen_wswan' || storedCore === 'snes9x' || !storedCore) ? defaultCore : storedCore;
      }
      localStorage.setItem("core", currentCore);
   } else {
      currentCore = localStorage.getItem("core") || defaultCore;
   }
   if (liteMode) {
      idbfsInit();
      zipfsInit();
      xhrfsInit();
   } else {
      loadCore(currentCore).then(function() {
         console.log("WEBPLAYER: wasm runtime initialized");
         appInitialized();
      });
      idbfsInit();
      zipfsInit();
      xhrfsInit();
   }
});

async function loadCoreFallback(currentCore) {
   if (currentCore == defaultCore) {
      console.error("Error: couldn't load default core!");
      alert("Error: couldn't load default core!");
      return;
   }
   await loadCore(defaultCore);
}

var CORE_WASM_CACHE_DB = 'playretro_core_wasm_v1';
var CORE_WASM_CACHE_STORE = 'wasm';

/** 无 Content-Length 时用于估算下载进度（字节） */
var CORE_WASM_EST_BYTES = {
   fceumm: 900000,
   nestopia: 1200000,
   gambatte: 800000,
   gearsystem: 900000,
   genesis_plus_gx: 1800000,
   picodrive: 1500000,
   snes9x: 1400000,
   mednafen_pce_fast: 1200000,
   mednafen_wswan: 900000,
   mgba: 1600000,
   pcsx_rearmed: 4200000,
   fbneo: 14000000
};
var CORE_JS_EST_BYTES = {
   fceumm: 180000,
   nestopia: 220000,
   gambatte: 200000,
   gearsystem: 200000,
   genesis_plus_gx: 260000,
   picodrive: 240000,
   snes9x: 250000,
   mednafen_pce_fast: 230000,
   mednafen_wswan: 210000,
   mgba: 270000,
   pcsx_rearmed: 280000,
   fbneo: 900000
};

function openCoreWasmCache() {
   return new Promise(function(resolve) {
      if (!window.indexedDB) {
         resolve(null);
         return;
      }
      var req = indexedDB.open(CORE_WASM_CACHE_DB, 1);
      req.onupgradeneeded = function(e) {
         var db = e.target.result;
         if (!db.objectStoreNames.contains(CORE_WASM_CACHE_STORE)) {
            db.createObjectStore(CORE_WASM_CACHE_STORE);
         }
      };
      req.onsuccess = function(e) { resolve(e.target.result); };
      req.onerror = function() { resolve(null); };
   });
}

function idbGetCoreWasm(core) {
   return openCoreWasmCache().then(function(db) {
      if (!db) return null;
      return new Promise(function(resolve) {
         try {
            var tx = db.transaction(CORE_WASM_CACHE_STORE, 'readonly');
            var req = tx.objectStore(CORE_WASM_CACHE_STORE).get(core);
            req.onsuccess = function() {
               var val = req.result;
               if (!val) {
                  resolve(null);
                  return;
               }
               resolve(val instanceof Uint8Array ? val : new Uint8Array(val));
            };
            req.onerror = function() { resolve(null); };
         } catch (e) {
            resolve(null);
         }
      });
   });
}

function idbPutCoreWasm(core, data) {
   return openCoreWasmCache().then(function(db) {
      if (!db) return;
      return new Promise(function(resolve) {
         try {
            var tx = db.transaction(CORE_WASM_CACHE_STORE, 'readwrite');
            tx.objectStore(CORE_WASM_CACHE_STORE).put(data, core);
            tx.oncomplete = function() { resolve(); };
            tx.onerror = function() { resolve(); };
         } catch (e) {
            resolve();
         }
      });
   });
}

async function loadCoreWasmBinary(core) {
   if (!liteMode) return null;
   reportLoadProgress(8, '检查核心缓存…');
   var cached = await idbGetCoreWasm(core);
   if (cached && cached.byteLength > 0) {
      console.log('WEBPLAYER: wasm cache hit for ' + core);
      reportLoadProgress(35, '使用缓存的核心');
      return cached;
   }
   var url = './' + core + '_libretro.wasm';
   console.log('WEBPLAYER: fetching wasm ' + url);
   reportLoadProgress(10, '下载核心… 0%');
   var wasmBuf = await fetchArrayBufferWithProgress(url, function (sub) {
      reportLoadProgress(10 + Math.round(sub * 0.24), '下载核心… ' + sub + '%');
   }, CORE_WASM_EST_BYTES[core] || 2500000);
   var data = new Uint8Array(wasmBuf);
   idbPutCoreWasm(core, data);
   reportLoadProgress(35, '核心下载完成');
   return data;
}

async function loadCore(core, args) {
   // Make the core the selected core in the UI.
   $('#core-selector a.active').removeClass('active');
   var coreTitle = $('#core-selector a[data-core="' + core + '"]').addClass('active').text();
   $('#dropdownMenu1').text(coreTitle || core);

   ModuleBase.arguments = args || ["-v", "--menu", "-c", "/home/web_user/retroarch/userdata/retroarch.cfg"];
   ModuleBase.preRun = [modulePreRun];
   ModuleBase.canvas = canvas;
   ModuleBase.corePath = "/home/web_user/retroarch/cores/" + core + "_libretro.core";

   var moduleOpts = Object.assign({}, ModuleBase);
   if (liteMode) {
      try {
         var wasmBinary = await loadCoreWasmBinary(core);
         if (wasmBinary) moduleOpts.wasmBinary = wasmBinary;
      } catch (e) {
         console.warn('WEBPLAYER: wasm preload failed, core will fetch itself', e);
      }
   }

   // Load the Core's related JavaScript.
   try {
      var script;
      if (liteMode) {
         var jsUrl = './' + core + '_libretro.js';
         reportLoadProgress(36, '下载核心脚本… 0%');
         var jsBuf = await fetchArrayBufferWithProgress(jsUrl, function (sub) {
            reportLoadProgress(36 + Math.round(sub * 0.14), '下载核心脚本… ' + sub + '%');
         }, CORE_JS_EST_BYTES[core] || 600000);
         moduleOpts.locateFile = function (path) {
            return '/retroarch/' + path;
         };
         reportLoadProgress(51, '加载核心模块… 51%');
         var blobUrl = URL.createObjectURL(new Blob([jsBuf], { type: 'application/javascript' }));
         try {
            script = await import(/* webpackIgnore: true */ blobUrl);
         } finally {
            URL.revokeObjectURL(blobUrl);
         }
      } else {
         script = await import("./" + core + "_libretro.js");
      }
      var stopCompile = liteMode
         ? startSmoothProgress(55, 71, 15000, '编译核心…')
         : function () {};
      try {
         Module = await script.default(moduleOpts);
         if (liteMode) {
            stopCompile(72, '核心就绪');
         }
      } catch (err) {
         if (liteMode) stopCompile();
         console.error("Couldn't instantiate module", err);
         await loadCoreFallback(core);
         throw err;
      }
   } catch (err) {
      console.error("Couldn't load script", err);
      await loadCoreFallback(core);
      throw err;
   }
}

// exit/exitspawn hook — must run only after the previous Module has quit (via QUIT → retroArchExit)
function forceStopModule(mod) {
   if (!mod) return;
   try {
      if (mod.PThread && mod.PThread.terminateAllThreads) mod.PThread.terminateAllThreads();
   } catch (e) {}
   try {
      if (typeof mod.pauseMainLoop === 'function') mod.pauseMainLoop();
   } catch (e2) {}
   try {
      if (typeof mod._emscripten_cancel_main_loop === 'function') mod._emscripten_cancel_main_loop();
   } catch (e3) {}
   try {
      if (typeof mod._emscripten_force_exit === 'function') mod._emscripten_force_exit(0);
   } catch (e4) {}
   try {
      if (mod.AL && mod.AL.currentCtx && mod.AL.currentCtx.audioCtx) {
         mod.AL.currentCtx.audioCtx.suspend();
      }
   } catch (e5) {}
   try {
      if (typeof mod.quit === 'function') mod.quit(0, true);
   } catch (e6) {}
}

function resetCanvasForRelaunch() {
   try {
      var old = document.getElementById('canvas') || canvas;
      if (!old || !old.parentNode) return;
      var neu = old.cloneNode(false);
      neu.id = 'canvas';
      if (old.className) neu.className = old.className;
      if (old.getAttribute('tabindex') != null) neu.setAttribute('tabindex', old.getAttribute('tabindex'));
      old.parentNode.replaceChild(neu, old);
      canvas = neu;
      ModuleBase.canvas = neu;
      try {
         if (window.Module) window.Module.canvas = neu;
      } catch (e) {}
   } catch (e2) {
      clearGameCanvas();
   }
}

function clearGameCanvas() {
   try {
      var c = document.getElementById('canvas') || canvas;
      if (!c) return;
      var ctx = c.getContext && (c.getContext('2d') || c.getContext('webgl') || c.getContext('webgl2'));
      if (ctx && ctx.clearColor && ctx.clear) {
         ctx.clearColor(0, 0, 0, 1);
         ctx.clear(ctx.COLOR_BUFFER_BIT);
      } else if (ctx && ctx.fillRect) {
         ctx.fillStyle = '#000';
         ctx.fillRect(0, 0, c.width || 800, c.height || 600);
      }
   } catch (e) {}
}

/**
 * 作弊用静默重载：立刻停旧实例，不刷核心进度条，避免双开/叠进度。
 */
async function relaunchContentSilent(content) {
   if (!content) content = currentContentPath;
   if (!content || content === '--menu') return false;
   if (relaunchInProgress) return false;

   relaunchInProgress = true;
   suppressLoadProgress = true;
   if (window.PlayRetroShell && window.PlayRetroShell.hideLoadProgress) {
      try { window.PlayRetroShell.hideLoadProgress(); } catch (e) {}
   }

   try {
      if (pendingRelaunch) {
         if (pendingRelaunch.fallback) clearTimeout(pendingRelaunch.fallback);
         var oldPending = pendingRelaunch;
         pendingRelaunch = null;
         if (oldPending.resolve) oldPending.resolve(false);
      }

      var oldModule = Module;
      retroArchRunning = false;
      Module = null;
      if (reloadTimeout) {
         clearTimeout(reloadTimeout);
         reloadTimeout = null;
      }
      if (oldModule) forceStopModule(oldModule);
      resetCanvasForRelaunch();

      /* 给浏览器一点时间停掉旧 rAF/音频，再起新实例 */
      await new Promise(function (r) { setTimeout(r, 80); });

      var coreName = currentCore || localStorage.getItem('core') || 'fbneo';
      localStorage.setItem('core', coreName);
      await loadCore(coreName, ['-v', content, '-c', '/home/web_user/retroarch/userdata/retroarch.cfg']);
      if (Module) Module.canvas = canvas;
      mountBrowserFS();
      if (pendingArcadeCheatState) {
         try { rewritePendingArcadeCheatIni(); } catch (eCheat) {}
      }
      /* 内容文件在 afs 上应仍在；若被清掉则无法启动 */
      try {
         if (Module.FS && Module.FS.analyzePath && !Module.FS.analyzePath(content).exists) {
            console.error('WEBPLAYER: silent relaunch missing content', content);
            return false;
         }
      } catch (eExist) {}

      trackContentPath(content);
      retroArchRunning = true;
      Module.callMain(Module.arguments);
      applyEmbedLayout();
      try {
         window.dispatchEvent(new CustomEvent('playretro-ready'));
      } catch (eReady) {}
      if (isArcadeEmbedBios()) {
         scheduleArcadeCheatSoftApply('silent-relaunch');
      }
      return true;
   } catch (e) {
      console.error('WEBPLAYER: silent relaunch failed', e);
      retroArchRunning = false;
      return false;
   } finally {
      relaunchInProgress = false;
      suppressLoadProgress = false;
      if (window.PlayRetroShell && window.PlayRetroShell.hideLoadProgress) {
         try { window.PlayRetroShell.hideLoadProgress(); } catch (e2) {}
      }
   }
}

function requestRelaunch(core, content) {
   if (!core) core = ModuleBase.corePath;
   if (!content) content = "--menu";

   if (relaunchInProgress) return Promise.resolve(false);

   if (!Module || !retroArchRunning) {
      return relaunch(core, content);
   }

   return new Promise(function (resolve) {
      if (pendingRelaunch) {
         resolve(false);
         return;
      }
      pendingRelaunch = { core: core, content: content, resolve: resolve };
      pendingRelaunch.fallback = setTimeout(function () {
         if (!pendingRelaunch || pendingRelaunch.resolve !== resolve) return;
         var p = pendingRelaunch;
         pendingRelaunch = null;
         forceStopModule(Module);
         relaunch(p.core, p.content).then(function (ok) {
            if (p.resolve) p.resolve(ok !== false);
         });
      }, 2000);
      try {
         Module.retroArchSend("QUIT");
      } catch (e) {
         clearTimeout(pendingRelaunch.fallback);
         pendingRelaunch = null;
         forceStopModule(Module);
         relaunch(core, content).then(resolve);
      }
   });
}

async function relaunch(core, content) {
   // force restart on exit
   if (!core) core = ModuleBase.corePath;

   if (!content) content = "--menu";

   if (relaunchInProgress) return false;
   relaunchInProgress = true;

   try {
      var oldModule = Module;
      retroArchRunning = false;
      Module = null;
      if (reloadTimeout) {
         clearTimeout(reloadTimeout);
         reloadTimeout = null;
      }
      if (oldModule) forceStopModule(oldModule);

      // parse core name from full path ("/home/web_user/retroarch/cores/NAME_libretro.core")
      currentCore = core.slice(0, -14).split("/").slice(-1)[0];

      localStorage.setItem("core", currentCore);
      await loadCore(currentCore, ["-v", content, "-c", "/home/web_user/retroarch/userdata/retroarch.cfg"]);
      mountBrowserFS();
      /* 街机作弊 INI 必须在 callMain 前写入，FBNeo 加载内容时读取 */
      if (pendingArcadeCheatState) {
         try { rewritePendingArcadeCheatIni(); } catch (eCheat) {}
      }
      retroArchRunning = true;
      Module.callMain(Module.arguments);
      applyEmbedLayout();
      return true;
   } catch (e) {
      retroArchRunning = false;
      return false;
   } finally {
      relaunchInProgress = false;
   }
}

var SHADER_FS_DIR = '/home/web_user/retroarch/shaders';
var SHADER_PRESET_PATH = SHADER_FS_DIR + '/active.glslp';
var currentShaderId = null;

function decodeShaderBlob(item) {
   if (!item) return '';
   if (typeof item === 'string') return item;
   var val = item.value != null ? item.value : '';
   if (item.type === 'base64') {
      try { return atob(val); } catch (e) { return ''; }
   }
   return val;
}

function applyVideoShader(shaderId, pack) {
   if (!Module || !retroArchRunning || !Module.retroArchSend) return false;
   pack = pack || window.RS_SHADERS || window.EJS_SHADERS || null;

   if (!shaderId || shaderId === 'disabled' || shaderId === 'none') {
      try { Module.retroArchSend('SET_SHADER'); } catch (e) {}
      currentShaderId = null;
      return true;
   }
   if (!pack || !pack[shaderId]) return false;

   try {
      try { Module.FS.mkdirTree(SHADER_FS_DIR); } catch (e) {}
      var cfg = pack[shaderId];
      if (typeof cfg === 'string') {
         Module.FS.writeFile(SHADER_PRESET_PATH, cfg);
      } else {
         Module.FS.writeFile(SHADER_PRESET_PATH, decodeShaderBlob(cfg.shader));
         var resources = cfg.resources || [];
         for (var i = 0; i < resources.length; i++) {
            var res = resources[i];
            if (!res || !res.name) continue;
            Module.FS.writeFile(SHADER_FS_DIR + '/' + res.name, decodeShaderBlob(res));
         }
      }
      Module.retroArchSend('SET_SHADER ' + SHADER_PRESET_PATH);
      currentShaderId = shaderId;
      return true;
   } catch (e) {
      console.warn('applyVideoShader failed', e);
      return false;
   }
}

/* 作弊：仅把「已勾选」的码写入核心（EMU handler / Game Genie & Raw） */
var cheatApiCache = undefined;
var activeCheatCodes = [];

function getCheatApi() {
   if (!Module || !Module.cwrap) {
      cheatApiCache = undefined;
      return null;
   }
   if (cheatApiCache !== undefined && cheatApiCache && cheatApiCache._module === Module) {
      return cheatApiCache;
   }
   cheatApiCache = null;
   try {
      var realloc = Module.cwrap('_cmd_cheat_realloc', 'number', ['number']);
      var setCode = Module.cwrap('_cmd_cheat_set_code', null, ['number', 'string']);
      var apply = Module.cwrap('_cmd_cheat_apply_cheats', null, []);
      if (typeof realloc !== 'function' || typeof setCode !== 'function' || typeof apply !== 'function') {
         return null;
      }
      cheatApiCache = {
         _module: Module,
         realloc: realloc,
         setCode: setCode,
         apply: apply,
         toggle: null,
         getSize: null
      };
      try {
         cheatApiCache.toggle = Module.cwrap('_cmd_cheat_toggle_index', null, ['number', 'number']);
      } catch (e1) {}
      try {
         cheatApiCache.getSize = Module.cwrap('_cmd_cheat_get_size', 'number', []);
      } catch (e2) {}
   } catch (e) {
      cheatApiCache = null;
   }
   return cheatApiCache;
}

function applyCheatCodes(codes) {
   if (!Module || !retroArchRunning) return false;
   var api = getCheatApi();
   if (!api) return false;
   var list = [];
   if (codes && codes.length) {
      for (var i = 0; i < codes.length; i++) {
         var c = codes[i];
         if (c == null) continue;
         var s = String(c).trim();
         if (s) list.push(s);
      }
   }
   try {
      api.realloc(list.length);
      for (var j = 0; j < list.length; j++) {
         api.setCode(j, list[j]);
      }
      api.apply();
      activeCheatCodes = list.slice();
      return true;
   } catch (e) {
      console.warn('applyCheatCodes failed', e);
      return false;
   }
}

function clearCheatCodes() {
   activeCheatCodes = [];
   return applyCheatCodes([]);
}

function writeArcadeCheatIni(basename, iniText) {
   if (!Module || !Module.FS || !basename || !iniText) return false;
   var text = String(iniText);
   var paths = [
      '/home/web_user/retroarch/system/fbneo/cheats/' + basename + '.ini',
      '/home/web_user/.config/retroarch/system/fbneo/cheats/' + basename + '.ini',
      '/home/web_user/retroarch/system/fbneo/' + basename + '.ini'
   ];
   var ok = false;
   for (var i = 0; i < paths.length; i++) {
      try {
         var dir = paths[i].replace(/\/[^/]+$/, '');
         ensureFsDir(dir);
         Module.FS.writeFile(paths[i], text);
         ok = true;
      } catch (e) {
         console.warn('writeArcadeCheatIni failed', paths[i], e);
      }
   }
   if (ok) {
      pendingArcadeCheatState = { basename: basename, ini: text };
      console.log('WEBPLAYER: arcade cheat ini ready', basename);
   }
   return ok;
}

/** 缓存：relaunch 后需重新写入（FBNeo 只在加载内容时读 INI） */
var pendingArcadeCheatState = null;
/** FBNeo 开机只 reset 作弊到 default，不会 CheatEnable；需软复位触发 apply（对标 EJS 开局后再 setVariable） */
var arcadeCheatSoftApplyTimer = null;
var ARCADE_CHEAT_SOFT_APPLY_MS = 2800;
var arcadeCheatsNeedSoftApply = false;

function rewritePendingArcadeCheatIni() {
   if (!pendingArcadeCheatState) return false;
   return writeArcadeCheatIni(pendingArcadeCheatState.basename, pendingArcadeCheatState.ini);
}

function pendingArcadeCheatHasEnabled() {
   if (!pendingArcadeCheatState || !pendingArcadeCheatState.basename) return false;
   var prefs = loadArcadeCheatPrefsForBasename(pendingArcadeCheatState.basename);
   var keys = Object.keys(prefs || {});
   for (var i = 0; i < keys.length; i++) {
      if ((parseInt(prefs[keys[i]], 10) || 0) > 0) return true;
   }
   /* 无偏好时看 INI 里是否已有 default > 0 */
   var ini = String(pendingArcadeCheatState.ini || '');
   return /(?:^|\n)\s*default\s+[1-9]\d*/.test(ini);
}

/**
 * 街机作弊真正生效：INI default 写好并加载后，延迟软复位一次，
 * 触发 FBNeo apply_cheats_from_variables / CheatEnable。
 * （网页核心无 ejs_set_variable，不能像旧 EJS 那样热改 core option）
 */
function scheduleArcadeCheatSoftApply(reason) {
   if (!arcadeCheatsNeedSoftApply && !pendingArcadeCheatHasEnabled()) return;
   if (arcadeCheatSoftApplyTimer) clearTimeout(arcadeCheatSoftApplyTimer);
   arcadeCheatSoftApplyTimer = setTimeout(function () {
      arcadeCheatSoftApplyTimer = null;
      if (!Module || !retroArchRunning) return;
      if (!pendingArcadeCheatHasEnabled() && !arcadeCheatsNeedSoftApply) return;
      arcadeCheatsNeedSoftApply = false;
      try {
         rewritePendingArcadeCheatIni();
         writeEmbedCoreOptions();
      } catch (e1) {}
      console.warn('WEBPLAYER: soft-reset to apply FBNeo cheats', reason || '');
      try {
         if (Module._cmd_unpause) Module._cmd_unpause();
         if (Module._cmd_reset) Module._cmd_reset();
         else triggerReset();
      } catch (e2) {
         console.warn('WEBPLAYER: arcade cheat soft-reset failed', e2);
      }
   }, ARCADE_CHEAT_SOFT_APPLY_MS);
}

function cancelArcadeCheatSoftApply() {
   if (arcadeCheatSoftApplyTimer) {
      clearTimeout(arcadeCheatSoftApplyTimer);
      arcadeCheatSoftApplyTimer = null;
   }
}

function loadArcadeCheatPrefsForBasename(basename) {
   try {
      var all = JSON.parse(localStorage.getItem('retro_shell_arcade_cheats_v1') || '{}') || {};
      return all['arcade:' + basename] || {};
   } catch (e) {
      return {};
   }
}

function applyDefaultsToIniText(iniText, values) {
   if (window.RS_ArcadeCheats && window.RS_ArcadeCheats.applyDefaultsToIni) {
      return window.RS_ArcadeCheats.applyDefaultsToIni(iniText, values);
   }
   values = values || {};
   var lines = String(iniText || '').split(/\r?\n/);
   var current = null;
   for (var i = 0; i < lines.length; i++) {
      var head = lines[i].match(/^cheat\s+"(.*)"\s*\{?$/);
      if (head) {
         current = head[1].trim();
         continue;
      }
      if (!current || values[current] == null) continue;
      if (/^\s*default\s+\d+/.test(lines[i])) {
         var indent = (lines[i].match(/^\s*/) || [''])[0];
         lines[i] = indent + 'default ' + (parseInt(values[current], 10) || 0);
      }
   }
   return lines.join('\n');
}

async function fetchArcadeCheatIniRaw(basename) {
   if (!basename) return '';
   if (window.RS_ArcadeCheats && window.RS_ArcadeCheats.fetchCheatIni) {
      var packed = await window.RS_ArcadeCheats.fetchCheatIni(basename);
      return (packed && packed.ini) || '';
   }
   var tokenUrl = '/data/api/arcade-cheats-token.php?name=' + encodeURIComponent(basename + '.zip');
   var token = '';
   try {
      var tr = await fetch(tokenUrl, { credentials: 'omit', cache: 'no-store' });
      if (tr.ok) {
         var tj = await tr.json();
         token = (tj && tj.t) || '';
      }
   } catch (e1) {}
   var cheatUrl = '/data/api/arcade-cheats.php?name=' + encodeURIComponent(basename + '.zip');
   if (token) cheatUrl += '&t=' + encodeURIComponent(token);
   var cr = await fetch(cheatUrl, { credentials: 'omit', cache: 'no-store' });
   if (!cr.ok) return '';
   var cj = await cr.json();
   return (cj && cj.cheats) || '';
}

function resolveArcadeCheatBasename(romFileName) {
   if (window.RS_ArcadeCheats && window.RS_ArcadeCheats.resolveArcadeRomBasename) {
      var b = window.RS_ArcadeCheats.resolveArcadeRomBasename(window.__playEmbed);
      if (b) return b;
   }
   var name = String(romFileName || '').split(/[\\/]/).pop().replace(/\.[^/.]+$/, '').toLowerCase();
   if (!name || /[\u4e00-\u9fff]/.test(name)) return '';
   return name;
}

function clearFbneoCheatCoreOptions() {
   Object.keys(embedCoreOptions).forEach(function (key) {
      if (key.indexOf('fbneo-cheat-') === 0) delete embedCoreOptions[key];
   });
}

function seedArcadeCheatCoreOptions(optionMap) {
   clearFbneoCheatCoreOptions();
   if (optionMap) {
      Object.keys(optionMap).forEach(function (key) {
         embedCoreOptions[key] = optionMap[key];
      });
   }
   if (Module && Module.FS) {
      try { writeEmbedCoreOptions(); } catch (e) {}
   }
   var n = optionMap ? Object.keys(optionMap).length : 0;
   console.log('WEBPLAYER: seeded fbneo cheat core options', n);
}

/**
 * 街机启动前：写 INI + 写入 fbneo-cheat-* 核心选项（FBNeo 真正启用作弊靠这个）。
 */
async function prepareArcadeCheatsBeforeLaunch(romFileName) {
   if (!isArcadeEmbedBios()) return false;
   try {
      if (!window.RS_ArcadeCheats) {
         await new Promise(function (resolve) {
            var s = document.createElement('script');
            s.src = '/playemu/arcade-cheats.js?v=1.20.4';
            s.async = true;
            s.onload = function () { resolve(); };
            s.onerror = function () { resolve(); };
            document.head.appendChild(s);
         });
      }
      var basename = resolveArcadeCheatBasename(romFileName);
      if (!basename) {
         console.log('WEBPLAYER: arcade cheat skip (no basename)');
         return false;
      }
      var ini = await fetchArcadeCheatIniRaw(basename);
      if (!String(ini).trim()) {
         console.log('WEBPLAYER: arcade cheat skip (no ini)', basename);
         return false;
      }
      var prefs = loadArcadeCheatPrefsForBasename(basename);
      var prepared = applyDefaultsToIniText(ini, prefs);
      writeArcadeCheatIni(basename, prepared);

      var optionMap = null;
      if (window.RS_ArcadeCheats && window.RS_ArcadeCheats.buildCoreOptionMap) {
         /* 用改过 default 的 INI 生成选项，键名与 FBNeo create_variables 一致 */
         optionMap = window.RS_ArcadeCheats.buildCoreOptionMap(prepared, prefs, basename);
      }
      seedArcadeCheatCoreOptions(optionMap);
      arcadeCheatsNeedSoftApply = pendingArcadeCheatHasEnabled();
      return true;
   } catch (e) {
      console.warn('WEBPLAYER: prepareArcadeCheatsBeforeLaunch failed', e);
      return false;
   }
}

/**
 * 应用街机作弊：写 INI + core options，再静默重载。
 * optionMap 由 shell/arcade-cheats.js 生成。
 */
function applyArcadeCheatIniAndRelaunch(basename, iniText, optionMap) {
   if (!basename || !iniText) return Promise.resolve(false);
   writeArcadeCheatIni(basename, iniText);
   seedArcadeCheatCoreOptions(optionMap || null);
   arcadeCheatsNeedSoftApply = true;

   if (!currentContentPath || currentContentPath === '--menu') {
      console.warn('WEBPLAYER: arcade cheat relaunch skipped (no content)');
      return Promise.resolve(false);
   }

   if (relaunchInProgress) {
      arcadeCheatRelaunchQueued = {
         basename: basename,
         ini: iniText,
         optionMap: optionMap || null
      };
      return Promise.resolve(true);
   }

   if (!Module || !retroArchRunning) {
      scheduleArcadeCheatSoftApply('deferred-start');
      return Promise.resolve(true);
   }

   return relaunchContentSilent(currentContentPath).then(function (ok) {
      if (arcadeCheatRelaunchQueued) {
         var q = arcadeCheatRelaunchQueued;
         arcadeCheatRelaunchQueued = null;
         writeArcadeCheatIni(q.basename, q.ini);
         seedArcadeCheatCoreOptions(q.optionMap);
         arcadeCheatsNeedSoftApply = true;
         return relaunchContentSilent(currentContentPath).then(function (ok2) {
            scheduleArcadeCheatSoftApply('after-queued-relaunch');
            return ok2 !== false;
         });
      }
      scheduleArcadeCheatSoftApply('after-relaunch');
      return ok !== false;
   });
}

window.PlayRetroCore = {
   send: function(cmd) {
      if (!Module || !retroArchRunning) return false;
      if (cmd === 'RESET') return triggerReset();
      if (Module.retroArchSend) {
         Module.retroArchSend(cmd);
         return true;
      }
      return false;
   },
   resetGame: function() {
      if (!window.__playEmbed) return false;
      return triggerReset();
   },
   rewriteCfg: writeEmbedRetroArchCfg,
   applyKeymap: applyEmbedKeymap,
   getCoreOption: function(key) {
      return embedCoreOptions[key];
   },
   setCoreOption: function(key, value) {
      if (!liteMode) return false;
      return applyCoreOptionLive(key, value);
   },
   setShader: function(shaderId, pack) {
      return applyVideoShader(shaderId, pack);
   },
   getShader: function() {
      return currentShaderId;
   },
   hasCheatSupport: function() {
      return !!getCheatApi();
   },
   applyCheats: function(codes) {
      return applyCheatCodes(codes);
   },
   clearCheats: function() {
      return clearCheatCodes();
   },
   getActiveCheats: function() {
      return activeCheatCodes.slice();
   },
   writeArcadeCheatIni: function(basename, iniText) {
      return writeArcadeCheatIni(basename, iniText);
   },
   applyArcadeCheatIniAndRelaunch: function(basename, iniText, optionMap) {
      return applyArcadeCheatIniAndRelaunch(basename, iniText, optionMap);
   },
   seedArcadeCheatCoreOptions: function(optionMap) {
      return seedArcadeCheatCoreOptions(optionMap);
   },
   exportState: function() {
      var found = pickNewestStateFile();
      return found ? found.data : null;
   },
   exportStateAsync: exportStateAsync,
   importState: function(data) {
      return importStateFromBuffer(data);
   },
   importStateAsync: importStateFromBufferAsync,
   minStateBytes: function() { return MIN_STATE_BYTES; },
   isRunning: function() {
      return !!(Module && retroArchRunning);
   }
};

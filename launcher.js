// The page around the game (port/web/README.md): puts the game data into
// the origin private file system (OPFS), where the game reads it as d:\,
// then starts the WebAssembly build on a click, which lets it play sound
// and capture the mouse.
"use strict";

(() => {
	const DATA_DIRECTORY = ["halo", "data"];
	const SAVE_DIRECTORY = ["halo", "save"];
	const LOG_LINES = 2000;

	const elements = {
		launcher: document.getElementById("launcher"),
		discInput: document.getElementById("disc-input"),
		ownTab: document.getElementById("own-tab"),
		folderInput: document.getElementById("folder-input"),
		clearButton: document.getElementById("clear-button"),
		startButton: document.getElementById("start-button"),
		initInput: document.getElementById("init-input"),
		maps: document.getElementById("maps"),
		progress: document.getElementById("progress"),
		status: document.getElementById("status"),
		canvas: document.getElementById("canvas"),
		hud: document.getElementById("hud"),
		hint: document.getElementById("hint"),
		log: document.getElementById("log"),
		logButton: document.getElementById("log-button"),
		fullscreenButton: document.getElementById("fullscreen-button"),
	};
	const parameters = new URLSearchParams(location.search);
	let busy = false;
	let started = false;

	// ---------- log

	const logLines = [];
	// for debugging from the browser's console
	window.haloLog = logLines;

	// Development: with ?env=HALO_SCREENSHOT_DIR=/opfs/halo/shots,
	// HALO_SCREENSHOT_EVERY=<frames> the renderer writes BMP frames into
	// storage; this sends the newest to tools/web_serve.py (--log) as a PNG
	// and removes the others.
	window.haloUploadScreenshot = async (name = "screenshot.png") => {
		const folder = await directory(["halo", "shots"], true);
		const frames = [];
		for await (const [entry, handle] of folder.entries()) {
			if (handle.kind === "file" && entry.endsWith(".bmp"))
				frames.push(entry);
		}
		frames.sort();
		if (!frames.length)
			return "no frames";
		const newest = frames[frames.length - 1];
		const bitmap = await createImageBitmap(await (await folder.getFileHandle(newest)).getFile());
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		canvas.getContext("2d").drawImage(bitmap, 0, 0);
		const png = await canvas.convertToBlob({ type: "image/png" });
		await fetch("/upload/" + name, { method: "POST", body: png });
		for (const frame of frames.slice(0, -1)) {
			try {
				await folder.removeEntry(frame);
			} catch (error) {
				// still being written
			}
		}
		return newest;
	};

	function log(text, isError) {
		(isError ? console.error : console.log)(text);
		logLines.push(text);
		if (logLines.length > LOG_LINES)
			logLines.splice(0, logLines.length - LOG_LINES);
		if (!elements.log.hidden) {
			elements.log.textContent = logLines.join("\n");
			elements.log.scrollTop = elements.log.scrollHeight;
		}
	}

	function setStatus(text, kind) {
		elements.status.textContent = text;
		elements.status.className = kind || "";
	}

	function formatBytes(bytes) {
		if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(1) + " GB";
		if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(0) + " MB";
		return (bytes / 1024).toFixed(0) + " KB";
	}

	// ---------- what the browser must support

	function missingFeatures() {
		const missing = [];
		if (!window.crossOriginIsolated || typeof SharedArrayBuffer === "undefined")
			missing.push("cross-origin isolation (the server must send COOP/COEP headers; see port/web/README.md)");
		if (!navigator.storage || !navigator.storage.getDirectory)
			missing.push("the origin private file system");
		if (!document.createElement("canvas").getContext("webgl2"))
			missing.push("WebGL 2");
		return missing;
	}

	function hasPromiseIntegration() {
		return typeof WebAssembly.Suspending === "function" && typeof WebAssembly.promising === "function";
	}

	// ---------- the origin private file system

	async function directory(path, create) {
		let handle = await navigator.storage.getDirectory();
		for (const name of path)
			handle = await handle.getDirectoryHandle(name, { create });
		return handle;
	}

	// The maps both Xbox releases have; the game needs all of them.
	const EXPECTED_MAPS = [
		"ui", "a10", "a30", "a50", "b30", "b40", "c10", "c20", "c40", "d20", "d40",
		"beavercreek", "bloodgulch", "boardingaction", "carousel", "chillout", "damnation",
		"hangemhigh", "longest", "prisoner", "putput", "ratrace", "sidewinder", "wizard",
	];

	// maps.json in the data folder holds each map's size once its copy has
	// finished, so that a copy cut short (a closed tab, a full disk) shows.
	// Data stored before it existed has none, and is only checked by header.
	const MANIFEST = "maps.json";

	async function readManifest() {
		try {
			const folder = await directory(DATA_DIRECTORY, false);
			return JSON.parse(await (await (await folder.getFileHandle(MANIFEST)).getFile()).text());
		} catch (error) {
			return null;
		}
	}

	async function writeManifest(manifest) {
		const folder = await directory(DATA_DIRECTORY, true);
		const writable = await (await folder.getFileHandle(MANIFEST, { create: true })).createWritable();
		await writable.write(JSON.stringify(manifest));
		await writable.close();
	}

	// the manifest to update: maps.json, or for data stored before it
	// existed, one that vouches for the maps whose headers look right
	async function currentManifest() {
		const manifest = await readManifest();
		if (manifest)
			return manifest;
		return Object.fromEntries((await storedMaps()).filter((map) => !map.problem).map((map) => [map.name, map.size]));
	}

	// one map into storage, in the manifest only once its copy is complete
	async function storeMap(manifest, name, source, size, onProgress, verify) {
		delete manifest[name];
		await writeManifest(manifest);
		await writeFile([...DATA_DIRECTORY, "maps", name], source, size, onProgress);
		if (verify) await verify();
		manifest[name] = size;
		await writeManifest(manifest);
	}

	// What the game keeps on z: besides the maps: its cache of decompressed
	// maps (cache_files_windows.c: two solo, one main menu and three
	// multiplayer files), and a margin for saved games.
	const GAME_CACHE_BYTES = 2 * 0x11600000 + 0x02300000 + 3 * 0x02f00000 + (64 << 20);

	// bytes under a storage folder, recursively
	async function folderBytes(path) {
		let bytes = 0;
		try {
			const walk = async (folder) => {
				for await (const [, handle] of folder.entries())
					bytes += handle.kind === "file" ? (await handle.getFile()).size : await walk(handle) || 0;
			};
			await walk(await directory(path, false));
		} catch (error) {
			// nothing stored there yet
		}
		return bytes;
	}

	// Whether the browser will let this page grow by that much. What
	// navigator.storage.estimate() reports is no guide (Chrome reports
	// usage + 10 GB whatever the real limit), so reserve it for a moment.
	async function canGrowBy(bytes) {
		if (bytes <= 0)
			return true;
		const folder = await directory(["halo"], true);
		try {
			const writable = await (await folder.getFileHandle("space-check", { create: true })).createWritable();
			try {
				await writable.truncate(bytes);
			} finally {
				await writable.abort().catch(() => {});
			}
			return true;
		} catch (error) {
			if (error.name === "QuotaExceededError")
				return false;
			throw error;
		} finally {
			await folder.removeEntry("space-check").catch(() => {});
		}
	}

	const embedded = window.top !== window;

	function storageMessage(need) {
		return `Not enough storage: this browser won't give this page the ${formatBytes(need)} the game needs. ` +
			(embedded ? "Open the game in its own tab (link above): a page inside another site's page can get less. " : "") +
			"In a private window (Incognito, InPrivate), use a normal window instead. Otherwise, free up space on this computer's disk.";
	}

	async function storedMapProblem(file, manifest) {
		if ((manifest && manifest[file.name] !== file.size) || file.size < 0x800)
			return "incomplete";
		const header = new Uint8Array(await file.slice(0, 0x800).arrayBuffer());
		const text = (offset) => String.fromCharCode(...header.subarray(offset, offset + 4));
		return text(0) === "daeh" && text(0x7fc) === "toof" ? null : "damaged";
	}

	async function storedMaps() {
		const maps = [];
		const manifest = await readManifest();
		try {
			const folder = await directory([...DATA_DIRECTORY, "maps"], false);
			for await (const [name, handle] of folder.entries()) {
				if (handle.kind !== "file" || !name.toLowerCase().endsWith(".map"))
					continue;
				const map = { name, size: 0, problem: null };
				try {
					const file = await handle.getFile();
					map.size = file.size;
					map.problem = await storedMapProblem(file, manifest);
				} catch (error) {
					map.problem = "in use in another tab";
				}
				maps.push(map);
			}
		} catch (error) {
			if (error.name !== "NotFoundError")
				throw error;
		}
		maps.sort((a, b) => a.name.localeCompare(b.name));
		return maps;
	}

	function mapProblems(maps) {
		const names = new Set(maps.map((map) => map.name.toLowerCase()));
		return [
			...EXPECTED_MAPS.filter((name) => !names.has(name + ".map")).map((name) => `${name}.map is missing`),
			...maps.filter((map) => map.problem).map((map) => `${map.name} is ${map.problem}`),
		];
	}

	async function writeFile(path, source, size, onProgress) {
		const folder = await directory(path.slice(0, -1), true);
		const handle = await folder.getFileHandle(path[path.length - 1], { create: true });
		const writable = await handle.createWritable();
		let written = 0;
		const counter = new TransformStream({
			transform(chunk, controller) {
				written += chunk.byteLength;
				onProgress(written, size);
				controller.enqueue(chunk);
			},
		});
		try {
			await source.pipeThrough(counter).pipeTo(writable);
			if (written !== size)
				throw new Error(`${path[path.length - 1]} came out as ${written} bytes instead of ${size}: the file it was copied from is damaged.`);
		} catch (error) {
			// leave no half-copied map behind for the game to trip over
			await folder.removeEntry(path[path.length - 1]).catch(() => {});
			throw error;
		}
	}

	// keepStatus: leave an error the caller just showed in place
	async function refreshMaps(keepStatus) {
		const maps = await storedMaps();
		const total = maps.reduce((sum, map) => sum + map.size, 0);
		const problems = mapProblems(maps);
		elements.maps.textContent = maps.length ?
			maps.map((map) => map.name).join("  ") :
			"No game data stored yet.";
		const ready = maps.length > 0 && !problems.length;
		if (!busy) window.haloAutoCache.refresh?.(maps);
		elements.startButton.disabled = busy || !ready;
		elements.clearButton.hidden = !maps.length;
		elements.launcher.classList.toggle("ready", ready);
		if (!busy && !keepStatus) {
			if (ready)
				setStatus(`${maps.length} ${maps.length === 1 ? "map" : "maps"} stored (${formatBytes(total)}). Press Play.`, "ok");
			else if (maps.length)
				setStatus(`Some of the stored maps are missing or damaged (${problems.slice(0, 3).join(", ")}${problems.length > 3 ? ", ..." : ""}): choose your disc image again.`, "error");
			else
				setStatus("Waiting for your Halo disc image.");
		}
		return maps;
	}

	// The Xbox game's cache files: header version 5 and a build string at
	// 0x40. These builds are the ones the game accepts (cache_files.c).
	const SUPPORTED_BUILDS = {
		"01.01.14.2342": "PAL",
		"01.10.12.2276": "NTSC",
	};

	async function mapBuild(file) {
		const header = new DataView(await file.slice(0, 0x60).arrayBuffer());
		const text = (offset, length) => String.fromCharCode(...new Uint8Array(header.buffer, offset, length)).replace(/\0.*$/, "");
		if (header.byteLength < 0x60 || text(0, 4) !== "daeh")
			return { error: `${file.name} is not a Halo map.` };
		const version = header.getUint32(4, true);
		const build = text(0x40, 32);
		if (version !== 5)
			return { error: `These maps are from Halo for PC or a remaster (map version ${version}, build ${build || "unknown"}): the original Xbox game's maps are needed.` };
		if (!SUPPORTED_BUILDS[build])
			return { error: `These maps are from build ${build}; the game plays the Xbox release's maps (${Object.keys(SUPPORTED_BUILDS).join(" or ")}).` };
		return { build, region: SUPPORTED_BUILDS[build] };
	}

	// ---------- Xbox disc images

	// A disc image holds the game partition's XDVDFS file system, either
	// alone (an "xiso", as extract-xiso and most dumping tools write it) or
	// at its place on the whole disc (a full dump of an original Xbox disc,
	// after the video partition). Its volume descriptor is sector 32.
	const SECTOR = 2048;
	const XDVDFS_MAGIC = "MICROSOFT*XBOX*MEDIA";
	const PARTITION_OFFSETS = [0, 0x18300000, 0x0fd90000, 0x02080000]; // xiso, XGD1 dump, XGD2, XGD3

	async function readBytes(file, offset, length) {
		return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
	}

	async function discPartition(file) {
		for (const base of PARTITION_OFFSETS) {
			const header = await readBytes(file, base + 32 * SECTOR, 28);
			if (header.length < 28 || String.fromCharCode(...header.subarray(0, 20)) !== XDVDFS_MAGIC)
				continue;
			const view = new DataView(header.buffer);
			return { base, root: { sector: view.getUint32(20, true), size: view.getUint32(24, true) } };
		}
		return null;
	}

	// A directory's table is a binary tree of entries: left and right
	// subtree offsets (in dwords), first sector, size, attributes, name.
	async function discDirectory(file, partition, directoryEntry) {
		const entries = [];
		if (!directoryEntry.size)
			return entries;
		const table = await readBytes(file, partition.base + directoryEntry.sector * SECTOR, directoryEntry.size);
		const view = new DataView(table.buffer);
		const pending = [0];
		const seen = new Set();
		while (pending.length) {
			const offset = pending.pop();
			if (seen.has(offset) || offset + 14 > table.length)
				continue;
			seen.add(offset);
			const left = view.getUint16(offset, true);
			if (left === 0xffff) // padding: an empty directory
				continue;
			const right = view.getUint16(offset + 2, true);
			const nameLength = table[offset + 13];
			entries.push({
				name: String.fromCharCode(...table.subarray(offset + 14, offset + 14 + nameLength)),
				sector: view.getUint32(offset + 4, true),
				size: view.getUint32(offset + 8, true),
				directory: (table[offset + 12] & 0x10) !== 0,
			});
			if (left)
				pending.push(left * 4);
			if (right)
				pending.push(right * 4);
		}
		return entries;
	}

	async function importDiscImage(file) {
		if (/\.(zip|7z|rar|gz|tgz|tar|xz)$/i.test(file.name)) {
			setStatus(`${file.name} is a compressed archive: unpack it first (right-click it, then Extract All), then choose the .iso file that comes out of it.`, "error");
			return;
		}
		setStatus(`Reading ${file.name}...`);
		const partition = await discPartition(file);
		if (!partition) {
			setStatus(`${file.name} is not an Xbox disc image: choose the .iso (or .xiso) file of Halo: Combat Evolved for the original Xbox.`, "error");
			return;
		}
		const root = await discDirectory(file, partition, partition.root);
		const mapsFolder = root.find((entry) => entry.directory && entry.name.toLowerCase() === "maps");
		const maps = mapsFolder ?
			(await discDirectory(file, partition, mapsFolder)).filter((entry) => !entry.directory && /\.map$/i.test(entry.name)) :
			[];
		if (!maps.some((entry) => entry.name.toLowerCase() === "ui.map")) {
			setStatus(`${file.name} is an Xbox disc image, but not of Halo: Combat Evolved (it has no maps\\ui.map).`, "error");
			return;
		}
		if (maps.some((entry) => partition.base + entry.sector * SECTOR + entry.size > file.size)) {
			setStatus(`${file.name} is incomplete: it ends before the files in it do. Copy or make it again.`, "error");
			return;
		}
		await importFiles(maps.map((entry) => {
			const start = partition.base + entry.sector * SECTOR;
			return new File([file.slice(start, start + entry.size)], entry.name);
		}));
	}

	// a file or folder dropped on the page: a disc image, map files, or a
	// folder holding them
	async function droppedFiles(entry, files) {
		if (entry.isFile) {
			files.push(await new Promise((resolve, reject) => entry.file(resolve, reject)));
			return;
		}
		const reader = entry.createReader();
		for (;;) {
			const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
			if (!batch.length)
				break;
			for (const child of batch) {
				if (child.isDirectory || /\.map$/i.test(child.name))
					await droppedFiles(child, files);
			}
		}
	}

	async function importDropped(entries, plainFiles) {
		const files = [];
		let folder = false;
		for (const entry of entries) {
			folder = folder || entry.isDirectory;
			await droppedFiles(entry, files);
		}
		if (!entries.length)
			files.push(...plainFiles);
		if (!folder && files.length === 1 && !/\.map$/i.test(files[0].name))
			await importDiscImage(files[0]);
		else
			await importFiles(files);
	}

	async function importFiles(files) {
		// any .map files in the chosen folder: the maps folder itself, the
		// game's folder around it, or a copy of the whole disc; one of each name
		const byName = new Map();
		for (const file of files) {
			const path = (file.webkitRelativePath || file.name).toLowerCase();
			if (!path.endsWith(".map"))
				continue;
			const name = file.name.toLowerCase();
			const inMaps = /(^|\/)maps\/[^/]+$/.test(path);
			if (!byName.has(name) || (inMaps && !byName.get(name).inMaps))
				byName.set(name, { file, inMaps });
		}
		const maps = [...byName.values()].map((entry) => entry.file);
		const ui = byName.get("ui.map");
		if (!ui) {
			setStatus(maps.length ?
				"That folder has maps but no ui.map: choose the game's whole maps folder." :
				"That folder has no .map files: choose the maps folder of your Halo (Xbox) copy.", "error");
			return;
		}
		const check = await mapBuild(ui.file);
		if (check.error) {
			setStatus(check.error, "error");
			return;
		}
		// ask the browser not to evict 1.7 GB of maps when disk space runs low
		if (navigator.storage.persist)
			navigator.storage.persist().catch(() => {});
		const total = maps.reduce((sum, file) => sum + file.size, 0);
		// the maps and the game's cache, less what is already stored
		setStatus("Checking storage space...");
		if (!await canGrowBy(total + GAME_CACHE_BYTES - await folderBytes(["halo"]))) {
			setStatus(storageMessage(total + GAME_CACHE_BYTES), "error");
			return;
		}
		let done = 0;
		busy = true;
		elements.startButton.disabled = true;
		elements.progress.hidden = false;
		try {
			const manifest = await currentManifest();
			for (const file of maps) {
				const name = file.name.toLowerCase();
				setStatus(`Copying ${name} (${formatBytes(file.size)})...`);
				await storeMap(manifest, name, file.stream(), file.size, (written) => {
					elements.progress.value = (done + written) / total;
				});
				done += file.size;
			}
		} catch (error) {
			if (error.name === "QuotaExceededError")
				throw new Error(storageMessage(total + GAME_CACHE_BYTES));
			throw error;
		} finally {
			busy = false;
			elements.progress.hidden = true;
		}
		await refreshMaps();
	}

	// Development: ?data=<url> copies the files a server lists in
	// <url>manifest.json (tools/web_serve.py --data) into storage, skipping
	// the ones already there with the same size.
	async function importFromServer(base) {
		if (!base.endsWith("/"))
			base += "/";
		const manifest = await (await fetch(base + "manifest.json", { cache: "no-store" })).json();
		const stored = new Map((await storedMaps()).map((map) => [map.name, map.size]));
		const wanted = manifest.files.filter((file) => /^maps\/[^/]+\.map$/i.test(file.name) &&
			stored.get(file.name.slice(5).toLowerCase()) !== file.size);
		if (!wanted.length)
			return;
		const total = wanted.reduce((sum, file) => sum + file.size, 0);
		let done = 0;
		busy = true;
		elements.progress.hidden = false;
		try {
			const manifest = await currentManifest();
			for (const file of wanted) {
				const name = file.name.slice(5).toLowerCase();
				setStatus(`Downloading ${name} (${formatBytes(file.size)})...`);
				const response = await fetch(base + file.name);
				if (!response.ok)
					throw new Error(`${file.name}: HTTP ${response.status}`);
				await storeMap(manifest, name, response.body, file.size, (written) => {
					elements.progress.value = (done + written) / total;
				});
				done += file.size;
			}
		} finally {
			busy = false;
			elements.progress.hidden = true;
		}
	}

	async function clearData() {
		if (!confirm("Remove the stored game data and saved games from this browser?"))
			return;
		const root = await navigator.storage.getDirectory();
		try {
			await root.removeEntry("halo", { recursive: true });
		} catch (error) {
			if (error.name !== "NotFoundError")
				throw error;
		}
		await refreshMaps();
	}

	async function writeInitCommands(text) {
		const folder = await directory(DATA_DIRECTORY, true);
		const lines = text.split(/;|\n/).map((line) => line.trim()).filter(Boolean);
		if (!lines.length) {
			try {
				await folder.removeEntry("init.txt");
			} catch (error) {
				if (error.name !== "NotFoundError")
					throw error;
			}
			return;
		}
		const handle = await folder.getFileHandle("init.txt", { create: true });
		const writable = await handle.createWritable();
		await writable.write(lines.join("\r\n") + "\r\n");
		await writable.close();
	}

	// ---------- the game

	function loadScript(url) {
		return new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = url;
			script.onload = resolve;
			script.onerror = () => reject(new Error(`cannot load ${url}`));
			document.head.appendChild(script);
		});
	}

	function stopped(error) {
		const text = error && error.stack ? error.stack : String(error);
		log(`The game stopped: ${text}`, true);
		elements.log.hidden = false;
		elements.log.textContent = logLines.join("\n");
		elements.log.scrollTop = elements.log.scrollHeight;
	}

	// One copy of the game at a time: the game's files in storage can be
	// open for writing in one page only, and a second copy (another tab, or
	// a reload whose previous page is still closing) would find them locked.
	// The lock is held until the page goes away.
	let releaseGameLock = null;
	function acquireGameLock(milliseconds) {
		if (!navigator.locks)
			return Promise.resolve(true);
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), milliseconds);
		return new Promise((resolve) => {
			navigator.locks.request("halo-game", { signal: abort.signal }, () => {
				clearTimeout(timer);
				resolve(true);
				return new Promise((release) => {
					releaseGameLock = release;
				});
			}).catch(() => resolve(false));
		});
	}

	async function start() {
		if (started)
			return;
		started = true;
		elements.startButton.disabled = true;
		try {
			// what the game will find on d:; its own cache must fit beside the
			// maps too, or it reports a damaged disc
			const maps = await storedMaps();
			if (!await canGrowBy(GAME_CACHE_BYTES - await folderBytes(SAVE_DIRECTORY)))
				throw new Error(storageMessage(maps.reduce((sum, map) => sum + map.size, 0) + GAME_CACHE_BYTES));
			if (!await acquireGameLock(8000))
				throw new Error("Halo is already running in another tab or window of this browser: close it, then press Play again.");
			log(`stored maps: ${maps.length}, ${formatBytes(maps.reduce((sum, map) => sum + map.size, 0))}` +
				(mapProblems(maps).length ? `; ${mapProblems(maps).join(", ")}` : ""));
			await writeInitCommands(elements.initInput.value);
			try {
				localStorage.setItem("halo.init", elements.initInput.value);
			} catch (error) {
				// storage may be unavailable; the field just starts empty
			}
			await directory(SAVE_DIRECTORY, true);
			const shots = await directory(["halo", "shots"], true);
			for await (const [name] of shots.entries())
				await shots.removeEntry(name).catch(() => {});
			// development: ?clearcache removes the maps the game copied to its
			// cache partition, so that it copies them again
			if (parameters.has("clearcache")) {
				try {
					const cache = await directory([...SAVE_DIRECTORY, "z"], false);
					for await (const [name] of cache.entries()) {
						if (/^cache\d+\.map$/i.test(name))
							await cache.removeEntry(name);
					}
				} catch (error) {
					if (error.name !== "NotFoundError")
						throw error;
				}
			}
			if (navigator.storage.persist)
				navigator.storage.persist();

			// the Asyncify build runs where promise integration is missing
			// (?build=asyncify forces it, for testing)
			const script = hasPromiseIntegration() && parameters.get("build") !== "asyncify" ?
				"halo.js" : "halo-asyncify.js";
			setStatus("Loading the game...");
			await loadScript(script);

			elements.launcher.hidden = true;
			elements.hud.hidden = false;
			elements.hint.hidden = false;
			elements.canvas.focus();

			const environment = {
				HALO_DATA_ROOT: "/opfs/" + DATA_DIRECTORY.join("/"),
				HALO_SAVE_ROOT: "/opfs/" + SAVE_DIRECTORY.join("/"),
			};
			// development: ?env=NAME=value,NAME=value
			for (const pair of (parameters.get("env") || "").split(",").filter(Boolean)) {
				const [name, ...value] = pair.split("=");
				environment[name] = value.join("=") || "1";
			}

			const module = await createHalo({
				canvas: elements.canvas,
				print: (text) => log(text),
				printErr: (text) => log(text, true),
				preRun: [(instance) => Object.assign(instance.ENV, environment)],
				onAbort: (what) => stopped(what),
			});
			window.halo = module;
			if (!await module.ccall("web_platform_prepare", "number", [], [], { async: true }))
				throw new Error("cannot open the game's storage");
			log("starting the game");
			// main() only returns if the game stops (it runs suspended between
			// frames); a crash rejects the promise
			Promise.resolve(module.callMain([])).catch((error) => stopped(error));
		} catch (error) {
			started = false;
			// a game that never loaded holds nothing: let imports and a retry in
			if (!window.halo && releaseGameLock) {
				releaseGameLock();
				releaseGameLock = null;
			}
			elements.launcher.hidden = false;
			elements.hud.hidden = true;
			elements.hint.hidden = true;
			elements.startButton.disabled = false;
			setStatus(String(error.message || error), "error");
			console.error(error);
		}
	}

	// ---------- page wiring

	// Changing the stored data while the game runs in another tab would half
	// work (the running game keeps its files locked): hold the game's lock
	// for the change, and refuse while the game has it.
	function withGameLock(task) {
		if (!navigator.locks)
			return task();
		return navigator.locks.request("halo-game", { ifAvailable: true }, (lock) => {
			if (!lock)
				throw new Error("Halo is running in another tab or window of this browser: close it first, then try again.");
			return task();
		});
	}

	function runImport(task) {
		if (busy || started)
			return;
		withGameLock(task).catch((error) => {
			busy = false;
			setStatus(String(error.message || error), "error");
			refreshMaps(true);
		});
	}
	elements.discInput.addEventListener("change", () => {
		const file = elements.discInput.files && elements.discInput.files[0];
		elements.discInput.value = "";
		if (file)
			runImport(() => importDiscImage(file));
	});
	elements.folderInput.addEventListener("change", () => {
		const files = Array.from(elements.folderInput.files || []);
		elements.folderInput.value = "";
		runImport(() => importFiles(files));
	});
	elements.launcher.addEventListener("dragover", (event) => {
		if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes("Files"))
			return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		elements.launcher.classList.add("dragging");
	});
	elements.launcher.addEventListener("dragleave", (event) => {
		if (!elements.launcher.contains(event.relatedTarget))
			elements.launcher.classList.remove("dragging");
	});
	elements.launcher.addEventListener("drop", (event) => {
		event.preventDefault();
		elements.launcher.classList.remove("dragging");
		// the entries must be taken before the event returns
		const entries = Array.from(event.dataTransfer.items || [])
			.map((item) => item.webkitGetAsEntry && item.webkitGetAsEntry())
			.filter(Boolean);
		const plainFiles = Array.from(event.dataTransfer.files || []);
		runImport(() => importDropped(entries, plainFiles));
	});
	elements.clearButton.addEventListener("click", () => withGameLock(clearData).catch((error) => {
		setStatus(String(error.message || error), "error");
		refreshMaps(true);
	}));
	elements.startButton.addEventListener("click", start);
	elements.logButton.addEventListener("click", () => {
		elements.log.hidden = !elements.log.hidden;
		elements.log.textContent = logLines.join("\n");
		elements.log.scrollTop = elements.log.scrollHeight;
	});
	elements.fullscreenButton.addEventListener("click", async () => {
		await document.getElementById("stage").requestFullscreen();
		// in fullscreen, escape can go to the game (hold it to leave)
		if (navigator.keyboard && navigator.keyboard.lock)
			navigator.keyboard.lock(["Escape"]).catch(() => {});
	});
	elements.canvas.addEventListener("contextmenu", (event) => event.preventDefault());
	elements.canvas.addEventListener("mousedown", () => { elements.hint.hidden = true; });
	document.addEventListener("pointerlockchange", () => {
		if (started)
			elements.hint.hidden = document.pointerLockElement === elements.canvas;
	});
	window.addEventListener("beforeunload", (event) => {
		// development runs (?autostart) are driven by scripts
		if (started && !parameters.has("autostart")) {
			event.preventDefault();
			event.returnValue = "";
		}
	});

	// A host that cannot send the cross-origin isolation headers gets them
	// from sw.js: register it, and reload once so that it serves the page.
	async function isolateThroughServiceWorker() {
		if (window.crossOriginIsolated || !window.isSecureContext || !("serviceWorker" in navigator))
			return false;
		let reloaded = false;
		try {
			reloaded = sessionStorage.getItem("halo.isolation-reload") === "1";
		} catch (error) {
			// no session storage: try once anyway
		}
		if (reloaded)
			return false;
		try {
			await navigator.serviceWorker.register("sw.js");
			await navigator.serviceWorker.ready;
			try {
				sessionStorage.setItem("halo.isolation-reload", "1");
			} catch (error) {
				// see above
			}
			location.reload();
			return true;
		} catch (error) {
			console.warn("cannot register the service worker that isolates the page:", error);
			return false;
		}
	}

	if (embedded) {
		elements.ownTab.href = location.href;
		elements.ownTab.parentElement.hidden = false;
	}

	(async () => {
		try {
			elements.initInput.value = parameters.get("init") || localStorage.getItem("halo.init") || "";
		} catch (error) {
			elements.initInput.value = parameters.get("init") || "";
		}
		if (await isolateThroughServiceWorker())
			return;
		try {
			sessionStorage.removeItem("halo.isolation-reload");
		} catch (error) {
			// see isolateThroughServiceWorker
		}
		const missing = missingFeatures();
		if (missing.length) {
			setStatus("This browser cannot run the game: open this page in Google Chrome or Microsoft Edge, on a computer. (It lacks " + missing.join(", ") + ".)", "error");
			return;
		}
		if (!parameters.get("data") && !parameters.has("manual")) {
            const ready = await window.haloAutoCache({
                base: document.querySelector('meta[name="halo-data-source"]').content,
                elements, storedMaps, mapProblems, directory, currentManifest, storeMap,
                canGrowBy, folderBytes, storageMessage, withGameLock, formatBytes,
                setStatus, refreshMaps, expectedMaps: EXPECTED_MAPS, cacheBytes: GAME_CACHE_BYTES,
                setBusy: value => { busy = value; },
            });
            if (!ready) return;
        }
		if (parameters.get("data")) {
			try {
				await importFromServer(parameters.get("data"));
			} catch (error) {
				setStatus(`Cannot copy the game data from ${parameters.get("data")}: ${error.message || error}`, "error");
				return;
			}
		}
		const maps = await refreshMaps();
		if (parameters.has("autostart") && maps.length && !mapProblems(maps).length)
			start();
	})();
})();

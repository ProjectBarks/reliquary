let native;
let mouseEvents;

if (process.platform === "win32") {
	native = require("./binding/napi-v5/untapped-node-native.node");
	mouseEvents = require("./mouseEvents");
} else if (process.platform === "darwin") {
	native = require("./binding/napi-v5/untapped-node-native.node");
} else if (process.platform === "linux") {
	native = require("./linuxX11.js");
} else {
	throw new Error(
		"untapped-node-native addon is only supported on Windows and macOS",
	);
}

// Cross-platform (platform-specific signatures are handled at native boundary)
function getWindowInfo(...args) {
	return native.getWindowInfo(...args);
}

// macOS-only APIs
function activateWindow(pid) {
	if (process.platform !== "darwin") {
		throw new Error("activateWindow is only available on macOS");
	}
	return native.activateWindow(pid);
}

// Windows-only APIs
function getExecPath(pid) {
	if (process.platform !== "win32") {
		throw new Error("getExecPath is only available on Windows");
	}
	return native.getExecPath(pid);
}

function killProcess(pid) {
	if (process.platform !== "win32") {
		throw new Error("killProcess is only available on Windows");
	}
	return native.killProcess(pid);
}

function isWindowInForeground(hwnd) {
	if (process.platform !== "win32") {
		throw new Error("isWindowInForeground is only available on Windows");
	}
	return native.isWindowInForeground(hwnd);
}

function bringWindowToForeground(hwnd) {
	if (process.platform !== "win32") {
		throw new Error("bringWindowToForeground is only available on Windows");
	}
	return native.bringWindowToForeground(hwnd);
}

function getWindowClientRect(hwnd) {
	if (process.platform !== "win32") {
		throw new Error("getWindowClientRect is only available on Windows");
	}
	return native.getWindowClientRect(hwnd);
}

function getWindowDpiScale(hwnd) {
	if (process.platform !== "win32") {
		throw new Error("getWindowDpiScale is only available on Windows");
	}
	return native.getWindowDpiScale(hwnd);
}

function getRelativeMousePosition(hwnd) {
	if (process.platform !== "win32") {
		throw new Error(
			"getRelativeMousePosition is only available on Windows",
		);
	}
	return native.getRelativeMousePosition(hwnd);
}

function toAbsoluteMousePosition(hwnd, x, y) {
	if (process.platform !== "win32") {
		throw new Error("toAbsoluteMousePosition is only available on Windows");
	}
	return native.toAbsoluteMousePosition(hwnd, x, y);
}

function sendMouseInput(input) {
	if (process.platform !== "win32") {
		throw new Error("sendMouseInput is only available on Windows");
	}
	return native.sendMouseInput(input);
}

function sendKeyboardInput(hwnd) {
	if (process.platform !== "win32") {
		throw new Error("sendKeyboardInput is only available on Windows");
	}
	return native.sendKeyboardInput(hwnd);
}

module.exports = {
	getWindowInfo,
};

if (process.platform === "win32") {
	Object.assign(module.exports, {
		getExecPath,
		killProcess,
		isWindowInForeground,
		bringWindowToForeground,
		getWindowClientRect,
		getWindowDpiScale,
		getRelativeMousePosition,
		toAbsoluteMousePosition,
		sendMouseInput,
		sendKeyboardInput,
		getRegistryValue: (root, subKey, valueName) =>
			native.getRegistryValue(root, subKey, valueName),
		setRegistryValue: (root, subKey, valueName, type, value) =>
			native.setRegistryValue(root, subKey, valueName, type, value),
		deleteRegistryValue: (root, subKey, valueName) =>
			native.deleteRegistryValue(root, subKey, valueName),
		mouseEvents,
	});
} else if (process.platform === "darwin") {
	Object.assign(module.exports, {
		activateWindow,
	});
}

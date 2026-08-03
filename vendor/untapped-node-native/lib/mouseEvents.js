const { EventEmitter } = require("events");

let addon;
if (process.platform === "win32") {
	addon = require("./binding/napi-v5/untapped-node-native.node");
}

class MouseEvents extends EventEmitter {
	constructor() {
		super();

		if (process.platform !== "win32") {
			return;
		}

		let hooked = false;
		let registeredEvents = [];

		this.on("newListener", (event) => {
			if (event !== "mouseup" && event !== "mousedown") {
				return;
			}
			if (registeredEvents.indexOf(event) !== -1) {
				return;
			}
			if (!hooked) {
				hooked = addon.hookMouse((event, button) => {
					this.emit(event, button);
				});
			} else {
				return;
			}
			registeredEvents.push(event);
		});

		this.on("removeListener", (event) => {
			if (this.listenerCount(event) > 0) {
				return;
			}
			registeredEvents = registeredEvents.filter((x) => x !== event);
			if (registeredEvents.length === 0 && hooked) {
				addon.unhookMouse();
				hooked = false;
			}
		});
	}
}

module.exports = new MouseEvents();

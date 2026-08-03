const util = require("util");
const x11 = require("x11");

let clientContext = createClient();

function withTimeout(promise, name) {
	return Promise.race([
		new Promise((_, reject) => {
			setTimeout(() => {
				reject(new Error(`Operation ${name} timed out`));
			}, 100);
		}),
		promise,
	]);
}

async function createClient() {
	return new Promise((resolve, reject) => {
		x11.createClient({ debug: true }, function (err, disp) {
			if (err) {
				reject(err);
			} else {
				const X = disp.client;
				const queryTree = util.promisify(X.QueryTree.bind(X));
				const getProperty = util.promisify(X.GetProperty.bind(X));
				const getGeometry = util.promisify(X.GetGeometry.bind(X));
				const internAtom = util.promisify(X.InternAtom.bind(X));

				resolve({
					X,
					root: disp.screen[0].root,
					queryTree,
					getProperty,
					getGeometry,
					internAtom,
				});
			}
		});
	});
}

async function getClientWithRetry() {
	try {
		return await clientContext;
	} catch (_) {
		clientContext = createClient();
		return await clientContext;
	}
}

async function callWithRetry(func, args) {
	let ctx = await getClientWithRetry();
	try {
		return await withTimeout(ctx[func].apply(ctx, args), func);
	} catch (_) {
		clientContext = Promise.reject();
		return getClientWithRetry().then((ctx) =>
			withTimeout(ctx[func].apply(ctx, args), func),
		);
	}
}

async function getFirstClass(wid) {
	var ctx = await getClientWithRetry();
	var classProp = await callWithRetry("getProperty", [
		0,
		wid,
		ctx.X.atoms.WM_CLASS,
		ctx.X.atoms.STRING,
		0,
		16384,
	]);

	var classProp00 = classProp.data.indexOf(0x00);
	if (classProp00 !== -1) {
		return classProp.data.toString("utf8", 0, classProp00);
	} else {
		return classProp.data.toString("utf8");
	}
}

async function computeGeometry(wid, root) {
	if (wid === root) {
		return { xPos: 0, yPos: 0 };
	} else {
		const geom = await callWithRetry("getGeometry", [wid]);
		const tree = await callWithRetry("queryTree", [wid]);
		const parentGeom = await computeGeometry(tree.parent, root);
		return {
			xPos: geom.xPos + parentGeom.xPos,
			yPos: geom.yPos + parentGeom.yPos,
		};
	}
}

async function getWindowInfo(windowName, windowClass, pidName, pidClass) {
	const effectiveWindowClass = windowClass ?? windowName;
	const effectivePidName = pidName ?? windowName;
	const effectivePidClass = pidClass ?? effectiveWindowClass;

	const ctx = await getClientWithRetry();

	const netClientList = await callWithRetry("internAtom", [
		false,
		"_NET_CLIENT_LIST",
	]);
	const netWmPid = await callWithRetry("internAtom", [false, "_NET_WM_PID"]);

	const managedWidsProp = await callWithRetry("getProperty", [
		0,
		ctx.root,
		netClientList,
		ctx.X.atoms.CARDNAL,
		0,
		16384,
	]);
	const managedWids = [];
	var offset = 0;
	while (offset < managedWidsProp.data.length) {
		managedWids.push(managedWidsProp.data.readUInt32LE(offset));
		offset += 4;
	}

	let wid;
	let pid;
	for (const managedWid of managedWids) {
		const name = await callWithRetry("getProperty", [
			0,
			managedWid,
			ctx.X.atoms.WM_NAME,
			ctx.X.atoms.STRING,
			0,
			16384,
		]).then((prop) => prop.data.toString());
		if (name === windowName) {
			const className = await getFirstClass(managedWid);
			if (className === effectiveWindowClass) {
				wid = managedWid;
			}
		}
		if (name === effectivePidName) {
			const className = await getFirstClass(managedWid);
			if (className === effectivePidClass) {
				pid = await callWithRetry("getProperty", [
					0,
					managedWid,
					netWmPid,
					ctx.X.atoms.CARDINAL,
					0,
					4,
				]).then((prop) => {
					if (prop.data.length >= 4) {
						return prop.data.readUInt32LE(0);
					} else {
						return 0;
					}
				});
			}
		}
	}

	if (wid && pid) {
		const sumGeom = await computeGeometry(wid, ctx.root);
		const localGeom = await callWithRetry("getGeometry", [wid]);

		return {
			exists: true,
			active: true,
			fullscreen: false,
			x: sumGeom.xPos,
			y: sumGeom.yPos,
			width: localGeom.width,
			height: localGeom.height,
			wid: wid,
			pid: pid,
		};
	} else {
		return {
			exists: false,
			active: false,
			pid: null,
		};
	}
}

module.exports = {
	getWindowInfo,
};
